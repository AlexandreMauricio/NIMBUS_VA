import { test } from "node:test";
import assert from "node:assert/strict";
import { CalendarProvider, CalendarProviderConfig } from "./calendarProvider";
import { IcsCalendarSource } from "./icsCalendarSource";

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

/** Builds a source factory that returns canned ICS text per feed address, or throws for a configured "broken" address. */
function stubSourceFactory(byAddress: Record<string, string | Error>): (address: string) => IcsCalendarSource {
  return (address: string) => {
    const canned = byAddress[address];
    return {
      fetchRaw: async () => {
        if (canned instanceof Error) throw canned;
        if (canned === undefined) throw new Error(`no stub configured for ${address}`);
        return canned;
      },
    } as unknown as IcsCalendarSource;
  };
}

function config(overrides: Partial<CalendarProviderConfig> = {}): CalendarProviderConfig {
  return {
    enabled: true,
    feeds: [{ id: "personal", label: "Personal", address: "feed://personal", enabled: true }],
    ...overrides,
  };
}

test("isAvailable is false when calendar is disabled", () => {
  const provider = new CalendarProvider(() => config({ enabled: false }));
  assert.equal(provider.isAvailable(), false);
});

test("isAvailable is false when enabled but no feed is enabled", () => {
  const provider = new CalendarProvider(() =>
    config({ feeds: [{ id: "x", label: "X", address: "a", enabled: false }] })
  );
  assert.equal(provider.isAvailable(), false);
});

test("isAvailable is true when enabled with at least one enabled feed", () => {
  const provider = new CalendarProvider(() => config());
  assert.equal(provider.isAvailable(), true);
});

test("an env fallback feed is used when enabled but no feed is saved yet", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const raw = ics("BEGIN:VEVENT", "UID:e1", "SUMMARY:From env feed", "DTSTART:20260715T140000Z", "END:VEVENT");
  const provider = new CalendarProvider(
    () => config({ feeds: [] }),
    stubSourceFactory({ "env://feed": raw }),
    () => now,
    Date.now,
    { label: "Env Default", address: "env://feed" }
  );

  assert.equal(provider.isAvailable(), true);
  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.todayEvents[0].calendarName, "Env Default");
});

test("a saved feed takes priority over the env fallback feed", async () => {
  const provider = new CalendarProvider(
    () => config(), // has a real "feed://personal" feed configured
    stubSourceFactory({ "feed://personal": ics() }),
    () => new Date(),
    Date.now,
    { label: "Env Default", address: "env://feed" } // should be ignored
  );

  await provider.getContext(); // would throw "no stub configured for env://feed" if the fallback were used instead
  assert.ok(true);
});

test("no events today or upcoming produces empty buckets and a null nextEvent", async () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const sourceFactory = stubSourceFactory({ "feed://personal": ics() });
  const provider = new CalendarProvider(() => config(), sourceFactory, () => now);

  const ctx = await provider.getContext();
  assert.deepEqual(ctx.todayEvents, []);
  assert.deepEqual(ctx.laterEvents, []);
  assert.equal(ctx.nextEvent, null);
  assert.ok(ctx.timezone.length > 0);
});

test("one event today appears in todayEvents and as nextEvent", async () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const raw = ics("BEGIN:VEVENT", "UID:e1", "SUMMARY:Standup", "DTSTART:20260715T140000Z", "DTEND:20260715T143000Z", "END:VEVENT");
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.todayEvents[0].title, "Standup");
  assert.equal(ctx.nextEvent?.id, "e1");
});

test("multiple events today are all bucketed and sorted by start time", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const raw = ics(
    "BEGIN:VEVENT", "UID:e-late", "SUMMARY:Afternoon review", "DTSTART:20260715T180000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:e-early", "SUMMARY:Morning standup", "DTSTART:20260715T130000Z", "END:VEVENT"
  );
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 2);
  assert.deepEqual(ctx.todayEvents.map((e) => e.id), ["e-early", "e-late"]);
});

test("an event tomorrow is classified as laterEvents, not todayEvents", async () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const raw = ics("BEGIN:VEVENT", "UID:tmr", "SUMMARY:Dentist", "DTSTART:20260716T140000Z", "END:VEVENT");
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 0);
  assert.equal(ctx.laterEvents.length, 1);
  assert.equal(ctx.laterEvents[0].id, "tmr");
  assert.equal(ctx.nextEvent?.id, "tmr");
});

test("an all-day event today is included in todayEvents with isAllDay true", async () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const raw = ics("BEGIN:VEVENT", "UID:holiday", "SUMMARY:Company holiday", "DTSTART;VALUE=DATE:20260715", "END:VEVENT");
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.todayEvents[0].isAllDay, true);
});

test("an event that already ended today still appears in todayEvents but is not nextEvent", async () => {
  const now = new Date("2026-07-15T16:00:00.000Z"); // after the event ended
  const raw = ics("BEGIN:VEVENT", "UID:done", "SUMMARY:Morning call", "DTSTART:20260715T130000Z", "DTEND:20260715T140000Z", "END:VEVENT");
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.nextEvent, null);
});

