import { app } from "electron";
import { logger } from "../logging/logger";

/** Marks a launch as Windows' own rather than the user's. */
export const AUTOSTART_FLAG = "--autostart";

/** What Windows is told to run at login. Pure data, so it can be checked without Electron. */
export interface LoginItemRegistration {
  openAtLogin: boolean;
  /** Which executable to register. Absent for a packaged build — Electron already knows its own. */
  path?: string;
  args: string[];
}

/**
 * Running from source, the executable Windows would launch is Electron
 * itself, and Electron started without an app path shows its own welcome
 * window instead of NIMBUS. A login item registered with no app path
 * therefore greets the user with "To run a local app, execute the
 * following on the command line" every morning — so an unpackaged install
 * registers `electron.exe` **and** the app directory it should open.
 *
 * A packaged build needs neither: its own .exe is the app.
 *
 * The path is passed raw: Electron builds the registry command line and
 * quotes what needs quoting. Quoting it here put the quote characters
 * *inside* the argument, and Electron then resolved that against its
 * working directory (C:\WINDOWS\system32) instead of opening the app.
 */
export function loginItemRegistration(
  enabled: boolean,
  context: { packaged: boolean; execPath: string; appPath: string }
): LoginItemRegistration {
  if (context.packaged) {
    return { openAtLogin: enabled, args: enabled ? [AUTOSTART_FLAG] : [] };
  }
  return {
    openAtLogin: enabled,
    path: context.execPath,
    args: enabled ? [context.appPath, AUTOSTART_FLAG] : [],
  };
}

/**
 * Wraps Electron's native login-item registration so the rest of the app
 * doesn't touch `app.setLoginItemSettings` directly. On Windows this adds
 * or removes a run-at-login entry for the app.
 *
 * NIMBUS decides whether to show its window from the "start minimized"
 * setting, not from how the OS invoked it.
 */
export function applyAutostart(enabled: boolean): void {
  try {
    const registration = loginItemRegistration(enabled, {
      packaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    });
    app.setLoginItemSettings(registration);
    logger.info("Autostart preference applied", { enabled, packaged: app.isPackaged });
  } catch (err) {
    logger.error("Failed to apply autostart setting", { error: String(err) });
  }
}
