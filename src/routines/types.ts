/**
 * Generic Routine data model — a user-configurable relationship between a
 * Trigger, a Suggestion, and one or more Actions. Deliberately has no
 * Spotify-specific (or any other service-specific) fields anywhere:
 * Spotify is just one possible Action Provider a Routine's `actions` can
 * reference by id, exactly like a future "open application" or "set
 * volume" provider would be. See ARCHITECTURE.md's "Context Event →
 * Trigger → Routine → Suggestion → Action" section for how this fits the
 * rest of NIMBUS.
 */

export type StringMatchMode = "exact" | "contains";

export interface ApplicationTriggerConfig {
  type: "applicationOpened";
  /** Executable name to match against, e.g. "steam.exe" — matched case-insensitively. */
  application: string;
  matchMode: StringMatchMode;
}

export interface WebsiteTriggerConfig {
  type: "websiteOpened";
  /** What to match `pattern` against. "domain"/"url" are only ever populated by a producer that can actually determine them (none yet — see events/types.ts); "windowTitle" is what today's heuristic detector supports. */
  matchField: "domain" | "url" | "windowTitle";
  pattern: string;
  matchMode: StringMatchMode;
}

export interface FolderTriggerConfig {
  type: "folderOpened";
  path: string;
  matchMode: StringMatchMode;
}

/**
 * Matches a TimerCompletedEvent (see events/types.ts and src/timers/).
 * `timerType`, when set, restricts the match to that timer type (e.g.
 * only "focus" timers) — omitted/empty matches any completed timer. No
 * routine ships using this yet (see the task's own "just establish the
 * architecture" scope for TimerCompleted), but the trigger/matcher side
 * is complete so a future "take a break?" routine needs no shape change.
 */
export interface TimerCompletedTriggerConfig {
  type: "timerCompleted";
  timerType: string;
}

export type TriggerConfig =
  ApplicationTriggerConfig | WebsiteTriggerConfig | FolderTriggerConfig | TimerCompletedTriggerConfig;

/** A time-of-day window, in the user's local time. `startHour`/`endHour` are 0-23; a range that wraps past midnight (e.g. 22-6) is supported. */
export interface TimeOfDayCondition {
  type: "timeOfDay";
  startHour: number;
  endHour: number;
}

/** Only Monday-Friday, in local time. */
export interface WeekdaysOnlyCondition {
  type: "weekdaysOnly";
}

/** Only when Spotify isn't already actively playing something — avoids interrupting music the user already started themselves. */
export interface SpotifyNotAlreadyPlayingCondition {
  type: "spotifyNotAlreadyPlaying";
}

/**
 * Only when the routine's own configured actions don't already appear to
 * be in effect — e.g. a routine that plays a specific playlist and
 * starts a timer won't re-suggest itself while that exact playlist is
 * already playing and a timer is already running. Distinct from
 * `spotifyNotAlreadyPlaying` (which blocks on *any* playback): this
 * checks specifically whether *this routine's* actions look already
 * done, so a routine can still suggest itself while a *different*
 * playlist happens to be playing.
 */
export interface ActionsNotAlreadyActiveCondition {
  type: "actionsNotAlreadyActive";
}

/**
 * Extension point for future conditions (headphones connected, PC idle,
 * not in a meeting, etc. — see the task's own examples). Only the four
 * above are implemented; adding another means one more variant here plus
 * one more case in conditionEvaluator.ts — nothing else changes.
 */
export type RoutineCondition =
  | TimeOfDayCondition
  | WeekdaysOnlyCondition
  | SpotifyNotAlreadyPlayingCondition
  | ActionsNotAlreadyActiveCondition;

/** One step of a Routine's action sequence — executed in array order through the existing Action system (src/actions/), never anything else. */
export interface RoutineActionStep {
  /** Must match a currently-registered ActionDefinition id, e.g. "spotify.playPlaylist". */
  actionId: string;
  params: Record<string, unknown>;
}

export interface RoutineSuggestionConfig {
  title: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerConfig;
  conditions: RoutineCondition[];
  suggestion: RoutineSuggestionConfig;
  actions: RoutineActionStep[];
  /** Minutes to wait before this routine can suggest again after it last did — prevents suggestion spam from a trigger firing repeatedly (e.g. re-focusing the same window). */
  cooldownMinutes: number;
  /**
   * When true, a matching trigger runs this routine's actions
   * immediately — no Suggestion, no popup, nothing for the user to
   * accept/dismiss. Meant only for low-friction, clearly-reversible
   * actions the user has explicitly opted into skipping confirmation
   * for (e.g. "open a game's wiki page whenever the game itself opens")
   * — this is the one deliberate exception to "a trigger never executes
   * an action by itself" elsewhere in this system, scoped per-routine
   * and opt-in, never the default. Cooldown and conditions still apply
   * exactly as they do for a normal suggestion. Defaults to `false`
   * (via `routine.autoRun ?? false`) for routines saved before this
   * field existed.
   */
  autoRun?: boolean;
}

