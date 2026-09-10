import { Routine } from "../routines/types";
import { ActivityMapping } from "./types";

/**
 * Turns the routines that declare an activity into activity mappings.
 *
 * This exists so an application or website is configured ONCE. A routine
 * that fires when a study site opens has already said which site that is;
 * making the user type it again in a separate mappings list is
 * duplication that then has to be kept in step by hand. Setting the
 * routine's `activity` reuses its own trigger as the mapping.
 *
 * Pure and derived — nothing is written anywhere. Change the routine's
 * trigger and the mapping follows automatically, because it never existed
 * as its own stored copy.
 *
 * What this does NOT do is change what the routine does. Activity is
 * context: whether the routine suggests anything is still decided by its
 * trigger, conditions and cooldown, exactly as before.
 */
export function mappingsFromRoutines(routines: Routine[]): ActivityMapping[] {
  const mappings: ActivityMapping[] = [];

  for (const routine of routines) {
    if (!routine.activity?.name) continue;
    // A disabled routine is off in every sense — it neither suggests nor
    // tells NIMBUS what the user is doing.
    if (!routine.enabled) continue;

    const derived = mappingFromTrigger(routine);
    if (derived) mappings.push(derived);
  }

  return mappings;
}

function mappingFromTrigger(routine: Routine): ActivityMapping | null {
  const trigger = routine.trigger;
  const base = {
    // Deterministic rather than random: the same routine always yields
    // the same mapping id, so precedence tie-breaking is stable across
    // restarts and the id points back at what produced it.
    id: `routine:${routine.id}`,
    enabled: true,
    activity: routine.activity!.name,
    icon: routine.activity!.icon,
    // Left at the default. A routine trigger is usually the specific
    // rule ("that one study site") while a standalone mapping is often
    // the broad one ("any browser window"), and the detector's
    // specificity tie-break already prefers the longer pattern — so this
    // lands the right way round without asking the user to reason about
    // priority numbers they never set.
    priority: 0,
  };

  switch (trigger.type) {
    case "applicationOpened":
      return { ...base, source: "application", value: trigger.application, matchMode: trigger.matchMode };
    case "websiteOpened":
      return { ...base, source: "website", value: trigger.pattern, matchMode: trigger.matchMode };
    case "folderOpened":
      return { ...base, source: "folder", value: trigger.path, matchMode: trigger.matchMode };
    case "timerCompleted":
      // A timer finishing is a moment, not something you spend time
      // doing. validateRoutine rejects this combination outright; this
      // is the belt to that braces.
      return null;
    default:
      return null;
  }
}