test("an event starting soon is reported as nextEvent", async () => {
  const now = new Date("2026-07-15T13:45:00.000Z");
  const raw = ics("BEGIN:VEVENT", "UID:soon", "SUMMARY:Interview", "DTSTART:20260715T140000Z", "END:VEVENT");
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.nextEvent?.id, "soon");
});

test("multiple enabled feeds are merged and tagged with their own calendar name", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const workRaw = ics("BEGIN:VEVENT", "UID:w1", "SUMMARY:Sprint planning", "DTSTART:20260715T140000Z", "END:VEVENT");
  const personalRaw = ics("BEGIN:VEVENT", "UID:p1", "SUMMARY:Gym", "DTSTART:20260715T190000Z", "END:VEVENT");

  const provider = new CalendarProvider(
    () =>
      config({
        feeds: [
          { id: "work", label: "Work", address: "feed://work", enabled: true },
          { id: "personal", label: "Personal", address: "feed://personal", enabled: true },
        ],
      }),
    stubSourceFactory({ "feed://work": workRaw, "feed://personal": personalRaw }),
    () => now
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 2);
  const byId = Object.fromEntries(ctx.todayEvents.map((e) => [e.id, e]));
  assert.equal(byId.w1.calendarName, "Work");
  assert.equal(byId.p1.calendarName, "Personal");
});

test("a disabled feed is not fetched or included", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const provider = new CalendarProvider(
    () =>
      config({
        feeds: [{ id: "off", label: "Disabled cal", address: "feed://off", enabled: false }],
      }),
    stubSourceFactory({}),
    () => now
  );
  assert.equal(provider.isAvailable(), false);
});

test("one feed failing does not prevent events from a working feed", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const goodRaw = ics("BEGIN:VEVENT", "UID:ok", "SUMMARY:Still works", "DTSTART:20260715T140000Z", "END:VEVENT");

  const provider = new CalendarProvider(
    () =>
      config({
        feeds: [
          { id: "broken", label: "Broken", address: "feed://broken", enabled: true },
          { id: "good", label: "Good", address: "feed://good", enabled: true },
        ],
      }),
    stubSourceFactory({ "feed://broken": new Error("network unreachable"), "feed://good": goodRaw }),
    () => now
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.todayEvents[0].id, "ok");
});

test("all feeds failing rejects getContext (for ContextService to catch)", async () => {
  const provider = new CalendarProvider(
    () => config(),
    stubSourceFactory({ "feed://personal": new Error("network unreachable") }),
    () => new Date()
  );

  await assert.rejects(() => provider.getContext(), /failed to load/);
});

test("an unauthorized/forbidden feed response is treated as a normal failure, not a crash", async () => {
  // Stand-in for "authentication failure": the ICS integration has no
  // OAuth token to expire, but a revoked/invalid private-feed link
  // surfaces the same way a real API would reject it — a rejected fetch.
  const provider = new CalendarProvider(
    () => config(),
    stubSourceFactory({ "feed://personal": new Error("Calendar feed request failed with status 403") }),
    () => new Date()
  );

  await assert.rejects(() => provider.getContext(), /failed to load/);
});

test("malformed ICS content does not throw — unparseable events are simply skipped", async () => {
  const now = new Date("2026-07-15T08:00:00.000Z");
  const raw = ics(
    "BEGIN:VEVENT", "SUMMARY:Missing uid", "DTSTART:20260715T090000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:valid", "SUMMARY:Valid event", "DTSTART:20260715T140000Z", "END:VEVENT"
  );
  const provider = new CalendarProvider(() => config(), stubSourceFactory({ "feed://personal": raw }), () => now);

  const ctx = await provider.getContext();
  assert.equal(ctx.todayEvents.length, 1);
  assert.equal(ctx.todayEvents[0].id, "valid");
});

test("getContext caches results within the TTL instead of re-fetching", async () => {
  let fetchCount = 0;
  const now = new Date("2026-07-15T08:00:00.000Z");
  let clockMs = now.getTime();
  const source = {
    fetchRaw: async () => {
      fetchCount++;
      return ics();
    },
  } as unknown as IcsCalendarSource;

  const provider = new CalendarProvider(
    () => config(),
    () => source,
    () => new Date(clockMs),
    () => clockMs
  );

  await provider.getContext();
  clockMs += 5 * 60 * 1000; // 5 minutes later, still within the 15-minute default TTL
  await provider.getContext();

  assert.equal(fetchCount, 1);
});

test("cache TTL shrinks (refreshes sooner) once the next known event is imminent", async () => {
  let fetchCount = 0;
  let clockMs = new Date("2026-07-15T13:00:00.000Z").getTime(); // 1 hour before the event
  const raw = ics("BEGIN:VEVENT", "UID:soon", "SUMMARY:Imminent", "DTSTART:20260715T134500Z", "END:VEVENT"); // 45 min out
  const source = {
    fetchRaw: async () => {
      fetchCount++;
      return raw;
    },
  } as unknown as IcsCalendarSource;

  const provider = new CalendarProvider(() => config(), () => source, () => new Date(clockMs), () => clockMs);

  await provider.getContext();
  clockMs += 3 * 60 * 1000; // 3 minutes later — longer than the 2-minute "imminent" cache TTL
  await provider.getContext();

  assert.equal(fetchCount, 2, "should have refreshed because the next event is imminent");
});
