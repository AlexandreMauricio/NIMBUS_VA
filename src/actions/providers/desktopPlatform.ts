import * as path from "path";

/**
 * What the desktop action providers need from the operating system.
 *
 * Core, and deliberately narrow: each member is one fixed operation with
 * typed arguments. There is no "run this command" member and nothing here
 * accepts a command line, so no provider built on it can become a way to
 * execute arbitrary code. The Windows implementation lives at the device
 * edge (src/main/desktop/windowsDesktop.ts); tests supply a fake.
 */

export type WindowCommand = "focus" | "minimize" | "maximize" | "close";
export type MediaKey = "playPause" | "next" | "previous";

export interface PathInfo {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DesktopPlatform {
  /** What is at `path` — checked before anything is opened or launched. */
  pathInfo(path: string): Promise<PathInfo>;
  /** Opens a file with its default application, or a folder in the file manager. */
  openPath(path: string): Promise<void>;
  /** Starts an application from an .exe (no arguments, no shell) or a .lnk shortcut. */
  launchApplication(path: string): Promise<void>;
  /**
   * Applies a window command to the named process's open main window(s).
   * Resolves with how many windows it found — 0 means the app has none open.
   */
  windowCommand(processName: string, command: WindowCommand): Promise<{ windows: number }>;
  /** Presses a media key, which Windows routes to whatever app is playing. */
  sendMediaKey(key: MediaKey): Promise<void>;
  /** Sets the default output device's master volume, 0–100. */
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  lockScreen(): Promise<void>;
}

/** What an application launch accepts: an executable, or a shortcut to one. */
export const APPLICATION_EXTENSIONS = [".exe", ".lnk"];

/**
 * Extensions files.openFile refuses to open.
 *
 * Opening a file hands it to its default handler, and for these that
 * handler *runs* it — an executable, a script, an installer, a shortcut to
 * either. files.openFile is for documents, images and the like; starting a
 * program is app.launch's job, where it is named as such. A denylist can
 * never be exhaustive, so this errs broad.
 */
export const BLOCKED_OPEN_EXTENSIONS = new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".psd1",
  ".ps1xml",
  ".vbs",
  ".vbe",
  ".vb",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".ws",
  ".msi",
  ".msp",
  ".mst",
  ".scr",
  ".pif",
  ".hta",
  ".cpl",
  ".msc",
  ".jar",
  ".lnk",
  ".url",
  ".appref-ms",
  ".application",
  ".reg",
  ".inf",
  ".scf",
  ".sct",
  ".chm",
  ".gadget",
  ".dll",
  ".sys",
  // Packaged apps and their installers
  ".appx",
  ".appxbundle",
  ".msix",
  ".msixbundle",
  ".appinstaller",
  // Files whose handler runs or mounts something
  ".settingcontent-ms",
  ".diagcab",
  ".library-ms",
  ".search-ms",
  ".psc1",
  ".wsc",
  ".xll",
  ".jnlp",
  ".iso",
  ".img",
  ".vhd",
  ".vhdx",
]);

/**
 * A validation error for `value` as a full local Windows path, or null when
 * it is one. Relative paths are refused so nothing depends on NIMBUS's own
 * working directory, and characters Windows forbids in a path — or a colon
 * beyond the drive's, which would address an alternate data stream — are
 * refused outright rather than passed along to see what happens.
 */
export function absolutePathError(value: unknown, what: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return `${what} is required.`;
  const p = value.trim();
  if (/["<>|*?]/.test(p) || [...p].some((c) => c.charCodeAt(0) < 32))
    return `${what} contains characters a Windows path can't have.`;
  if (!/^[A-Za-z]:[\\/]/.test(p))
    return `${what} must be a full path starting with a drive letter, e.g. C:\\...`;
  if (p.indexOf(":", 2) !== -1) return `${what} can't contain a colon after the drive letter.`;
  // Windows drops trailing dots and spaces from a name, so "setup.exe."
  // opens setup.exe while its extension reads as "." — refused, so the
  // extension checked is the one Windows will use.
  if (/[. ]$/.test(p.replace(/[\\/]+$/, ""))) return `${what} can't end with a dot or a space.`;
  return null;
}

export function extensionOf(p: string): string {
  return path.win32.extname(p.trim()).toLowerCase();
}

export function fileNameOf(p: string): string {
  return path.win32.basename(p.trim());
}

/**
 * A process name as Windows reports it ("discord", "chrome"), or null when
 * `value` isn't one. A trailing ".exe" is accepted and dropped, since that
 * is how people naturally write it. Only letters, digits, spaces, dots,
 * underscores and hyphens are allowed — in particular no wildcards, which
 * would let one name address many processes.
 */
export function normalizeProcessName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = value.trim();
  if (name.toLowerCase().endsWith(".exe")) name = name.slice(0, -4).trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name) ? name : null;
}
