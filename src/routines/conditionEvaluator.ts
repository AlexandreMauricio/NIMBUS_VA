import { RoutineActionStep, RoutineCondition } from "./types";

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

/** All conditions must hold for a routine to be allowed to suggest — an empty list always passes. */
export async function evaluateConditions(conditions: RoutineCondition[], ctx: ConditionContext): Promise<boolean> {
  for (const condition of conditions) {
    if (!(await evaluateCondition(condition, ctx))) return false;
  }
  return true;
}

async function evaluateCondition(condition: RoutineCondition, ctx: ConditionContext): Promise<boolean> {
  switch (condition.type) {
    case "timeOfDay":
      return isWithinHourRange(ctx.now.getHours(), condition.startHour, condition.endHour);

    case "weekdaysOnly": {
      const day = ctx.now.getDay(); // 0 = Sunday, 6 = Saturday
      return day >= 1 && day <= 5;
    }

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

/** Supports a range that wraps past midnight, e.g. startHour=22, endHour=6 covers 22:00-05:59. */
function isWithinHourRange(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true; // a zero-width/full-day range is treated as "always"
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}
