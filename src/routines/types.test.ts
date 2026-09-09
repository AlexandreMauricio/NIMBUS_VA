import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRoutine, Routine } from "./types";

const KNOWN_ACTION_IDS = ["spotify.play", "spotify.playPlaylist", "spotify.setVolume"];

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Study",
    enabled: true,
    trigger: {
      type: "websiteOpened",
      matchField: "windowTitle",
      pattern: "skillcert",
      matchMode: "contains",
    },
    conditions: [],
    suggestion: {
      title: "Study mode?",
      message: "Play your study playlist?",
      primaryLabel: "Play",
      secondaryLabel: "Not now",
    },
    actions: [{ actionId: "spotify.playPlaylist", params: { playlistQuery: "Study" } }],
    cooldownMinutes: 30,
    ...overrides,
  };
}

test("a well-formed routine validates successfully", () => {
  assert.equal(validateRoutine(routine(), KNOWN_ACTION_IDS).valid, true);
});

test("a routine without a name is rejected", () => {
  const result = validateRoutine(routine({ name: "" }), KNOWN_ACTION_IDS);
  assert.equal(result.valid, false);
});

test("a routine with no actions is rejected", () => {
  const result = validateRoutine(routine({ actions: [] }), KNOWN_ACTION_IDS);
  assert.equal(result.valid, false);
  assert.match(result.error!, /at least one action/);
});

