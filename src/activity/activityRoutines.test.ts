import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityService } from "./activityService";
import { ActivityMapping, ActivitySettings } from "./types";
import { RoutineService } from "../routines/routineService";
import { Routine } from "../routines/types";
import { ActionService } from "../actions/actionService";
import { ActionDefinition, ActionProvider, ActionResult, ActionValidationResult } from "../actions/types";
import { ContextEventBus } from "../events/eventBus";
import { ApplicationOpenedEvent } from "../events/types";

/**
 * Activity and the Routine engine together.
 *
 * The point of these is the boundary: activity is context, routines
 * decide. Detecting an activity must never run anything by itself, and
 * the routine flow that existed before this feature must behave exactly
 * as it did.
 */

class RecordingProvider implements ActionProvider {
  readonly id = "demo";
  readonly displayName = "Demo";
  calls: string[] = [];
  listActions(): ActionDefinition[] {
    return ["playlist", "timer"].map((n) => ({
      id: `demo.${n}`,
      name: n,
      description: "",
      parameters: [],
      readOnly: false,
      changesExternalState: true,
      requiresConfirmation: false,
      affectsService: "demo",
    }));
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
    return { actionId, status: "success", startedAt: now, finishedAt: now, durationMs: 1 };
  }
}

function mapping(overrides: Partial<ActivityMapping> = {}): ActivityMapping {
  return {
    id: "m1",
    enabled: true,
    activity: "Study",
    source: "application",
    value: "study.exe",
    matchMode: "exact",
    priority: 0,
    ...overrides,
  };
}

function studyRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "study",
    name: "Study Mode",
    enabled: true,
    trigger: { type: "applicationOpened", application: "study.exe", matchMode: "exact" },
    conditions: [],
    suggestion: { title: "Study Mode", message: "Start?", primaryLabel: "Yes", secondaryLabel: "No" },
    actions: [
      { actionId: "demo.playlist", params: {} },
      { actionId: "demo.timer", params: {} },
    ],
    cooldownMinutes: 30,
    ...overrides,
  };
}

function appEvent(executableName: string): ApplicationOpenedEvent {
  return {
    id: "e" + Math.random(),
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName,
    windowTitle: null,
    activation: "launched",
  };
}

