import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutineService } from "./routineService";
import { ActionService } from "../actions/actionService";
import { ActionDefinition, ActionProvider, ActionResult, ActionValidationResult } from "../actions/types";
import { ContextEventBus } from "../events/eventBus";
import { ApplicationOpenedEvent } from "../events/types";
import { Routine } from "./types";

function actionResult(actionId: string, status: "success" | "failure" = "success"): ActionResult {
  const now = new Date().toISOString();
  return status === "success"
    ? { actionId, status, message: "done", startedAt: now, finishedAt: now, durationMs: 1 }
    : { actionId, status, error: { category: "unknown", message: "failed" }, startedAt: now, finishedAt: now, durationMs: 1 };
}

/** A stub provider that records call order and can be told to fail specific actions. */
class RecordingProvider implements ActionProvider {
  readonly id = "demo";
  readonly displayName = "Demo";
  calls: string[] = [];
  failingActionIds = new Set<string>();
  actions: ActionDefinition[] = [
    { id: "demo.one", name: "One", description: "", parameters: [], readOnly: false, changesExternalState: true, requiresConfirmation: false, affectsService: "demo" },
    { id: "demo.two", name: "Two", description: "", parameters: [], readOnly: false, changesExternalState: true, requiresConfirmation: false, affectsService: "demo" },
    { id: "demo.three", name: "Three", description: "", parameters: [], readOnly: false, changesExternalState: true, requiresConfirmation: false, affectsService: "demo" },
  ];
  listActions() {
    return this.actions;
  }
  isAvailable() {
    return true;
  }
  validate(): ActionValidationResult {
    return { valid: true };
  }
  async execute(actionId: string): Promise<ActionResult> {
    this.calls.push(actionId);
    return actionResult(actionId, this.failingActionIds.has(actionId) ? "failure" : "success");
  }
}

function appEvent(overrides: Partial<ApplicationOpenedEvent> = {}): ApplicationOpenedEvent {
  return {
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName: "steam.exe",
    windowTitle: null,
    activation: "launched",
    ...overrides,
  };
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Gaming",
    enabled: true,
    trigger: { type: "applicationOpened", application: "steam.exe", matchMode: "exact" },
    conditions: [],
    suggestion: { title: "Gaming?", message: "Play your gaming playlist?", primaryLabel: "Play", secondaryLabel: "Not now" },
    actions: [{ actionId: "demo.one", params: {} }],
    cooldownMinutes: 30,
    ...overrides,
  };
}

function setup(routines: Routine[], now: () => Date = () => new Date(), isSpotifyPlaying?: () => boolean) {
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => routines, actionService, eventBus, now, isSpotifyPlaying, 60_000);
  service.start();
  return { service, eventBus, provider };
}

test("a matching trigger creates a suggestion rather than executing any action", async () => {
  const { service, eventBus, provider } = setup([routine()]);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));

  assert.equal(provider.calls.length, 0);
  const suggestions = service.getActiveSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].routineId, "r1");
  assert.equal(suggestions[0].title, "Gaming?");
});

test("a suggestion's actionSummary is built from each action's registered name, in order — never hard-coded", async () => {
  const r = routine({ actions: [{ actionId: "demo.two", params: {} }, { actionId: "demo.one", params: {} }] });
  const { service, eventBus } = setup([r]);
  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));

  const [suggestion] = service.getActiveSuggestions();
  assert.deepEqual(suggestion.actionSummary, [
    { label: "Two", service: "demo" },
    { label: "One", service: "demo" },
  ]);
});

test("a suggestion's actionSummary falls back to the raw action id for an unregistered action", async () => {
  const r = routine({ actions: [{ actionId: "ghost.action", params: {} }] });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [r], actionService, eventBus);
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  const [suggestion] = service.getActiveSuggestions();
  assert.deepEqual(suggestion.actionSummary, [{ label: "ghost.action", service: "ghost" }]);
});

test("onSuggestion notifies listeners of a new suggestion", async () => {
  const { eventBus, service } = setup([routine()]);
  const received: string[] = [];
  service.onSuggestion((s) => received.push(s.id));

  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));

  assert.equal(received.length, 1);
});

