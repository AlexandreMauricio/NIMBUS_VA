import { CurrentActivity } from "../activity/types";
import { ConditionLogic, RoutineActionStep, RoutineCondition, RoutineTimerStatus } from "./types";

/** External signals a condition might need — kept as a small, optional bag of injected functions so evaluation stays pure/testable and Core never reaches into Electron or a specific provider directly. */
export interface ConditionContext {
  now: Date;
  /** Only needed by the "spotifyNotAlreadyPlaying" condition. Omitted (or throwing) is treated as "unknown" -> condition fails closed (does not block the routine) — see evaluateConditions. */
  isSpotifyPlaying?: () => boolean | Promise<boolean>;
  /**
   * The routine's own configured action steps — only read by the
   * "actionsNotAlreadyActive" condition, which needs to know exactly
   * *which* playlist/timer this routine would start in order to check
   * whether that's already the case. Nothing else in this module reads
   * routine configuration; conditions like timeOfDay/weekdaysOnly stay
   * fully generic.
   */
  routineActions?: RoutineActionStep[];
  /**
   * Only needed by the "actionsNotAlreadyActive" condition. Given the
   * routine's action steps, reports whether their configured effects
   * already appear to be in place (e.g. Spotify already playing the
   * exact configured playlist, a timer already running) — omitted (or
   * throwing) is treated as "unknown" -> condition fails open (does not
   * block the routine), same fail-open discipline as
   * "spotifyNotAlreadyPlaying" below.
   */
  areActionsAlreadyActive?: (steps: RoutineActionStep[]) => boolean | Promise<boolean>;
  /**
   * What the user appears to be doing, for the activity conditions.
   * Injected like the others so Core never reaches into the Activity
   * service directly. Omitted means "no signal": those conditions then
   * fail CLOSED (they block), unlike the Spotify checks which fail open.
   * The difference is deliberate — "only while studying" must not fire
   * when NIMBUS has no idea whether the user is studying.
   */
  getCurrentActivity?: () => CurrentActivity | null;
  /**
   * The Spotify URI of whatever is driving playback (a playlist, album or
   * artist), or null when nothing is. Only the Spotify playlist
   * condition reads it; absent means "can't tell" and it fails closed,
   * since "only while this playlist plays" must not fire blind.
   */
  getPlaybackContextUri?: () => string | null | Promise<string | null>;
  /** What the timer is doing. Absent means "can't tell": the timer conditions then fail closed. */
  getTimerStatus?: () => RoutineTimerStatus;
  /**
   * Whether a device NIMBUS knows is on the local network. `undefined`
   * means NIMBUS has no idea (an unknown device, or network watching
   * off), which fails closed both ways - see DeviceOnlineCondition.
   */
  isDeviceOnline?: (deviceId: string) => boolean | undefined;
}

/** One condition's outcome, with a description fit to show the user verbatim. */
export interface ConditionResult {
  condition: RoutineCondition;
  passed: boolean;
  /** Deterministic, human-readable, e.g. "Time is within 18:00-23:00". */
  label: string;
}

export interface ConditionsEvaluation {
  passed: boolean;
  results: ConditionResult[];
}

/**
 * Evaluates every condition and reports both the verdict and the
 * per-condition detail behind it — the detail is what makes "why did
 * this trigger?" answerable rather than guesswork.
 *
 * `logic` is "all" by default, which is how every routine behaved before
 * the operator existed. An empty condition list passes under either
 * operator: a routine with no conditions is unconditional, and reading
 * "any" as "at least one of nothing" would silently disable it.
 *
 * Deliberately evaluates ALL conditions rather than short-circuiting on
 * the first decisive one: a partial list of reasons is a misleading
 * explanation. Every condition check is side-effect-free and either
 * local or served from an existing cache, so the cost is negligible.
 */
