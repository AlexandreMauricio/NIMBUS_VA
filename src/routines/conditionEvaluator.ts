import { ConditionLogic, RoutineActionStep, RoutineCondition } from "./types";

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
