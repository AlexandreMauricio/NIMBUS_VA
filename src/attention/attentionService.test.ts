import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionPresenter, AttentionService } from "./attentionService";
import { AttentionItem } from "./types";
import { AssistantSuggestion } from "../common/assistantEvents";
import { ContextSnapshot } from "../context/types";
import { CalendarContext } from "../context/providers/calendar/types";
import { ActionService } from "../actions/actionService";
import { ContextEventBus } from "../events/eventBus";
import { RoutineService } from "../routines/routineService";
import { Routine } from "../routines/types";

class FakePresenter implements AttentionPresenter {
  shown: AssistantSuggestion[] = [];
  notices: AttentionItem[] = [];
  popup: { suggestionId: string; expiresAt: string } | null = null;

  showSuggestion(suggestion: AssistantSuggestion): void {
    this.shown.push(suggestion);
    this.popup = { suggestionId: suggestion.id, expiresAt: suggestion.expiresAt };
  }
  postNotice(item: AttentionItem): void {
    this.notices.push(item);
  }
  currentPopup(): { suggestionId: string; expiresAt: string } | null {
    return this.popup;
  }
}

function setup(options: { enabled?: boolean; popups?: boolean; meetingInMinutes?: number | null } = {}) {
  const clock = { now: new Date("2026-09-11T10:00:00Z") };
  const settings = { enabled: options.enabled ?? true, popups: options.popups ?? true };
  const meeting = options.meetingInMinutes === undefined ? 12 : options.meetingInMinutes;
  const start = new Date(clock.now.getTime() + (meeting ?? 0) * 60_000);
  const calendar: CalendarContext = {
    retrievedAt: clock.now.toISOString(),
    timezone: "UTC",
    todayEvents:
      meeting === null
        ? []
        : [
            {
              id: "standup",
              title: "Standup",
              startsAt: start.toISOString(),
              endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
              isAllDay: false,
              location: "Room 2",
              calendarName: null,
            },
          ],
    laterEvents: [],
    nextEvent: null,
  };
  const snapshot: ContextSnapshot = {
    generatedAt: clock.now.toISOString(),
    providers: {
      calendar: {
        providerId: "calendar",
        displayName: "Calendar",
        status: "ok",
        data: calendar,
        timestamp: clock.now.toISOString(),
        stale: false,
      },
    },
  };
  let reads = 0;
  const presenter = new FakePresenter();
  const service = new AttentionService({
    getSettings: () => settings,
    getSnapshot: async () => {
      reads++;
      return snapshot;
    },
    getActivity: () => null,
    isTimerRunning: () => false,
    presenter,
    now: () => clock.now,
    timeZone: () => "UTC",
  });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { service, presenter, settings, clock, advance, reads: () => reads };
}

function routineSuggestion(id: string, now: Date): AssistantSuggestion {
  return {
    id,
    type: "suggestion",
    source: "routines",
    createdAt: now.toISOString(),
    routineId: "r1",
    title: "Study mode?",
    message: "Play your study playlist?",
    primaryLabel: "Yes",
    secondaryLabel: "Not now",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    actionSummary: [{ label: "Start timer", service: "timer" }],
  };
}

test("a meeting starting soon pops up once, as an informational suggestion that says why", async () => {
  const { service, presenter, advance, reads } = setup();

  await service.tick();

  assert.equal(presenter.shown.length, 1);
  const shown = presenter.shown[0];
  assert.equal(shown.origin, "attention");
  assert.equal(shown.title, "Standup in 12 min");
  assert.equal(shown.primaryLabel, "Got it");
  assert.deepEqual(shown.actionSummary, [], "nothing to run");
  assert.equal(shown.reason, "High priority · Starts in 12 minutes · Time-sensitive calendar event");
  assert.ok(service.ownsSuggestion(shown.id));

  for (let i = 0; i < 4; i++) {
    advance(30_000);
    await service.tick();
  }
  assert.equal(presenter.shown.length, 1, "not on every polling cycle");
  assert.equal(reads(), 1, "the context snapshot is reused");
  advance(5 * 60_000);
  await service.tick();
  assert.equal(reads(), 2);
});

test('"Got it" only acknowledges: never shown again, even as the meeting gets closer', async () => {
  const { service, presenter, advance } = setup();
  await service.tick();
  const shown = presenter.shown[0];
  presenter.popup = null;

  assert.equal(service.acknowledgeSuggestion(shown.id), true);
  advance(8 * 60_000);
  await service.tick();

  assert.equal(presenter.shown.length, 1);
  assert.equal(service.getDebugState().items[0].decision, "acknowledged");
});

test("a popup that runs out unanswered may come back once the meeting is close", async () => {
  const { service, presenter, advance } = setup();
  await service.tick();
  const shown = presenter.shown[0];

  advance(2 * 60_000);
  presenter.popup = null;
  assert.equal(service.dismissSuggestion(shown.id), true, "the popup's own auto-dismiss at expiry");
  advance(6 * 60_000);
  await service.tick();

  assert.equal(presenter.shown.length, 2);
  assert.equal(presenter.shown[1].title, "Standup in 4 min");
  assert.match(presenter.shown[1].reason ?? "", /^Urgent priority/);
});

