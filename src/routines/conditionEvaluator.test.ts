import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateConditions, evaluateConditionsDetailed } from "./conditionEvaluator";
import { RoutineCondition } from "./types";

test("an empty condition list always passes", async () => {
  assert.equal(await evaluateConditions([], { now: new Date() }), true);
});

test("timeOfDay passes when the current hour is within a normal (non-wrapping) range", async () => {
  const now = new Date(2026, 0, 1, 14, 0, 0); // 14:00
  const conditions: RoutineCondition[] = [{ type: "timeOfDay", startHour: 9, endHour: 17 }];
  assert.equal(await evaluateConditions(conditions, { now }), true);
});

test("timeOfDay fails when the current hour is outside a normal range", async () => {
  const now = new Date(2026, 0, 1, 20, 0, 0); // 20:00
  const conditions: RoutineCondition[] = [{ type: "timeOfDay", startHour: 9, endHour: 17 }];
  assert.equal(await evaluateConditions(conditions, { now }), false);
});

test("timeOfDay supports a range that wraps past midnight", async () => {
  const conditions: RoutineCondition[] = [{ type: "timeOfDay", startHour: 22, endHour: 6 }];
  assert.equal(await evaluateConditions(conditions, { now: new Date(2026, 0, 1, 23, 0, 0) }), true);
  assert.equal(await evaluateConditions(conditions, { now: new Date(2026, 0, 1, 3, 0, 0) }), true);
  assert.equal(await evaluateConditions(conditions, { now: new Date(2026, 0, 1, 12, 0, 0) }), false);
});

test("weekdaysOnly passes on a weekday and fails on a weekend", async () => {
  const conditions: RoutineCondition[] = [{ type: "weekdaysOnly" }];
  const monday = new Date(2026, 0, 5); // a Monday
  const saturday = new Date(2026, 0, 3); // a Saturday
  assert.equal(await evaluateConditions(conditions, { now: monday }), true);
  assert.equal(await evaluateConditions(conditions, { now: saturday }), false);
});

test("spotifyNotAlreadyPlaying passes when Spotify is not playing", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyNotAlreadyPlaying" }];
  assert.equal(
    await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => false }),
    true
  );
});

test("spotifyNotAlreadyPlaying fails when Spotify is already playing", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyNotAlreadyPlaying" }];
  assert.equal(
    await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => true }),
    false
  );
});

test("spotifyNotAlreadyPlaying passes (fails open) when no playback signal is available", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyNotAlreadyPlaying" }];
  assert.equal(await evaluateConditions(conditions, { now: new Date() }), true);
});

test("spotifyNotAlreadyPlaying passes (fails open) when the playback check throws", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyNotAlreadyPlaying" }];
  assert.equal(
    await evaluateConditions(conditions, {
      now: new Date(),
      isSpotifyPlaying: async () => {
        throw new Error("boom");
      },
    }),
    true
  );
});

test("spotifyIsPlaying is the mirror of spotifyNotAlreadyPlaying", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyIsPlaying" }];
  assert.equal(
    await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => true }),
    true
  );
  assert.equal(
    await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => false }),
    false,
    "this is what stops a wind-down asking to stop music that isn't playing"
  );
});

test("spotifyIsPlaying passes (fails open) with no signal, or when the check throws", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyIsPlaying" }];
  assert.equal(await evaluateConditions(conditions, { now: new Date() }), true);
  assert.equal(
    await evaluateConditions(conditions, {
      now: new Date(),
      isSpotifyPlaying: async () => {
        throw new Error("boom");
      },
    }),
    true
  );
});

test("a condition's explanation says which way round it is", async () => {
  const playing = await evaluateConditionsDetailed([{ type: "spotifyIsPlaying" }], {
    now: new Date(),
    isSpotifyPlaying: async () => false,
  });
  assert.equal(playing.results[0].label, "Spotify is not playing");
  assert.equal(playing.passed, false);
});

