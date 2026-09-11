import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../../logging/logger";
import { ContextEventBus } from "../../events/eventBus";
import {
  diffActivitySnapshot,
  emptySnapshot,
  RawActivitySnapshot,
  KNOWN_BROWSER_EXECUTABLES,
} from "./activitySnapshot";
import { PowerShellRunner, PowerShellSession } from "./powerShellSession";

const execAsync = promisify(exec);

const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Consecutive session failures after which NIMBUS stops trying to use one. */
const MAX_SESSION_FAILURES = 3;

/**
 * One PowerShell round-trip per poll, gathering everything a tick needs:
 * running process names (APPLICATION_OPENED), known browsers' window
 * titles (the WEBSITE_OPENED heuristic — see activitySnapshot.ts's doc
 * comment), and currently-open Explorer folder paths via the
 * `Shell.Application` COM object — the standard, supported way to
 * enumerate Explorer windows on Windows, chosen specifically because it's
 * a real API rather than scraping window titles or watching the
 * filesystem (the task's own "use a more appropriate Windows-specific
 * mechanism rather than fragile polling" guidance for folder detection).
 *
 * Deliberately reads only process/window names and folder paths — never
 * page content, keystrokes, or screenshots (see "Privacy" in
 * docs/routines.md).
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process | Select-Object -ExpandProperty ProcessName -Unique
$browsers = Get-Process -Name chrome,msedge,firefox,brave,opera -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle } |
  Select-Object ProcessName, MainWindowTitle
# Programs with a visible window, and their description — kept only by the
# opt-in app-usage tally.
$windowed = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object ProcessName, Description
$folders = @()
try {
  $shell = New-Object -ComObject Shell.Application
  foreach ($w in @($shell.Windows())) {
    try {
      $path = $w.Document.Folder.Self.Path
      if ($path) { $folders += $path }
    } catch {}
  }
} catch {}
@{ processes = @($procs); browsers = @($browsers); folders = @($folders); windowed = @($windowed) } | ConvertTo-Json -Compress -Depth 4
`.trim();

interface RawPollResult {
  processes?: string | string[];
  browsers?:
    | { ProcessName?: string; MainWindowTitle?: string }
    | Array<{ ProcessName?: string; MainWindowTitle?: string }>;
  folders?: string | string[];
  windowed?:
    | { ProcessName?: string; Description?: string | null }
    | Array<{ ProcessName?: string; Description?: string | null }>;
}

/** PowerShell's ConvertTo-Json collapses a single-item array to a bare scalar — this undoes that so callers can always treat the field as an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const POLL_TIMEOUT_MS = 8000;

/**
 * The one-shot path, kept as a fallback for when the persistent session
 * can't be used (it failed to start, or died repeatedly). Slower per
 * call — a fresh PowerShell pays its own startup cost — but it has no
 * state to get wedged, so it always works.
 *
 * -EncodedCommand (Base64 of the UTF-16LE script) rather than -Command
 * with escaped quotes: a multi-line script full of quotes does not
 * survive being re-quoted through cmd.exe (which is what Node's exec()
 * shells out through on Windows) — the command silently produces empty
 * output instead of erroring, which is exactly the kind of failure that
 * must never be allowed to look like "nothing is running." Encoding
 * sidesteps quoting entirely.
 */
