import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTimeProvider } from "./dateTimeProvider";

test("reports date, time, and day of week for a fixed clock", () => {
  // 2024-01-15 09:05:03 local time — a Monday.
  const fixed = new Date(2024, 0, 15, 9, 5, 3);
  // Locale is pinned to en-US here only so this assertion is deterministic
  // regardless of the host's OS locale — production leaves it unset (see
  // "reports a locale-appropriate day name" below).
  const provider = new DateTimeProvider(() => fixed, "en-US");

  const ctx = provider.getContext();

  assert.equal(ctx.date, "2024-01-15");
  assert.equal(ctx.time, "09:05:03");
  assert.equal(ctx.dayOfWeek, "Monday");
  assert.equal(ctx.dayOfWeekIndex, 1);
  assert.equal(ctx.isoTimestamp.startsWith("2024-01-15T09:05:03"), true);
});

test("reports a non-empty IANA timezone name", () => {
  const provider = new DateTimeProvider(() => new Date());
  const ctx = provider.getContext();

  assert.equal(typeof ctx.timezone, "string");
  assert.ok(ctx.timezone.length > 0);
});

test("is always available", () => {
  const provider = new DateTimeProvider();
  assert.equal(provider.isAvailable(), true);
});

test("reports a locale-appropriate day name when a locale is given", () => {
  const fixed = new Date(2024, 0, 15, 9, 5, 3); // a Monday
  const provider = new DateTimeProvider(() => fixed, "pt-PT");

  const ctx = provider.getContext();
  assert.match(ctx.dayOfWeek.toLowerCase(), /segunda/);
});

test("pads single-digit date/time components", () => {
  const fixed = new Date(2024, 2, 5, 4, 2, 9); // 2024-03-05 04:02:09
  const provider = new DateTimeProvider(() => fixed);

  const ctx = provider.getContext();

  assert.equal(ctx.date, "2024-03-05");
  assert.equal(ctx.time, "04:02:09");
});
