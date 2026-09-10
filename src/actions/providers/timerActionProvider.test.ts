import { test } from "node:test";
import assert from "node:assert/strict";
import { TimerActionProvider, TIMER_ACTIONS } from "./timerActionProvider";
import { TimerService } from "../../timers/timerService";
import { ContextEventBus } from "../../events/eventBus";

function provider(): TimerActionProvider {
  const bus = new ContextEventBus();
  const timerService = new TimerService(bus, () => new Date(), setInterval, clearInterval, 1000);
  return new TimerActionProvider(timerService);
}

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

function providerWithFakeTimers(): {
  provider: TimerActionProvider;
  timerService: TimerService;
  advance: (ms: number) => void;
} {
  const bus = new ContextEventBus();
  const timers = fakeTimers(1000);
  const timerService = new TimerService(
    bus,
    () => new Date(),
    timers.setIntervalFn,
    timers.clearIntervalFn,
    1000
  );
  return { provider: new TimerActionProvider(timerService), timerService, advance: timers.advance };
}

test("isAvailable is always true — a timer needs no auth/config", () => {
  assert.equal(provider().isAvailable(), true);
});

test("validate rejects a missing/non-numeric duration", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, {}).valid, false);
  assert.equal(p.validate(TIMER_ACTIONS.START, { duration: "long" }).valid, false);
  assert.equal(p.validate(TIMER_ACTIONS.START, { duration: -5 }).valid, false);
  assert.equal(p.validate(TIMER_ACTIONS.START, { duration: 0 }).valid, false);
});

test("validate accepts a positive duration with no type/title", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, { duration: 25 }).valid, true);
});

test("validate rejects an unknown timer type", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, { duration: 25, type: "sprint" }).valid, false);
});

test("execute starts a timer and returns its id/title/type in the result data", async () => {
  const p = provider();
  const result = await p.execute(TIMER_ACTIONS.START, { duration: 120, type: "focus", title: "Study" });
  assert.equal(result.status, "success");
  const data = result.data as { timerId: string; title: string; type: string; durationMs: number };
  assert.ok(data.timerId);
  assert.equal(data.title, "Study");
  assert.equal(data.type, "focus");
  assert.equal(data.durationMs, 120 * 60_000);
});

test("execute defaults the title based on timer type when none is given", async () => {
  const p = provider();
  const result = await p.execute(TIMER_ACTIONS.START, { duration: 25, type: "pomodoro" });
  const data = result.data as { title: string };
  assert.equal(data.title, "Pomodoro");
});

test("execute defaults to a focus timer when no type is given", async () => {
  const p = provider();
  const result = await p.execute(TIMER_ACTIONS.START, { duration: 25 });
  const data = result.data as { type: string };
  assert.equal(data.type, "focus");
});

test("the success message reflects the configured duration", async () => {
  const p = provider();
  const result = await p.execute(TIMER_ACTIONS.START, { duration: 120, type: "focus", title: "Study" });
  assert.match(result.message!, /2 hours/);
});

test("listActions declares timer.start with no confirmation required", () => {
  const p = provider();
  const start = p.listActions().find((a) => a.id === TIMER_ACTIONS.START);
  assert.notEqual(start, undefined);
  assert.equal(start!.requiresConfirmation, false);
  assert.equal(start!.affectsService, "timer");
});

test("listActions also declares timer.addStudy, and nothing else", () => {
  const ids = provider()
    .listActions()
    .map((a) => a.id)
    .sort();
  assert.deepEqual(ids, [TIMER_ACTIONS.ADD_STUDY, TIMER_ACTIONS.START].sort());
});

test("validate accepts mode: pomodoro with no other params (all default)", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, { mode: "pomodoro" }).valid, true);
});

test("validate rejects a non-positive studyMinutes/breakMinutes/cycles in pomodoro mode", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, { mode: "pomodoro", studyMinutes: 0 }).valid, false);
  assert.equal(p.validate(TIMER_ACTIONS.START, { mode: "pomodoro", breakMinutes: -5 }).valid, false);
  assert.equal(p.validate(TIMER_ACTIONS.START, { mode: "pomodoro", cycles: 0 }).valid, false);
});

test("validate rejects an unknown mode", () => {
  const p = provider();
  assert.equal(p.validate(TIMER_ACTIONS.START, { mode: "sprint", duration: 25 }).valid, false);
});

test("validate in pomodoro mode does not require duration (single-mode-only param)", () => {
  const p = provider();
  assert.equal(
    p.validate(TIMER_ACTIONS.START, { mode: "pomodoro", studyMinutes: 45, breakMinutes: 15, cycles: 2 })
      .valid,
    true
  );
});

test("execute with mode: pomodoro starts a plan whose first phase is Study 1 of N", async () => {
  const { provider: p, timerService } = providerWithFakeTimers();
  const result = await p.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    studyMinutes: 45,
    breakMinutes: 15,
    cycles: 2,
  });
  assert.equal(result.status, "success");
  const state = timerService.getState();
  assert.equal(state?.title, "Study 1 of 2");
  assert.equal(state?.type, "focus");
  assert.equal(state?.durationMs, 45 * 60_000);
});

test("a pomodoro plan runs Study -> Break -> Study for 2 cycles, with no trailing break", async () => {
  const { provider: p, timerService, advance } = providerWithFakeTimers();
  await p.execute(TIMER_ACTIONS.START, { mode: "pomodoro", studyMinutes: 1, breakMinutes: 1, cycles: 2 });

  advance(60_000); // Study 1 finishes
  assert.equal(timerService.getState()?.title, "Break");

  advance(60_000); // Break finishes
  assert.equal(timerService.getState()?.title, "Study 2 of 2");

  advance(60_000); // Study 2 finishes — plan is done, no further phase
  const finalState = timerService.getState();
  assert.equal(finalState?.title, "Study 2 of 2");
  assert.equal(finalState?.status, "completed");
});

