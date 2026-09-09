import { zonedTimeToUtcMs } from "./icsTimeUtils";

export interface ParsedIcsEvent {
  uid: string;
  title: string;
  startsAt: string; // ISO instant
  endsAt: string; // ISO instant
  isAllDay: boolean;
  location: string | null;
}

export interface ParsedIcsCalendar {
  /** From the feed's X-WR-CALNAME property, if present. */
  calendarName: string | null;
  events: ParsedIcsEvent[];
  /** Count of VEVENT blocks that couldn't be parsed (missing UID/DTSTART, bad date value, etc.). */
  skippedCount: number;
}

/**
 * A deliberately minimal RFC 5545 (iCalendar) parser — just enough to
 * read the fields NIMBUS's CalendarContext needs (see
 * src/context/providers/calendar/types.ts): UID, SUMMARY, DTSTART,
 * DTEND, LOCATION, and the feed-level X-WR-CALNAME.
 *
 * Deliberately NOT implemented (out of scope for this feature): RRULE
 * recurrence expansion, VALARM, VTIMEZONE component parsing (TZID values
 * are resolved via the IANA database through Intl instead — see
 * icsTimeUtils.ts — which covers the common case of a TZID naming a real
 * IANA zone, but not custom VTIMEZONE definitions), attendees, and
 * multi-value properties. A recurring event will appear once, using its
 * first/literal DTSTART — see README/ARCHITECTURE for this documented as
 * a known limitation.
 *
 * Malformed input degrades gracefully: an unparseable VEVENT is skipped
 * (counted in `skippedCount`), never thrown — parsing one bad event must
 * not lose every other event in the feed, and must never crash the
 * caller. This function is pure (no logging, no I/O) — the caller
 * decides what to do with `skippedCount`.
 */
export function parseIcs(raw: string, defaultTimeZone: string): ParsedIcsCalendar {
  const lines = unfoldLines(raw);

  let calendarName: string | null = null;
  const events: ParsedIcsEvent[] = [];
  let skippedCount = 0;

  let inEvent = false;
  let current: Record<string, { value: string; params: Record<string, string> }> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      inEvent = false;
      const parsed = finalizeEvent(current, defaultTimeZone);
      if (parsed) {
        events.push(parsed);
      } else {
        skippedCount++;
      }
      continue;
    }

    const property = parseProperty(line);
    if (!property) continue;

    if (!inEvent && property.name === "X-WR-CALNAME") {
      calendarName = unescapeText(property.value);
      continue;
    }

    if (inEvent) {
      current[property.name] = { value: property.value, params: property.params };
    }
  }

  return { calendarName, events, skippedCount };
}

function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");

  const unfolded: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function parseProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;

  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...paramParts] = head.split(";");

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    params[part.slice(0, eqIdx).toUpperCase()] = part.slice(eqIdx + 1);
  }

  return { name: name.toUpperCase(), params, value };
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function finalizeEvent(
  fields: Record<string, { value: string; params: Record<string, string> }>,
  defaultTimeZone: string
): ParsedIcsEvent | null {
  const uid = fields.UID?.value?.trim();
  const dtstart = fields.DTSTART;
  if (!uid || !dtstart) return null;

  let start: { iso: string; isAllDay: boolean };
  try {
    start = parseDateTimeValue(dtstart.value, dtstart.params, defaultTimeZone);
  } catch {
    return null;
  }

  let end: { iso: string; isAllDay: boolean } | null = null;
  if (fields.DTEND) {
    try {
      end = parseDateTimeValue(fields.DTEND.value, fields.DTEND.params, defaultTimeZone);
    } catch {
      end = null;
    }
  }

  const endIso =
    end?.iso ??
    new Date(
      new Date(start.iso).getTime() + (start.isAllDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000)
    ).toISOString();

  const title = fields.SUMMARY ? unescapeText(fields.SUMMARY.value) : "(Untitled event)";
  const location = fields.LOCATION ? unescapeText(fields.LOCATION.value) : null;

  return {
    uid,
    title,
    startsAt: start.iso,
    endsAt: endIso,
    isAllDay: start.isAllDay,
    location: location || null,
  };
}

function parseDateTimeValue(
  value: string,
  params: Record<string, string>,
  defaultTimeZone: string
): { iso: string; isAllDay: boolean } {
  const isDateOnly = params.VALUE === "DATE" || /^\d{8}$/.test(value);

  if (isDateOnly) {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) throw new Error(`Unrecognized all-day date value: ${value}`);
    const [, y, mo, d] = match;
    const ms = zonedTimeToUtcMs(
      { year: Number(y), month: Number(mo), day: Number(d), hour: 0, minute: 0, second: 0 },
      defaultTimeZone
    );
    return { iso: new Date(ms).toISOString(), isAllDay: true };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) throw new Error(`Unrecognized date-time value: ${value}`);
  const [, y, mo, d, h, mi, s, isUtc] = match;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  };

  if (isUtc) {
    return {
      iso: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)).toISOString(),
      isAllDay: false,
    };
  }

  // No "Z": either TZID-qualified or a "floating" local time — both are
  // resolved as wall-clock time in an IANA zone (TZID if given, else the
  // zone NIMBUS treats as the user's local zone).
  const tzid = params.TZID || defaultTimeZone;
  const ms = zonedTimeToUtcMs(parts, tzid);
  return { iso: new Date(ms).toISOString(), isAllDay: false };
}
