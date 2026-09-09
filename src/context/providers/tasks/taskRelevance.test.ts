import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskUrgency, UrgencyInput } from "./taskRelevance";

function input(overrides: Partial<UrgencyInput> = {}): UrgencyInput {
  return {
    isOverdue: false,
    isDueToday: false,
    minutesUntilDue: null,
    minutesUntilReminder: null,
    sourceHighPriority: false,
    ageDays: null,
    completed: false,
    ...overrides,
  };
}

test("a task with no deadline and no signals classifies as low", () => {
  const { urgency, signals } = classifyTaskUrgency(input());
  assert.equal(urgency, "low");
  assert.equal(signals.isOverdue, false);
  assert.equal(signals.isDueToday, false);
});

test("a completed task always classifies as low regardless of other signals", () => {
  const { urgency } = classifyTaskUrgency(
    input({ isOverdue: true, sourceHighPriority: true, completed: true })
  );
  assert.equal(urgency, "low");
});

test("an overdue task classifies as at least important", () => {
  const { urgency, signals } = classifyTaskUrgency(input({ isOverdue: true }));
  assert.equal(signals.isOverdue, true);
  assert.ok(urgency === "important" || urgency === "high");
});

test("a task due today (but not soon) classifies as normal or higher", () => {
  const { urgency } = classifyTaskUrgency(input({ isDueToday: true, minutesUntilDue: 600 }));
  assert.notEqual(urgency, "low");
});

test("a task due within the imminent window classifies as high", () => {
  const { urgency, signals } = classifyTaskUrgency(input({ isDueToday: true, minutesUntilDue: 30 }));
  assert.equal(signals.isDueSoon, true);
  assert.equal(urgency, "high");
});

test("a task due in exactly the imminent boundary (120 minutes) is still due-soon", () => {
  const { signals } = classifyTaskUrgency(input({ minutesUntilDue: 120 }));
  assert.equal(signals.isDueSoon, true);
});

test("a task due just past the imminent window is not due-soon", () => {
  const { signals } = classifyTaskUrgency(input({ minutesUntilDue: 121 }));
  assert.equal(signals.isDueSoon, false);
});

test("an overdue task combined with due-today and high priority classifies as high", () => {
  const { urgency } = classifyTaskUrgency(
    input({ isOverdue: true, isDueToday: true, sourceHighPriority: true })
  );
  assert.equal(urgency, "high");
});

test("explicit high priority alone nudges urgency up but isn't enough for high on its own", () => {
  const { urgency, signals } = classifyTaskUrgency(input({ sourceHighPriority: true }));
  assert.equal(signals.hasHighPriority, true);
  assert.notEqual(urgency, "low");
});

test("a reminder approaching soon is reflected in signals and raises urgency", () => {
  const { urgency, signals } = classifyTaskUrgency(input({ minutesUntilReminder: 10 }));
  assert.equal(signals.hasReminderApproaching, true);
  assert.notEqual(urgency, "low");
});

test("a reminder far in the future is not flagged as approaching", () => {
  const { signals } = classifyTaskUrgency(input({ minutesUntilReminder: 500 }));
  assert.equal(signals.hasReminderApproaching, false);
});

test("an old still-open task is flagged stale", () => {
  const { signals } = classifyTaskUrgency(input({ ageDays: 30 }));
  assert.equal(signals.isStale, true);
});

test("a recently created task is not flagged stale", () => {
  const { signals } = classifyTaskUrgency(input({ ageDays: 1 }));
  assert.equal(signals.isStale, false);
});

test("urgency signals are always returned alongside the tier, never a bare verdict", () => {
  const { signals } = classifyTaskUrgency(input({ isOverdue: true }));
  assert.equal(typeof signals.isOverdue, "boolean");
  assert.equal(typeof signals.isDueToday, "boolean");
  assert.equal(typeof signals.isDueSoon, "boolean");
  assert.equal(typeof signals.hasHighPriority, "boolean");
  assert.equal(typeof signals.hasReminderApproaching, "boolean");
  assert.equal(typeof signals.isStale, "boolean");
});
