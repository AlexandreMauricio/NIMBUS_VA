import { ActivityMapping } from "../activity/types";

/**
 * Moves activities off routines and into the standalone mapping list.
 *
 * Activities used to be declared on the routine that implied them
 * (`routine.activity`), so a routine's own trigger doubled as the
 * mapping and an application or website was typed once. Activities are
 * now their own thing, edited in the Activities tab, which means that
 * link no longer exists — and a routine's `activity` would simply stop
 * meaning anything.
 *
 * Rather than let that silently delete activities people are using, this
 * converts each one into the standalone mapping it was already behaving
 * as, copying the trigger the routine had supplied. A routine with
 * wind-down actions also gets an explicit `stopTrigger`, since the
 * implicit "ends when my activity ends" reading went with the field.
 *
 * Runs on every load and is idempotent: a routine that no longer carries
 * an activity produces nothing, and an activity already represented by a
 * mapping with the same source and value is left alone rather than
 * duplicated.
 */
export function migrateRoutineActivities(parsed: any): void {
  const routines = parsed?.userPreferences?.routines?.routines;
  if (!Array.isArray(routines)) return;

  // A settings file old enough to have routine activities may predate the
  // activity group entirely. Create just enough of it to migrate into;
  // applyDefaults fills the rest in immediately afterwards.
  if (!parsed.userPreferences.activity) parsed.userPreferences.activity = {};
  const activity = parsed.userPreferences.activity;
  if (!Array.isArray(activity.mappings)) activity.mappings = [];
  const mappings: ActivityMapping[] = activity.mappings;

  let migrated = 0;
  for (const routine of routines) {
    const name = typeof routine?.activity?.name === "string" ? routine.activity.name.trim() : "";
    if (!name) continue;

    // The end half kept working through `effectiveStopTrigger`, which
    // read the routine's activity when no end trigger was stored. Write
    // that reading down before the activity it depended on is gone.
    if (Array.isArray(routine.stopActions) && routine.stopActions.length > 0 && !routine.stopTrigger) {
      routine.stopTrigger = { type: "activityEnded", activity: name };
    }

    const derived = mappingFromTrigger(routine, name);
    // A routine whose trigger never described a thing being open (a timer
    // finishing, an activity ending) was never a mapping to begin with.
    if (derived && !mappings.some((m) => sameRule(m, derived))) {
      mappings.push(derived);
      migrated += 1;
    }

    delete routine.activity;
  }

  // An activity that came from a routine was live without the master
  // switch — the routine declaring it was the opt-in. Turning these into
  // standalone mappings must not quietly stop them working.
  if (migrated > 0) activity.enabled = true;
}

function sameRule(a: ActivityMapping, b: ActivityMapping): boolean {
  return (
    a.activity.trim().toLowerCase() === b.activity.trim().toLowerCase() &&
    a.source === b.source &&
    a.value.trim().toLowerCase() === b.value.trim().toLowerCase()
  );
}

function mappingFromTrigger(routine: any, activity: string): ActivityMapping | null {
  const trigger = routine.trigger;
  const base = {
    // Same deterministic id the derived mapping used to have, so a
    // second run recognises its own work even if the rule was edited.
    id: `routine:${routine.id}`,
    // A disabled routine described a real activity; it just wasn't
    // watching for it. Preserve that rather than silently enabling it.
    enabled: routine.enabled !== false,
    activity,
    icon: typeof routine.activity?.icon === "string" ? routine.activity.icon : undefined,
    priority: 0,
  };

  switch (trigger?.type) {
    case "applicationOpened":
      return { ...base, source: "application", value: trigger.application, matchMode: trigger.matchMode };
    case "websiteOpened":
      return { ...base, source: "website", value: trigger.pattern, matchMode: trigger.matchMode };
    case "folderOpened":
      return { ...base, source: "folder", value: trigger.path, matchMode: trigger.matchMode };
    default:
      return null;
  }
}