test("a disabled routine never suggests", async () => {
  const { eventBus, service } = setup([routine({ enabled: false })]);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("a non-matching event does not create a suggestion", async () => {
  const { eventBus, service } = setup([routine()]);
  eventBus.publish(appEvent({ executableName: "notepad.exe" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("accepting a suggestion executes the routine's action", async () => {
  const { eventBus, service, provider } = setup([routine()]);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));

  const [suggestion] = service.getActiveSuggestions();
  const results = await service.acceptSuggestion(suggestion.id);

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0], "demo.one");
  assert.equal(results[0].status, "success");
});

test("accepting a suggestion removes it from the active set", async () => {
  const { eventBus, service } = setup([routine()]);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));

  const [suggestion] = service.getActiveSuggestions();
  await service.acceptSuggestion(suggestion.id);
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("dismissing a suggestion never executes any action", async () => {
  const { eventBus, service, provider } = setup([routine()]);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));

  const [suggestion] = service.getActiveSuggestions();
  service.dismissSuggestion(suggestion.id);

  assert.equal(provider.calls.length, 0);
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("multiple actions execute in the configured order", async () => {
  const r = routine({ actions: [{ actionId: "demo.two", params: {} }, { actionId: "demo.one", params: {} }, { actionId: "demo.three", params: {} }] });
  const { eventBus, service, provider } = setup([r]);
  eventBus.publish(appEvent());
  await new Promise((r2) => setImmediate(r2));

  const [suggestion] = service.getActiveSuggestions();
  await service.acceptSuggestion(suggestion.id);

  assert.deepEqual(provider.calls, ["demo.two", "demo.one", "demo.three"]);
});

test("a failing action step does not prevent later steps from running", async () => {
  const r = routine({ actions: [{ actionId: "demo.one", params: {} }, { actionId: "demo.two", params: {} }] });
  const { eventBus, service, provider } = setup([r]);
  provider.failingActionIds.add("demo.one");

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  const [suggestion] = service.getActiveSuggestions();
  const results = await service.acceptSuggestion(suggestion.id);

  assert.deepEqual(provider.calls, ["demo.one", "demo.two"]);
  assert.equal(results[0].status, "failure");
  assert.equal(results[1].status, "success");
});

test("cooldown prevents an immediate repeat suggestion for the same routine", async () => {
  let currentTime = new Date(2026, 0, 1, 10, 0, 0);
  const { eventBus, service } = setup([routine({ cooldownMinutes: 30 })], () => currentTime);

  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 1);

  service.dismissSuggestion(service.getActiveSuggestions()[0].id);

  // Re-trigger a few seconds later (e.g. tab-switch-and-back) — should NOT re-suggest.
  currentTime = new Date(currentTime.getTime() + 5_000);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("after the cooldown elapses, the routine can suggest again", async () => {
  let currentTime = new Date(2026, 0, 1, 10, 0, 0);
  const { eventBus, service } = setup([routine({ cooldownMinutes: 30 })], () => currentTime);

  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  service.dismissSuggestion(service.getActiveSuggestions()[0].id);

  currentTime = new Date(currentTime.getTime() + 31 * 60_000);
  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 1);
});

test("a spotifyNotAlreadyPlaying condition blocks the suggestion when Spotify is already playing", async () => {
  const r = routine({ conditions: [{ type: "spotifyNotAlreadyPlaying" }] });
  const { eventBus, service } = setup([r], undefined, () => true);
  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("a spotifyNotAlreadyPlaying condition allows the suggestion when Spotify is not playing", async () => {
  const r = routine({ conditions: [{ type: "spotifyNotAlreadyPlaying" }] });
  const { eventBus, service } = setup([r], undefined, () => false);
  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  assert.equal(service.getActiveSuggestions().length, 1);
});

test("getActiveSuggestions omits suggestions past their expiry", async () => {
  let currentTime = new Date(2026, 0, 1, 10, 0, 0);
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [routine()], actionService, eventBus, () => currentTime, undefined, 1000);
  service.start();

  eventBus.publish(appEvent());
  await new Promise((r) => setImmediate(r));
  assert.equal(service.getActiveSuggestions().length, 1);

  currentTime = new Date(currentTime.getTime() + 1001);
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("testRoutine executes a routine's actions directly, bypassing trigger/cooldown/conditions", async () => {
  const r = routine({ enabled: false, conditions: [{ type: "spotifyNotAlreadyPlaying" }] });
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date(), () => true);

  const results = await service.testRoutine("r1");
  assert.equal(provider.calls.length, 1);
  assert.equal(results[0].status, "success");
});

test("accepting an unknown suggestion id is a no-op, not an error", async () => {
  const { service } = setup([routine()]);
  const results = await service.acceptSuggestion("does-not-exist");
  assert.deepEqual(results, []);
});

test("onActionExecuted fires for each step run via testRoutine", async () => {
  const r = routine({ actions: [{ actionId: "demo.one", params: {} }, { actionId: "demo.two", params: {} }] });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const executedIds: string[] = [];
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date(), undefined, undefined, (id) =>
    executedIds.push(id)
  );

  await service.testRoutine("r1");
  assert.deepEqual(executedIds, ["demo.one", "demo.two"]);
});

test("onActionExecuted fires for each step run via acceptSuggestion", async () => {
  const r = routine({ actions: [{ actionId: "demo.one", params: {} }] });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const executedIds: string[] = [];
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date(), undefined, undefined, (id) =>
    executedIds.push(id)
  );
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  const [suggestion] = service.getActiveSuggestions();
  await service.acceptSuggestion(suggestion.id);

  assert.deepEqual(executedIds, ["demo.one"]);
});

test("a throwing onActionExecuted listener does not prevent remaining action steps from running", async () => {
  const r = routine({ actions: [{ actionId: "demo.one", params: {} }, { actionId: "demo.two", params: {} }] });
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date(), undefined, undefined, () => {
    throw new Error("boom");
  });

  const results = await service.testRoutine("r1");
  assert.deepEqual(provider.calls, ["demo.one", "demo.two"]);
  assert.equal(results.length, 2);
});

test("a routine with the actionsNotAlreadyActive condition does not suggest while its actions already appear active", async () => {
  const r = routine({ conditions: [{ type: "actionsNotAlreadyActive" }] });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const service = new RoutineService(
    () => [r],
    actionService,
    eventBus,
    () => new Date(),
    undefined,
    60_000,
    undefined,
    async () => true // "already active"
  );
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("a routine with the actionsNotAlreadyActive condition still suggests once its actions are no longer active", async () => {
  const r = routine({ conditions: [{ type: "actionsNotAlreadyActive" }] });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const service = new RoutineService(
    () => [r],
    actionService,
    eventBus,
    () => new Date(),
    undefined,
    60_000,
    undefined,
    async () => false // no longer active
  );
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  assert.equal(service.getActiveSuggestions().length, 1);
});

test("the actionsNotAlreadyActive checker receives this specific routine's action steps", async () => {
  const r = routine({
    conditions: [{ type: "actionsNotAlreadyActive" }],
    actions: [{ actionId: "demo.one", params: { foo: "bar" } }],
  });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  let receivedSteps: unknown = null;
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date(), undefined, 60_000, undefined, async (steps) => {
    receivedSteps = steps;
    return false;
  });
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(receivedSteps, [{ actionId: "demo.one", params: { foo: "bar" } }]);
});

test("a routine with autoRun runs its actions immediately on a matching trigger, with no suggestion ever created", async () => {
  const r = routine({ autoRun: true });
  const { service, eventBus, provider } = setup([r]);

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(provider.calls, ["demo.one"]);
  assert.equal(service.getActiveSuggestions().length, 0);
});

test("a routine with autoRun still respects cooldown — a second matching event within cooldown doesn't re-run it", async () => {
  const r = routine({ autoRun: true, cooldownMinutes: 30 });
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date());
  service.start();

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));
  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(provider.calls, ["demo.one"]); // only once, not twice
});

