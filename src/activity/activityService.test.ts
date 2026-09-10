import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityService } from "./activityService";
import { ActivityHistoryState, ActivityMapping, ActivitySettings, ActivityStateStore } from "./types";
import { ContextEventBus } from "../events/eventBus";
import { ApplicationClosedEvent, ApplicationOpenedEvent, WebsiteOpenedEvent } from "../events/types";

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

function settings(overrides: Partial<ActivitySettings> = {}): ActivitySettings {
  return { enabled: true, mappings: [mapping()], graceMinutes: 5, ...overrides };
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

function closedEvent(executableName: string): ApplicationClosedEvent {
  return {
    id: "c" + Math.random(),
    type: "applicationClosed",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName,
  };
}

function siteEvent(windowTitle: string): WebsiteOpenedEvent {
  return {
    id: "s" + Math.random(),
    type: "websiteOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    browserExecutable: "chrome.exe",
    windowTitle,
    url: null,
    domain: null,
  };
}

/** A clock the test moves by hand, so durations are exact rather than timing-dependent. */
function setup(activitySettings: ActivitySettings = settings(), store?: ActivityStateStore) {
  const clock = { now: new Date("2026-03-16T09:00:00") };
  const bus = new ContextEventBus();
  const service = new ActivityService(
    () => activitySettings,
    bus,
    () => clock.now,
    store
  );
  service.start();
  const advance = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };
  return { service, bus, clock, advance };
}

// ------------------------------------------------------------- starting

test("a mapped application starts a session", () => {
  const { service, bus } = setup();

  bus.publish(appEvent("study.exe"));

  const current = service.getCurrentActivity();
  assert.equal(current?.activity, "Study");
  assert.equal(current?.sourceValue, "study.exe");
});

test("an unmapped application starts nothing", () => {
  const { service, bus } = setup();

  bus.publish(appEvent("unknown.exe"));

  assert.equal(service.getCurrentActivity(), null);
});

test("detection is off unless activity awareness is enabled", () => {
  const { service, bus } = setup(settings({ enabled: false }));

  bus.publish(appEvent("study.exe"));

  assert.equal(service.getCurrentActivity(), null);
});

// ------------------------------------------------------------ continuing

test("repeated events for the same activity do NOT create a second session", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  const startedAt = service.getCurrentActivity()!.startedAt;
  advance(15);
  bus.publish(appEvent("study.exe"));
  advance(15);
  bus.publish(appEvent("study.exe"));
  advance(15);
  bus.publish(appEvent("study.exe"));

  const current = service.getCurrentActivity()!;
  assert.equal(current.startedAt, startedAt, "the session must keep its original start");
  assert.equal(current.durationMs, 45 * 60_000, "45 minutes, not reset to zero");
  assert.equal(service.getRecentSessions().length, 1, "exactly one session, not four");
});

test("duration is computed from the start, not accumulated", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(47);

  assert.equal(service.getCurrentActivity()!.durationMs, 47 * 60_000);
});

test("two different applications mapped to the same activity continue one session", () => {
  const { service, bus, advance } = setup(
    settings({
      mappings: [mapping({ id: "a", value: "study.exe" }), mapping({ id: "b", value: "notes.exe" })],
    })
  );

  bus.publish(appEvent("study.exe"));
  advance(10);
  bus.publish(appEvent("notes.exe"));

  assert.equal(service.getRecentSessions().length, 1);
  assert.equal(service.getCurrentActivity()!.durationMs, 10 * 60_000);
});

// --------------------------------------------------- temporary switching

test("opening an unmapped application does not end the session", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(10);
  bus.publish(appEvent("chat.exe")); // unmapped — says nothing
  advance(10);

  const current = service.getCurrentActivity();
  assert.equal(current?.activity, "Study");
  assert.equal(current?.durationMs, 20 * 60_000);
});

test("closing the application within the grace period continues the same session", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  const startedAt = service.getCurrentActivity()!.startedAt;
  advance(10);
  bus.publish(closedEvent("study.exe")); // closed by accident / restarted
  advance(2); // inside the 5-minute grace
  bus.publish(appEvent("study.exe"));
  advance(5);

  const current = service.getCurrentActivity()!;
  assert.equal(current.startedAt, startedAt, "same session resumed");
  assert.equal(service.getRecentSessions().length, 1);
});

