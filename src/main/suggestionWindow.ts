import { BrowserWindow, screen } from "electron";
import * as path from "path";
import { AssistantSuggestion } from "../common/assistantEvents";
import { logger } from "../logging/logger";

const WINDOW_WIDTH = 340;
const WINDOW_HEIGHT = 220;
const MARGIN = 16;

let popupWindow: BrowserWindow | null = null;
let currentSuggestion: AssistantSuggestion | null = null;

/**
 * The single NIMBUS-owned popup used for every Routine suggestion —
 * replaces both the native Windows `Notification` and the old in-window
 * toast that previously duplicated it. One implementation, reused for
 * every kind of suggestion (application-triggered, website-triggered,
 * and future timer/calendar/email ones): none of this file knows what
 * *kind* of routine produced the suggestion it's showing.
 *
 * A native OS `Notification` was tried first and rejected — see
 * ARCHITECTURE.md's "Suggestion popup" section for why an unpackaged
 * Electron app's notifications show a generic/technical identity
 * (`app.setAppUserModelId` in main.ts is the actual fix for that, kept
 * regardless for any future simple background notification) and why a
 * self-owned window is the more reliable way to show rich, branded
 * content (artwork-free playlist/timer summaries, two real buttons)
 * that native toast notifications aren't well suited for cross-platform.
 */
function targetPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  return { x: x + width - WINDOW_WIDTH - MARGIN, y: y + height - WINDOW_HEIGHT - MARGIN };
}

function createWindow(): BrowserWindow {
  const { x, y } = targetPosition();
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    resizable: false,
    // Draggable via the card's own -webkit-app-region: drag (see
    // suggestion.html) — `movable: false` would silently disable that
    // CSS drag region, pinning the window in place with no way to move
    // it out of the way of whatever it's covering.
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Never becomes the active typing target and never steals focus from
    // whatever the user was doing — see showInactive() below, which is
    // what actually avoids activating it even though it's focusable
    // enough for its own buttons to receive clicks.
    focusable: true,
    show: false,
    backgroundColor: "#16141f",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "suggestionPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "..", "ui", "suggestion.html"));
  win.on("closed", () => {
    popupWindow = null;
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logger.debug("[suggestion popup console]", { level, message, line, sourceId });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error("[suggestion popup] render process gone", { details });
  });
  return win;
}

export function showSuggestionPopup(suggestion: AssistantSuggestion): void {
  currentSuggestion = suggestion;

  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindow = createWindow();
    popupWindow.once("ready-to-show", () => {
      popupWindow?.showInactive(); // shows without activating/stealing focus
    });
  } else {
    const { x, y } = targetPosition(); // re-derive in case the primary display changed
    popupWindow.setPosition(x, y);
    popupWindow.webContents.send("nimbus:popup-suggestion-updated", suggestion);
    popupWindow.showInactive();
  }

  // Info, not debug: the one place that proves a popup window was actually
  // put on screen, as opposed to only decided on.
  logger.info("Suggestion popup window shown", {
    suggestionId: suggestion.id,
    origin: suggestion.origin ?? "routine",
    routineId: suggestion.routineId,
  });
}

export function getCurrentPopupSuggestion(): AssistantSuggestion | null {
  return currentSuggestion;
}

export function closeSuggestionPopup(): void {
  currentSuggestion = null;
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
}
