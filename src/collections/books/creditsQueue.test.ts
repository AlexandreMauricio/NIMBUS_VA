import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditsQueue, CreditsQueueState, QueueIssue } from "./creditsQueue";
import type { IssueCredits } from "./readings";

const issue = (number: number): QueueIssue => ({ series: "Iron Man", year: 1968, number });

function harness(answers: Array<"ok" | "none" | "pause" | "down">) {
  const pending = [issue(1), issue(2), issue(3)];
  const saved: Array<[number, IssueCredits]> = [];
  const sleeps: number[] = [];
  const states: CreditsQueueState[] = [];
  let clock = 0;
  class Paused extends Error {}
  const queue = new CreditsQueue({
    pending: (limit) => ({ issues: pending.slice(0, limit), total: pending.length }),
    lookup: async (i) => {
      const answer = answers.shift() ?? "ok";
      if (answer === "pause") throw new Paused("pause");
      if (answer === "down") throw new Error("GCD couldn't be reached.");
      return answer === "none"
        ? null
        : { title: null, characters: [`Iron Man ${i.number}`], writers: [], artists: [], pageCount: null };
    },
    save: (i, credits) => {
      saved.push([i.number, credits]);
      pending.splice(
        pending.findIndex((p) => p.number === i.number),
        1
      );
    },
    pauseSeconds: (err) => (err instanceof Paused ? 1500 : null),
    onState: (state) => states.push(state),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { queue, saved, sleeps, states, done: () => new Promise((r) => setTimeout(r, 0)) };
}

async function settle(queue: CreditsQueue): Promise<void> {
  for (let i = 0; i < 50 && queue.state().running; i++) await new Promise((r) => setTimeout(r, 0));
}

test("works through every issue by itself, remembering GCD's 'no such issue'", async () => {
  const h = harness(["ok", "none", "ok"]);
  h.queue.kick();
  await settle(h.queue);
  assert.deepEqual(
    h.saved.map(([n, c]) => [n, c.characters]),
    [
      [1, ["Iron Man 1"]],
      [2, []],
      [3, ["Iron Man 3"]],
    ]
  );
  assert.equal(h.queue.state().running, false);
  assert.equal(h.queue.state().done, 3);
  assert.deepEqual(h.sleeps, [4000, 4000, 4000], "a gentle gap between lookups");
});

test("a GCD pause is waited out, the pace slows, and it carries on without being asked", async () => {
  const h = harness(["ok", "pause", "ok", "ok"]);
  h.queue.kick();
  await settle(h.queue);
  assert.equal(h.saved.length, 3);
  assert.ok(h.sleeps.includes(1_505_000), "waits the pause GCD named");
  assert.ok(
    h.states.some((s) => s.pausedUntil !== null),
    "says it's paused"
  );
  assert.equal(h.queue.state().gapSeconds, 6);
  assert.equal(h.queue.state().pausedUntil, null);
});

test("a network problem is retried after a while; kick does nothing when there's nothing to do or it's running", async () => {
  const h = harness(["down", "ok", "ok", "ok"]);
  h.queue.kick();
  h.queue.kick();
  await settle(h.queue);
  assert.equal(h.saved.length, 3);
  assert.ok(h.sleeps.includes(120_000));
  const before = h.states.length;
  h.queue.kick();
  assert.equal(h.states.length, before, "nothing left: no run");
});
