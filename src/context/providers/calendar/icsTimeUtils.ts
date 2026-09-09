/**
 * Timezone-aware date/time helpers for ICS parsing and "today" bucketing.
 *
 * ICS (RFC 5545) date-times come in three flavors, and getting this wrong
 * is exactly how "do not assume UTC is the user's display timezone" bugs
 * happen:
 *   - UTC:      DTSTART:20260910T103000Z            (trailing "Z")
 *   - Floating: DTSTART:20260910T103000              (no TZID, no "Z") —
 *               interpreted as wall-clock time in whatever zone is
 *               viewing it, i.e. the user's local zone.
 *   - Zoned:    DTSTART;TZID=America/New_York:20260910T103000
 *   - All-day:  DTSTART;VALUE=DATE:20260910           (date only)
 */

export interface DateTimeParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The IANA zone NIMBUS treats as "the user's local timezone" — same source DateTimeProvider uses. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Converts a wall-clock time in a given IANA timezone to a UTC instant
 * (as epoch milliseconds). Uses the standard "format a guess, measure the
 * offset, correct" technique since neither the JS `Date` constructor nor
 * `Date.UTC` can target an arbitrary named zone directly.
 */
export function zonedTimeToUtcMs(parts: DateTimeParts, timeZone: string): number {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offsetMs = tzOffsetMsAt(utcGuess, timeZone);
  return utcGuess - offsetMs;
}

/** How far `timeZone`'s wall clock is ahead of UTC at the instant `utcMs`, in milliseconds. */
function tzOffsetMsAt(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  // Some ICU implementations render midnight as "24:00" — normalize to 0.
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - utcMs;
}

/** The local calendar date (YYYY-MM-DD, in `timeZone`) an ISO instant falls on. */
export function localCalendarDate(isoInstant: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(isoInstant)); // en-CA formats as YYYY-MM-DD
}

/** Local HH:MM (24-hour) an ISO instant falls on, in `timeZone`. */
export function localTime(isoInstant: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return formatter.format(new Date(isoInstant));
}

/** Adds whole days to an ISO calendar date string (YYYY-MM-DD), returning the same format. */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  const date = new Date(utcMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
