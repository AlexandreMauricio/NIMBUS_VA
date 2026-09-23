import { app, protocol } from "electron";
import * as path from "path";
import { logger, configureFileLogging } from "../logging/logger";
import { configureLocale } from "../common/locale";
import { startApp } from "./lifecycle";
import { installNavigationGuard } from "./navigationGuard";

/**
 * Entry point for the Windows (Electron) client. Wires up global error
 * handling so the process fails loudly (into the log) instead of dying
 * silently, then starts the application lifecycle.
 *
 * `configureFileLogging` is called here — not inside the logger module
 * itself — because "log to <userData>/logs" is a Windows/Electron detail.
 * A future client supplies its own directory (or skips file logging
 * entirely); Core code (context/, briefing/) never needs to know.
 */
configureFileLogging(() => path.join(app.getPath("userData"), "logs"));

// Without an explicit AppUserModelID, an unpackaged Electron app
// (`electron .` / `npx electron .`) has no real Windows app identity, so
// any native `Notification` Windows shows falls back to a generic/technical
// one (e.g. the Electron process name) instead of "NIMBUS". This fixes that
// for any simple native notification NIMBUS uses; rich, interactive
// suggestions use the NIMBUS-owned popup window instead (see
// src/main/suggestionWindow.ts) since native toasts can't render those well
// regardless of identity.
app.setAppUserModelId("com.nimbus.desktop");

// Covers you choose for books are kept in NIMBUS's own folder and shown
// through this scheme (see coverStore.ts) — never as file:// paths.
// Every window stays on NIMBUS's own pages (see navigationGuard.ts).
installNavigationGuard();

protocol.registerSchemesAsPrivileged([
  { scheme: "nimbus-cover", privileges: { standard: true, secure: true } },
]);

// `app.getLocale()` needs Electron ready; briefing/context generation
// only ever happens after that anyway, so this is always set in time.
app.whenReady().then(() => configureLocale(app.getLocale()));

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: String(err), stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  logger.warn("Another instance of NIMBUS is already running — quitting");
  app.quit();
} else {
  startApp();
}
