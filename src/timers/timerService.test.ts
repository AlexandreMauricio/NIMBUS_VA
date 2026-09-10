import { test } from "node:test";
import assert from "node:assert/strict";
import { TimerService } from "./timerService";
import { ContextEventBus } from "../events/eventBus";

/** A fake interval clock: `advance(ms)` runs however many ticks that represents, synchronously. */
function fakeTimers(tickMs: number) {
  let handler: (() => void) | null = null;
  const setIntervalFn = ((fn: () => void) => {
    handler = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalFn = (() => {
    handler = null;
  }) as typeof clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    advance(ms: number) {
      const ticks = Math.floor(ms / tickMs);
      for (let i = 0; i < ticks; i++) handler?.();
    },
  };
}

test("start creates a running timer with the full duration remaining", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 5 * 60_000, "focus");
  assert.equal(state.status, "running");
  assert.equal(state.remainingMs, 5 * 60_000);
  assert.equal(state.title, "Study");
  assert.equal(state.type, "focus");
});

test("ticking decreases remaining time", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 10_000, "focus");
  timers.advance(3000);
  const updated = service.getState(state.id);
  assert.equal(updated?.remainingMs, 7000);
});

test("pause stops the countdown", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 10_000, "focus");
  timers.advance(2000);
  service.pause(state.id);
  timers.advance(5000); // should have no effect — paused
  const updated = service.getState(state.id);
  assert.equal(updated?.status, "paused");
  assert.equal(updated?.remainingMs, 8000);
});

test("resume continues the countdown from where it paused", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 10_000, "focus");
  timers.advance(2000);
  service.pause(state.id);
  service.resume(state.id);
  timers.advance(3000);
  const updated = service.getState(state.id);
  assert.equal(updated?.status, "running");
  assert.equal(updated?.remainingMs, 5000);
});

test("cancel stops the timer and clears it from getState", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 10_000, "focus");
  const cancelled = service.cancel(state.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(service.getState(state.id), null);

  timers.advance(20_000); // should have no further effect
});

test("reaching zero marks the timer completed and stops ticking further", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 3000, "focus");
  timers.advance(3000);
  const updated = service.getState(state.id);
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.remainingMs, 0);
  assert.ok(updated?.completedAt);
});

test("completion publishes a timerCompleted Context Event", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Study", 2000, "focus");
  timers.advance(2000);
  assert.deepEqual(events, ["timerCompleted"]);
  void state;
});

test("the timerCompleted event carries the timer's id, title, and type", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  let captured: unknown = null;
  bus.subscribe((e) => {
    if (e.type === "timerCompleted") captured = e;
  });
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.start("Deep Work", 1000, "pomodoro");
  timers.advance(1000);

  assert.equal((captured as { timerId: string }).timerId, state.id);
  assert.equal((captured as { title: string }).title, "Deep Work");
  assert.equal((captured as { timerType: string }).timerType, "pomodoro");
});

test("starting a new timer replaces (cancels) any previous one", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const first = service.start("First", 10_000, "focus");
  const second = service.start("Second", 5000, "focus");

  assert.equal(service.getState(first.id), null);
  assert.equal(service.getState(second.id)?.title, "Second");
});

test("getState with no argument returns the current timer, if any", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  assert.equal(service.getState(), null);
  service.start("Study", 10_000, "focus");
  assert.equal(service.getState()?.title, "Study");
});

test("pausing/resuming an id that isn't the current timer is a no-op returning the current state", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  service.start("Study", 10_000, "focus");
  const result = service.pause("not-the-real-id");
  assert.equal(result?.status, "running"); // untouched
});

test("startPlan begins the first phase immediately", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.startPlan([
    { title: "Study 1 of 2", durationMs: 3000, type: "focus" },
    { title: "Break", durationMs: 2000, type: "break" },
    { title: "Study 2 of 2", durationMs: 3000, type: "focus" },
  ]);
  assert.equal(state.title, "Study 1 of 2");
  assert.equal(state.status, "running");
});

