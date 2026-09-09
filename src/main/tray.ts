import { Menu, Tray, nativeImage } from "electron";
import * as path from "path";
import { logger } from "../logging/logger";
import { APP_NAME } from "../common/appInfo";

export interface TrayCallbacks {
  onOpen: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;

/**
 * Creates the system tray icon that keeps NIMBUS reachable while its
 * window is hidden. This is what lets the app "run in the background"
 * rather than disappearing when the window closes.
 */
export function createTray(callbacks: TrayCallbacks): Tray {
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);

  const menu = Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: () => callbacks.onOpen() },
    { type: "separator" },
    { label: `Quit ${APP_NAME}`, click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(menu);

  tray.on("click", () => callbacks.onOpen());

  logger.info("Tray icon created");
  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
