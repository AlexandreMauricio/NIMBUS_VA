import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedTimeToUtcMs, localCalendarDate, localTime, addDaysToDateString } from "./icsTimeUtils";

test("zonedTimeToUtcMs converts a New York wall-clock time to the correct UTC instant (EDT, summer)", () => {
  // 2026-07-15 10:30 in America/New_York is EDT (UTC-4) in July.
  const ms = zonedTimeToUtcMs(
    { year: 2026, month: 7, day: 15, hour: 10, minute: 30, second: 0 },
    "America/New_York"
  );
  const iso = new Date(ms).toISOString();
  assert.equal(iso, "2026-07-15T14:30:00.000Z");
});

test("zonedTimeToUtcMs converts a New York wall-clock time to the correct UTC instant (EST, winter)", () => {
  // 2026-01-15 10:30 in America/New_York is EST (UTC-5) in January.
  const ms = zonedTimeToUtcMs(
    { year: 2026, month: 1, day: 15, hour: 10, minute: 30, second: 0 },
    "America/New_York"
  );
  const iso = new Date(ms).toISOString();
  assert.equal(iso, "2026-01-15T15:30:00.000Z");
});

test("zonedTimeToUtcMs handles a positive-offset zone (Tokyo, UTC+9)", () => {
  const ms = zonedTimeToUtcMs(
    { year: 2026, month: 3, day: 1, hour: 9, minute: 0, second: 0 },
    "Asia/Tokyo"
  );
  const iso = new Date(ms).toISOString();
  assert.equal(iso, "2026-03-01T00:00:00.000Z");
});

test("localCalendarDate reports the correct date in a non-UTC zone even near a day boundary", () => {
  // 2026-03-01T23:30:00Z is already 2026-03-02 in Tokyo (UTC+9).
  assert.equal(localCalendarDate("2026-03-01T23:30:00.000Z", "Asia/Tokyo"), "2026-03-02");
  // The same instant is still 2026-03-01 in New York (UTC-5 in March before DST, roughly).
  assert.equal(localCalendarDate("2026-03-01T23:30:00.000Z", "America/New_York"), "2026-03-01");
});

test("localTime formats a 24-hour local time string", () => {
  assert.equal(localTime("2026-07-15T14:30:00.000Z", "America/New_York"), "10:30");
});

test("addDaysToDateString adds whole days without drifting across month/year boundaries", () => {
  assert.equal(addDaysToDateString("2026-01-31", 1), "2026-02-01");
  assert.equal(addDaysToDateString("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysToDateString("2026-03-01", -1), "2026-02-28");
});