test("a single-cycle pomodoro plan is just one study phase with no break, and no '1 of 1' suffix", async () => {
  const { provider: p, timerService } = providerWithFakeTimers();
  await p.execute(TIMER_ACTIONS.START, { mode: "pomodoro", studyMinutes: 45, breakMinutes: 15, cycles: 1 });
  assert.equal(timerService.getState()?.title, "Study");
});

test("pomodoro mode uses defaults (45/15/1) when studyMinutes/breakMinutes/cycles are omitted", async () => {
  const { provider: p, timerService } = providerWithFakeTimers();
  await p.execute(TIMER_ACTIONS.START, { mode: "pomodoro" });
  const state = timerService.getState();
  assert.equal(state?.durationMs, 45 * 60_000);
  assert.equal(state?.title, "Study");
});

test("pomodoro mode's baseTitle (from the title param) is used for study phase names", async () => {
  const { provider: p, timerService } = providerWithFakeTimers();
  await p.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    title: "Deep Work",
    cycles: 2,
    studyMinutes: 1,
    breakMinutes: 1,
  });
  assert.equal(timerService.getState()?.title, "Deep Work 1 of 2");
});

/* ------------------- Extending a running Pomodoro plan ------------------- */

/** A provider plus the TimerService behind it, with a controllable clock. */
function pomodoroSetup(tickMs = 1000) {
  const clock = fakeTimers(tickMs);
  const bus = new ContextEventBus();
  const timerService = new TimerService(
    bus,
    () => new Date(),
    clock.setIntervalFn,
    clock.clearIntervalFn,
    tickMs
  );
  return { provider: new TimerActionProvider(timerService), timerService, clock, bus };
}

test("adding a study renumbers the plan instead of leaving a stale total", async () => {
  const { provider, timerService } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    studyMinutes: 45,
    breakMinutes: 15,
    cycles: 2,
    title: "Study Time",
  });
  assert.equal(timerService.getState()!.title, "Study Time 1 of 2");

  const result = await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  assert.equal(result.status, "success");
  assert.equal(timerService.getState()!.title, "Study Time 1 of 3", "the running phase is relabelled");
  const plan = timerService.getPlan()!;
  assert.deepEqual(
    plan.phases.map((p) => p.title),
    ["Study Time 1 of 3", "Break", "Study Time 2 of 3", "Break", "Study Time 3 of 3"]
  );
});

test("the extra study keeps the durations the plan is already using", async () => {
  const { provider, timerService } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    studyMinutes: 45,
    breakMinutes: 15,
    cycles: 2,
  });

  await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  const plan = timerService.getPlan()!;
  assert.equal(plan.phases[4].durationMs, 45 * 60_000, "new study matches the existing study length");
  assert.equal(plan.phases[3].durationMs, 15 * 60_000, "new break matches the existing break length");
});

test("the phase in progress keeps its remaining time when a study is added", async () => {
  const { provider, timerService, clock } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    studyMinutes: 45,
    breakMinutes: 15,
    cycles: 2,
  });
  clock.advance(10 * 60_000);
  const before = timerService.getState()!.remainingMs;

  await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  assert.equal(timerService.getState()!.remainingMs, before, "the countdown must not restart or jump");
});

test("adding several studies at once is supported", async () => {
  const { provider, timerService } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, { mode: "pomodoro", cycles: 2 });

  await provider.execute(TIMER_ACTIONS.ADD_STUDY, { count: 2 });

  const studies = timerService.getPlan()!.phases.filter((p) => p.type === "focus");
  assert.equal(studies.length, 4);
});

test("adding a study twice does not accumulate numbering suffixes", async () => {
  const { provider, timerService } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, { mode: "pomodoro", cycles: 2, title: "Study" });

  await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});
  await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  assert.equal(timerService.getState()!.title, "Study 1 of 4");
});

test("the extended plan actually runs into the added study", async () => {
  const { provider, timerService, clock } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, {
    mode: "pomodoro",
    studyMinutes: 1,
    breakMinutes: 1,
    cycles: 1,
  });
  // A single-cycle plan has no break to copy; extending gives it one.
  await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  clock.advance(60_000); // finish study 1 -> break
  assert.equal(timerService.getState()!.type, "break");
  clock.advance(15 * 60_000); // finish the (default-length) break -> study 2
  assert.equal(timerService.getState()!.title, "Study 2 of 2");
});

test("adding a study with no timer running fails cleanly", async () => {
  const { provider } = pomodoroSetup();

  const result = await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  assert.equal(result.status, "failure");
  assert.match(result.error!.message, /No timer is running/);
});

test("a non-positive count is rejected before anything runs", () => {
  const { provider } = pomodoroSetup();

  assert.equal(provider.validate(TIMER_ACTIONS.ADD_STUDY, { count: 0 }).valid, false);
  assert.equal(provider.validate(TIMER_ACTIONS.ADD_STUDY, { count: 1.5 }).valid, false);
  assert.equal(provider.validate(TIMER_ACTIONS.ADD_STUDY, {}).valid, true);
});

test("a plain single timer can be extended into a two-study plan", async () => {
  const { provider, timerService } = pomodoroSetup();
  await provider.execute(TIMER_ACTIONS.START, { mode: "single", duration: 30, title: "Focus" });

  const result = await provider.execute(TIMER_ACTIONS.ADD_STUDY, {});

  assert.equal(result.status, "success");
  assert.equal(timerService.getState()!.title, "Focus 1 of 2");
});
