/** A single calendar event, normalized from whatever source produced it. */
export interface CalendarEvent {
  /** Stable identifier from the source (e.g. the ICS UID). */
  id: string;
  title: string;
  /** ISO 8601 instant. */
  startsAt: string;
  /** ISO 8601 instant. */
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
  /** The calendar/feed this event came from, e.g. "Work", "Personal" — null if unlabeled. */
  calendarName: string | null;
}

/** Structured calendar data as exposed through the Context system. */
export interface CalendarContext {
  /** ISO timestamp of when this data was fetched/parsed. */
  retrievedAt: string;
  /** IANA zone used to decide what "today" means. */
  timezone: string;
  /** Events overlapping today's local calendar date, sorted by start time. */
  todayEvents: CalendarEvent[];
  /** Future events beyond today, within a bounded lookahead window, sorted by start time. */
  laterEvents: CalendarEvent[];
  /** The single soonest event (today or later) that hasn't started yet, or null. */
  nextEvent: CalendarEvent | null;
}

/** Classification of an event relative to a point in time — used by the briefing, not stored on the event itself. */
export type EventTiming = "past" | "ongoing" | "upcoming";

export function classifyEvent(event: CalendarEvent, now: Date): EventTiming {
  const nowMs = now.getTime();
  const startMs = new Date(event.startsAt).getTime();
  const endMs = new Date(event.endsAt).getTime();
  if (nowMs >= endMs) return "past";
  if (nowMs >= startMs) return "ongoing";
  return "upcoming";
}
