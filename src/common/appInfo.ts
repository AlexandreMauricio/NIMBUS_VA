import * as fs from "fs";
import * as path from "path";

/**
 * Central branding/identity constants for NIMBUS.
 * Other modules should import from here rather than hard-coding the name/version.
 */
export const APP_NAME = "NIMBUS";
export const APP_FULL_NAME = "Navigation & Intelligent Monitoring Base for User Systems";
/**
 * Read from package.json rather than written here, because it was
 * written here: this said 0.1.0 while package.json said 0.2.0, and the
 * sidebar reported the wrong version for a release and a half. Two
 * places to change a version means one of them is eventually stale, and
 * the one on screen is the one nobody thinks to update.
 *
 * Safe to read at module load: this file is imported only by the main
 * process (and the context provider it runs), never bundled into the
 * renderer, so Node's `fs` is available and package.json sits beside the
 * compiled output's root in both a dev run and a packaged app. Read with fs
 * rather than require(): ESLint forbids require-style imports, and an ES
 * import of a file outside src/ would break tsc's rootDir.
 */
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")
) as { version: string; build?: { appId?: string } };

export const APP_VERSION: string = packageJson.version;

/**
 * Windows' identity for NIMBUS (its AppUserModelID) — the installer's
 * `build.appId`, read from the same file for the same reason as the
 * version. The installer stamps it on the Start-menu and desktop
 * shortcuts; a running app that claims a different one is, to Windows, a
 * different app: its taskbar button doesn't group with a pinned shortcut
 * and its notifications don't carry NIMBUS's name. Never change
 * `build.appId` itself — the installer keys its uninstall entry on it, so
 * an update would install as a second app.
 */
export const APP_ID: string = packageJson.build?.appId ?? "com.alexandremauricio.nimbus";