test("a routine referencing an unregistered action id is rejected", () => {
  const result = validateRoutine(
    routine({ actions: [{ actionId: "shell.exec", params: {} }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
  assert.match(result.error!, /Unknown action/);
});

test("a routine whose action params are not a plain object is rejected", () => {
  const result = validateRoutine(
    routine({ actions: [{ actionId: "spotify.play", params: ["not", "an", "object"] as never }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("an application trigger missing its application field is rejected", () => {
  const result = validateRoutine(
    routine({ trigger: { type: "applicationOpened", application: "", matchMode: "exact" } }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("a website trigger with an invalid matchField is rejected", () => {
  const result = validateRoutine(
    routine({
      trigger: { type: "websiteOpened", matchField: "bogus" as never, pattern: "x", matchMode: "contains" },
    }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("a folder trigger without a path is rejected", () => {
  const result = validateRoutine(
    routine({ trigger: { type: "folderOpened", path: "", matchMode: "contains" } }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("an invalid matchMode is rejected", () => {
  const result = validateRoutine(
    routine({
      trigger: { type: "applicationOpened", application: "steam.exe", matchMode: "fuzzy" as never },
    }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("a negative cooldown is rejected", () => {
  const result = validateRoutine(routine({ cooldownMinutes: -5 }), KNOWN_ACTION_IDS);
  assert.equal(result.valid, false);
});

test("an out-of-range timeOfDay condition is rejected", () => {
  const result = validateRoutine(
    routine({ conditions: [{ type: "timeOfDay", startHour: 25, endHour: 5 }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("a valid timeOfDay condition is accepted", () => {
  const result = validateRoutine(
    routine({ conditions: [{ type: "timeOfDay", startHour: 9, endHour: 17 }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, true);
});

test("a suggestion missing a title or message is rejected", () => {
  const result = validateRoutine(
    routine({ suggestion: { title: "", message: "", primaryLabel: "Play", secondaryLabel: "Not now" } }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});

test("an unknown trigger type is rejected rather than silently accepted", () => {
  const result = validateRoutine(routine({ trigger: { type: "somethingElse" } as never }), KNOWN_ACTION_IDS);
  assert.equal(result.valid, false);
});

test("multiple valid actions in sequence are accepted", () => {
  const result = validateRoutine(
    routine({
      actions: [
        { actionId: "spotify.setVolume", params: { volumePercent: 40 } },
        { actionId: "spotify.playPlaylist", params: { playlistQuery: "Gaming" } },
      ],
    }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, true);
});

test("autoRun: true is accepted", () => {
  assert.equal(validateRoutine(routine({ autoRun: true }), KNOWN_ACTION_IDS).valid, true);
});

test("a routine with no autoRun field at all is still accepted (defaults to false elsewhere)", () => {
  const r = routine();
  delete (r as { autoRun?: boolean }).autoRun;
  assert.equal(validateRoutine(r, KNOWN_ACTION_IDS).valid, true);
});

test("a non-boolean autoRun is rejected", () => {
  const result = validateRoutine(routine({ autoRun: "yes" as unknown as boolean }), KNOWN_ACTION_IDS);
  assert.equal(result.valid, false);
});

test("actionsNotAlreadyActive is a recognized condition type", () => {
  assert.equal(
    validateRoutine(routine({ conditions: [{ type: "actionsNotAlreadyActive" }] }), KNOWN_ACTION_IDS).valid,
    true
  );
});

/* ------------- Routine Engine 2.0: new fields and their validation ------------- */

test("a routine with none of the new fields is still valid — old configurations keep loading", () => {
  const legacy = routine();
  delete (legacy as Partial<Routine>).conditionLogic;
  delete (legacy as Partial<Routine>).sessionRestriction;
  delete (legacy as Partial<Routine>).description;

  assert.equal(validateRoutine(legacy, KNOWN_ACTION_IDS).valid, true);
});

test("conditionLogic accepts all and any, and rejects anything else", () => {
  assert.equal(validateRoutine(routine({ conditionLogic: "all" }), KNOWN_ACTION_IDS).valid, true);
  assert.equal(validateRoutine(routine({ conditionLogic: "any" }), KNOWN_ACTION_IDS).valid, true);

  const bad = validateRoutine(routine({ conditionLogic: "sometimes" as unknown as "all" }), KNOWN_ACTION_IDS);
  assert.equal(bad.valid, false);
  assert.match(bad.error ?? "", /conditionLogic/);
});

test("sessionRestriction accepts its two values and rejects anything else", () => {
  assert.equal(validateRoutine(routine({ sessionRestriction: "none" }), KNOWN_ACTION_IDS).valid, true);
  assert.equal(
    validateRoutine(routine({ sessionRestriction: "oncePerSession" }), KNOWN_ACTION_IDS).valid,
    true
  );

  const bad = validateRoutine(
    routine({ sessionRestriction: "onceEver" as unknown as "none" }),
    KNOWN_ACTION_IDS
  );
  assert.equal(bad.valid, false);
  assert.match(bad.error ?? "", /sessionRestriction/);
});

test("a non-string description is rejected", () => {
  const bad = validateRoutine(routine({ description: 42 as unknown as string }), KNOWN_ACTION_IDS);
  assert.equal(bad.valid, false);
  assert.match(bad.error ?? "", /description/);
});

test("a valid daysOfWeek condition is accepted", () => {
  assert.equal(
    validateRoutine(routine({ conditions: [{ type: "daysOfWeek", days: [0, 6] }] }), KNOWN_ACTION_IDS).valid,
    true
  );
});

test("an empty daysOfWeek list is rejected — it could never match", () => {
  const result = validateRoutine(
    routine({ conditions: [{ type: "daysOfWeek", days: [] }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /at least one day/);
});

test("an out-of-range day is rejected", () => {
  const result = validateRoutine(
    routine({ conditions: [{ type: "daysOfWeek", days: [1, 7] }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /0 \(Sunday\) to 6/);
});

test("timeOfDay minutes are validated when present", () => {
  assert.equal(
    validateRoutine(
      routine({ conditions: [{ type: "timeOfDay", startHour: 18, endHour: 23, startMinute: 30 }] }),
      KNOWN_ACTION_IDS
    ).valid,
    true
  );

  const result = validateRoutine(
    routine({ conditions: [{ type: "timeOfDay", startHour: 18, endHour: 23, endMinute: 60 }] }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /minutes must be between 0 and 59/);
});

test("a routine mixing several condition types validates as a whole", () => {
  const result = validateRoutine(
    routine({
      conditionLogic: "all",
      conditions: [
        { type: "timeOfDay", startHour: 18, endHour: 23, startMinute: 0, endMinute: 0 },
        { type: "daysOfWeek", days: [1, 2, 3, 4, 5] },
        { type: "spotifyNotAlreadyPlaying" },
        { type: "actionsNotAlreadyActive" },
      ],
      sessionRestriction: "oncePerSession",
      description: "Evening study",
    }),
    KNOWN_ACTION_IDS
  );

  assert.equal(result.valid, true);
});

test("one malformed condition rejects the whole routine, so nothing partial is saved", () => {
  const result = validateRoutine(
    routine({
      conditions: [
        { type: "timeOfDay", startHour: 18, endHour: 23 },
        { type: "daysOfWeek", days: [99] },
      ],
    }),
    KNOWN_ACTION_IDS
  );
  assert.equal(result.valid, false);
});