export async function evaluateConditionsDetailed(
  conditions: RoutineCondition[],
  ctx: ConditionContext,
  logic: ConditionLogic = "all"
): Promise<ConditionsEvaluation> {
  const results: ConditionResult[] = [];
  for (const condition of conditions) {
    const passed = await evaluateCondition(condition, ctx);
    results.push({ condition, passed, label: describeCondition(condition, passed) });
  }

  if (results.length === 0) return { passed: true, results };
  const passed = logic === "any" ? results.some((r) => r.passed) : results.every((r) => r.passed);
  return { passed, results };
}

/** Boolean-only form, kept for callers that just need the verdict. */
export async function evaluateConditions(
  conditions: RoutineCondition[],
  ctx: ConditionContext,
  logic: ConditionLogic = "all"
): Promise<boolean> {
  return (await evaluateConditionsDetailed(conditions, ctx, logic)).passed;
}

/**
 * A plain-language rendering of one condition and how it just came out.
 * Interpolates the user's own configured values; nothing here names a
 * specific application, site or service.
 */
function describeCondition(condition: RoutineCondition, passed: boolean): string {
  switch (condition.type) {
    case "timeOfDay": {
      const window = `${formatHm(condition.startHour, condition.startMinute)}-${formatHm(condition.endHour, condition.endMinute)}`;
      return passed ? `Time is within ${window}` : `Time is outside ${window}`;
    }
    case "weekdaysOnly":
      return passed ? "It is a weekday" : "It is the weekend";
    case "daysOfWeek": {
      const days = condition.days.map((d) => DAY_NAMES[d] ?? String(d)).join(", ");
      return passed ? `Today is one of ${days}` : `Today is not one of ${days}`;
    }
    case "spotifyNotAlreadyPlaying":
      return passed ? "Spotify is not already playing" : "Spotify is already playing";
    case "spotifyIsPlaying":
      return passed ? "Spotify is playing" : "Spotify is not playing";
    case "activityIs": {
      const is = `Current activity is ${condition.activity}`;
      const isNot = `Current activity is not ${condition.activity}`;
      if (condition.negate === true) return passed ? isNot : is;
      return passed ? is : isNot;
    }
    case "activityDuration": {
      const minutes = condition.minMinutes;
      if (condition.operator === "lessThan") {
        return passed
          ? `Current activity has lasted less than ${minutes} min`
          : `Current activity has lasted ${minutes} min or more`;
      }
      return passed
        ? `Current activity has lasted at least ${minutes} min`
        : `Current activity has not lasted ${minutes} min yet`;
    }
    case "timeIs": {
      const at = formatHm(condition.hour, condition.minute);
      const side = condition.operator === "after" ? "after" : "before";
      return passed ? `Time is ${side} ${at}` : `Time is not ${side} ${at}`;
    }
    case "spotifyPlaylistIs": {
      const name = condition.playlistName || "that playlist";
      const wanted = condition.negate === true ? `is not ${name}` : `is ${name}`;
      const other = condition.negate === true ? `is ${name}` : `is not ${name}`;
      return passed ? `The playlist ${wanted}` : `The playlist ${other}`;
    }
    case "timerStatusIs":
      if (condition.status === "none") return passed ? "No timer is running" : "A timer is running";
      return passed ? `The timer is ${condition.status}` : `The timer is not ${condition.status}`;
    case "deviceOnline": {
      const name = condition.deviceName || "That device";
      const wanted = condition.negate === true ? "not on the network" : "on the network";
      const other = condition.negate === true ? "on the network" : "not on the network";
      return passed ? `${name} is ${wanted}` : `${name} is ${other}`;
    }
    case "actionsNotAlreadyActive":
      return passed
        ? "This routine's actions are not already active"
        : "This routine's actions already appear to be active";
    default:
      return `Unknown condition "${(condition as { type?: string }).type}"`;
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatHm(hour: number, minute: number | undefined): string {
  return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

async function evaluateCondition(condition: RoutineCondition, ctx: ConditionContext): Promise<boolean> {
  switch (condition.type) {
    case "timeOfDay":
      return isWithinTimeRange(
        ctx.now.getHours() * 60 + ctx.now.getMinutes(),
        condition.startHour * 60 + (condition.startMinute ?? 0),
        condition.endHour * 60 + (condition.endMinute ?? 0)
      );

    case "weekdaysOnly": {
      const day = ctx.now.getDay(); // 0 = Sunday, 6 = Saturday
      return day >= 1 && day <= 5;
    }

    case "daysOfWeek":
      return condition.days.includes(ctx.now.getDay());

    case "spotifyNotAlreadyPlaying": {
      if (!ctx.isSpotifyPlaying) return true; // no signal available — don't block the routine on a condition we can't check
      try {
        return !(await ctx.isSpotifyPlaying());
      } catch {
        return true; // fail open — a broken playback check shouldn't silently suppress every suggestion
      }
    }

    case "spotifyIsPlaying": {
      if (!ctx.isSpotifyPlaying) return true; // no signal available — same fail-open discipline as its counterpart
      try {
        return await ctx.isSpotifyPlaying();
      } catch {
        return true;
      }
    }

    case "activityIs": {
      const current = ctx.getCurrentActivity?.() ?? null;
      const matches =
        current !== null && current.activity.trim().toLowerCase() === condition.activity.trim().toLowerCase();
      // "is X" fails closed with no activity (see getCurrentActivity's
      // doc); "is not X" treats nothing running as a real answer, because
      // whatever the user is doing, it demonstrably isn't X.
      return condition.negate === true ? !matches : matches;
    }

    case "activityDuration": {
      const current = ctx.getCurrentActivity?.() ?? null;
      if (!current) return false;
      const threshold = condition.minMinutes * 60_000;
      return condition.operator === "lessThan"
        ? current.durationMs < threshold
        : current.durationMs >= threshold;
    }

    case "timeIs": {
      const minuteOfDay = ctx.now.getHours() * 60 + ctx.now.getMinutes();
      const at = condition.hour * 60 + (condition.minute ?? 0);
      return condition.operator === "after" ? minuteOfDay >= at : minuteOfDay < at;
    }

    case "spotifyPlaylistIs": {
      if (!ctx.getPlaybackContextUri) return false; // can't tell - fail closed
      let uri: string | null;
      try {
        uri = await ctx.getPlaybackContextUri();
      } catch {
        return false;
      }
      // Nothing playing is a real answer: the playlist certainly isn't it.
      const matches = uri !== null && uri === condition.playlistUri;
      return condition.negate === true ? !matches : matches;
    }

    case "timerStatusIs": {
      if (!ctx.getTimerStatus) return false; // can't tell - fail closed
      try {
        return ctx.getTimerStatus() === condition.status;
      } catch {
        return false;
      }
    }

    case "deviceOnline": {
      if (!ctx.isDeviceOnline) return false; // can't tell - fail closed
      let online: boolean | undefined;
      try {
        online = ctx.isDeviceOnline(condition.deviceId);
      } catch {
        return false;
      }
      if (online === undefined) return false; // NIMBUS has never seen this device
      return condition.negate === true ? !online : online;
    }

    case "actionsNotAlreadyActive": {
      if (!ctx.areActionsAlreadyActive || !ctx.routineActions) return true; // no signal available — don't block the routine on a condition we can't check
      try {
        return !(await ctx.areActionsAlreadyActive(ctx.routineActions));
      } catch {
        return true; // fail open — a broken "is this already running" check shouldn't silently suppress every suggestion
      }
    }

    default:
      return true;
  }
}

/**
 * Whether a minutes-since-midnight instant falls in a range, supporting a
 * range that wraps past midnight (22:00-02:00 covers 22:00 through
 * 01:59). Comparing minute counts rather than clock strings is what makes
 * the wrap a single inequality flip instead of a special case — and
 * string comparison would get "22:00" > "02:00" wrong in the first place.
 *
 * The end is exclusive, so back-to-back windows don't both claim the
 * boundary minute. Start == end is treated as "always", preserving the
 * pre-existing whole-hour behaviour.
 */
function isWithinTimeRange(minuteOfDay: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}
