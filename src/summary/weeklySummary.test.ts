import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeeklySummary, formatMinutes, weekdayName } from "./weeklySummary";
import type { ActivitySession } from "../activity/types";

const now = new Date("2026-09-13T20:00:00Z");

function session(activity: string, startedAt: string, endedAt: string): ActivitySession {
  return {
    id: `${activity}-${startedAt}`,
    activity,
    source: "application",
    sourceValue: "x.exe",
    anchorProcess: null,
    startedAt,
    lastActiveAt: endedAt,
    endedAt,
    state: "ended",
  } as ActivitySession;
}

test("activity time is added up per activity and per day, inside the last 7 days only", () => {
  const summary = buildWeeklySummary(
    {
      sessions: [
        session("Study", "2026-09-12T09:00:00Z", "2026-09-12T11:00:00Z"),
        session("Study", "2026-09-13T09:00:00Z", "2026-09-13T10:00:00Z"),
        session("Gaming", "2026-09-13T18:00:00Z", "2026-09-13T18:30:00Z"),
        session("Old", "2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z"),
      ],
      usage: [],
      cardsAdded: [],
      booksAdded: [],
      decks: [],
      upcoming: [],
    },
    now,
    "UTC"
  );
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days[6], "2026-09-13");
  assert.deepEqual(
    summary.activities.map((a) => [a.name, a.minutes, a.sessions]),
    [
      ["Study", 180, 2],
      ["Gaming", 30, 1],
    ]
  );
  assert.equal(summary.activities[0].perDay[5], 120);
  assert.equal(summary.activityMinutes, 210);
  assert.match(summary.highlights[0], /3 h 30 min in activities — most of it Study \(3 h over 2 days\)/);
  assert.match(summary.highlights[1], /Busiest day: Saturday, 2 h/);
});

test("usage, collection additions and upcoming events", () => {
  const summary = buildWeeklySummary(
    {
      sessions: [],
      usage: [
        {
          key: "youtube",
          name: "YouTube",
          source: "website",
          days: { "2026-09-11": 20, "2026-09-12": 15, "2026-09-13": 10 },
          daysUsed: 3,
          minutesUsed: 45,
          status: "candidate",
        },
      ],
      cardsAdded: [
        { addedAt: "2026-09-12T10:00:00Z", quantity: 4 },
        { addedAt: "2026-08-01T10:00:00Z", quantity: 1 },
      ],
      booksAdded: [{ addedAt: "2026-09-10T10:00:00Z" }],
      decks: [{ name: "Burn", createdAt: "2026-09-13T10:00:00Z", updatedAt: "2026-09-13T11:00:00Z" }],
      upcoming: [
        {
          id: "1",
          title: "Massage",
          startsAt: "2026-09-14T08:30:00Z",
          endsAt: "2026-09-14T09:30:00Z",
          isAllDay: false,
          location: null,
          calendarName: null,
        },
        {
          id: "2",
          title: "Far away",
          startsAt: "2026-10-30T08:30:00Z",
          endsAt: "2026-10-30T09:30:00Z",
          isAllDay: false,
          location: null,
          calendarName: null,
        },
      ],
    },
    now,
    "UTC"
  );
  assert.equal(summary.usage[0].daysUsed, 3);
  assert.deepEqual(summary.collection, { cards: 4, books: 1, decksCreated: 1, decksEdited: 0 });
  assert.deepEqual(
    summary.upcoming.map((e) => e.title),
    ["Massage"]
  );
  assert.ok(summary.highlights.includes("Most-used website: YouTube, on 3 of 7 days."));
  assert.ok(summary.highlights.includes("Added 4 cards, 1 book, 1 new deck to your collections."));
});

test("formatting helpers", () => {
  assert.equal(formatMinutes(45), "45 min");
  assert.equal(formatMinutes(120), "2 h");
  assert.equal(formatMinutes(125), "2 h 5 min");
  assert.equal(weekdayName("2026-09-14"), "Monday");
});