/** One bus feeding both services, exactly as lifecycle.ts wires them. */
function setup(routines: Routine[], activitySettings: ActivitySettings) {
  const clock = { now: new Date("2026-03-16T09:00:00") };
  const bus = new ContextEventBus();

  const actionService = new ActionService();
  const provider = new RecordingProvider();
  actionService.register(provider);

  const activity = new ActivityService(
    () => activitySettings,
    bus,
    () => clock.now
  );
  activity.start();

  const routineService = new RoutineService(
    () => routines,
    actionService,
    bus,
    () => clock.now,
    undefined,
    60_000,
    undefined,
    undefined,
    undefined,
    () => activity.getCurrentActivity()
  );
  routineService.start();

  return {
    activity,
    routineService,
    bus,
    provider,
    advance: (minutes: number) => {
      clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const activitySettings = (mappings: ActivityMapping[]): ActivitySettings => ({
  enabled: true,
  mappings,
  graceMinutes: 5,
});

// ------------------------------------------------------ the boundary

test("detecting an activity executes nothing on its own", async () => {
  // No routine at all — just a mapping. Nothing may happen.
  const { provider, bus, activity } = setup([], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe"));
  await settle();

  assert.equal(activity.getCurrentActivity()?.activity, "Study");
  assert.equal(provider.calls.length, 0, "activity is context, not a decision");
});

test("an activity condition gates a routine without running it", async () => {
  const r = studyRoutine({
    id: "break",
    trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" },
    conditions: [{ type: "activityIs", activity: "Study" }],
  });
  const { routineService, provider, bus } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe")); // starts the Study activity
  await settle();
  bus.publish(appEvent("other.exe")); // fires the routine's trigger
  await settle();

  assert.equal(routineService.getActiveSuggestions().length, 1, "condition satisfied");
  assert.equal(provider.calls.length, 0, "still only a suggestion");
});

test("an activity condition blocks when a different activity is current", async () => {
  const r = studyRoutine({
    id: "gaming-only",
    trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" },
    conditions: [{ type: "activityIs", activity: "Gaming" }],
  });
  const { routineService, bus } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe"));
  await settle();
  bus.publish(appEvent("other.exe"));
  await settle();

  assert.equal(routineService.getActiveSuggestions().length, 0);
});

test("an activity condition blocks when there is no activity at all", async () => {
  const r = studyRoutine({
    id: "needs-activity",
    trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" },
    conditions: [{ type: "activityIs", activity: "Study" }],
  });
  const { routineService, bus } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("other.exe"));
  await settle();

  assert.equal(routineService.getActiveSuggestions().length, 0, "must fail closed, not open");
});

test("activity matching ignores case", async () => {
  const r = studyRoutine({
    id: "case",
    trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" },
    conditions: [{ type: "activityIs", activity: "study" }],
  });
  const { routineService, bus } = setup([r], activitySettings([mapping({ activity: "Study" })]));

  bus.publish(appEvent("study.exe"));
  await settle();
  bus.publish(appEvent("other.exe"));
  await settle();

  assert.equal(routineService.getActiveSuggestions().length, 1);
});

// ------------------------------------------------------------ duration

test("a duration condition blocks until the activity has lasted long enough", async () => {
  const r = studyRoutine({
    id: "break",
    trigger: { type: "applicationOpened", application: "other.exe", matchMode: "exact" },
    conditions: [
      { type: "activityIs", activity: "Study" },
      { type: "activityDuration", minMinutes: 90 },
    ],
    cooldownMinutes: 0,
  });
  const { routineService, bus, advance } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe"));
  await settle();

  advance(30);
  bus.publish(appEvent("other.exe"));
  await settle();
  assert.equal(routineService.getActiveSuggestions().length, 0, "only 30 minutes in");

  advance(65); // now 95 minutes into the session
  bus.publish(appEvent("other.exe"));
  await settle();
  assert.equal(routineService.getActiveSuggestions().length, 1, "past 90 minutes");
});

test("the explanation names the activity checks", async () => {
  const r = studyRoutine({
    id: "break",
    conditions: [
      { type: "activityIs", activity: "Study" },
      { type: "activityDuration", minMinutes: 90 },
    ],
  });
  const { routineService, bus } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe"));
  await settle();
  const evaluation = await routineService.testRoutine("break");

  const labels = evaluation!.checks.map((c) => c.label);
  assert.equal(
    labels.some((l) => l.includes("Current activity is Study")),
    true
  );
  assert.equal(
    labels.some((l) => l.includes("has not lasted 90 min yet")),
    true
  );
});

// ------------------------------- the existing flow must be untouched (§22)

test("BACKWARDS COMPATIBILITY: the existing study routine flow still works end to end", async () => {
  // The exact shape that worked before Activity existed: a routine with
  // no activity conditions at all, triggered by opening an application.
  const r = studyRoutine();
  const { routineService, provider, bus, activity } = setup(r ? [r] : [], activitySettings([mapping()]));

  // 1. Opening the application fires the trigger.
  bus.publish(appEvent("study.exe"));
  await settle();

  // 2. A suggestion appears, and nothing has run yet.
  const suggestions = routineService.getActiveSuggestions();
  assert.equal(suggestions.length, 1, "the routine still suggests");
  assert.equal(suggestions[0].title, "Study Mode");
  assert.equal(provider.calls.length, 0, "still asks before acting");

  // 3. Accepting runs both actions, in order.
  await routineService.acceptSuggestion(suggestions[0].id);
  assert.deepEqual(provider.calls, ["demo.playlist", "demo.timer"]);

  // 4. And the activity is tracked alongside, without interfering.
  assert.equal(activity.getCurrentActivity()?.activity, "Study");
});

test("BACKWARDS COMPATIBILITY: routines behave identically with activity detection switched off", async () => {
  const r = studyRoutine();
  const { routineService, provider, bus, activity } = setup([r], {
    enabled: false,
    mappings: [mapping()],
    graceMinutes: 5,
  });

  bus.publish(appEvent("study.exe"));
  await settle();

  assert.equal(routineService.getActiveSuggestions().length, 1);
  assert.equal(activity.getCurrentActivity(), null, "no activity tracked when off");
  assert.equal(provider.calls.length, 0);
});

test("the study session keeps running while the routine's actions execute", async () => {
  const r = studyRoutine();
  const { routineService, bus, activity, advance } = setup([r], activitySettings([mapping()]));

  bus.publish(appEvent("study.exe"));
  await settle();
  // Accept promptly — a suggestion has its own short expiry, and this
  // test is about the session outliving the accept, not about that.
  await routineService.acceptSuggestion(routineService.getActiveSuggestions()[0].id);
  advance(12);

  const current = activity.getCurrentActivity()!;
  assert.equal(current.activity, "Study");
  assert.equal(current.durationMs, 12 * 60_000, "the session keeps tracking after the actions ran");
});

test("switching to a game ends the study session and starts a gaming one, routines unaffected", async () => {
  const r = studyRoutine();
  const { routineService, bus, activity, advance } = setup(
    [r],
    activitySettings([mapping(), mapping({ id: "g", activity: "Gaming", value: "game.exe" })])
  );

  bus.publish(appEvent("study.exe"));
  await settle();
  advance(60);
  bus.publish(appEvent("game.exe"));
  await settle();

  assert.equal(activity.getCurrentActivity()?.activity, "Gaming");
  const sessions = activity.getRecentSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((s) => s.activity === "Study")!.state, "ended");
  // The study routine's own trigger doesn't match game.exe, so the
  // activity change produced no routine activity of its own.
  const kinds = routineService.getHistory().map((h) => h.kind);
  assert.equal(kinds.filter((k) => k === "suggested").length, 1, "only the original suggestion");
});
