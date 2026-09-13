import { localCalendarDate } from "../context/providers/calendar/icsTimeUtils";
import type { ActivitySession } from "../activity/types";
import type { UsageEntry } from "../activity/appUsage";
import type { CalendarEvent } from "../context/providers/calendar/types";

/**
 * "Your week" for the Home page — the last 7 days of what NIMBUS already
 * keeps: activity sessions, app and website time, what was added to the
 * collections, and what's coming up. Pure and deterministic: the same
 * inputs always give the same summary, and every sentence comes from a
 * number shown next to it.
 */

export interface WeeklySummaryInput {
  sessions: ActivitySession[];
  usage: UsageEntry[];
  cardsAdded: Array<{ addedAt: string; quantity: number }>;
  booksAdded: Array<{ addedAt: string }>;
  decks: Array<{ name: string; createdAt: string; updatedAt: string }>;
  upcoming: CalendarEvent[];
}

export interface WeeklySummary {
  /** The 7 local days, oldest first. */
  days: string[];
  activities: Array<{ name: string; icon?: string; minutes: number; sessions: number; perDay: number[] }>;
  activityMinutes: number;
  /** Top apps and sites by time, with each day's minutes. */
  usage: Array<{
    name: string;
    source: "app" | "website";
    minutes: number;
    daysUsed: number;
    perDay: number[];
  }>;
  collection: { cards: number; books: number; decksCreated: number; decksEdited: number };
  upcoming: Array<{ title: string; startsAt: string; isAllDay: boolean }>;
  highlights: string[];
}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE = 60_000;

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function buildWeeklySummary(input: WeeklySummaryInput, now: Date, timeZone: string): WeeklySummary {
  const nowMs = now.getTime();
  const dayOf = (ms: number) => localCalendarDate(new Date(ms).toISOString(), timeZone);
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = dayOf(nowMs - i * DAY_MS);
    if (!days.includes(day)) days.push(day);
  }
  const first = days[0];
  const inWeek = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms <= nowMs && dayOf(ms) >= first;
  };

  // Activity time, split per local day a minute at a time would be exact
  // but slow; sessions are split at 15-minute steps instead.
  const byActivity = new Map<
    string,
    { name: string; icon?: string; minutes: number; sessions: number; perDay: number[] }
  >();
  const weekStartMs = nowMs - 7 * DAY_MS;
  for (const session of input.sessions) {
    const start = Date.parse(session.startedAt);
    const end = Math.min(nowMs, Date.parse(session.endedAt ?? session.lastActiveAt));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end < weekStartMs) continue;
    const entry = byActivity.get(session.activity) ?? {
      name: session.activity,
      icon: session.icon,
      minutes: 0,
      sessions: 0,
      perDay: days.map(() => 0),
    };
    let counted = false;
    const step = 15 * MINUTE;
    for (let t = start; t < end; t += step) {
      const slice = Math.min(step, end - t);
      const index = days.indexOf(dayOf(t));
      if (index < 0) continue;
      entry.perDay[index] += slice / MINUTE;
      entry.minutes += slice / MINUTE;
      counted = true;
    }
    if (!counted) continue;
    entry.sessions += 1;
    byActivity.set(session.activity, entry);
  }
  const activities = [...byActivity.values()]
    .map((a) => ({ ...a, minutes: Math.round(a.minutes), perDay: a.perDay.map(Math.round) }))
    .filter((a) => a.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  const activityMinutes = activities.reduce((sum, a) => sum + a.minutes, 0);

  const usage = input.usage
    .map((u) => ({
      name: u.name,
      source: u.source,
      minutes: Math.round(days.reduce((sum, day) => sum + (u.days[day] ?? 0), 0)),
      daysUsed: days.filter((day) => day in u.days).length,
      perDay: days.map((day) => Math.round(u.days[day] ?? 0)),
    }))
    .filter((u) => u.daysUsed > 0)
    .sort((a, b) => b.minutes - a.minutes || b.daysUsed - a.daysUsed || a.name.localeCompare(b.name))
    .slice(0, 8);

  const collection = {
    cards: input.cardsAdded.filter((c) => inWeek(c.addedAt)).reduce((sum, c) => sum + c.quantity, 0),
    books: input.booksAdded.filter((b) => inWeek(b.addedAt)).length,
    decksCreated: input.decks.filter((d) => inWeek(d.createdAt)).length,
    decksEdited: input.decks.filter((d) => inWeek(d.updatedAt) && !inWeek(d.createdAt)).length,
  };

  const upcoming = input.upcoming
    .filter((e) => Date.parse(e.endsAt) > nowMs && Date.parse(e.startsAt) < nowMs + 7 * DAY_MS)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 6)
    .map((e) => ({ title: e.title, startsAt: e.startsAt, isAllDay: e.isAllDay }));

  const highlights: string[] = [];
  if (activities.length) {
    const top = activities[0];
    const activeDays = top.perDay.filter((m) => m > 0).length;
    highlights.push(
      `${formatMinutes(activityMinutes)} in activities — most of it ${top.name} (${formatMinutes(top.minutes)} over ${activeDays} day${activeDays === 1 ? "" : "s"}).`
    );
    const busiest = days
      .map((day, i) => ({ day, minutes: activities.reduce((sum, a) => sum + a.perDay[i], 0) }))
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (busiest.minutes > 0)
      highlights.push(`Busiest day: ${weekdayName(busiest.day)}, ${formatMinutes(busiest.minutes)}.`);
  }
  if (usage.length) {
    const topSite = usage.find((u) => u.source === "website");
    if (topSite) highlights.push(`Most-used website: ${topSite.name}, on ${topSite.daysUsed} of 7 days.`);
    const topApp = usage.find((u) => u.source === "app");
    if (topApp) highlights.push(`Most-used app: ${topApp.name}, ${formatMinutes(topApp.minutes)}.`);
  }
  const added = [
    collection.cards ? `${collection.cards} card${collection.cards === 1 ? "" : "s"}` : null,
    collection.books ? `${collection.books} book${collection.books === 1 ? "" : "s"}` : null,
    collection.decksCreated
      ? `${collection.decksCreated} new deck${collection.decksCreated === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  if (added.length) highlights.push(`Added ${added.join(", ")} to your collections.`);
  if (upcoming.length) {
    highlights.push(
      `${upcoming.length === 6 ? "6 or more" : upcoming.length} event${upcoming.length === 1 ? "" : "s"} in the next 7 days.`
    );
  }

  return { days, activities, activityMinutes, usage, collection, upcoming, highlights };
}

/** "Monday" for "2026-09-14" — the date is a calendar day, so it's read in UTC. */
export function weekdayName(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`)
  );
}
