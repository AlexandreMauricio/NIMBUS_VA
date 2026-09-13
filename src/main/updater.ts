import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { logger } from "../logging/logger";

/**
 * In-app updates from the project's GitHub Releases (electron-updater).
 *
 * Only an installed build updates itself: `npm start` runs from source,
 * which is updated with git or a ZIP instead. An installed build checks
 * shortly after starting and every 6 hours, downloads a newer release in
 * the background, and asks before restarting — or installs it the next
 * time NIMBUS quits. Settings and data live in %APPDATA%\nimbus, which
 * the installer never touches, so an update keeps them.
 *
 * Nothing here takes input from the renderer besides "check" and
 * "restart": where updates come from is fixed in package.json
 * (build.publish), and electron-updater verifies the download against
 * the release's latest.yml checksum before installing it.
 */

export type UpdateStatus =
  "unsupported" | "idle" | "checking" | "upToDate" | "downloading" | "ready" | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** The newer version found, if any. */
  version: string | null;
  /** Download progress, 0–100. */
  percent: number | null;
  error: string | null;
  checkedAt: string | null;
}

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 30_000;

let state: UpdateState = {
  status: "unsupported",
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
  error: null,
  checkedAt: null,
};
let timer: NodeJS.Timeout | null = null;

function set(changes: Partial<UpdateState>): void {
  state = { ...state, ...changes };
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:update-state-changed");
}

export function getUpdateState(): UpdateState {
  return { ...state };
}

export function startUpdater(): void {
  if (!app.isPackaged) {
    logger.info("Updates: running from source — update with git or a new ZIP instead");
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () =>
    set({ status: "upToDate", checkedAt: new Date().toISOString(), version: null })
  );
  autoUpdater.on("update-available", (info) => {
    logger.info("Updates: a newer version is downloading", { version: info.version });
    set({ status: "downloading", version: info.version, percent: 0, checkedAt: new Date().toISOString() });
  });
  autoUpdater.on("download-progress", (progress) => set({ percent: Math.round(progress.percent) }));
  autoUpdater.on("update-downloaded", (info) => {
    logger.info("Updates: ready to install", { version: info.version });
    set({ status: "ready", version: info.version, percent: 100 });
  });
  autoUpdater.on("error", (err) => {
    logger.warn("Updates: check failed", { error: String(err).split("\n")[0].slice(0, 200) });
    set({ status: "error", error: friendlyError(err), checkedAt: new Date().toISOString() });
  });
  set({ status: "idle" });
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.status === "unsupported") return getUpdateState();
  if (state.status === "checking" || state.status === "downloading" || state.status === "ready") {
    return getUpdateState();
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ status: "error", error: friendlyError(err), checkedAt: new Date().toISOString() });
  }
  return getUpdateState();
}

/** Restart into the downloaded version. Only once one is ready. */
export function installUpdate(): void {
  if (state.status !== "ready") throw new Error("There's no downloaded update to install yet.");
  logger.info("Updates: restarting to install", { version: state.version });
  if (timer) clearInterval(timer);
  autoUpdater.quitAndInstall(false, true);
}

function friendlyError(err: unknown): string {
  const text = String(err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(text))
    return "Couldn't reach GitHub — check the connection.";
  if (/404|latest\.yml/i.test(text))
    return "No update release found on GitHub — none published yet, or the repository is private.";
  return "The update check failed — see the log for details.";
}