test("past the grace period the session ends, dated when the app actually closed", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(30);
  bus.publish(closedEvent("study.exe"));
  advance(10); // beyond the 5-minute grace

  assert.equal(service.getCurrentActivity(), null);
  const [session] = service.getRecentSessions();
  assert.equal(session.state, "ended");
  const durationMs = new Date(session.endedAt!).getTime() - new Date(session.startedAt).getTime();
  assert.equal(durationMs, 30 * 60_000, "ends when it closed, not when NIMBUS noticed");
});

test("another application closing does not touch the session", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(10);
  bus.publish(closedEvent("chat.exe"));
  advance(10);

  assert.equal(service.getCurrentActivity()?.activity, "Study");
});

// ------------------------------------------------------ activity changes

test("a different activity ends the first session and starts a second", () => {
  const { service, bus, advance } = setup(
    settings({
      mappings: [mapping(), mapping({ id: "g", activity: "Gaming", value: "game.exe" })],
    })
  );

  bus.publish(appEvent("study.exe"));
  advance(80);
  bus.publish(appEvent("game.exe"));
  advance(20);

  const current = service.getCurrentActivity()!;
  assert.equal(current.activity, "Gaming");
  assert.equal(current.durationMs, 20 * 60_000);

  const sessions = service.getRecentSessions();
  assert.equal(sessions.length, 2, "the study session is kept, not destroyed");
  const study = sessions.find((s) => s.activity === "Study")!;
  assert.equal(study.state, "ended");
  assert.equal(new Date(study.endedAt!).getTime() - new Date(study.startedAt).getTime(), 80 * 60_000);
});

test("a website session is anchored to its browser", () => {
  const { service, bus, advance } = setup(
    settings({
      mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })],
    })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  advance(10);
  bus.publish(closedEvent("chrome.exe"));
  advance(10); // past grace

  assert.equal(service.getCurrentActivity(), null);
});

// ----------------------------------------------------------- persistence

test("history is persisted as sessions start and end", () => {
  const writes: ActivityHistoryState[] = [];
  const store: ActivityStateStore = {
    load: () => ({ sessions: [] }),
    save: (state) => writes.push(structuredClone(state)),
  };
  const { bus } = setup(settings(), store);

  bus.publish(appEvent("study.exe"));

  assert.equal(writes.length >= 1, true);
  assert.equal(writes[writes.length - 1].sessions[0].activity, "Study");
});

test("a session left active by a previous run is closed out, never resumed", () => {
  // NIMBUS cannot know whether the app kept running or the machine slept,
  // so the time between then and now must not be invented.
  const stale = {
    id: "old",
    activity: "Study",
    source: "application" as const,
    sourceValue: "study.exe",
    anchorProcess: "study.exe",
    startedAt: "2026-03-15T09:00:00.000Z",
    lastActiveAt: "2026-03-15T10:00:00.000Z",
    endedAt: null,
    state: "active" as const,
  };
  const store: ActivityStateStore = { load: () => ({ sessions: [stale] }), save: () => undefined };
  const { service } = setup(settings(), store);

  assert.equal(service.getCurrentActivity(), null, "no activity is resumed on startup");
  const [restored] = service.getRecentSessions();
  assert.equal(restored.state, "ended");
  assert.equal(restored.endedAt, stale.lastActiveAt, "ended when last seen, not now");
});

test("a corrupt store never stops activity tracking", () => {
  const store: ActivityStateStore = {
    load: () => {
      throw new Error("corrupt");
    },
    save: () => undefined,
  };
  const { service, bus } = setup(settings(), store);

  bus.publish(appEvent("study.exe"));

  assert.equal(service.getCurrentActivity()?.activity, "Study");
});

test("stopping the service ends the session in progress", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(25);
  service.stop();

  assert.equal(service.getCurrentActivity(), null);
  assert.equal(service.getRecentSessions()[0].state, "ended");
});

test("history is capped", () => {
  const { service, bus, advance } = setup(
    settings({
      mappings: [
        mapping({ id: "a", activity: "A", value: "a.exe" }),
        mapping({ id: "b", activity: "B", value: "b.exe" }),
      ],
    })
  );

  for (let i = 0; i < 250; i++) {
    bus.publish(appEvent(i % 2 === 0 ? "a.exe" : "b.exe"));
    advance(1);
  }

  assert.equal(service.getRecentSessions(500).length <= 201, true);
});

// --------------------------------------------------------------- privacy

test("a session records only what a mapping matched — no full window titles", () => {
  const { service, bus } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Bank statement for March - Chrome"));

  const serialized = JSON.stringify(service.getRecentSessions());
  assert.equal(serialized.includes("Bank statement"), false);
});

