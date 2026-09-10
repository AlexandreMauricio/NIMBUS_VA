import { BrowserWindow, screen } from "electron";
import * as path from "path";
import { logger } from "../logging/logger";

const WINDOW_WIDTH = 220;
// Sized to the card's tallest state — the one that also shows a status
// line ("Paused"/"Complete"). At 190 the content was 217px tall and
// `overflow: hidden` simply clipped it: the progress bar got flex-shrunk
// to nothing and the buttons ended up jammed against the bottom edge.
// Measured: the tallest state renders 255px (including the "+ Study"
// row), so this leaves a little slack.
const WINDOW_HEIGHT = 258;
const MARGIN = 16;

let timerWindow: BrowserWindow | null = null;

/**
 * The small, NIMBUS-owned floating timer window — separate from both the
 * main window and the suggestion popup (src/main/suggestionWindow.ts),
 * since it needs to stay visible and interactive for the timer's entire
 * duration rather than auto-dismissing. Its renderer polls
 * `nimbus:get-timer-state` itself (see timerRenderer.ts) rather than
 * being pushed updates every tick, keeping this window manager as simple
 * as the suggestion one.
 */
function targetPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  return { x: x + width - WINDOW_WIDTH - MARGIN, y: y + MARGIN }; // top-right, out of the way of the suggestion popup's bottom-right spot
}

export function showTimerWindow(): void {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.showInactive();
    return;
  }

  const { x, y } = targetPosition();
  timerWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    resizable: false,
    // Draggable via the card's own -webkit-app-region: drag (see
    // timer.html) — `movable: false` would silently disable that CSS
    // drag region entirely, pinning the window to one spot with no way
    // to move it out of the way of whatever it's covering.
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#16141f",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "timerPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  timerWindow.setAlwaysOnTop(true, "screen-saver");
  timerWindow.loadFile(path.join(__dirname, "..", "ui", "timer.html"));
  timerWindow.once("ready-to-show", () => timerWindow?.showInactive());
  timerWindow.on("closed", () => {
    timerWindow = null;
  });
  timerWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logger.debug("[timer popup console]", { level, message, line, sourceId });
  });
  timerWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error("[timer popup] render process gone", { details });
  });

  logger.debug("Timer window shown");
}

export function closeTimerWindow(): void {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.close();
  }
}

export function isTimerWindowOpen(): boolean {
  return !!timerWindow && !timerWindow.isDestroyed();
}
