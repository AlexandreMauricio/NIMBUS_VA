import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutineService } from "./routineService";
import { ActionService } from "../actions/actionService";
import { ActionDefinition, ActionProvider, ActionResult, ActionValidationResult } from "../actions/types";
import { ContextEventBus } from "../events/eventBus";
import { ApplicationClosedEvent, ApplicationOpenedEvent, WebsiteOpenedEvent } from "../events/types";
import { Routine, RoutineRuntimeState, RoutineStateStore } from "./types";

/**
 * Tests for Routine Engine 2.0 — condition logic, time windows, session
 * restrictions, cooldown persistence, explanations and history.
 *
 * Kept in its own file rather than appended to routineService.test.ts:
 * that file covers the original engine's contract, and keeping it intact
 * and separately readable is what proves the upgrade did not quietly
 * change the behaviour underneath it.
 */

class RecordingProvider implements ActionProvider {
  readonly id = "demo";
  readonly displayName = "Demo";
  calls: string[] = [];
  actions: ActionDefinition[] = [
    {
      id: "demo.one",
      name: "One",
      description: "",
      parameters: [],
      readOnly: false,
      changesExternalState: true,
      requiresConfirmation: false,
      affectsService: "demo",
    },
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
    const now = new Date().toISOString();
    return { actionId, status: "success", message: "ok", startedAt: now, finishedAt: now, durationMs: 1 };
  }
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Test routine",
    enabled: true,
    trigger: { type: "applicationOpened", application: "app.exe", matchMode: "exact" },
    conditions: [],
    suggestion: { title: "T", message: "M", primaryLabel: "Yes", secondaryLabel: "No" },
    actions: [{ actionId: "demo.one", params: {} }],
    cooldownMinutes: 30,
    ...overrides,
  };
}

function appEvent(executableName = "app.exe"): ApplicationOpenedEvent {
  return {
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName,
    windowTitle: null,
    activation: "launched",
  };
}

function appClosedEvent(executableName = "app.exe"): ApplicationClosedEvent {
  return {
    id: "e2",
    type: "applicationClosed",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName,
  };
}

function siteEvent(windowTitle: string): WebsiteOpenedEvent {
  return {
    id: "e3",
    type: "websiteOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    browserExecutable: "chrome.exe",
    windowTitle,
    url: null,
    domain: null,
  };
}

function setup(routines: Routine[], now: () => Date = () => new Date(), stateStore?: RoutineStateStore) {
  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);
  const eventBus = new ContextEventBus();
  const service = new RoutineService(
    () => routines,
    actionService,
    eventBus,
    now,
    undefined,
    60_000,
    undefined,
    undefined,
    stateStore
  );
  service.start();
  return { service, eventBus, provider };
}

const settle = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------ backwards compatibility

test("a routine saved before the new fields existed still matches and suggests", async () => {
  // Exactly the shape the old editor produced: no conditionLogic, no
  // sessionRestriction, no description.
  const legacy = routine();
  delete (legacy as Partial<Routine>).conditionLogic;
  delete (legacy as Partial<Routine>).sessionRestriction;
  const { service, eventBus } = setup([legacy]);

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

test("conditions default to ALL when no conditionLogic is saved", async () => {
  const legacy = routine({
    conditions: [{ type: "timeOfDay", startHour: 9, endHour: 17 }, { type: "weekdaysOnly" }],
  });
  delete (legacy as Partial<Routine>).conditionLogic;
  // Sunday 12:00 — the time passes, the weekday check does not.
  const { service, eventBus } = setup([legacy], () => new Date("2026-03-15T12:00:00"));

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0, "ALL must still be the default");
});

// -------------------------------------------------------- AND / OR logic

test("conditionLogic 'all' requires every condition", async () => {
  const r = routine({
    conditionLogic: "all",
    conditions: [
      { type: "timeOfDay", startHour: 9, endHour: 17 },
      { type: "daysOfWeek", days: [0] }, // Sunday only
    ],
  });
  // Monday 12:00 — time passes, day fails.
  const { service, eventBus } = setup([r], () => new Date("2026-03-16T12:00:00"));

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0);
});