// ------------------------------------------- ending at the true moment

test("switching activity during the grace period ends the first one when its app closed", () => {
  // Closing a study app and opening a game two minutes later means
  // studying stopped when the app closed — those two minutes are not
  // study time just because that is when NIMBUS found out.
  const { service, bus, advance } = setup(
    settings({
      mappings: [mapping(), mapping({ id: "g", activity: "Gaming", value: "game.exe" })],
    })
  );

  bus.publish(appEvent("study.exe"));
  advance(30);
  bus.publish(closedEvent("study.exe"));
  advance(2); // still inside the 5-minute grace
  bus.publish(appEvent("game.exe"));

  const study = service.getRecentSessions().find((s) => s.activity === "Study")!;
  const durationMs = new Date(study.endedAt!).getTime() - new Date(study.startedAt).getTime();
  assert.equal(durationMs, 30 * 60_000, "30 minutes, not 32");
});

test("a session whose app is still open ends at the moment the activity changed", () => {
  // The counterpart: no anchor close, so 'now' really is when it ended.
  const { service, bus, advance } = setup(
    settings({
      mappings: [mapping(), mapping({ id: "g", activity: "Gaming", value: "game.exe" })],
    })
  );

  bus.publish(appEvent("study.exe"));
  advance(30);
  bus.publish(appEvent("game.exe"));

  const study = service.getRecentSessions().find((s) => s.activity === "Study")!;
  assert.equal(new Date(study.endedAt!).getTime() - new Date(study.startedAt).getTime(), 30 * 60_000);
});

test("shutting down after the app closed ends the session at the close, not at shutdown", () => {
  const { service, bus, advance } = setup();

  bus.publish(appEvent("study.exe"));
  advance(30);
  bus.publish(closedEvent("study.exe"));
  advance(3); // inside grace, so still active
  service.stop();

  const [session] = service.getRecentSessions();
  assert.equal(
    new Date(session.endedAt!).getTime() - new Date(session.startedAt).getTime(),
    30 * 60_000,
    "not 33"
  );
});

// -------------------------------- website sessions and the browser tab

test("navigating the browser away from the site starts the grace period", () => {
  // NIMBUS cannot see tabs: closing one just makes the browser report a
  // different title. Waiting for the whole browser to close would leave
  // a study session running all day.
  const { service, bus, advance } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  advance(30);
  bus.publish(siteEvent("Something else entirely - Chrome"));
  advance(6); // past the 5-minute grace

  assert.equal(service.getCurrentActivity(), null);
  const [session] = service.getRecentSessions();
  assert.equal(
    new Date(session.endedAt!).getTime() - new Date(session.startedAt).getTime(),
    30 * 60_000,
    "ends when the browser left the site"
  );
});

test("flicking to another tab and back within the grace continues the session", () => {
  const { service, bus, advance } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  const startedAt = service.getCurrentActivity()!.startedAt;
  advance(20);
  bus.publish(siteEvent("Docs - Chrome"));
  advance(1);
  bus.publish(siteEvent("MySchool - Chrome"));
  advance(10);

  const current = service.getCurrentActivity()!;
  assert.equal(current.startedAt, startedAt, "same session");
  assert.equal(current.durationMs, 31 * 60_000);
  assert.equal(service.getRecentSessions().length, 1);
});

test("a browser cycling through unmatched tabs cannot keep a finished session alive", () => {
  // Each unmatched title must not push the deadline back.
  const { service, bus, advance } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  advance(10);
  for (let i = 0; i < 10; i++) {
    bus.publish(siteEvent(`Other page ${i} - Chrome`));
    advance(1);
  }

  assert.equal(service.getCurrentActivity(), null, "the grace ran out despite the churn");
});

test("a different browser moving on does not touch the session", () => {
  const { service, bus, advance } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  advance(10);
  bus.publish({ ...siteEvent("Anything - Firefox"), browserExecutable: "firefox.exe" });
  advance(10);

  assert.equal(service.getCurrentActivity()?.activity, "Study");
});

test("an unmapped application still does not end a website session", () => {
  // Rule 2 stands for applications — only the session's own browser
  // moving away counts.
  const { service, bus, advance } = setup(
    settings({ mappings: [mapping({ source: "website", value: "myschool", matchMode: "contains" })] })
  );

  bus.publish(siteEvent("MySchool - Chrome"));
  advance(10);
  bus.publish(appEvent("chat.exe"));
  advance(10);

  assert.equal(service.getCurrentActivity()?.activity, "Study");
});
