import { app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as path from "path";
import { pathToFileURL } from "url";
import { logger } from "../logging/logger";

/**
 * Keeps every NIMBUS window on NIMBUS's own pages.
 *
 * A window's preload bridge belongs to the window, not to the page in it:
 * if the main window navigated elsewhere, that page would get
 * `window.nimbus` — every IPC channel, actions included — without the
 * app's Content Security Policy. Electron navigates by default when a file
 * or link is dropped onto a window, so nothing here is hypothetical.
 *
 * Windows load their pages with `loadFile`, which is not a navigation
 * these events see; nothing NIMBUS draws navigates or opens windows on
 * its own (links out go through the main process and the system browser).
 */
export function installNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      logger.warn("Blocked a window navigating away from NIMBUS", { url: String(url).slice(0, 200) });
    });
    contents.setWindowOpenHandler(({ url }) => {
      logger.warn("Blocked a page opening a window", { url: String(url).slice(0, 200) });
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** file:///…/dist/ui/ — where every NIMBUS page lives, in a dev run and inside app.asar alike. */
const UI_ROOT = (pathToFileURL(path.join(__dirname, "..", "ui")).href + "/").toLowerCase();

/**
 * Whether an IPC call came from one of NIMBUS's own pages. The second
 * line of defence behind the guard above: a frame that somehow isn't
 * NIMBUS's page gets no answer from any handler. Compared without case,
 * as Windows paths are.
 */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  return typeof url === "string" && url.toLowerCase().startsWith(UI_ROOT);
}
