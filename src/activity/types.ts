import { StringMatchMode } from "../common/patternMatch";

/**
 * Activity & Session — what the user appears to be doing right now, and
 * for how long.
 *
 * The distinction this module draws, and the reason it exists alongside
 * the Event system rather than inside it:
 *
 *   Event    something happened          "SkillCert was opened"
 *   Activity what that means             "Study"
 *   Session  a continuous period of it   "Study, since 09:00"
 *
 * Activity is *context*, never a decision. Detecting Study does not
 * start music or a timer — Routines decide what to do, exactly as they
 * did before this existed. Nothing in this module can invoke an Action.
 *
 * Nothing here names a specific application, website or activity.
 * "Study" is a string the user typed into a mapping, not a case in a
 * switch: NIMBUS has no built-in belief that SkillCert means studying.
 */

/**
 * One user-configured rule: "this observed thing means that activity".
 *
 * `value` and `matchMode` behave exactly like a Routine trigger's
 * pattern (comma-separated alternatives, exact/contains) because they
 * share the implementation — see common/patternMatch.
 */
export interface ActivityMapping {
  id: string;
  enabled: boolean;
  /** The activity's name, free text chosen by the user: "Study", "Gaming", "Coding". */
  activity: string;
  /** Optional emoji shown beside it. Presentation only; never matched on. */
  icon?: string;
  /** Which observed signal this rule reads. */
  source: ActivitySource;
  /** What to match against: an executable name, a window title fragment, a folder path. */
  value: string;
  matchMode: StringMatchMode;
  /**
   * Higher wins when several rules match at once.
   *
   * This is what makes "Chrome is Browsing, but Chrome showing the study
   * site is Study" expressible: give the narrower rule a higher number.
   * Ties are broken by the longer pattern (the more specific one), then
   * by order, so the outcome never depends on object iteration order.
   */
  priority: number;
}

export type ActivitySource = "application" | "website" | "folder";

/** What a detector concluded from one event. */
export interface ActivityMatch {
  activity: string;
  icon?: string;
  source: ActivitySource;
  /**
   * The configured pattern that matched — never the raw observed value.
   *
   * For an application that is effectively the executable name. For a
   * website it is the fragment the user put in the mapping, deliberately
   * NOT the window title: titles carry whatever page someone happens to
   * be on, and storing them would make the session history a browsing
   * log. This is what "Study · myschool" shows.
   */
  sourceValue: string;
  mappingId: string;
}

export type ActivitySessionState = "active" | "ended";

/**
 * A continuous period of one activity.
 *
 * `endedAt` is null while it runs; duration is always computed from the
 * timestamps rather than counted up, so it cannot drift and survives the
 * process being busy elsewhere.
 *
 * `anchorProcess` is the executable whose running-or-not decides whether
 * this session is still alive — the app itself for an application
 * session, the browser for a website one. NIMBUS gets told when a
 * process closes (applicationClosed), and that is the only signal it
 * has that an activity genuinely stopped. Without an anchor, ending a
 * session would mean inferring "stopped" from silence, and silence is
 * exactly what sustained work looks like.
 */
export interface ActivitySession {
  id: string;
  activity: string;
  icon?: string;
  source: ActivitySource;
  sourceValue: string;
  anchorProcess: string | null;
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
  state: ActivitySessionState;
}

/** The flattened "what is happening now" view the UI and Routine conditions read. */
export interface CurrentActivity {
  activity: string;
  icon?: string;
  source: ActivitySource;
  sourceValue: string;
  startedAt: string;
  /** Computed from startedAt, never accumulated. */
  durationMs: number;
}

export interface ActivitySettings {
  /** Master switch. Off means no detection at all, and no sessions recorded. */
  enabled: boolean;
  mappings: ActivityMapping[];
  /**
   * How long an activity survives its application closing before the
   * session is considered over, in minutes.
   *
   * This is the "I closed it by accident / it crashed / I restarted it"
   * allowance: reopening within the window continues the same session
   * instead of starting a second one. Resolved lazily when the session
   * is next read, so it needs no timer of its own.
   */
  graceMinutes: number;
  /**
   * Opt-in: keep a small tally of programs with a window open and offer to
   * make the frequent ones activities (see appUsage.ts). Absent means off.
   */
  suggestFrequentApps?: boolean;
}

export const DEFAULT_ACTIVITY_GRACE_MINUTES = 5;

/** Sessions kept for the recent-activity list. Old ones are dropped, not archived. */
export const MAX_ACTIVITY_SESSIONS = 200;

/** Persisted session history. Deliberately only NIMBUS's own conclusions — see the module doc. */
export interface ActivityHistoryState {
  sessions: ActivitySession[];
}

export interface ActivityStateStore {
  load(): ActivityHistoryState;
  save(state: ActivityHistoryState): void;
}

export interface ActivityValidationResult {
  valid: boolean;
  error?: string;
}

/** Rejects a malformed mapping before it can be saved, in the spirit of validateRoutine. */
export function validateActivityMapping(mapping: ActivityMapping): ActivityValidationResult {
  if (!mapping || typeof mapping !== "object") return { valid: false, error: "Invalid mapping." };
  if (!mapping.id || typeof mapping.id !== "string") {
    return { valid: false, error: "Mapping id is required." };
  }
  if (typeof mapping.activity !== "string" || mapping.activity.trim().length === 0) {
    return { valid: false, error: "An activity name is required." };
  }
  if (!["application", "website", "folder"].includes(mapping.source)) {
    return { valid: false, error: "Mapping source must be application, website or folder." };
  }
  if (typeof mapping.value !== "string" || mapping.value.trim().length === 0) {
    return { valid: false, error: "A value to match is required." };
  }
  if (mapping.matchMode !== "exact" && mapping.matchMode !== "contains") {
    return { valid: false, error: "matchMode must be exact or contains." };
  }
  if (typeof mapping.priority !== "number" || !Number.isFinite(mapping.priority)) {
    return { valid: false, error: "priority must be a number." };
  }
  if (typeof mapping.enabled !== "boolean") {
    return { valid: false, error: "enabled must be a boolean." };
  }
  if (mapping.icon !== undefined && typeof mapping.icon !== "string") {
    return { valid: false, error: "icon must be a string." };
  }
  return { valid: true };
}
