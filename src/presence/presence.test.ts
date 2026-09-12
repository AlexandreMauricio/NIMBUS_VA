import { test } from "node:test";
import assert from "node:assert/strict";
import { PresenceService, judgePresence } from "./presence";

const NOW = new Date("2026-09-13T20:00:00Z");
const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

test("recent input means at the PC, whatever the phone says", () => {
  const judged = judgePresence(
    { idleSeconds: 30, phoneLastSeen: minutesBefore(600), phoneChosen: true },
    NOW
  );
  assert.equal(judged.state, "atPc");
});

test("idle with the phone recently on Wi-Fi is home — a phone asleep for a while still counts", () => {
  assert.equal(
    judgePresence({ idleSeconds: 20 * 60, phoneLastSeen: minutesBefore(3), phoneChosen: true }, NOW).state,
    "home"
  );
  const asleep = judgePresence(
    { idleSeconds: 60 * 60, phoneLastSeen: minutesBefore(40), phoneChosen: true },
    NOW
  );
  assert.equal(asleep.state, "home", "40 minutes unseen is within the grace period");
  assert.match(asleep.reason, /40 min ago/);
});

test("idle with the phone gone past the grace period is away", () => {
  const judged = judgePresence(
    { idleSeconds: 3 * 3600, phoneLastSeen: minutesBefore(90), phoneChosen: true },
    NOW
  );
  assert.equal(judged.state, "away");
  assert.match(judged.reason, /90 min/);
});

test("idle with no phone chosen can't tell home from out — and says so", () => {
  const judged = judgePresence({ idleSeconds: 10 * 60, phoneLastSeen: null, phoneChosen: false }, NOW);
  assert.equal(judged.state, "idle");
  assert.match(judged.reason, /choose your phone/);
});

test("no idle reading assumes at the PC, rather than silently stopping everything", () => {
  assert.equal(
    judgePresence({ idleSeconds: null, phoneLastSeen: null, phoneChosen: false }, NOW).state,
    "atPc"
  );
});

test("the service reports changes once, keeps 'since', and survives broken signals", () => {
  let idle = 0;
  let clock = NOW;
  const changes: string[] = [];
  const service = new PresenceService(
    () => idle,
    () => ({ chosen: true, lastSeen: minutesBefore(100) }),
    () => clock
  );
  service.onChange((snapshot) => changes.push(snapshot.state));

  assert.equal(service.isAtPc(), true);
  service.update();
  assert.deepEqual(changes, [], "no change, no event");

  idle = 6 * 60;
  clock = new Date(NOW.getTime() + 60_000);
  service.update();
  service.update();
  assert.deepEqual(changes, ["away"], "reported once");
  assert.equal(service.get().since, clock.toISOString());

  const broken = new PresenceService(
    () => {
      throw new Error("no idle API");
    },
    () => {
      throw new Error("no network");
    },
    () => NOW
  );
  assert.equal(broken.update().state, "atPc");
});
