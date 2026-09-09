import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatContextValue,
  formatEventDateLabel,
  formatEventTime,
  formatMs,
  formatTaskDue,
  maskAddress,
  triggerSummary,
  withSkipIfActiveCondition,
} from "./uiFormat";

// ------------------------------------------------------------ maskAddress

test("a short feed address is shown in full", () => {
  assert.equal(maskAddress("https://example.com/cal.ics"), "https://example.com/cal.ics");
});

test("a long feed address is truncated in the middle, never fully shown", () => {
  const secret = `https://calendar.google.com/calendar/ical/${"s".repeat(60)}/basic.ics`;

  const masked = maskAddress(secret);

  assert.equal(masked.includes("…"), true);
  assert.equal(masked.length < secret.length, true);
  assert.equal(masked.includes("s".repeat(60)), false, "the secret portion must not survive masking");
});

test("masking keeps enough of both ends to tell two feeds apart", () => {
  const a = maskAddress(`https://example.com/feeds/${"a".repeat(60)}/one.ics`);
  const b = maskAddress(`https://example.com/feeds/${"b".repeat(60)}/two.ics`);

  assert.notEqual(a, b);
});

test("masking is exclusive at the boundary length", () => {
  assert.equal(maskAddress("x".repeat(40)).includes("…"), false);
  assert.equal(maskAddress("x".repeat(41)).includes("…"), true);
});

// --------------------------------------------------------------- formatMs

test("formatMs renders m:ss with a zero-padded seconds field", () => {
  assert.equal(formatMs(0), "0:00");
  assert.equal(formatMs(5000), "0:05");
  assert.equal(formatMs(65_000), "1:05");
  assert.equal(formatMs(600_000), "10:00");
});

test("formatMs does not roll over into hours", () => {
  // A long track/podcast keeps counting in minutes rather than resetting.
  assert.equal(formatMs(3_600_000), "60:00");
});

test("formatMs clamps a negative position to zero rather than rendering a negative clock", () => {
  assert.equal(formatMs(-5000), "0:00");
});

test("formatMs rounds to the nearest second", () => {
  assert.equal(formatMs(1499), "0:01");
  assert.equal(formatMs(1500), "0:02");
});

// ---------------------------------------------------------- triggerSummary

test("each trigger type gets a readable one-line summary", () => {
  assert.equal(
    triggerSummary({ type: "applicationOpened", application: "steam.exe" }),
    "App opened: steam.exe"
  );
  assert.equal(
    triggerSummary({ type: "websiteOpened", matchField: "windowTitle", pattern: "YouTube" }),
    "Website windowTitle contains: YouTube"
  );
  assert.equal(
    triggerSummary({ type: "folderOpened", path: "C:\\Projects" }),
    "Folder path contains: C:\\Projects"
  );
});

// ----------------------------------------------- withSkipIfActiveCondition

test("checking the box adds the condition", () => {
  const result = withSkipIfActiveCondition([], true);

  assert.deepEqual(result, [{ type: "actionsNotAlreadyActive" }]);
});

test("unchecking the box removes the condition", () => {
  const result = withSkipIfActiveCondition([{ type: "actionsNotAlreadyActive" }], false);

  assert.deepEqual(result, []);
});

test("toggling never duplicates the condition", () => {
  const result = withSkipIfActiveCondition([{ type: "actionsNotAlreadyActive" }], true);

  assert.equal(result.filter((c) => c.type === "actionsNotAlreadyActive").length, 1);
});

test("conditions set outside this UI survive a toggle in both directions", () => {
  const existing = [{ type: "weekdaysOnly" }, { type: "spotifyNotAlreadyPlaying" }];

  const added = withSkipIfActiveCondition(existing, true);
  const removed = withSkipIfActiveCondition(added, false);

  assert.equal(added.length, 3);
  assert.deepEqual(removed, existing);
});

test("withSkipIfActiveCondition does not mutate the array it was given", () => {
  const existing = [{ type: "weekdaysOnly" }];

  withSkipIfActiveCondition(existing, true);

  assert.deepEqual(existing, [{ type: "weekdaysOnly" }]);
});

// ----------------------------------------------------------- formatTaskDue

test("a task with no due date has nothing to render", () => {
  assert.equal(formatTaskDue({ dueAt: null }), null);
});

test("a date-only due date renders without a time", () => {
  const result = formatTaskDue({ dueAt: "2026-03-14T00:00:00.000Z", dueIsDateOnly: true });

  assert.notEqual(result, null);
  assert.equal(/\d/.test(result!.text), true);
  assert.equal(result!.text.includes(":"), false, "a date-only task should not show a clock time");
});

test("a timed due date includes a time", () => {
  const result = formatTaskDue({ dueAt: "2026-03-14T15:30:00.000Z", dueIsDateOnly: false });

  assert.notEqual(result, null);
  assert.equal(result!.text.includes(":"), true);
});

test("only an overdue task is flagged overdue", () => {
  const overdue = formatTaskDue({ dueAt: "2026-03-14T15:30:00.000Z", category: "overdue" });
  const dueToday = formatTaskDue({ dueAt: "2026-03-14T15:30:00.000Z", category: "dueToday" });

  assert.equal(overdue!.overdue, true);
  assert.equal(dueToday!.overdue, false);
});

// ------------------------------------------------------ formatContextValue

test("absent context values render as an em dash rather than blank", () => {
  assert.equal(formatContextValue(null), "—");
  assert.equal(formatContextValue(undefined), "—");
});

test("primitive context values render as their own text", () => {
  assert.equal(formatContextValue("sunny"), "sunny");
  assert.equal(formatContextValue(21), "21");
  assert.equal(formatContextValue(false), "false");
});

test("a zero or empty string is shown as itself, not treated as absent", () => {
  assert.equal(formatContextValue(0), "0");
  assert.equal(formatContextValue(""), "");
});

test("object context values render as JSON", () => {
  assert.equal(formatContextValue({ temp: 21 }), '{"temp":21}');
  assert.equal(formatContextValue([1, 2]), "[1,2]");
});

// -------------------------------------------------------- event formatting

test("event times render in the calendar's timezone, not the machine's", () => {
  const iso = "2026-03-14T15:30:00.000Z";

  assert.equal(formatEventTime(iso, "UTC"), "15:30");
  assert.equal(formatEventTime(iso, "America/New_York"), "11:30");
  assert.equal(formatEventTime(iso, "Asia/Tokyo"), "00:30");
});

test("event times use a 24-hour clock regardless of locale defaults", () => {
  assert.equal(formatEventTime("2026-03-14T23:05:00.000Z", "UTC"), "23:05");
  assert.equal(formatEventTime("2026-03-14T00:05:00.000Z", "UTC"), "00:05");
});

test("a date label follows the calendar's timezone across a day boundary", () => {
  // 23:30 UTC is already the next day in Tokyo — the label must say so.
  const iso = "2026-03-14T23:30:00.000Z";

  const utc = formatEventDateLabel(iso, "UTC");
  const tokyo = formatEventDateLabel(iso, "Asia/Tokyo");

  assert.equal(utc.includes("14"), true);
  assert.equal(tokyo.includes("15"), true);
  assert.notEqual(utc, tokyo);
});