test("actionsNotAlreadyActive fails (blocks the routine) when the checker reports the actions are already active", async () => {
  const conditions: RoutineCondition[] = [{ type: "actionsNotAlreadyActive" }];
  assert.equal(
    await evaluateConditions(conditions, {
      now: new Date(),
      routineActions: [{ actionId: "spotify.playPlaylist", params: { playlistUri: "spotify:playlist:abc" } }],
      areActionsAlreadyActive: async () => true,
    }),
    false
  );
});

test("actionsNotAlreadyActive passes when the checker reports the actions are not active", async () => {
  const conditions: RoutineCondition[] = [{ type: "actionsNotAlreadyActive" }];
  assert.equal(
    await evaluateConditions(conditions, {
      now: new Date(),
      routineActions: [{ actionId: "spotify.playPlaylist", params: { playlistUri: "spotify:playlist:abc" } }],
      areActionsAlreadyActive: async () => false,
    }),
    true
  );
});

test("actionsNotAlreadyActive passes (fails open) when no checker/routineActions is available", async () => {
  const conditions: RoutineCondition[] = [{ type: "actionsNotAlreadyActive" }];
  assert.equal(await evaluateConditions(conditions, { now: new Date() }), true);
});

test("actionsNotAlreadyActive passes (fails open) when the checker throws", async () => {
  const conditions: RoutineCondition[] = [{ type: "actionsNotAlreadyActive" }];
  assert.equal(
    await evaluateConditions(conditions, {
      now: new Date(),
      routineActions: [{ actionId: "timer.start", params: {} }],
      areActionsAlreadyActive: async () => {
        throw new Error("boom");
      },
    }),
    true
  );
});

test("the checker receives the routine's own action steps", async () => {
  const conditions: RoutineCondition[] = [{ type: "actionsNotAlreadyActive" }];
  const steps = [{ actionId: "timer.start", params: { duration: 45 } }];
  let received: unknown = null;
  await evaluateConditions(conditions, {
    now: new Date(),
    routineActions: steps,
    areActionsAlreadyActive: async (s) => {
      received = s;
      return false;
    },
  });
  assert.deepEqual(received, steps);
});

test("all conditions must pass — one failing condition fails the whole set", async () => {
  const conditions: RoutineCondition[] = [
    { type: "weekdaysOnly" },
    { type: "timeOfDay", startHour: 9, endHour: 17 },
  ];
  const mondayEvening = new Date(2026, 0, 5, 20, 0, 0); // Monday but outside the hour range
  assert.equal(await evaluateConditions(conditions, { now: mondayEvening }), false);
});

/* ---------------- Routine Engine 2.0: minutes, days, AND/OR ---------------- */

const at = (h: number, m = 0) => new Date(2026, 2, 16, h, m, 0); // a Monday

test("timeOfDay respects start and end minutes", async () => {
  const conditions: RoutineCondition[] = [
    { type: "timeOfDay", startHour: 18, endHour: 23, startMinute: 30, endMinute: 15 },
  ];

  assert.equal(await evaluateConditions(conditions, { now: at(18, 29) }), false);
  assert.equal(await evaluateConditions(conditions, { now: at(18, 30) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(23, 14) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(23, 15) }), false, "end is exclusive");
});

test("a timeOfDay without minutes behaves exactly as it did before they existed", async () => {
  const conditions: RoutineCondition[] = [{ type: "timeOfDay", startHour: 18, endHour: 23 }];

  assert.equal(await evaluateConditions(conditions, { now: at(17, 59) }), false);
  assert.equal(await evaluateConditions(conditions, { now: at(18, 0) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(22, 59) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(23, 0) }), false);
});

