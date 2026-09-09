import { randomUUID } from "crypto";
import { ContextEvent } from "../../events/types";

/**
 * The raw desktop state one poll observes — process names (for
 * APPLICATION_OPENED), known-browser window titles (the heuristic
 * substitute for WEBSITE_OPENED — see module doc below), and open
 * Explorer folder paths (for FOLDER_OPENED). Deliberately minimal: no
 * page content, no keystrokes, no screenshots — see "Privacy" in
 * docs/routines.md.
 */
export interface RawActivitySnapshot {
  /** Lowercased running executable names, e.g. "steam.exe". */
  processNames: string[];
  /** Only for recognized browser executables (see KNOWN_BROWSER_EXECUTABLES) that currently have a window title. */
  browserWindows: Array<{ executable: string; title: string }>;
  /** Currently-open Windows Explorer folder paths. */
  explorerFolders: string[];
}

export const KNOWN_BROWSER_EXECUTABLES = [
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
];

export function emptySnapshot(): RawActivitySnapshot {
  return { processNames: [], browserWindows: [], explorerFolders: [] };
}

/**
 * Turns the difference between two consecutive polls into Context Events
 * — this is what keeps a process that's simply still running (or a
 * browser tab that hasn't changed) from generating a fresh event on
 * every single poll tick (see the task's "prevent duplicate triggers"
 * requirement). Pure and side-effect-free, so it's fully testable
 * without spawning a real process poller.
 *
 * - A process name appearing that wasn't in `previous` → one
 *   `applicationOpened` event, `activation: "launched"`. NIMBUS has no
 *   reliable, dependency-free way to distinguish "brought to the
 *   foreground" from "still running in the background" without a native
 *   foreground-window API, so `"activated"` is never emitted today — the
 *   event shape already supports it for when a more precise detector is
 *   added (see events/types.ts).
 * - A recognized browser's window title appearing or *changing* from
 *   what it was last poll → one `websiteOpened` event. An unchanged
 *   title never re-fires.
 * - An Explorer folder path appearing that wasn't open last poll → one
 *   `folderOpened` event.
 *
 * `previous === null` means this is the very first poll since the
 * monitor started (or restarted). For **processes and folders** this
 * establishes the baseline only and deliberately produces no events —
 * without that, every already-running background process (there are
 * routinely 80-100+ on a real machine) and every already-open Explorer
 * window would fire as "just launched/opened" the moment a user turns
 * Routines on, which is both wrong and exactly the spam the task calls
 * out to avoid.
 *
 * **Browser windows are the deliberate exception.** There are only ever
 * a handful open at once (not dozens), and — critically — the most
 * common real workflow is "I already have the site open, *then* I set
 * up a routine for it," e.g. a user browsing SkillCert who switches to
 * NIMBUS to configure a Study routine without ever leaving the tab. If
 * browser titles were baseline-suppressed like everything else, that
 * routine would silently never fire until the user happened to navigate
 * away and back — indistinguishable from "broken." So the very first
 * poll's browser window titles are compared against an empty baseline
 * (i.e. every currently-titled browser window is eligible to match)
 * while processes/folders still get the quiet, event-free baseline poll.
 */
export function diffActivitySnapshot(
  previous: RawActivitySnapshot | null,
  current: RawActivitySnapshot,
  now: Date
): ContextEvent[] {
  const events: ContextEvent[] = [];
  const occurredAt = now.toISOString();

  if (previous !== null) {
    const previousProcesses = new Set(previous.processNames);
    for (const name of current.processNames) {
      if (!previousProcesses.has(name)) {
        events.push({
          id: randomUUID(),
          type: "applicationOpened",
          occurredAt,
          source: "desktopActivityMonitor",
          executableName: name,
          windowTitle: null,
          activation: "launched",
        });
      }
    }
  }

  // Intentionally NOT gated on `previous !== null` — see doc comment above.
  const previousBrowserTitles = new Map((previous?.browserWindows ?? []).map((w) => [w.executable, w.title]));
  for (const window of current.browserWindows) {
    if (!window.title) continue;
    if (previousBrowserTitles.get(window.executable) === window.title) continue;
    events.push({
      id: randomUUID(),
      type: "websiteOpened",
      occurredAt,
      source: "desktopActivityMonitor",
      browserExecutable: window.executable,
      windowTitle: window.title,
      url: null,
      domain: null,
    });
  }

  if (previous !== null) {
    const previousFolders = new Set(previous.explorerFolders);
    for (const path of current.explorerFolders) {
      if (!previousFolders.has(path)) {
        events.push({
          id: randomUUID(),
          type: "folderOpened",
          occurredAt,
          source: "desktopActivityMonitor",
          path,
        });
      }
    }
  }

  return events;
}