async function runOneShot(script: string): Promise<string> {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedScript}`,
    { timeout: POLL_TIMEOUT_MS, windowsHide: true }
  );
  return stdout;
}

/**
 * Reads one activity snapshot through `runScript` — the persistent
 * session in production (see powerShellSession.ts), a stub in tests.
 */
async function pollRealActivity(
  runScript: (script: string) => Promise<string> = runOneShot
): Promise<RawActivitySnapshot> {
  try {
    const stdout = await runScript(POWERSHELL_SCRIPT);

    const parsed = stdout.trim() ? (JSON.parse(stdout) as RawPollResult) : {};

    const processNames = asArray(parsed.processes)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => `${name.toLowerCase()}.exe`);

    const browserWindows = asArray(parsed.browsers)
      .filter((b) => b && b.ProcessName && b.MainWindowTitle)
      .map((b) => ({ executable: `${b.ProcessName!.toLowerCase()}.exe`, title: b.MainWindowTitle! }))
      .filter((w) => KNOWN_BROWSER_EXECUTABLES.includes(w.executable));

    const explorerFolders = asArray(parsed.folders).filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );

    const windowedApps = asArray(parsed.windowed)
      .filter((w) => w && typeof w.ProcessName === "string" && w.ProcessName.length > 0)
      .map((w) => ({
        executable: `${w.ProcessName!.toLowerCase()}.exe`,
        description: typeof w.Description === "string" && w.Description.trim() ? w.Description.trim() : null,
      }));

    return { processNames, browserWindows, explorerFolders, windowedApps };
  } catch (err) {
    // Never let a poll failure take NIMBUS down — same discipline every
    // Context/Action provider already applies to its own external calls.
    logger.warn("Desktop activity poll failed", { error: String(err) });
    return emptySnapshot();
  }
}

/**
 * Periodically polls desktop activity and publishes the resulting
 * Context Events onto the shared ContextEventBus. This is the only
 * producer of ApplicationOpened/WebsiteOpened/FolderOpened events today
 * (see events/types.ts) — RoutineService and anything else just
 * subscribes to the bus and never needs to know polling is involved.
 *
 * Only runs when explicitly started — gated behind the Routines "Enable
 * context-aware suggestions" master switch in Settings (off by default),
 * per the task's privacy principle: NIMBUS should not monitor desktop
 * activity unless the user has actually opted into routines.
 */
export class DesktopActivityMonitor {
  private previous: RawActivitySnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private session: PowerShellRunner | null = null;
  private sessionFailures = 0;

  constructor(
    private readonly eventBus: ContextEventBus,
    private readonly pollFn: (
      runScript?: (script: string) => Promise<string>
    ) => Promise<RawActivitySnapshot> = pollRealActivity,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private readonly now: () => Date = () => new Date(),
    /** Injectable so tests can drive the session paths without a real PowerShell. */
    private readonly createSession: () => PowerShellRunner = () => new PowerShellSession(),
    /** Every poll's snapshot — the opt-in app-usage tally reads windowed programs from it. */
    private readonly onSnapshot?: (snapshot: RawActivitySnapshot) => void
  ) {}

  /**
   * Runs one script through the long-lived PowerShell session, falling
   * back to a one-shot `powershell.exe` when the session isn't usable.
   *
   * After MAX_SESSION_FAILURES consecutive session errors NIMBUS stops
   * retrying it for good and stays on the one-shot path: a session that
   * keeps dying would otherwise pay a process spawn *and* a failed poll
   * every tick, which is strictly worse than the original behaviour.
   * Polls are best-effort either way — nothing here is allowed to be
   * the reason NIMBUS stops working.
   */
  private runScript = async (script: string): Promise<string> => {
    if (this.sessionFailures < MAX_SESSION_FAILURES) {
      if (!this.session) this.session = this.createSession();
      try {
        const output = await this.session.run(script, POLL_TIMEOUT_MS);
        this.sessionFailures = 0;
        return output;
      } catch (err) {
        this.sessionFailures++;
        logger.warn("PowerShell session poll failed — falling back to a one-shot call", {
          error: String(err),
          consecutiveFailures: this.sessionFailures,
        });
        if (this.sessionFailures >= MAX_SESSION_FAILURES) {
          logger.warn("Giving up on the persistent PowerShell session — using one-shot calls from now on");
          this.disposeSession();
        }
      }
    }
    return runOneShot(script);
  };

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick(); // don't wait a full interval for the first read
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.previous = null;
    // The monitor only runs while Routines are enabled — leaving a
    // PowerShell process alive after the user turns them off would keep
    // a visible background process around for a feature they just
    // switched off.
    this.disposeSession();
  }

  private disposeSession(): void {
    this.session?.dispose();
    this.session = null;
  }

  /** The most recent poll's raw snapshot, or null before the first poll completes — a debugging aid for "why didn't my trigger fire" (see nimbus:get-activity-snapshot in lifecycle.ts). Never exposes more than what the monitor already reads (process/window names, folder paths). */
  getLastSnapshot(): RawActivitySnapshot | null {
    return this.previous;
  }

  private async tick(): Promise<void> {
    if (this.polling) return; // a slow poll (e.g. COM enumeration hiccup) should never stack up concurrent ticks
    this.polling = true;
    try {
      const current = await this.pollFn(this.runScript);
      const events = diffActivitySnapshot(this.previous, current, this.now());
      this.previous = current;
      for (const event of events) this.eventBus.publish(event);
      try {
        this.onSnapshot?.(current);
      } catch (err) {
        logger.warn("A snapshot listener threw", { error: String(err) });
      }
    } catch (err) {
      logger.warn("Desktop activity monitor tick failed", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }
}