export const DEFAULT_ROUTINE_COOLDOWN_MINUTES = 30;
export const DEFAULT_SUGGESTION_TTL_MS = 60_000;

export interface RoutineValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a Routine's shape before it's saved or executed — the same
 * "never trust configuration blindly" discipline ActionProvider.validate
 * applies to action params. `knownActionIds` is passed in (rather than
 * imported) so this stays a pure function usable from both Core (tests)
 * and the settings-update IPC handler without a circular dependency on
 * ActionService.
 */
export function validateRoutine(routine: Routine, knownActionIds: string[]): RoutineValidationResult {
  if (!routine.id || typeof routine.id !== "string") {
    return { valid: false, error: "Routine id is required." };
  }
  if (!routine.name || typeof routine.name !== "string" || routine.name.trim().length === 0) {
    return { valid: false, error: "Routine name is required." };
  }
  if (typeof routine.enabled !== "boolean") {
    return { valid: false, error: "Routine enabled must be a boolean." };
  }

  const triggerError = validateTrigger(routine.trigger);
  if (triggerError) return { valid: false, error: triggerError };

  if (!Array.isArray(routine.actions) || routine.actions.length === 0) {
    return { valid: false, error: "A routine needs at least one action." };
  }
  for (const step of routine.actions) {
    if (!step || typeof step.actionId !== "string" || step.actionId.trim().length === 0) {
      return { valid: false, error: "Each action step needs an actionId." };
    }
    if (!knownActionIds.includes(step.actionId)) {
      return { valid: false, error: `Unknown action "${step.actionId}".` };
    }
    if (
      step.params !== undefined &&
      (typeof step.params !== "object" || step.params === null || Array.isArray(step.params))
    ) {
      return { valid: false, error: `Action "${step.actionId}" params must be a plain object.` };
    }
  }

  if (
    !routine.suggestion ||
    typeof routine.suggestion.title !== "string" ||
    routine.suggestion.title.trim().length === 0 ||
    typeof routine.suggestion.message !== "string" ||
    routine.suggestion.message.trim().length === 0
  ) {
    return { valid: false, error: "Routine suggestion needs a title and message." };
  }

  if (
    typeof routine.cooldownMinutes !== "number" ||
    !Number.isFinite(routine.cooldownMinutes) ||
    routine.cooldownMinutes < 0
  ) {
    return { valid: false, error: "cooldownMinutes must be a non-negative number." };
  }

  if (routine.autoRun !== undefined && typeof routine.autoRun !== "boolean") {
    return { valid: false, error: "autoRun must be a boolean." };
  }

  if (!Array.isArray(routine.conditions)) {
    return { valid: false, error: "conditions must be an array." };
  }
  for (const condition of routine.conditions) {
    const conditionError = validateCondition(condition);
    if (conditionError) return { valid: false, error: conditionError };
  }

  return { valid: true };
}

function validateTrigger(trigger: TriggerConfig): string | null {
  if (!trigger || typeof trigger !== "object") return "Routine trigger is required.";

  switch (trigger.type) {
    case "applicationOpened":
      if (!trigger.application || typeof trigger.application !== "string") {
        return "Application trigger needs an application name.";
      }
      return validateMatchMode(trigger.matchMode);
    case "websiteOpened":
      if (!trigger.pattern || typeof trigger.pattern !== "string") {
        return "Website trigger needs a pattern.";
      }
      if (!["domain", "url", "windowTitle"].includes(trigger.matchField)) {
        return "Website trigger matchField must be domain, url, or windowTitle.";
      }
      return validateMatchMode(trigger.matchMode);
    case "folderOpened":
      if (!trigger.path || typeof trigger.path !== "string") {
        return "Folder trigger needs a path.";
      }
      return validateMatchMode(trigger.matchMode);
    case "timerCompleted":
      if (typeof trigger.timerType !== "string") {
        return "Timer-completed trigger needs a timerType (may be empty for any type).";
      }
      return null;
    default:
      return `Unknown trigger type "${(trigger as { type?: string }).type}".`;
  }
}

function validateMatchMode(matchMode: unknown): string | null {
  if (matchMode !== "exact" && matchMode !== "contains") {
    return "matchMode must be exact or contains.";
  }
  return null;
}

function validateCondition(condition: RoutineCondition): string | null {
  if (!condition || typeof condition !== "object") return "Invalid condition.";
  switch (condition.type) {
    case "timeOfDay":
      if (
        !Number.isInteger(condition.startHour) ||
        condition.startHour < 0 ||
        condition.startHour > 23 ||
        !Number.isInteger(condition.endHour) ||
        condition.endHour < 0 ||
        condition.endHour > 23
      ) {
        return "timeOfDay condition needs startHour/endHour between 0 and 23.";
      }
      return null;
    case "weekdaysOnly":
    case "spotifyNotAlreadyPlaying":
    case "actionsNotAlreadyActive":
      return null;
    default:
      return `Unknown condition type "${(condition as { type?: string }).type}".`;
  }
}