test("a midnight-crossing window with minutes covers both sides of midnight", async () => {
  const conditions: RoutineCondition[] = [
    { type: "timeOfDay", startHour: 22, endHour: 2, startMinute: 30, endMinute: 15 },
  ];

  assert.equal(await evaluateConditions(conditions, { now: at(22, 29) }), false);
  assert.equal(await evaluateConditions(conditions, { now: at(22, 30) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(23, 59) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(0, 30) }), true, "after midnight");
  assert.equal(await evaluateConditions(conditions, { now: at(2, 14) }), true);
  assert.equal(await evaluateConditions(conditions, { now: at(2, 15) }), false);
  assert.equal(await evaluateConditions(conditions, { now: at(12, 0) }), false, "midday is outside");
});

test("a window whose start equals its end is treated as always", async () => {
  const conditions: RoutineCondition[] = [{ type: "timeOfDay", startHour: 9, endHour: 9 }];
  assert.equal(await evaluateConditions(conditions, { now: at(3, 0) }), true);
});

test("daysOfWeek passes only on the listed days", async () => {
  const monday: RoutineCondition[] = [{ type: "daysOfWeek", days: [1] }];
  const weekend: RoutineCondition[] = [{ type: "daysOfWeek", days: [0, 6] }];

  assert.equal(await evaluateConditions(monday, { now: at(12) }), true);
  assert.equal(await evaluateConditions(weekend, { now: at(12) }), false);
  // Sunday
  assert.equal(await evaluateConditions(weekend, { now: new Date(2026, 2, 15, 12) }), true);
});

test("daysOfWeek [1..5] is equivalent to weekdaysOnly", async () => {
  const explicit: RoutineCondition[] = [{ type: "daysOfWeek", days: [1, 2, 3, 4, 5] }];
  const legacy: RoutineCondition[] = [{ type: "weekdaysOnly" }];

  for (const day of [15, 16, 17, 18, 19, 20, 21]) {
    const now = new Date(2026, 2, day, 12);
    assert.equal(
      await evaluateConditions(explicit, { now }),
      await evaluateConditions(legacy, { now }),
      `day ${day}`
    );
  }
});

test("'all' requires every condition and 'any' requires just one", async () => {
  const conditions: RoutineCondition[] = [
    { type: "timeOfDay", startHour: 9, endHour: 17 },
    { type: "daysOfWeek", days: [0] }, // Sunday only — false on a Monday
  ];

  assert.equal(await evaluateConditions(conditions, { now: at(12) }, "all"), false);
  assert.equal(await evaluateConditions(conditions, { now: at(12) }, "any"), true);
});

test("'any' fails when nothing holds", async () => {
  const conditions: RoutineCondition[] = [
    { type: "timeOfDay", startHour: 9, endHour: 17 },
    { type: "daysOfWeek", days: [0] },
  ];
  assert.equal(await evaluateConditions(conditions, { now: at(3) }, "any"), false);
});

test("an empty condition list passes under 'any' too, rather than reading as 'none held'", async () => {
  assert.equal(await evaluateConditions([], { now: at(12) }, "any"), true);
});

test("the detailed evaluation reports every condition, not just the decisive one", async () => {
  const conditions: RoutineCondition[] = [
    { type: "timeOfDay", startHour: 9, endHour: 17 },
    { type: "daysOfWeek", days: [0] },
  ];

  const evaluation = await evaluateConditionsDetailed(conditions, { now: at(12) }, "all");

  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.results.length, 2, "a partial list would be a misleading explanation");
  assert.equal(evaluation.results[0].passed, true);
  assert.equal(evaluation.results[1].passed, false);
});

test("each condition carries a readable label describing the outcome", async () => {
  const evaluation = await evaluateConditionsDetailed([{ type: "timeOfDay", startHour: 18, endHour: 23 }], {
    now: at(12),
  });

  assert.match(evaluation.results[0].label, /Time is outside 18:00-23:00/);
});

test("labels name the configured days rather than raw numbers", async () => {
  const evaluation = await evaluateConditionsDetailed([{ type: "daysOfWeek", days: [1, 5] }], {
    now: at(12),
  });

  assert.match(evaluation.results[0].label, /Monday, Friday/);
});