test("a routine without autoRun (or autoRun: false) still creates a normal suggestion", async () => {
  const r = routine({ autoRun: false });
  const { service, eventBus, provider } = setup([r]);

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(provider.calls, []); // nothing executed yet — only suggested
  assert.equal(service.getActiveSuggestions().length, 1);
});

test("onAutoRun is notified with the routine and its action results, and never fires for a normal (non-autoRun) routine", async () => {
  const autoRoutine = routine({ id: "auto1", autoRun: true });
  const normalRoutine = routine({ id: "normal1", autoRun: false, trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" } });
  const actionService = new ActionService();
  actionService.register(new RecordingProvider());
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [autoRoutine, normalRoutine], actionService, eventBus, () => new Date());
  service.start();

  const autoRunCalls: Array<{ routineId: string }> = [];
  service.onAutoRun((r, results) => {
    autoRunCalls.push({ routineId: r.id });
    void results;
  });

  eventBus.publish(appEvent({ executableName: "steam.exe" }));
  eventBus.publish(appEvent({ executableName: "other.exe" }));
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(autoRunCalls, [{ routineId: "auto1" }]);
});

test("a throwing onAutoRun listener does not prevent the routine's actions from having already run", async () => {
  const r = routine({ autoRun: true });
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(() => [r], actionService, eventBus, () => new Date());
  service.start();
  service.onAutoRun(() => {
    throw new Error("boom");
  });

  eventBus.publish(appEvent());
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(provider.calls, ["demo.one"]);
});