test("conditionLogic 'any' needs only one condition to hold", async () => {
  const r = routine({
    conditionLogic: "any",
    conditions: [
      { type: "timeOfDay", startHour: 9, endHour: 17 },
      { type: "daysOfWeek", days: [0] }, // Sunday only — fails on a Monday
    ],
  });
  const { service, eventBus } = setup([r], () => new Date("2026-03-16T12:00:00"));

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

test("conditionLogic 'any' still blocks when no condition holds", async () => {
  const r = routine({
    conditionLogic: "any",
    conditions: [
      { type: "timeOfDay", startHour: 9, endHour: 17 },
      { type: "daysOfWeek", days: [0] },
    ],
  });
  // Monday 03:00 — neither holds.
  const { service, eventBus } = setup([r], () => new Date("2026-03-16T03:00:00"));

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0);
});

// ------------------------------------------------------------- cooldowns

test("cooldown state is restored from the store, so a restart does not bypass it", async () => {
  const firedAt = new Date("2026-03-16T12:00:00").getTime();
  const saved: RoutineRuntimeState = { lastTriggeredAt: { r1: firedAt } };
  const store: RoutineStateStore = { load: () => saved, save: () => undefined };

  // 10 minutes later, into a 30-minute cooldown — as if NIMBUS had just
  // restarted and the routine fired shortly before the restart.
  const { service, eventBus } = setup(
    [routine({ cooldownMinutes: 30 })],
    () => new Date("2026-03-16T12:10:00"),
    store
  );

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0, "the restored cooldown must still apply");
});

test("a cooldown restored from the store expires normally", async () => {
  const firedAt = new Date("2026-03-16T12:00:00").getTime();
  const store: RoutineStateStore = {
    load: () => ({ lastTriggeredAt: { r1: firedAt } }),
    save: () => undefined,
  };
  const { service, eventBus } = setup(
    [routine({ cooldownMinutes: 30 })],
    () => new Date("2026-03-16T12:31:00"),
    store
  );

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

test("firing a routine writes the cooldown timestamp to the store", async () => {
  const writes: RoutineRuntimeState[] = [];
  const store: RoutineStateStore = {
    load: () => ({ lastTriggeredAt: {} }),
    save: (state) => writes.push(structuredClone(state)),
  };
  const { eventBus } = setup([routine()], () => new Date("2026-03-16T12:00:00"), store);

  eventBus.publish(appEvent());
  await settle();

  assert.equal(writes.length >= 1, true);
  assert.equal(writes[writes.length - 1].lastTriggeredAt.r1, new Date("2026-03-16T12:00:00").getTime());
});

test("a corrupt state store never stops the engine starting", async () => {
  const store: RoutineStateStore = {
    load: () => {
      throw new Error("corrupt");
    },
    save: () => undefined,
  };
  const { service, eventBus } = setup([routine()], () => new Date(), store);

  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

// -------------------------------------------------- session restrictions

test("oncePerSession suppresses a repeat trigger for the same application", async () => {
  const r = routine({ sessionRestriction: "oncePerSession", cooldownMinutes: 0 });
  const { service, eventBus } = setup([r]);

  eventBus.publish(appEvent());
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0]?.id ?? "");

  // The same application triggering again — switching away and back.
  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0);
});

test("closing the application ends the session, so the next launch suggests again", async () => {
  const r = routine({ sessionRestriction: "oncePerSession", cooldownMinutes: 0 });
  const { service, eventBus } = setup([r]);

  eventBus.publish(appEvent());
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0]?.id ?? "");

  eventBus.publish(appClosedEvent());
  await settle();
  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

test("a different application is a different session", async () => {
  const r = routine({
    sessionRestriction: "oncePerSession",
    cooldownMinutes: 0,
    trigger: { type: "applicationOpened", application: "a.exe,b.exe", matchMode: "exact" },
  });
  const { service, eventBus } = setup([r]);

  eventBus.publish(appEvent("a.exe"));
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0]?.id ?? "");
  eventBus.publish(appEvent("b.exe"));
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

test("repeated identical website events do not re-suggest under oncePerSession", async () => {
  // The activity monitor re-emits a browser window whenever its title
  // changes; the same title arriving twice is the same page.
  const r = routine({
    sessionRestriction: "oncePerSession",
    cooldownMinutes: 0,
    trigger: { type: "websiteOpened", matchField: "windowTitle", pattern: "docs", matchMode: "contains" },
  });
  const { service, eventBus } = setup([r]);

  eventBus.publish(siteEvent("Docs - Chrome"));
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0]?.id ?? "");
  eventBus.publish(siteEvent("Docs - Chrome"));
  await settle();

  assert.equal(service.getActiveSuggestions().length, 0);
});

test("without a session restriction, only the cooldown limits repeats", async () => {
  const r = routine({ cooldownMinutes: 0 });
  const { service, eventBus } = setup([r]);

  eventBus.publish(appEvent());
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0]?.id ?? "");
  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getActiveSuggestions().length, 1);
});

// ------------------------------------------------------------ explaining

test("testRoutine explains a match without executing any action", async () => {
  const r = routine({
    conditions: [{ type: "timeOfDay", startHour: 9, endHour: 17 }],
  });
  const { service, provider } = setup([r], () => new Date("2026-03-16T12:00:00"));

  const evaluation = await service.testRoutine("r1");

  assert.equal(provider.calls.length, 0, "testing must never run actions");
  assert.equal(evaluation?.matched, true);
  assert.equal(
    evaluation?.checks.some((c) => c.label.includes("18:00") === false && c.passed),
    true
  );
});