test("a real dismissal is final", async () => {
  const { service, presenter, advance } = setup();
  await service.tick();
  presenter.popup = null;
  service.dismissSuggestion(presenter.shown[0].id);
  advance(8 * 60_000);
  await service.tick();
  assert.equal(presenter.shown.length, 1);
});

test("with Attention off, a routine suggestion is shown at once and nothing else is raised", async () => {
  const { service, presenter, clock } = setup({ enabled: false });
  await service.tick();
  assert.equal(presenter.shown.length, 0);

  const suggestion = routineSuggestion("s1", clock.now);
  service.offerSuggestion(suggestion);

  assert.deepEqual(presenter.shown, [suggestion]);
  assert.deepEqual(service.getDebugState().items, []);
});

test("a lone routine suggestion pops up at once, exactly as RoutineService made it", async () => {
  const { service, presenter, clock } = setup({ meetingInMinutes: null });
  await service.tick();

  const suggestion = routineSuggestion("s1", clock.now);
  service.offerSuggestion(suggestion);

  assert.equal(presenter.shown.length, 1);
  assert.equal(presenter.shown[0], suggestion);
});

test("a routine suggestion waits while something more important is on screen, then follows", async () => {
  const { service, presenter, clock } = setup({ meetingInMinutes: 4 });
  await service.tick();
  const meeting = presenter.shown[0];
  assert.match(meeting.reason ?? "", /^Urgent/);

  const suggestion = routineSuggestion("s1", clock.now);
  service.offerSuggestion(suggestion);
  assert.equal(presenter.shown.length, 1, "it didn't overwrite the meeting");
  const held = service.getDebugState().items.find((i) => i.id === "suggestion:s1")!;
  assert.equal(held.decision, "held");

  presenter.popup = null;
  service.acknowledgeSuggestion(meeting.id);
  service.popupClosed();
  assert.equal(presenter.shown.length, 2);
  assert.equal(presenter.shown[1], suggestion);
});

test("a routine suggestion that expired while waiting is never shown late", async () => {
  const { service, presenter, clock, advance } = setup({ meetingInMinutes: 4 });
  await service.tick();
  service.offerSuggestion(routineSuggestion("s1", clock.now));

  advance(61_000);
  presenter.popup = null;
  service.popupClosed();

  assert.equal(presenter.shown.length, 1);
});

test("with popups off, Attention's own items go to the feed", async () => {
  const { service, presenter } = setup({ popups: false });
  await service.tick();
  assert.equal(presenter.shown.length, 0);
  assert.deepEqual(
    presenter.notices.map((n) => n.title),
    ["Standup in 12 min"]
  );
});

test("Attention runs nothing: only a routine suggestion accepted through RoutineService runs its steps", async () => {
  const executed: string[] = [];
  const actionService = {
    listActions: () => [],
    executeAction: async (actionId: string) => {
      executed.push(actionId);
      return { actionId, status: "success", message: "ok" };
    },
  } as unknown as ActionService;
  const bus = new ContextEventBus();
  const routine: Routine = {
    id: "r1",
    name: "Study",
    enabled: true,
    trigger: { type: "applicationOpened", application: "notes.exe", matchMode: "exact" },
    conditions: [],
    suggestion: {
      title: "Study mode?",
      message: "Start a timer?",
      primaryLabel: "Yes",
      secondaryLabel: "No",
    },
    actions: [{ actionId: "timer.start", params: {} }],
    cooldownMinutes: 0,
  };
  const { service, presenter, clock } = setup();
  const routines = new RoutineService(
    () => [routine],
    actionService,
    bus,
    () => clock.now
  );
  routines.onSuggestion((s) => service.offerSuggestion(s));
  routines.start();
  // How the app answers a suggestion (lifecycle.ts): Attention's own are
  // acknowledged; every other goes to RoutineService, as before.
  const accept = async (id: string) => {
    if (service.acknowledgeSuggestion(id)) return [];
    const results = await routines.acceptSuggestion(id);
    service.suggestionResolved(id, "accepted");
    return results;
  };

  await service.tick();
  await accept(presenter.shown[0].id);
  assert.deepEqual(executed, [], "acknowledging Attention's suggestion ran nothing");
  presenter.popup = null;
  service.popupClosed();

  bus.publish({
    id: "e1",
    type: "applicationOpened",
    occurredAt: clock.now.toISOString(),
    source: "test",
    executableName: "notes.exe",
    windowTitle: null,
    activation: "launched",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const offered = presenter.shown.find((s) => s.routineId === "r1");
  assert.ok(offered, "the routine's suggestion reached the popup through Attention");
  assert.deepEqual(executed, [], "offering it ran nothing either");

  await accept(offered!.id);
  assert.deepEqual(executed, ["timer.start"]);
  routines.stop();
});
