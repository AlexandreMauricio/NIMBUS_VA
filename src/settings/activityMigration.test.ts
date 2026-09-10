import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRoutineActivities } from "./activityMigration";

function file(routines: any[], activity: any = { enabled: false, mappings: [] }): any {
  return { userPreferences: { routines: { enabled: true, routines }, activity } };
}

function studyRoutine(extra: any = {}): any {
  return {
    id: "study",
    name: "Study",
    enabled: true,
    trigger: { type: "websiteOpened", matchField: "windowTitle", pattern: "Halo", matchMode: "contains" },
    activity: { name: "Study", icon: "📚" },
    ...extra,
  };
}

test("a routine's activity becomes a standalone mapping using its own trigger", () => {
  const parsed = file([studyRoutine()]);

  migrateRoutineActivities(parsed);

  const [m] = parsed.userPreferences.activity.mappings;
  assert.equal(m.activity, "Study");
  assert.equal(m.icon, "📚");
  assert.equal(m.source, "website");
  assert.equal(m.value, "Halo");
  assert.equal(m.matchMode, "contains");
});

test("the routine no longer carries the activity afterwards", () => {
  const parsed = file([studyRoutine()]);

  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.routines.routines[0].activity, undefined);
});

test("migrating turns activity tracking on, since declaring one used to be the opt-in", () => {
  const parsed = file([studyRoutine()]);

  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.activity.enabled, true);
});

test("running twice does not duplicate the mapping", () => {
  const parsed = file([studyRoutine()]);

  migrateRoutineActivities(parsed);
  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.activity.mappings.length, 1);
});

test("an equivalent mapping the user already wrote is left alone", () => {
  const parsed = file([studyRoutine()], {
    enabled: true,
    mappings: [
      {
        id: "mine",
        enabled: true,
        activity: "study",
        source: "website",
        value: "halo",
        matchMode: "contains",
        priority: 3,
      },
    ],
  });

  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.activity.mappings.length, 1);
  assert.equal(parsed.userPreferences.activity.mappings[0].priority, 3, "the user's own rule wins");
});

test("a disabled routine's activity arrives disabled rather than quietly switched on", () => {
  const parsed = file([studyRoutine({ enabled: false })]);

  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.activity.mappings[0].enabled, false);
});

test("an end half that relied on the implicit trigger gets it written down", () => {
  const parsed = file([studyRoutine({ stopActions: [{ actionId: "timer.stop", params: {} }] })]);

  migrateRoutineActivities(parsed);

  assert.deepEqual(parsed.userPreferences.routines.routines[0].stopTrigger, {
    type: "activityEnded",
    activity: "Study",
  });
});

test("an explicit end trigger is not overwritten", () => {
  const stopTrigger = { type: "timerCompleted", timerType: "focus" };
  const parsed = file([studyRoutine({ stopActions: [{ actionId: "timer.stop", params: {} }], stopTrigger })]);

  migrateRoutineActivities(parsed);

  assert.deepEqual(parsed.userPreferences.routines.routines[0].stopTrigger, stopTrigger);
});

test("a trigger that never described something being open yields no mapping", () => {
  // A timer finishing is a moment, not something you spend time doing.
  const parsed = file([studyRoutine({ trigger: { type: "timerCompleted", timerType: "focus" } })]);

  migrateRoutineActivities(parsed);

  assert.deepEqual(parsed.userPreferences.activity.mappings, []);
  assert.equal(parsed.userPreferences.routines.routines[0].activity, undefined);
});

test("a settings file predating the activity group is migrated into a new one", () => {
  const parsed: any = { userPreferences: { routines: { enabled: true, routines: [studyRoutine()] } } };

  migrateRoutineActivities(parsed);

  assert.equal(parsed.userPreferences.activity.mappings.length, 1);
});

test("a file with no routines at all is left untouched", () => {
  const parsed: any = { userPreferences: {} };

  migrateRoutineActivities(parsed);

  assert.deepEqual(parsed, { userPreferences: {} });
});
