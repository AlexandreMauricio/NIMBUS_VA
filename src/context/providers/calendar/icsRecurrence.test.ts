import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "./icsParser";

const TZ = "America/New_York";

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

function event(...props: string[]): string[] {
  return ["BEGIN:VEVENT", "UID:r1", "SUMMARY:Recurring", ...props, "END:VEVENT"];
}

function window(from: string, to: string) {
  return { expand: { from: new Date(from), to: new Date(to) } };
}

function starts(raw: string, from: string, to: string, tz = TZ): string[] {
  return parseIcs(raw, tz, window(from, to)).events.map((e) => e.startsAt);
}

test("without an expand window a recurring event still appears once", () => {
  const raw = ics(...event("DTSTART:20260706T140000Z", "RRULE:FREQ=DAILY"));
  assert.equal(parseIcs(raw, TZ).events.length, 1);
});

test("a daily rule yields every day inside the window", () => {
  const raw = ics(...event("DTSTART:20260701T140000Z", "DTEND:20260701T150000Z", "RRULE:FREQ=DAILY"));
  const events = parseIcs(raw, TZ, window("2026-07-10T00:00:00Z", "2026-07-13T00:00:00Z")).events;
  assert.deepEqual(
    events.map((e) => [e.startsAt, e.endsAt]),
    [
      ["2026-07-10T14:00:00.000Z", "2026-07-10T15:00:00.000Z"],
      ["2026-07-11T14:00:00.000Z", "2026-07-11T15:00:00.000Z"],
      ["2026-07-12T14:00:00.000Z", "2026-07-12T15:00:00.000Z"],
    ]
  );
  assert.ok(events.every((e) => e.uid === "r1" && e.title === "Recurring"));
});

test("a weekly TZID event keeps its wall-clock time across a DST change", () => {
  const raw = ics(...event("DTSTART;TZID=America/New_York:20261026T090000", "RRULE:FREQ=WEEKLY"));
  assert.deepEqual(starts(raw, "2026-10-25T00:00:00Z", "2026-11-10T00:00:00Z", "UTC"), [
    "2026-10-26T13:00:00.000Z", // EDT
    "2026-11-02T14:00:00.000Z", // EST
    "2026-11-09T14:00:00.000Z",
  ]);
});

test("weekly BYDAY with INTERVAL picks the listed days every other week", () => {
  // 2026-07-06 is a Monday.
  const raw = ics(...event("DTSTART:20260706T120000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"));
  assert.deepEqual(starts(raw, "2026-07-01T00:00:00Z", "2026-07-25T00:00:00Z"), [
    "2026-07-06T12:00:00.000Z",
    "2026-07-08T12:00:00.000Z",
    "2026-07-20T12:00:00.000Z",
    "2026-07-22T12:00:00.000Z",
  ]);
});

test("COUNT stops after that many occurrences, counted from DTSTART", () => {
  const raw = ics(...event("DTSTART:20260701T120000Z", "RRULE:FREQ=DAILY;COUNT=5"));
  assert.deepEqual(starts(raw, "2026-07-04T00:00:00Z", "2026-08-01T00:00:00Z"), [
    "2026-07-04T12:00:00.000Z",
    "2026-07-05T12:00:00.000Z",
  ]);
});

test("UNTIL is inclusive, and a date-only UNTIL covers that whole day", () => {
  const timed = ics(...event("DTSTART:20260701T120000Z", "RRULE:FREQ=DAILY;UNTIL=20260703T120000Z"));
  assert.equal(starts(timed, "2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z").length, 3);
  const dateOnly = ics(...event("DTSTART:20260701T120000Z", "RRULE:FREQ=DAILY;UNTIL=20260703"));
  assert.equal(starts(dateOnly, "2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z").length, 3);
});

test("monthly BYDAY ordinals: the second Tuesday and the last Friday", () => {
  const second = ics(...event("DTSTART:20260714T150000Z", "RRULE:FREQ=MONTHLY;BYDAY=2TU"));
  assert.deepEqual(starts(second, "2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"), [
    "2026-07-14T15:00:00.000Z",
    "2026-08-11T15:00:00.000Z",
    "2026-09-08T15:00:00.000Z",
  ]);
  const last = ics(...event("DTSTART:20260731T150000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR"));
  assert.deepEqual(starts(last, "2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"), [
    "2026-07-31T15:00:00.000Z",
    "2026-08-28T15:00:00.000Z",
    "2026-09-25T15:00:00.000Z",
  ]);
});

test("a monthly event on the 31st skips months without one", () => {
  const raw = ics(...event("DTSTART:20260131T100000Z", "RRULE:FREQ=MONTHLY"));
  assert.deepEqual(starts(raw, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"), [
    "2026-01-31T10:00:00.000Z",
    "2026-03-31T10:00:00.000Z",
    "2026-05-31T10:00:00.000Z",
  ]);
});

