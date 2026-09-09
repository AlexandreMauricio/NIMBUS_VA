import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateConditions } from "./conditionEvaluator";
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
  assert.equal(await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => false }), true);
});

test("spotifyNotAlreadyPlaying fails when Spotify is already playing", async () => {
  const conditions: RoutineCondition[] = [{ type: "spotifyNotAlreadyPlaying" }];
  assert.equal(await evaluateConditions(conditions, { now: new Date(), isSpotifyPlaying: async () => true }), false);
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
