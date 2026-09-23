import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import { actionService } from "../../actions";
import { validateRoutine } from "../../routines";
import type { Routine } from "../../routines";
import { normalizeReminderMinutes } from "../../attention/signals";
import { knownActivityNames, validateActivityMapping } from "../../activity";
import type { ActivityMapping } from "../../activity";
import { handle } from "./handle";
import { asRecord, boolOr, idArg, numberOr, recordList } from "./input";
import type { IpcContext } from "./context";

/** Routines, activity, suggestions and Attention. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerRoutinesIpc(ctx: IpcContext): void {
  // Routines (src/routines/) — a user-configurable Trigger → Suggestion →
  // Action relationship. Every write is validated the same way action
  // params are: reject before it's ever saved or executed, never trust
  // renderer-supplied configuration blindly.
  handle("nimbus:get-routine-settings", () => ctx.settings.userPreferences.routines);

  handle("nimbus:update-routine-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    let routines = ctx.settings.userPreferences.routines.routines;
    if (partial.routines !== undefined) {
      const knownActionIds = actionService.listActions().map((a) => a.id);
      const incoming = recordList(partial.routines, "Routines");
      for (const routine of incoming) {
        // Validated at run time: the type is what it must turn out to be.
        const result = validateRoutine(routine as unknown as Routine, knownActionIds);
        if (!result.valid) {
          throw new Error(`Invalid routine "${String(routine.name ?? "?")}": ${result.error}`);
        }
      }
      routines = incoming as unknown as Routine[];
    }

    ctx.settings.userPreferences.routines = {
      enabled: boolOr(partial.enabled, ctx.settings.userPreferences.routines.enabled),
      routines,
    };
    saveSettings(ctx.settings);
    ctx.syncActivityMonitor();
    logger.info("Routine settings updated", {
      enabled: ctx.settings.userPreferences.routines.enabled,
      routineCount: ctx.settings.userPreferences.routines.routines.length,
    });
    return ctx.settings.userPreferences.routines;
  });

  // "Test" evaluates and explains; it deliberately runs nothing (see
  // RoutineService.testRoutine). "Run now" is the separate, explicit way
  // to actually execute a routine's actions — what Test used to do.
  handle("nimbus:test-routine", (_event, routineId: unknown) =>
    ctx.routineService.testRoutine(idArg(routineId))
  );
  handle("nimbus:run-routine-now", (_event, routineId: unknown) =>
    ctx.routineService.runRoutineNow(idArg(routineId))
  );
  handle("nimbus:get-routine-history", () => ctx.routineService.getHistory());

  // Activity is read-only over IPC apart from its configuration: the
  // renderer can see what NIMBUS concluded and edit the rules, but
  // cannot assert an activity or end a session by hand.
  handle("nimbus:get-current-activity", () => ctx.activityService.getCurrentActivity());
  handle("nimbus:get-activity-sessions", () => ctx.activityService.getRecentSessions(50));
  // Every activity name in play, so the editor can offer them as a
  // choice instead of asking the user to retype one exactly.
  handle("nimbus:get-known-activities", () =>
    knownActivityNames(ctx.settings.userPreferences.activity.mappings)
  );
  handle("nimbus:get-activity-settings", () => ctx.settings.userPreferences.activity);
  handle("nimbus:update-activity-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    const current = ctx.settings.userPreferences.activity;
    // Same discipline as routines: reject before saving, never trust
    // renderer-supplied configuration blindly.
    let mappings = current.mappings;
    if (partial.mappings !== undefined) {
      const incoming = recordList(partial.mappings, "Activity mappings");
      for (const mapping of incoming) {
        const result = validateActivityMapping(mapping as unknown as ActivityMapping);
        if (!result.valid) {
          throw new Error(`Invalid activity mapping "${String(mapping.activity ?? "?")}": ${result.error}`);
        }
      }
      mappings = incoming as unknown as ActivityMapping[];
    }
    ctx.settings.userPreferences.activity = {
      enabled: boolOr(partial.enabled, current.enabled),
      mappings,
      graceMinutes: numberOr(partial.graceMinutes, current.graceMinutes),
      suggestFrequentApps:
        typeof partial.suggestFrequentApps === "boolean"
          ? partial.suggestFrequentApps
          : current.suggestFrequentApps,
    };
    saveSettings(ctx.settings);
    ctx.syncActivityMonitor();
    logger.info("Activity settings updated", {
      enabled: ctx.settings.userPreferences.activity.enabled,
      mappingCount: ctx.settings.userPreferences.activity.mappings.length,
    });
    return ctx.settings.userPreferences.activity;
  });
  handle("nimbus:get-routine-last-triggered", () => ctx.routineService.getLastTriggeredAt());

  // A debugging aid for "why didn't my trigger fire" — the exact raw
  // process/window/folder data the desktop activity monitor saw on its
  // most recent poll, or null if it isn't running. Same information the
  // monitor already reads for matching; nothing new is exposed.
  handle("nimbus:get-activity-snapshot", () => ctx.activityMonitor?.getLastSnapshot() ?? null);

  handle("nimbus:get-active-suggestions", () => ctx.routineService.getActiveSuggestions());
  // One answer path for every suggestion. Attention's own are informational:
  // answering them only tells Attention not to show them again — nothing
  // runs. Every other suggestion is a routine's, answered by
  // RoutineService exactly as before; Attention is then told it's resolved,
  // so it leaves the popup queue.
  handle("nimbus:accept-suggestion", async (_event, raw: unknown) => {
    const suggestionId = idArg(raw);
    if (ctx.attentionService.acknowledgeSuggestion(suggestionId)) return [];
    const suggestion = ctx.routineService.getActiveSuggestions().find((s) => s.id === suggestionId);
    const results = await ctx.routineService.acceptSuggestion(suggestionId);
    ctx.attentionService.suggestionResolved(suggestionId, "accepted");
    if (suggestion) ctx.rememberRoutineDecision(suggestion, "accepted");
    return results;
  });
  handle("nimbus:dismiss-suggestion", (_event, raw: unknown) => {
    const suggestionId = idArg(raw);
    if (ctx.attentionService.dismissSuggestion(suggestionId)) return;
    const suggestion = ctx.routineService.getActiveSuggestions().find((s) => s.id === suggestionId);
    ctx.routineService.dismissSuggestion(suggestionId);
    ctx.attentionService.suggestionResolved(suggestionId, "dismissed");
    if (suggestion) ctx.rememberRoutineDecision(suggestion, "dismissed");
  });
  // The Attention debug view (Context tab): every current item, its score,
  // decision and why. Read-only.
  handle("nimbus:get-attention", () => ctx.attentionService.getDebugState());
  // Answering a question from the Home feed. Routed through the same
  // onAnswer path as the popup, so "Make it an activity" opens the editor
  // and "Not now" is remembered either way.
  handle("nimbus:answer-attention-item", (_event, itemId: unknown, outcome: unknown) =>
    ctx.attentionService.answerItem(String(itemId ?? ""), outcome === "accepted" ? "accepted" : "dismissed")
  );
  handle("nimbus:update-attention-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    const current = ctx.settings.userPreferences.attention;
    ctx.settings.userPreferences.attention = {
      enabled: typeof partial?.enabled === "boolean" ? partial.enabled : current.enabled,
      popups: typeof partial?.popups === "boolean" ? partial.popups : current.popups,
      reminderMinutes: normalizeReminderMinutes(
        partial?.reminderMinutes !== undefined ? partial.reminderMinutes : current.reminderMinutes
      ),
    };
    saveSettings(ctx.settings);
    logger.info("Attention settings updated", { ...ctx.settings.userPreferences.attention });
    void ctx.attentionService.tick();
    return ctx.settings.userPreferences.attention;
  });
}
