import { test } from "node:test";
import assert from "node:assert/strict";
import { busyState, priorityFor, scoreSignal } from "./scoring";
import { AttentionSignal, AttentionSituation } from "./types";

const NOW = new Date("2026-09-11T10:00:00Z");

function signal(overrides: Partial<AttentionSignal> = {}): AttentionSignal {
  return {
    key: "k",
    source: "calendar",
    kind: "test",
    title: "T",
    description: "D",
    importance: 70,
    urgency: 85,
    relevance: 70,
    reasons: [],
    expiresAt: "2026-09-11T11:00:00Z",
    ...overrides,
  };
}

const idle: AttentionSituation = { now: NOW, activity: null, timerRunning: false, popup: null };
const studying: AttentionSituation = {
  ...idle,
  activity: { name: "Study", startedAt: "2026-09-11T09:30:00Z", durationMs: 30 * 60_000 },
};
const RAIN = { urgency: 30, importance: 35, relevance: 80 };

test("the score is the weighted sum of urgency, importance and relevance, factor by factor", () => {
  const result = scoreSignal(signal(), idle);

  assert.equal(result.score, 76);
  assert.equal(result.priority, "high");
  assert.deepEqual(
    result.factors.map((f) => f.points),
    [34, 24.5, 17.5]
  );
  assert.equal(result.factors[0].label, "Urgency 85 × 0.40");
});

test("scores fall into four bands", () => {
  const cases: Array<[number, string]> = [
    [100, "urgent"],
    [80, "urgent"],
    [79, "high"],
    [65, "high"],
    [64, "normal"],
    [40, "normal"],
    [39, "low"],
    [0, "low"],
  ];
  for (const [score, band] of cases) assert.equal(priorityFor(score), band, String(score));
});

test("while busy, what isn't time-critical is held back — and only that", () => {
  const rain = scoreSignal(signal(RAIN), studying);
  // 12 + 12.25 + 20 = 44.25, then −15 for being busy
  assert.equal(rain.score, 29);
  assert.equal(rain.priority, "low");
  assert.ok(rain.factors.some((f) => f.points === -15 && /Study/.test(f.label)));

  assert.equal(scoreSignal(signal(), studying).score, 76, "urgency 85 gets through untouched");
  assert.equal(
    scoreSignal(signal(RAIN), { ...idle, timerRunning: true }).score,
    29,
    "a running timer counts too"
  );
  assert.equal(scoreSignal(signal(RAIN), idle).score, 44);
});

test("an item about the current activity is more relevant", () => {
  const result = scoreSignal(
    signal({ urgency: 40, importance: 40, relevance: 60, relatedActivity: "study" }),
    studying
  );
  // 16 + 14 + 15 = 45, −15 while busy, +10 for being about Study
  assert.equal(result.score, 40);
  assert.equal(result.priority, "normal");
  assert.ok(result.factors.some((f) => f.points === 10 && /Study/.test(f.label)));
});

test("inputs are clamped, and nonsense counts as zero", () => {
  assert.equal(scoreSignal(signal({ urgency: 150, importance: 100, relevance: 100 }), idle).score, 100);
  assert.equal(scoreSignal(signal({ urgency: Number.NaN, importance: 0, relevance: 0 }), idle).score, 0);
});

test("busy means an activity in progress or a running timer", () => {
  assert.deepEqual(busyState(idle), { busy: false, reason: null });
  assert.deepEqual(busyState(studying), { busy: true, reason: "You're busy with Study" });
  assert.equal(busyState({ ...idle, timerRunning: true }).busy, true);
});