test("startPlan automatically starts the next phase once the current one completes", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  service.startPlan([
    { title: "Study 1 of 2", durationMs: 3000, type: "focus" },
    { title: "Break", durationMs: 2000, type: "break" },
    { title: "Study 2 of 2", durationMs: 3000, type: "focus" },
  ]);

  timers.advance(3000); // Study 1 finishes
  let state = service.getState();
  assert.equal(state?.title, "Break");
  assert.equal(state?.status, "running");
  assert.equal(state?.remainingMs, 2000);

  timers.advance(2000); // Break finishes
  state = service.getState();
  assert.equal(state?.title, "Study 2 of 2");
  assert.equal(state?.status, "running");

  timers.advance(3000); // Study 2 finishes — no more phases queued
  state = service.getState();
  assert.equal(state?.title, "Study 2 of 2");
  assert.equal(state?.status, "completed");
});

test("a plan publishes one timerCompleted event per phase, each with that phase's type", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const events: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "timerCompleted") events.push(e.timerType);
  });
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  service.startPlan([
    { title: "Study 1 of 2", durationMs: 1000, type: "focus" },
    { title: "Break", durationMs: 1000, type: "break" },
    { title: "Study 2 of 2", durationMs: 1000, type: "focus" },
  ]);
  timers.advance(3000);

  assert.deepEqual(events, ["focus", "break", "focus"]);
});

test("cancelling mid-plan stops the whole plan, not just the current phase", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  const state = service.startPlan([
    { title: "Study 1 of 2", durationMs: 3000, type: "focus" },
    { title: "Break", durationMs: 2000, type: "break" },
  ]);
  service.cancel(state.id);
  timers.advance(10_000); // even if this many ms passed, no queued phase should start
  assert.equal(service.getState(), null);
});

test("a plain start() clears any pending plan phases from an earlier startPlan", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const service = new TimerService(bus, () => new Date(), timers.setIntervalFn, timers.clearIntervalFn, 1000);

  service.startPlan([
    { title: "Study 1 of 2", durationMs: 1000, type: "focus" },
    { title: "Break", durationMs: 1000, type: "break" },
  ]);
  service.start("Something else", 1000, "custom");
  timers.advance(1000); // the "Something else" timer completes — Break must not follow it
  assert.equal(service.getState()?.title, "Something else");
  assert.equal(service.getState()?.status, "completed");
});

// ------------------------------------------------- wall clock, not ticks

test("time the machine spent asleep still counts down", () => {
  // An interval doesn't fire during sleep. Counting ticks alone meant a
  // 45-minute study with 20 minutes of sleep in it finished 20 minutes late.
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  let nowMs = new Date("2026-09-10T09:00:00Z").getTime();
  const service = new TimerService(
    bus,
    () => new Date(nowMs),
    timers.setIntervalFn,
    timers.clearIntervalFn,
    1000
  );

  const state = service.start("Study", 45 * 60_000, "focus");
  nowMs += 20 * 60_000; // asleep: no ticks happen
  timers.advance(1000); // the first tick after waking

  assert.equal(service.getState(state.id)?.remainingMs, 25 * 60_000);
});

test("a timer whose end passed during sleep completes on the first tick after", () => {
  const bus = new ContextEventBus();
  const completed: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "timerCompleted") completed.push(e.title);
  });
  const timers = fakeTimers(1000);
  let nowMs = new Date("2026-09-10T09:00:00Z").getTime();
  const service = new TimerService(
    bus,
    () => new Date(nowMs),
    timers.setIntervalFn,
    timers.clearIntervalFn,
    1000
  );

  service.start("Study", 10 * 60_000, "focus");
  nowMs += 30 * 60_000;
  timers.advance(1000);

  assert.deepEqual(completed, ["Study"]);
});

test("time spent paused is not counted, even by the clock", () => {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  let nowMs = new Date("2026-09-10T09:00:00Z").getTime();
  const service = new TimerService(
    bus,
    () => new Date(nowMs),
    timers.setIntervalFn,
    timers.clearIntervalFn,
    1000
  );

  const state = service.start("Study", 10 * 60_000, "focus");
  // A minute of real running: each tick arrives as a second passes.
  for (let i = 0; i < 60; i++) {
    nowMs += 1000;
    timers.advance(1000);
  }
  service.pause(state.id);
  nowMs += 60 * 60_000; // an hour away, paused
  service.resume(state.id);
  nowMs += 1000;
  timers.advance(1000);

  assert.equal(service.getState(state.id)?.remainingMs, 9 * 60_000 - 1000);
});
