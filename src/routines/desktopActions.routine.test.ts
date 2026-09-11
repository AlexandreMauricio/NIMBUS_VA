import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionService } from "../actions/actionService";
import { AppActionProvider } from "../actions/providers/appActionProvider";
import { FileActionProvider } from "../actions/providers/fileActionProvider";
import { MediaActionProvider } from "../actions/providers/mediaActionProvider";
import { SystemActionProvider } from "../actions/providers/systemActionProvider";
import { TimerActionProvider } from "../actions/providers/timerActionProvider";
import { FakeDesktop } from "../actions/providers/testing/fakeDesktop";
import { ContextEventBus } from "../events/eventBus";
import { TimerService } from "../timers/timerService";
import { RoutineService } from "./routineService";
import { Routine, validateRoutine } from "./types";

/**
 * The desktop actions inside the Routine engine — no routine-specific code
 * exists for them; they are just more registered actions.
 */

const DISCORD = "C:\\Apps\\Discord\\Discord.exe";
const GAME = "C:\\Games\\Terraria\\Terraria.exe";

function setup() {
  const bus = new ContextEventBus();
  const desktop = new FakeDesktop();
  desktop.addFile(DISCORD);
  desktop.addFile(GAME);
  const timers = new TimerService(
    bus,
    () => new Date(),
    (() => 1) as unknown as typeof setInterval,
    (() => {}) as unknown as typeof clearInterval
  );
  const actions = new ActionService();
  actions.register(new AppActionProvider(desktop));
  actions.register(new FileActionProvider(desktop));
  actions.register(new MediaActionProvider(desktop));
  actions.register(new TimerActionProvider(timers));
  actions.register(
    new SystemActionProvider(
      async () => {},
      undefined,
      async () => {}
    )
  );
  return { bus, desktop, timers, actions };
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "gaming",
    name: "Start gaming",
    enabled: true,
    trigger: { type: "applicationOpened", application: "steam.exe", matchMode: "exact" },
    conditions: [],
    suggestion: {
      title: "Game time?",
      message: "Launch Discord and the game?",
      primaryLabel: "Yes",
      secondaryLabel: "No",
    },
    actions: [
      { actionId: "app.launch", params: { path: DISCORD } },
      { actionId: "app.launch", params: { path: GAME } },
      { actionId: "media.setVolume", params: { volumePercent: 40 } },
    ],
    cooldownMinutes: 30,
    ...overrides,
  };
}

test("the desktop actions pass routine validation like any other registered action", () => {
  const { actions } = setup();
  const ids = actions.listActions().map((a) => a.id);

  assert.equal(validateRoutine(routine(), ids).valid, true);
});

test("the existing actions are still registered alongside the new ones", () => {
  const ids = setup()
    .actions.listActions()
    .map((a) => a.id);

  for (const id of ["timer.start", "timer.stop", "timer.addStudy", "system.openUrl"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const id of [
    "app.launch",
    "app.focus",
    "files.openFile",
    "media.setVolume",
    "media.mute",
    "system.lock",
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test("an accepted routine runs its desktop steps in order, and nothing before", async () => {
  const { bus, desktop, actions } = setup();
  const r = routine();
  const service = new RoutineService(() => [r], actions, bus);
  service.start();

  bus.publish({
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName: "steam.exe",
    windowTitle: null,
    activation: "launched",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const [suggestion] = service.getActiveSuggestions();
  assert.ok(suggestion, "the trigger produced a suggestion");
  assert.deepEqual(desktop.calls, [], "a suggestion runs nothing by itself");
  assert.deepEqual(
    suggestion.actionSummary.map((a) => a.service),
    ["applications", "applications", "media"]
  );

  const results = await service.acceptSuggestion(suggestion.id);

  assert.deepEqual(
    results.map((res) => res.status),
    ["success", "success", "success"]
  );
  assert.deepEqual(desktop.calls, [`launch ${DISCORD}`, `launch ${GAME}`, "volume 40"]);
  service.stop();
});

test("a study routine mixes desktop, media and timer steps", async () => {
  const { bus, desktop, actions, timers } = setup();
  desktop.windows.set("chrome", 1);
  const r = routine({
    id: "study",
    actions: [
      { actionId: "app.focus", params: { processName: "chrome" } },
      { actionId: "media.setVolume", params: { volumePercent: 30 } },
      { actionId: "timer.start", params: { mode: "pomodoro", cycles: 2 } },
    ],
  });
  const service = new RoutineService(() => [r], actions, bus);

  const results = await service.runRoutineNow("study");

  assert.deepEqual(
    results.map((res) => res.status),
    ["success", "success", "success"]
  );
  assert.deepEqual(desktop.calls, ["focus chrome", "volume 30"]);
  const timer = timers.getState()!;
  assert.equal(timer.title, "Study 1 of 2");
  timers.cancel(timer.id);
});

test("a failing desktop step doesn't stop the steps after it", async () => {
  const { bus, desktop, actions } = setup();
  const r = routine({
    actions: [
      { actionId: "app.launch", params: { path: "C:\\Apps\\Missing.exe" } },
      { actionId: "media.mute", params: {} },
    ],
  });
  const service = new RoutineService(() => [r], actions, bus);

  const results = await service.runRoutineNow("gaming");

  assert.deepEqual(
    results.map((res) => res.status),
    ["failure", "success"]
  );
  assert.equal(results[0].error?.category, "not_found");
  assert.deepEqual(desktop.calls, ["muted true"]);
});
