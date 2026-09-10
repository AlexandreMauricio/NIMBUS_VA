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

/**
 * Fires when a recognized activity finishes (see src/activity/).
 * `activity`, when set, restricts it to that one; empty matches any
 * activity ending. `minMinutes` ignores blips — a session shorter than
 * it never fires the routine, so "when I finish studying" doesn't fire
 * because a tab was open for ninety seconds.
 */
export interface ActivityEndedTriggerConfig {
  type: "activityEnded";
  activity: string;
  minMinutes?: number;
}

export type TriggerConfig =
  | ApplicationTriggerConfig
  | WebsiteTriggerConfig
  | FolderTriggerConfig
  | TimerCompletedTriggerConfig
  | ActivityEndedTriggerConfig;

/**
 * A time-of-day window, in the user's local time. `startHour`/`endHour`
 * are 0-23 and a range that wraps past midnight (e.g. 22-6) is supported.
 *
 * `startMinute`/`endMinute` are optional and default to 0, which is what
 * keeps every routine saved before they existed behaving identically —
 * an 18-23 window still means 18:00-23:00. With them, the same condition
 * expresses 18:30-23:15.
 */
export interface TimeOfDayCondition {
  type: "timeOfDay";
  startHour: number;
  endHour: number;
  startMinute?: number;
  endMinute?: number;
}

/**
 * Only Monday-Friday, in local time. Kept as its own type rather than
 * being rewritten into `daysOfWeek` on load: routines saved with it must
 * keep working untouched, and "weekdays" is the common case stated
 * plainly. It is exactly equivalent to daysOfWeek [1,2,3,4,5].
 */
export interface WeekdaysOnlyCondition {
  type: "weekdaysOnly";
}

/**
 * Only on the listed days, in local time — 0 is Sunday through 6 is
 * Saturday, matching `Date.getDay()`. Covers what `weekdaysOnly` cannot:
 * weekends only, or a single day.
 */
export interface DaysOfWeekCondition {
  type: "daysOfWeek";
  days: number[];
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
/**
 * Only while the user appears to be doing a particular thing — the
 * activity name as configured in an Activity mapping (see
 * src/activity/). Matched case-insensitively so "Study" and "study" are
 * the same activity rather than two.
 */
export interface ActivityIsCondition {
  type: "activityIs";
  activity: string;
}

/**
 * Only once the current activity has been going for at least
 * `minMinutes` — the "you have been at this for 90 minutes, take a
 * break?" shape. Fails when there is no activity at all: a routine that
 * asks about duration has nothing to say when nothing is happening.
 */
export interface ActivityDurationCondition {
  type: "activityDuration";
  minMinutes: number;
}

export type RoutineCondition =
  | TimeOfDayCondition
  | WeekdaysOnlyCondition
  | DaysOfWeekCondition
  | SpotifyNotAlreadyPlayingCondition
  | ActionsNotAlreadyActiveCondition
  | ActivityIsCondition
  | ActivityDurationCondition;

/**
 * How a routine's conditions combine. "all" (the default, and what every
 * routine saved before this field existed did) requires every condition;
 * "any" requires at least one.
 *
 * A flat list plus one operator rather than a nested boolean tree: it
 * covers the cases actually asked for, stays representable in a simple
 * editor, and — being structured data rather than an expression — leaves
 * room to grow into groups later without invalidating what is saved
 * today.
 */
export type ConditionLogic = "all" | "any";

/**
 * How often a routine may fire within one "session" of whatever
 * triggered it.
 *
 * "oncePerSession" exists for the case where a trigger legitimately
 * re-fires for something the user is already doing — returning to an app
 * that is still open, or a browser re-reporting the same page. The
 * session key is derived from the event itself (see
 * RoutineService.sessionKeyFor), so it is the *thing* that has a session,
 * not NIMBUS: a different app, page or folder is a different session.
 */
export type SessionRestriction = "none" | "oncePerSession";

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
  /** Free-text note for the user's own benefit. Never shown in a suggestion; purely to make a list of routines readable. Optional — routines saved before it existed simply have none. */
  description?: string;
  /** Defaults to "all" when absent, which is exactly how every routine saved before this field existed already behaved. */
  conditionLogic?: ConditionLogic;
  /** Defaults to "none" when absent — again, the pre-existing behaviour. */
  sessionRestriction?: SessionRestriction;
  /**
   * What this routine's trigger MEANS the user is doing, if anything.
   *
   * Setting it makes the routine's own trigger double as an activity
   * mapping, so an app or website is configured once rather than twice
   * (see src/activity/routineMappings.ts). Absent means the routine says
   * nothing about activity — the pre-existing behaviour, and still the
   * case for every routine saved before this field existed.
   *
   * It does not change what the routine DOES. Activity is context;
   * whether this routine suggests anything is still decided by its
   * trigger, conditions and cooldown exactly as before.
   */
  activity?: RoutineActivityConfig;
}

export interface RoutineActivityConfig {
  /** The activity name, e.g. "Study". Free text, matched case-insensitively by activity conditions. */
  name: string;
  /** Optional emoji for the UI. */
  icon?: string;
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

