import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../../logging/logger";
import { ContextEventBus } from "../../events/eventBus";
import { diffActivitySnapshot, emptySnapshot, RawActivitySnapshot, KNOWN_BROWSER_EXECUTABLES } from "./activitySnapshot";

const execAsync = promisify(exec);

const DEFAULT_POLL_INTERVAL_MS = 5000;

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
 * page content, keystrokes, or screenshots (see "Privacy" in README's
 * Routines section).
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process | Select-Object -ExpandProperty ProcessName -Unique
$browsers = Get-Process -Name chrome,msedge,firefox,brave,opera -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle } |
  Select-Object ProcessName, MainWindowTitle
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
@{ processes = @($procs); browsers = @($browsers); folders = @($folders) } | ConvertTo-Json -Compress -Depth 4
`.trim();

interface RawPollResult {
  processes?: string | string[];
  browsers?: { ProcessName?: string; MainWindowTitle?: string } | Array<{ ProcessName?: string; MainWindowTitle?: string }>;
  folders?: string | string[];
}

/** PowerShell's ConvertTo-Json collapses a single-item array to a bare scalar — this undoes that so callers can always treat the field as an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function pollRealActivity(): Promise<RawActivitySnapshot> {
  try {
    // -EncodedCommand (Base64 of the UTF-16LE script) rather than -Command
    // with escaped quotes: a multi-line script full of quotes does not
    // survive being re-quoted through cmd.exe (which is what Node's
    // exec() shells out through on Windows) — the command silently
    // produces empty output instead of erroring, which is exactly the
    // kind of failure that must never be allowed to look like "nothing
    // is running." Encoding sidesteps quoting entirely.
    const encodedScript = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedScript}`,
      { timeout: 8000, windowsHide: true }
    );

    const parsed = stdout.trim() ? (JSON.parse(stdout) as RawPollResult) : {};

    const processNames = asArray(parsed.processes)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => `${name.toLowerCase()}.exe`);

    const browserWindows = asArray(parsed.browsers)
      .filter((b) => b && b.ProcessName && b.MainWindowTitle)
      .map((b) => ({ executable: `${b.ProcessName!.toLowerCase()}.exe`, title: b.MainWindowTitle! }))
      .filter((w) => KNOWN_BROWSER_EXECUTABLES.includes(w.executable));

    const explorerFolders = asArray(parsed.folders).filter((p): p is string => typeof p === "string" && p.length > 0);

    return { processNames, browserWindows, explorerFolders };
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

  constructor(
    private readonly eventBus: ContextEventBus,
    private readonly pollFn: () => Promise<RawActivitySnapshot> = pollRealActivity,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private readonly now: () => Date = () => new Date()
  ) {}

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
  }

  /** The most recent poll's raw snapshot, or null before the first poll completes — a debugging aid for "why didn't my trigger fire" (see nimbus:get-activity-snapshot in lifecycle.ts). Never exposes more than what the monitor already reads (process/window names, folder paths). */
  getLastSnapshot(): RawActivitySnapshot | null {
    return this.previous;
  }

  private async tick(): Promise<void> {
    if (this.polling) return; // a slow poll (e.g. COM enumeration hiccup) should never stack up concurrent ticks
    this.polling = true;
    try {
      const current = await this.pollFn();
      const events = diffActivitySnapshot(this.previous, current, this.now());
      this.previous = current;
      for (const event of events) this.eventBus.publish(event);
    } catch (err) {
      logger.warn("Desktop activity monitor tick failed", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }
}
