import { app } from "electron";
import { logger } from "../logging/logger";

/**
 * Wraps Electron's native login-item registration so the rest of the app
 * doesn't touch `app.setLoginItemSettings` directly. On Windows this adds
 * or removes a run-at-login entry for the app.
 */
export function applyAutostart(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Launch hidden — NIMBUS decides whether to show its window based on
      // the "start minimized" setting, not on how the OS invoked it.
      args: enabled ? ["--autostart"] : [],
    });
    logger.info("Autostart preference applied", { enabled });
  } catch (err) {
    logger.error("Failed to apply autostart setting", { error: String(err) });
  }
}
