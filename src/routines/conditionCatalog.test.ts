import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONDITION_FIELDS,
  ConditionValue,
  buildCondition,
  defaultValueFor,
  operatorsFor,
  readCondition,
} from "./conditionCatalog";
import { Routine, RoutineCondition, validateRoutine } from "./types";

function routineWith(conditions: RoutineCondition[]): Routine {
  return {
    id: "r1",
    name: "Test routine",
    enabled: true,
    trigger: { type: "applicationOpened", application: "study.exe", matchMode: "exact" },
    conditions,
    suggestion: { title: "T", message: "M", primaryLabel: "Yes", secondaryLabel: "No" },
    actions: [{ actionId: "timer.start", params: { duration: 25 } }],
    cooldownMinutes: 30,
  };
}

test("every field/operator the picker offers builds a condition the model accepts", () => {
  let built = 0;
  for (const field of CONDITION_FIELDS) {
    for (const operator of operatorsFor(field.id)) {
      const condition = buildCondition(field.id, operator.id);
      assert.ok(condition, `${field.id}.${operator.id} built nothing`);

      // Value-taking operators start empty on purpose; give them one, so
      // what is validated is a row the user has actually filled in.
      const value: ConditionValue | undefined =
        operator.value === "activity"
          ? "Study"
          : operator.value === "playlist" || operator.value === "device"
            ? { id: "x:1", name: "X" }
            : undefined;
      const filled = buildCondition(field.id, operator.id, value ?? defaultValueFor(operator.value));
      const result = validateRoutine(routineWith([filled as RoutineCondition]), ["timer.start"]);
      assert.equal(result.valid, true, `${field.id}.${operator.id}: ${result.error}`);
      built++;
    }
  }
  assert.ok(built >= 14, `expected the catalog to cover more than ${built} combinations`);
});

test("a built condition reads back as the same field, operator and value", () => {
  const cases: Array<[string, string, ConditionValue]> = [
    ["time", "between", { startHour: 9, startMinute: 30, endHour: 17, endMinute: 45 }],
    ["time", "before", { hour: 8, minute: 15 }],
    ["time", "after", { hour: 22, minute: 0 }],
    ["day", "isOneOf", [0, 6]],
    ["activity", "is", "Study"],
    ["activity", "isNot", "Gaming"],
    ["activity", "lastedAtLeast", 90],
    ["activity", "lastedLessThan", 15],
    ["spotify", "isPlaying", null],
    ["spotify", "isNotPlaying", null],
    ["spotifyPlaylist", "is", { id: "spotify:playlist:1", name: "Deep Focus" }],
    ["spotifyPlaylist", "isNot", { id: "spotify:playlist:2", name: "Party" }],
    ["timer", "isRunning", null],
    ["timer", "isPaused", null],
    ["timer", "isNotRunning", null],
    ["presence", "isAtPc", null],
    ["presence", "isNotAtPc", null],
    ["presence", "isOut", null],
    ["device", "isHome", { id: "mac:aa:bb", name: "Phone" }],
    ["device", "isAway", { id: "mac:cc:dd", name: "Laptop" }],
  ];

  for (const [fieldId, operatorId, value] of cases) {
    const condition = buildCondition(fieldId, operatorId, value);
    const row = readCondition(condition);
    assert.ok(row, `${fieldId}.${operatorId} read back as nothing`);
    assert.equal(row.fieldId, fieldId);
    assert.equal(row.operatorId, operatorId);
    assert.deepEqual(row.value, value, `${fieldId}.${operatorId} value`);
  }
});

test("the negated forms are the same stored condition with a flag, not separate types", () => {
  assert.deepEqual(buildCondition("activity", "is", "Study"), { type: "activityIs", activity: "Study" });
  assert.deepEqual(buildCondition("activity", "isNot", "Study"), {
    type: "activityIs",
    activity: "Study",
    negate: true,
  });
});

test("conditions saved before the catalog still read back", () => {
  // Minutes absent, as older routines wrote them.
  assert.deepEqual(readCondition({ type: "timeOfDay", startHour: 18, endHour: 23 })?.value, {
    startHour: 18,
    startMinute: 0,
    endHour: 23,
    endMinute: 0,
  });
  // No operator meant "at least".
  const duration = readCondition({ type: "activityDuration", minMinutes: 90 });
  assert.equal(duration?.operatorId, "lastedAtLeast");
  assert.equal(duration?.value, 90);
});

test("weekdaysOnly still renders, but is not offered for new conditions", () => {
  const row = readCondition({ type: "weekdaysOnly" });
  assert.equal(row?.fieldId, "day");
  assert.equal(row?.operatorLabel, "is a weekday (Mon-Fri)");
  assert.ok(!operatorsFor("day").some((operator) => operator.id === "weekdaysOnly"));
});

test("anything the catalog does not cover is reported, never guessed at", () => {
  assert.equal(readCondition({ type: "actionsNotAlreadyActive" }), null, "its own checkbox");
  assert.equal(readCondition({ type: "somethingNewer" }), null);
  assert.equal(readCondition(null), null);
  assert.equal(buildCondition("nope", "is"), null);
  assert.equal(buildCondition("spotify", "nope"), null);
  assert.equal(buildCondition("day", "weekdaysOnly"), null, "legacy operators are not built anew");
});

test("a row with a missing or malformed value still builds something valid", () => {
  assert.deepEqual(buildCondition("time", "between", null as unknown as ConditionValue), {
    type: "timeOfDay",
    startHour: 18,
    startMinute: 0,
    endHour: 23,
    endMinute: 0,
  });
  assert.deepEqual(buildCondition("day", "isOneOf", ["monday"] as unknown as ConditionValue), {
    type: "daysOfWeek",
    days: [],
  });
});
