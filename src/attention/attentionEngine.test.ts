import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionEngine } from "./attentionEngine";
import { AttentionSignal, AttentionSituation } from "./types";

const T0 = Date.parse("2026-09-11T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const FAR = "2026-09-12T00:00:00.000Z";
const OPTS = { popups: true };

function sig(key: string, overrides: Partial<AttentionSignal> = {}): AttentionSignal {
  return {
    key,
    source: "calendar",
    kind: "test",
    title: key,
    description: "",
    importance: 70,
    urgency: 85,
    relevance: 70,
    reasons: [],
    expiresAt: FAR,
    ...overrides,
  };
}

/** 76 — high */
const HIGH = (key: string) => sig(key);
/** 82 — urgent */
const URGENT = (key: string) => sig(key, { urgency: 100 });
/** 48 — normal */
const NORMAL = (key: string) => sig(key, { source: "weather", urgency: 40, importance: 35, relevance: 80 });
/** 20 — low */
const LOW = (key: string) => sig(key, { source: "stocks", urgency: 20, importance: 20, relevance: 20 });
/** 67 — high, and a routine's suggestion */
const ROUTINE = (key: string) => sig(key, { source: "routines", urgency: 80, importance: 50, relevance: 70 });
/** 72 — high */
const TASK = (key: string) => sig(key, { source: "tasks", urgency: 90, importance: 60, relevance: 60 });

function situation(now: Date, overrides: Partial<AttentionSituation> = {}): AttentionSituation {
  return { now, activity: null, timerRunning: false, popup: null, ...overrides };
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

// ----------------------------------------------------------- deduplication

test("the same thing on every cycle is one item, shown once", () => {
  const engine = new AttentionEngine();

  const first = engine.evaluate([HIGH("meeting"), HIGH("meeting")], situation(at(0)), OPTS);
  assert.equal(first.items.length, 1, "duplicates in one evaluation are one item");
  assert.deepEqual(
    first.surfaced.map((i) => [i.id, i.channel]),
    [["meeting", "popup"]]
  );

  for (let minute = 1; minute <= 5; minute++) {
    const again = engine.evaluate([HIGH("meeting")], situation(at(minute)), OPTS);
    assert.equal(again.surfaced.length, 0, `minute ${minute}`);
    assert.equal(again.items[0].decision, "shown");
    assert.equal(again.items[0].surfaceCount, 1);
  }
});

test("an item comes back only when it becomes more pressing — and never once answered", () => {
  const engine = new AttentionEngine();
  engine.evaluate([HIGH("meeting")], situation(at(0)), OPTS);
  const escalated = engine.evaluate([URGENT("meeting")], situation(at(10)), OPTS);
  assert.deepEqual(ids(escalated.surfaced), ["meeting"]);
  assert.match(escalated.surfaced[0].decisionReason, /more pressing/);

  for (const answer of ["acknowledge", "dismiss"] as const) {
    const answered = new AttentionEngine();
    answered.evaluate([HIGH("meeting")], situation(at(0)), OPTS);
    answered[answer]("meeting", at(1));
    const later = answered.evaluate([URGENT("meeting")], situation(at(10)), OPTS);
    assert.equal(later.surfaced.length, 0, answer);
    assert.equal(later.items[0].decision, answer === "acknowledge" ? "acknowledged" : "dismissed");
  }
});

test("expired items are no longer considered", () => {
  const engine = new AttentionEngine();
  const expiring = sig("x", { expiresAt: at(5).toISOString() });
  assert.equal(engine.evaluate([expiring], situation(at(0)), OPTS).items.length, 1);
  assert.equal(engine.evaluate([expiring], situation(at(6)), OPTS).items.length, 0);
});

// --------------------------------------------------------------- conflicts

test("six things at once: one interruption, a few feed posts, the rest wait with a reason", () => {
  const engine = new AttentionEngine();
  const result = engine.evaluate(
    [NORMAL("rain"), TASK("task"), ROUTINE("routine"), HIGH("meeting"), NORMAL("overdue"), LOW("stocks")],
    situation(at(0)),
    OPTS
  );

  assert.deepEqual(
    result.surfaced.map((i) => [i.id, i.channel]),
    [
      ["meeting", "popup"],
      ["overdue", "feed"],
      ["rain", "feed"],
    ]
  );
  assert.deepEqual(ids(result.items), ["meeting", "task", "routine", "overdue", "rain", "stocks"]);
  const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
  assert.equal(byId.task.decision, "held");
  assert.match(byId.task.decisionReason, /Outranked by "meeting"/);
  assert.equal(byId.routine.decision, "held");
  assert.equal(byId.stocks.decision, "quiet", "kept, not dropped");
});

test("what waited is shown when the way is clear — a routine's suggestion first, it expires soon", () => {
  const engine = new AttentionEngine();
  const all = [TASK("task"), ROUTINE("routine"), HIGH("meeting")];
  engine.evaluate(all, situation(at(0)), OPTS);

  const oneMinuteLater = engine.evaluate(all, situation(at(1)), OPTS);
  assert.deepEqual(ids(oneMinuteLater.surfaced), ["routine"]);
  const task = oneMinuteLater.items.find((i) => i.id === "task")!;
  assert.match(task.decisionReason, /interrupted 1 min ago/);

  assert.deepEqual(ids(engine.evaluate(all, situation(at(2)), OPTS).surfaced), []);
  assert.deepEqual(ids(engine.evaluate(all, situation(at(3)), OPTS).surfaced), ["task"]);
});

test("an urgent item may replace a less important one on screen; others wait for the screen", () => {
  const onScreen = { itemId: "routine", score: 67, expiresAt: at(1).toISOString() };

  const high = new AttentionEngine().evaluate([HIGH("meeting")], situation(at(0), { popup: onScreen }), OPTS);
  assert.equal(high.surfaced.length, 0);
  assert.match(high.items[0].decisionReason, /another suggestion is on screen/);

  const urgent = new AttentionEngine().evaluate(
    [URGENT("fire")],
    situation(at(0), { popup: onScreen }),
    OPTS
  );
  assert.deepEqual(ids(urgent.surfaced), ["fire"]);

  const expiredPopup = { ...onScreen, expiresAt: at(-1).toISOString() };
  const free = new AttentionEngine().evaluate(
    [HIGH("meeting")],
    situation(at(0), { popup: expiredPopup }),
    OPTS
  );
  assert.deepEqual(ids(free.surfaced), ["meeting"], "an expired popup doesn't block");
});

// ---------------------------------------------------------------- activity

test("while busy, casual items go quiet — kept, and shown once the user is free", () => {
  const engine = new AttentionEngine();
  const studying = { name: "Study", startedAt: at(-30).toISOString(), durationMs: 30 * 60_000 };

  const busy = engine.evaluate(
    [NORMAL("rain"), HIGH("meeting")],
    situation(at(0), { activity: studying }),
    OPTS
  );
  assert.equal(busy.busy, true);
  assert.equal(busy.busyReason, "You're busy with Study");
  const rain = busy.items.find((i) => i.id === "rain")!;
  assert.equal(rain.decision, "quiet");
  assert.equal(rain.score, 33);
  assert.deepEqual(ids(busy.surfaced), ["meeting"], "a meeting still gets through mid-study");

  const free = engine.evaluate([NORMAL("rain")], situation(at(30)), OPTS);
  assert.deepEqual(ids(free.surfaced), ["rain"]);
});

// ---------------------------------------------------------------- channels

test("with popups off, high items go to the feed — routine suggestions still interrupt", () => {
  const result = new AttentionEngine().evaluate([HIGH("meeting"), ROUTINE("routine")], situation(at(0)), {
    popups: false,
  });
  assert.deepEqual(result.surfaced.map((i) => [i.id, i.channel]).sort(), [
    ["meeting", "feed"],
    ["routine", "popup"],
  ]);
});

test("feed posts are limited per round; the rest follow on the next", () => {
  const engine = new AttentionEngine();
  const five = ["a", "b", "c", "d", "e"].map(NORMAL);
  assert.deepEqual(ids(engine.evaluate(five, situation(at(0)), OPTS).surfaced), ["a", "b", "c"]);
  assert.deepEqual(ids(engine.evaluate(five, situation(at(1)), OPTS).surfaced), ["d", "e"]);
});

test("equal scores are ordered by key, so the result never depends on input order", () => {
  const one = new AttentionEngine().evaluate([NORMAL("b"), NORMAL("a")], situation(at(0)), OPTS);
  const two = new AttentionEngine().evaluate([NORMAL("a"), NORMAL("b")], situation(at(0)), OPTS);
  assert.deepEqual(ids(one.items), ["a", "b"]);
  assert.deepEqual(one.items, two.items);
});

test("every item explains itself", () => {
  const [item] = new AttentionEngine().evaluate([HIGH("meeting")], situation(at(0)), OPTS).items;
  assert.equal(item.factors.length, 3);
  assert.equal(item.priority, "high");
  assert.equal(item.score, 76);
  assert.ok(item.decisionReason.length > 0);
});
