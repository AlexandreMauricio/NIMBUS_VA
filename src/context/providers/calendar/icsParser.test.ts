import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "./icsParser";

const TZ = "America/New_York";

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

test("parses a single timed event with an explicit UTC time", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:event-1",
    "SUMMARY:Team sync",
    "DTSTART:20260715T140000Z",
    "DTEND:20260715T150000Z",
    "LOCATION:Room 4",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);

  assert.equal(result.events.length, 1);
  assert.equal(result.skippedCount, 0);
  const event = result.events[0];
  assert.equal(event.uid, "event-1");
  assert.equal(event.title, "Team sync");
  assert.equal(event.startsAt, "2026-07-15T14:00:00.000Z");
  assert.equal(event.endsAt, "2026-07-15T15:00:00.000Z");
  assert.equal(event.isAllDay, false);
  assert.equal(event.location, "Room 4");
});

test("parses a TZID-qualified event using the named zone's offset", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:event-2",
    "SUMMARY:Client call",
    "DTSTART;TZID=America/New_York:20260715T103000",
    "DTEND;TZID=America/New_York:20260715T113000",
    "END:VEVENT"
  );

  const result = parseIcs(raw, "UTC");

  assert.equal(result.events[0].startsAt, "2026-07-15T14:30:00.000Z"); // EDT = UTC-4
});

test("treats a floating (no TZID, no Z) time as local to the given default timezone", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:event-3",
    "SUMMARY:Floating time",
    "DTSTART:20260115T090000",
    "END:VEVENT"
  );

  const result = parseIcs(raw, "America/New_York");

  assert.equal(result.events[0].startsAt, "2026-01-15T14:00:00.000Z"); // EST = UTC-5
});

test("parses an all-day event (VALUE=DATE) as local midnight-to-midnight", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:event-4",
    "SUMMARY:Company holiday",
    "DTSTART;VALUE=DATE:20260904",
    "DTEND;VALUE=DATE:20260905",
    "END:VEVENT"
  );

  const result = parseIcs(raw, "America/New_York");
  const event = result.events[0];

  assert.equal(event.isAllDay, true);
  assert.equal(event.startsAt, "2026-09-04T04:00:00.000Z"); // midnight EDT
  assert.equal(event.endsAt, "2026-09-05T04:00:00.000Z");
});

test("defaults a missing DTEND to +1 hour for timed events and +1 day for all-day events", () => {
  const timed = parseIcs(
    ics("BEGIN:VEVENT", "UID:e1", "SUMMARY:No end", "DTSTART:20260715T140000Z", "END:VEVENT"),
    TZ
  );
  assert.equal(timed.events[0].endsAt, "2026-07-15T15:00:00.000Z");

  const allDay = parseIcs(
    ics("BEGIN:VEVENT", "UID:e2", "SUMMARY:No end all day", "DTSTART;VALUE=DATE:20260904", "END:VEVENT"),
    "UTC"
  );
  assert.equal(allDay.events[0].endsAt, "2026-09-05T00:00:00.000Z");
});

test("extracts the calendar name from X-WR-CALNAME", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Work Calendar",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Standup",
    "DTSTART:20260715T140000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const result = parseIcs(raw, TZ);
  assert.equal(result.calendarName, "Work Calendar");
});

test("unescapes commas, semicolons, backslashes, and newlines in text fields", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Lunch\\, then meeting\\; prep",
    "DTSTART:20260715T140000Z",
    "LOCATION:5th Ave\\, NY",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);
  assert.equal(result.events[0].title, "Lunch, then meeting; prep");
  assert.equal(result.events[0].location, "5th Ave, NY");
});

test("unfolds continuation lines (leading space/tab) per RFC 5545", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:A very long title that\r\n  continues on the next physical line",
    "DTSTART:20260715T140000Z",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);
  assert.equal(result.events[0].title, "A very long title that continues on the next physical line");
});

test("parses multiple events in one feed, in document order", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:First",
    "DTSTART:20260715T090000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:e2",
    "SUMMARY:Second",
    "DTSTART:20260715T140000Z",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 2);
  assert.deepEqual(
    result.events.map((e) => e.title),
    ["First", "Second"]
  );
});

test("falls back to a placeholder title when SUMMARY is missing", () => {
  const raw = ics("BEGIN:VEVENT", "UID:e1", "DTSTART:20260715T140000Z", "END:VEVENT");
  const result = parseIcs(raw, TZ);
  assert.equal(result.events[0].title, "(Untitled event)");
});

test("skips an event missing UID rather than throwing", () => {
  const raw = ics("BEGIN:VEVENT", "SUMMARY:No uid", "DTSTART:20260715T140000Z", "END:VEVENT");
  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 0);
  assert.equal(result.skippedCount, 1);
});

test("skips an event missing DTSTART rather than throwing", () => {
  const raw = ics("BEGIN:VEVENT", "UID:e1", "SUMMARY:No start", "END:VEVENT");
  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 0);
  assert.equal(result.skippedCount, 1);
});

test("skips an event with an unparseable date value rather than throwing", () => {
  const raw = ics("BEGIN:VEVENT", "UID:e1", "SUMMARY:Bad date", "DTSTART:not-a-date", "END:VEVENT");
  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 0);
  assert.equal(result.skippedCount, 1);
});

test("one malformed event does not prevent other valid events from parsing", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "SUMMARY:Missing uid, should be skipped",
    "DTSTART:20260715T090000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:e2",
    "SUMMARY:Valid event",
    "DTSTART:20260715T140000Z",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Valid event");
  assert.equal(result.skippedCount, 1);
});

test("an empty feed with no VEVENTs parses cleanly to zero events", () => {
  const raw = ["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join("\r\n");
  const result = parseIcs(raw, TZ);
  assert.equal(result.events.length, 0);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.calendarName, null);
});

// --------------------------------------------- TZIDs Intl doesn't accept

test("a Windows timezone name (as Outlook and Exchange write) is understood", () => {
  // Intl rejects "Eastern Standard Time", which used to drop every timed
  // event from such a feed without a word.
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:win-1",
    "SUMMARY:Standup",
    "DTSTART;TZID=Eastern Standard Time:20260715T103000",
    "END:VEVENT"
  );

  const result = parseIcs(raw, "Europe/Lisbon");

  assert.equal(result.skippedCount, 0);
  assert.equal(result.events[0].startsAt, "2026-07-15T14:30:00.000Z");
});

test("a quoted TZID is understood", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:quoted-1",
    "SUMMARY:Standup",
    'DTSTART;TZID="America/New_York":20260715T103000',
    "END:VEVENT"
  );

  const result = parseIcs(raw, "Europe/Lisbon");

  assert.equal(result.skippedCount, 0);
  assert.equal(result.events[0].startsAt, "2026-07-15T14:30:00.000Z");
});

test("an unrecognised TZID falls back to the local zone rather than dropping the event", () => {
  const raw = ics(
    "BEGIN:VEVENT",
    "UID:unknown-1",
    "SUMMARY:Standup",
    "DTSTART;TZID=Somewhere Made Up:20260715T103000",
    "END:VEVENT"
  );

  const result = parseIcs(raw, TZ);

  assert.equal(result.skippedCount, 0);
  assert.equal(result.events[0].startsAt, "2026-07-15T14:30:00.000Z");
});