  if (routine.activity !== undefined) {
    if (
      typeof routine.activity !== "object" ||
      routine.activity === null ||
      typeof routine.activity.name !== "string" ||
      routine.activity.name.trim().length === 0
    ) {
      return { valid: false, error: "A routine's activity needs a name." };
    }
    if (routine.activity.icon !== undefined && typeof routine.activity.icon !== "string") {
      return { valid: false, error: "A routine's activity icon must be a string." };
    }
    if (routine.trigger?.type === "timerCompleted") {
      return {
        valid: false,
        error:
          "A timer-completed trigger is a moment, not something you spend time doing — it can't define an activity.",
      };
    }
  }

  if (routine.description !== undefined && typeof routine.description !== "string") {
    return { valid: false, error: "description must be a string." };
  }

  if (
    routine.conditionLogic !== undefined &&
    routine.conditionLogic !== "all" &&
    routine.conditionLogic !== "any"
  ) {
    return { valid: false, error: 'conditionLogic must be "all" or "any".' };
  }

  if (
    routine.sessionRestriction !== undefined &&
    routine.sessionRestriction !== "none" &&
    routine.sessionRestriction !== "oncePerSession"
  ) {
    return { valid: false, error: 'sessionRestriction must be "none" or "oncePerSession".' };
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
    case "activityEnded":
      if (typeof trigger.activity !== "string") {
        return "Activity-ended trigger needs an activity name (may be empty for any activity).";
      }
      if (
        trigger.minMinutes !== undefined &&
        (typeof trigger.minMinutes !== "number" ||
          !Number.isFinite(trigger.minMinutes) ||
          trigger.minMinutes < 0)
      ) {
        return "Activity-ended trigger minMinutes must be a non-negative number.";
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
      for (const minute of [condition.startMinute, condition.endMinute]) {
        if (minute === undefined) continue; // absent means :00 — see TimeOfDayCondition
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
          return "timeOfDay condition minutes must be between 0 and 59.";
        }
      }
      return null;
    case "daysOfWeek":
      if (!Array.isArray(condition.days) || condition.days.length === 0) {
        return "daysOfWeek condition needs at least one day.";
      }
      for (const day of condition.days) {
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          return "daysOfWeek condition days must be integers from 0 (Sunday) to 6 (Saturday).";
        }
      }
      return null;
    case "activityIs":
      if (typeof condition.activity !== "string" || condition.activity.trim().length === 0) {
        return "activityIs condition needs an activity name.";
      }
      return null;
    case "activityDuration":
      if (
        typeof condition.minMinutes !== "number" ||
        !Number.isFinite(condition.minMinutes) ||
        condition.minMinutes < 0
      ) {
        return "activityDuration condition needs a non-negative minMinutes.";
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

/* ------------------------------------------------------------------ *
 * Explanation, history and persisted runtime state.
 *
 * These describe what the engine DECIDED, as opposed to what the user
 * CONFIGURED (everything above). They live here so the IPC layer and UI
 * can share the shapes without importing the service itself.
 * ------------------------------------------------------------------ */

/** One line of a routine's decision, phrased for a human and safe to show verbatim. */
export interface RoutineCheck {
  label: string;
  passed: boolean;
}

/** Why a routine did not run. Ordered as the engine tests them. */
export type RoutineBlockReason = "disabled" | "trigger" | "cooldown" | "session" | "conditions";

/**
 * The deterministic answer to "why did (or didn't) this routine fire?".
 * Produced both by live event handling and by the editor's Test button,
 * so the explanation a user reads while testing is generated by the same
 * code that makes the real decision — not a parallel description of it
 * that could drift.
 */
export interface RoutineEvaluation {
  routineId: string;
  routineName: string;
  matched: boolean;
  checks: RoutineCheck[];
  blockedBy?: RoutineBlockReason;
}

/**
 * What happened, as a short record for debugging and for a future
 * intelligence layer to learn the shape of.
 *
 * Deliberately narrow: NIMBUS's own decisions and nothing else. There is
 * no field here for page content, window titles beyond what a routine
 * already matched on, keystrokes, or anything the user typed or read —
 * see "Privacy" in docs/routines.md.
 */
export type RoutineHistoryKind =
  | "matched"
  | "suggested"
  | "accepted"
  | "dismissed"
  | "expired"
  | "autoRan"
  | "blockedByCooldown"
  | "blockedBySession"
  | "blockedByConditions"
  | "actionsCompleted";

export interface RoutineHistoryEntry {
  id: string;
  at: string;
  routineId: string;
  routineName: string;
  kind: RoutineHistoryKind;
  /** One short, non-sensitive clarifier, e.g. "2 actions, 1 failed". */
  detail?: string;
}

/**
 * The slice of routine state that must outlive a restart.
 *
 * Only cooldown timestamps: a cooldown that silently resets because
 * NIMBUS restarted is exactly the suggestion spam cooldowns exist to
 * stop. Session state is deliberately NOT here — a session belongs to a
 * running application, and after a restart NIMBUS cannot know whether
 * the app it saw is the same one still running, so the honest default is
 * a fresh session.
 */
export interface RoutineRuntimeState {
  /** routine id -> epoch ms when it last fired. */
  lastTriggeredAt: Record<string, number>;
}

/** Injected into RoutineService so Core never touches the filesystem or Electron directly. */
export interface RoutineStateStore {
  load(): RoutineRuntimeState;
  save(state: RoutineRuntimeState): void;
}

export const MAX_ROUTINE_HISTORY_ENTRIES = 200;