test("testRoutine explains why a routine does not match", async () => {
  const r = routine({ conditions: [{ type: "timeOfDay", startHour: 18, endHour: 23 }] });
  const { service, provider } = setup([r], () => new Date("2026-03-16T12:00:00"));

  const evaluation = await service.testRoutine("r1");

  assert.equal(provider.calls.length, 0);
  assert.equal(evaluation?.matched, false);
  assert.equal(evaluation?.blockedBy, "conditions");
  const failing = evaluation?.checks.filter((c) => !c.passed) ?? [];
  assert.equal(failing.length, 1);
  assert.match(failing[0].label, /Time is outside 18:00-23:00/);
});

test("the explanation names the cooldown as the blocker when that is the reason", async () => {
  let clock = new Date("2026-03-16T12:00:00");
  const { service, eventBus } = setup([routine({ cooldownMinutes: 30 })], () => clock);

  eventBus.publish(appEvent());
  await settle();

  clock = new Date("2026-03-16T12:05:00");
  const evaluation = await service.testRoutine("r1");

  assert.equal(evaluation?.matched, false);
  assert.equal(evaluation?.blockedBy, "cooldown");
});

test("testRoutine returns null for a routine that no longer exists", async () => {
  const { service } = setup([routine()]);
  assert.equal(await service.testRoutine("nope"), null);
});

test("runRoutineNow still executes, unlike testRoutine", async () => {
  const { service, provider } = setup([routine()]);

  await service.runRoutineNow("r1");

  assert.deepEqual(provider.calls, ["demo.one"]);
});

// -------------------------------------------------------------- history

test("history records a suggestion and the user's response", async () => {
  const { service, eventBus } = setup([routine()]);

  eventBus.publish(appEvent());
  await settle();
  await service.acceptSuggestion(service.getActiveSuggestions()[0].id);

  const kinds = service.getHistory().map((h) => h.kind);
  assert.equal(kinds.includes("matched"), true);
  assert.equal(kinds.includes("suggested"), true);
  assert.equal(kinds.includes("accepted"), true);
  assert.equal(kinds.includes("actionsCompleted"), true);
});

test("history records a dismissal", async () => {
  const { service, eventBus } = setup([routine()]);

  eventBus.publish(appEvent());
  await settle();
  service.dismissSuggestion(service.getActiveSuggestions()[0].id);

  assert.equal(
    service.getHistory().some((h) => h.kind === "dismissed"),
    true
  );
});

test("history records why a routine was blocked", async () => {
  let clock = new Date("2026-03-16T12:00:00");
  const { service, eventBus } = setup([routine({ cooldownMinutes: 30 })], () => clock);

  eventBus.publish(appEvent());
  await settle();
  clock = new Date("2026-03-16T12:05:00");
  eventBus.publish(appEvent());
  await settle();

  assert.equal(
    service.getHistory().some((h) => h.kind === "blockedByCooldown"),
    true
  );
});

test("history records a session block distinctly from a cooldown block", async () => {
  const r = routine({ sessionRestriction: "oncePerSession", cooldownMinutes: 0 });
  const { service, eventBus } = setup([r]);

  eventBus.publish(appEvent());
  await settle();
  eventBus.publish(appEvent());
  await settle();

  assert.equal(
    service.getHistory().some((h) => h.kind === "blockedBySession"),
    true
  );
});

test("history holds only routine decisions — no window titles or user content", async () => {
  const r = routine({
    trigger: { type: "websiteOpened", matchField: "windowTitle", pattern: "bank", matchMode: "contains" },
  });
  const { service, eventBus } = setup([r]);

  eventBus.publish(siteEvent("My Bank - Statements for March - Chrome"));
  await settle();

  const serialized = JSON.stringify(service.getHistory());
  assert.equal(serialized.includes("Statements"), false);
  assert.equal(serialized.includes("My Bank"), false);
});

test("history is capped so it cannot grow without bound", async () => {
  const r = routine({ cooldownMinutes: 0 });
  const { service, eventBus } = setup([r]);

  for (let i = 0; i < 250; i++) {
    eventBus.publish(appEvent());
    await settle();
  }

  assert.equal(service.getHistory().length <= 200, true);
});

// --------------------------------------------------------- last-triggered

test("getLastTriggeredAt reports when a routine actually fired", async () => {
  const clock = new Date("2026-03-16T12:00:00");
  const { service, eventBus } = setup([routine()], () => clock);

  assert.deepEqual(service.getLastTriggeredAt(), {});
  eventBus.publish(appEvent());
  await settle();

  assert.equal(service.getLastTriggeredAt().r1, clock.getTime());
});