test("monthly BYSETPOS=-1 with weekdays picks the last weekday of the month", () => {
  const raw = ics(
    ...event("DTSTART:20260731T090000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")
  );
  assert.deepEqual(starts(raw, "2026-07-01T00:00:00Z", "2026-11-01T00:00:00Z"), [
    "2026-07-31T09:00:00.000Z",
    "2026-08-31T09:00:00.000Z",
    "2026-09-30T09:00:00.000Z",
    "2026-10-30T09:00:00.000Z",
  ]);
});

test("a yearly all-day birthday recurs on its date", () => {
  const raw = ics(...event("DTSTART;VALUE=DATE:20200915", "RRULE:FREQ=YEARLY"));
  const events = parseIcs(raw, "UTC", window("2026-09-01T00:00:00Z", "2027-10-01T00:00:00Z")).events;
  assert.deepEqual(
    events.map((e) => [e.startsAt, e.isAllDay]),
    [
      ["2026-09-15T00:00:00.000Z", true],
      ["2027-09-15T00:00:00.000Z", true],
    ]
  );
});

test("yearly BYMONTH with an ordinal BYDAY: US Thanksgiving", () => {
  const raw = ics(...event("DTSTART;VALUE=DATE:20201126", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"));
  assert.deepEqual(starts(raw, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z", "UTC"), [
    "2026-11-26T00:00:00.000Z",
    "2027-11-25T00:00:00.000Z",
  ]);
});

test("EXDATE removes occurrences, including comma-separated and repeated ones", () => {
  const raw = ics(
    ...event(
      "DTSTART;TZID=America/New_York:20260706T090000",
      "RRULE:FREQ=DAILY;COUNT=5",
      "EXDATE;TZID=America/New_York:20260707T090000,20260708T090000",
      "EXDATE;TZID=America/New_York:20260710T090000"
    )
  );
  assert.deepEqual(starts(raw, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"), [
    "2026-07-06T13:00:00.000Z",
    "2026-07-09T13:00:00.000Z",
  ]);
});

test("a moved occurrence replaces the generated one, and a cancelled one disappears", () => {
  const raw = ics(
    ...event("DTSTART:20260706T140000Z", "DTEND:20260706T150000Z", "RRULE:FREQ=DAILY;COUNT=3"),
    "BEGIN:VEVENT",
    "UID:r1",
    "SUMMARY:Recurring (moved)",
    "RECURRENCE-ID:20260707T140000Z",
    "DTSTART:20260707T180000Z",
    "DTEND:20260707T190000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:r1",
    "RECURRENCE-ID:20260708T140000Z",
    "DTSTART:20260708T140000Z",
    "STATUS:CANCELLED",
    "END:VEVENT"
  );
  const events = parseIcs(raw, TZ, window("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z")).events;
  assert.deepEqual(
    events.map((e) => [e.title, e.startsAt]).sort((a, b) => a[1].localeCompare(b[1])),
    [
      ["Recurring", "2026-07-06T14:00:00.000Z"],
      ["Recurring (moved)", "2026-07-07T18:00:00.000Z"],
    ]
  );
});

test("an occurrence that began before the window but is still running is included", () => {
  const raw = ics(...event("DTSTART:20260701T220000Z", "DTEND:20260702T020000Z", "RRULE:FREQ=DAILY"));
  const events = parseIcs(raw, TZ, window("2026-07-05T00:00:00Z", "2026-07-05T12:00:00Z")).events;
  assert.deepEqual(
    events.map((e) => e.startsAt),
    ["2026-07-04T22:00:00.000Z"]
  );
});

test("an unsupported rule keeps the single literal occurrence", () => {
  const raw = ics(...event("DTSTART:20260706T140000Z", "RRULE:FREQ=HOURLY;COUNT=3"));
  assert.deepEqual(starts(raw, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"), ["2026-07-06T14:00:00.000Z"]);
});

test("a daily rule that started years ago reaches today without walking every day", () => {
  const raw = ics(...event("DTSTART:20000101T080000Z", "RRULE:FREQ=DAILY"));
  assert.deepEqual(starts(raw, "2026-07-10T00:00:00Z", "2026-07-12T00:00:00Z"), [
    "2026-07-10T08:00:00.000Z",
    "2026-07-11T08:00:00.000Z",
  ]);
});

test("a cancelled non-recurring event is dropped", () => {
  const raw = ics(...event("DTSTART:20260706T140000Z", "STATUS:CANCELLED"));
  assert.equal(parseIcs(raw, TZ).events.length, 0);
});
