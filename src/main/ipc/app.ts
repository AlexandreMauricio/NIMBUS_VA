import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import { APP_FULL_NAME, APP_NAME, APP_VERSION } from "../../common/appInfo";
import { config } from "../../config/config";
import { applyAutostart } from "../autostart";
import { contextService } from "../../context";
import { checkForUpdates, getUpdateState, installUpdate } from "../updater";
import { handle } from "./handle";
import { mergeKnown } from "./mergeKnown";
import type { IpcContext } from "./context";

/** App, window, zoom, updates and the briefing. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerAppIpc(ctx: IpcContext): void {
  handle("nimbus:get-app-info", () => ({
    name: APP_NAME,
    fullName: APP_FULL_NAME,
    version: APP_VERSION,
    environment: config.appEnv,
  }));

  handle("nimbus:get-settings", () => ctx.settings.windowsClient.startup);

  // How large the UI is drawn on this PC. Clamped in Core, and the
  // keyboard shortcuts go through the same one place.
  handle("nimbus:get-zoom", () => ctx.settings.windowsClient.zoomPercent);
  handle("nimbus:set-zoom", (_event, percent: unknown) => ctx.applyZoom(percent));

  handle("nimbus:update-settings", (_event, partial: unknown) => {
    ctx.settings.windowsClient.startup = mergeKnown(ctx.settings.windowsClient.startup, partial);
    saveSettings(ctx.settings);
    // Re-applied whenever it is sent, even unchanged: that is how a moved
    // app folder re-registers its login item.
    if (partial && typeof partial === "object" && "launchWithWindows" in partial) {
      applyAutostart(ctx.settings.windowsClient.startup.launchWithWindows);
    }
    logger.info("Settings updated", ctx.settings.windowsClient.startup);
    return ctx.settings.windowsClient.startup;
  });

  handle("nimbus:hide-window", () => {
    ctx.mainWindow?.hide();
  });

  handle("nimbus:get-context", () => contextService.getSnapshot());

  handle("nimbus:get-update-state", () => getUpdateState());
  handle("nimbus:check-for-updates", () => checkForUpdates());
  handle("nimbus:install-update", () => installUpdate());

  // Pull-only: returns whatever briefing was last generated (or null before
  // the first one completes). Never generates — that's what keeps a UI
  // reload from producing a new briefing every time it asks.
  handle("nimbus:get-briefing", () => ctx.briefingService.getCurrent());

  // Explicit, user-initiated regeneration (e.g. a "Regenerate" button) —
  // distinct from the pull above, and from the one automatic generation
  // that happens at startup.
  handle("nimbus:regenerate-briefing", () => ctx.generateBriefing());
}
