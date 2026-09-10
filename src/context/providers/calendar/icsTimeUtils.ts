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
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
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

/**
 * Windows timezone names that calendar feeds use in place of IANA ones.
 * Outlook and Exchange write `TZID=GMT Standard Time` rather than
 * `Europe/London`, and Intl rejects those outright. Not exhaustive: the
 * common zones, with anything else falling back (see resolveTimeZone).
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "Morocco Standard Time": "Africa/Casablanca",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Egypt Standard Time": "Africa/Cairo",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  UTC: "Etc/UTC",
  "Coordinated Universal Time": "Etc/UTC",
};

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA zone a feed's TZID refers to, or `fallback` when it names
 * nothing Intl understands.
 *
 * Handles the two shapes real feeds send that Intl rejects: a quoted
 * value (`TZID="Europe/Lisbon"`) and a Windows zone name. Anything still
 * unrecognised is read in the fallback zone rather than dropped — an
 * event that may be an hour out is far more useful than one that
 * silently vanishes, which is what a thrown RangeError used to cause.
 */
export function resolveTimeZone(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  const cleaned = tzid.trim().replace(/^"(.*)"$/, "$1");
  const candidate = WINDOWS_TO_IANA[cleaned] ?? cleaned;
  return isValidTimeZone(candidate) ? candidate : fallback;
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

/**
 * How to refer to the day an event falls on, relative to today: "today",
 * "tomorrow", "on Saturday" within the coming week, or "on 20 Sep"
 * beyond it.
 *
 * A weekday name is only unambiguous for about a week — "on Saturday"
 * eight days out would mean the wrong Saturday — so anything further
 * away gets a date instead.
 */
export function relativeDayLabel(isoInstant: string, todayDate: string, timeZone: string): string {
  const eventDate = localCalendarDate(isoInstant, timeZone);
  if (eventDate === todayDate) return "today";
  if (eventDate === addDaysToDateString(todayDate, 1)) return "tomorrow";

  for (let days = 2; days <= 6; days++) {
    if (eventDate === addDaysToDateString(todayDate, days)) {
      const weekday = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "long" }).format(
        new Date(isoInstant)
      );
      return `on ${weekday}`;
    }
  }

  const date = new Intl.DateTimeFormat(undefined, {
    timeZone,
    day: "numeric",
    month: "short",
  }).format(new Date(isoInstant));
  return `on ${date}`;
}
