import { actionService } from "../../actions";
import { closeSuggestionPopup, getCurrentPopupSuggestion } from "../suggestionWindow";
import { closeTimerWindow } from "../timerWindow";
import { handle } from "./handle";
import { idArg } from "./input";
import type { IpcContext } from "./context";

/** The suggestion and timer popups' own channels. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerPopupsIpc(ctx: IpcContext): void {
  // The suggestion popup window's own small surface (src/main/suggestionWindow.ts,
  // src/preload/suggestionPreload.ts) — reuses the accept/dismiss handlers
  // above, just adds a way for that window to read what it should show
  // and to close itself.
  handle("nimbus:get-popup-suggestion", () => getCurrentPopupSuggestion());
  handle("nimbus:close-suggestion-popup", () => {
    closeSuggestionPopup();
    // Whatever was waiting for the popup may be shown now.
    ctx.attentionService?.popupClosed();
  });

  // The timer popup window's surface (src/main/timerWindow.ts,
  // src/timers/). A generic timer engine — nothing here is Spotify- or
  // Routine-specific.
  handle("nimbus:get-timer-state", () => ctx.timerService.getState());
  handle("nimbus:pause-timer", (_event, timerId: unknown) => ctx.timerService.pause(idArg(timerId)));
  handle("nimbus:resume-timer", (_event, timerId: unknown) => ctx.timerService.resume(idArg(timerId)));
  handle("nimbus:cancel-timer", (_event, timerId: unknown) => ctx.timerService.cancel(idArg(timerId)));
  // Extends the running Pomodoro through the normal Action path, so it
  // gets the same validation and result handling as any other action.
  handle("nimbus:timer-add-study", async () => {
    const result = await actionService.executeAction("timer.addStudy", {});
    ctx.onActionExecuted("timer.addStudy", result);
    return { status: result.status, message: result.message ?? result.error?.message };
  });
  handle("nimbus:close-timer-window", () => closeTimerWindow());
}
