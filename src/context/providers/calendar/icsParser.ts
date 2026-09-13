import { expandRecurrence, CivilDate } from "./icsRecurrence";
import { resolveTimeZone, zonedTimeToUtcMs } from "./icsTimeUtils";

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

export interface ParseIcsOptions {
  /**
   * Expand recurring events (RRULE) into their occurrences starting in
   * [from, to). Without it, a recurring event appears once, at its
   * literal DTSTART.
   */
  expand?: { from: Date; to: Date };
}

type Property = { value: string; params: Record<string, string> };
type EventFields = Record<string, Property>;
interface EventBlock {
  fields: EventFields;
  /** EXDATE may repeat; every other property NIMBUS reads appears once. */
  exdates: Property[];
}

/**
 * A deliberately minimal RFC 5545 (iCalendar) parser — just enough to
 * read the fields NIMBUS's CalendarContext needs (see
 * src/context/providers/calendar/types.ts): UID, SUMMARY, DTSTART,
 * DTEND, LOCATION, STATUS, RRULE/EXDATE/RECURRENCE-ID, and the
 * feed-level X-WR-CALNAME.
 *
 * Recurrence: with `options.expand`, an RRULE is expanded into its
 * occurrences inside that window (see icsRecurrence.ts), minus EXDATEs,
 * with moved or cancelled single occurrences (a VEVENT sharing the UID
 * and carrying RECURRENCE-ID) replacing the generated one. A rule the
 * expander doesn't support keeps the single literal occurrence. RDATE is
 * not read.
 *
 * Deliberately NOT implemented: VALARM, VTIMEZONE component parsing (TZID
 * values are resolved via the IANA database through Intl instead — see
 * icsTimeUtils.ts — which covers the common case of a TZID naming a real
 * IANA zone, but not custom VTIMEZONE definitions), and attendees.
 *
 * Malformed input degrades gracefully: an unparseable VEVENT is skipped
 * (counted in `skippedCount`), never thrown — parsing one bad event must
 * not lose every other event in the feed, and must never crash the
 * caller. This function is pure (no logging, no I/O) — the caller
 * decides what to do with `skippedCount`.
 */
export function parseIcs(
  raw: string,
  defaultTimeZone: string,
  options: ParseIcsOptions = {}
): ParsedIcsCalendar {
  const lines = unfoldLines(raw);

  let calendarName: string | null = null;
  const blocks: EventBlock[] = [];

  let inEvent = false;
  let current: EventBlock = { fields: {}, exdates: [] };

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = { fields: {}, exdates: [] };
      continue;
    }

    if (line === "END:VEVENT") {
      inEvent = false;
      blocks.push(current);
      continue;
    }

    const property = parseProperty(line);
    if (!property) continue;

    if (!inEvent && property.name === "X-WR-CALNAME") {
      calendarName = unescapeText(property.value);
      continue;
    }

    if (inEvent) {
      const entry = { value: property.value, params: property.params };
      if (property.name === "EXDATE") current.exdates.push(entry);
      else current.fields[property.name] = entry;
    }
  }

  // Moved/cancelled single occurrences, by UID, keyed by the instant they replace.
  const overridden = new Map<string, Set<number>>();
  for (const { fields } of blocks) {
    const uid = fields.UID?.value?.trim();
    if (!uid || !fields["RECURRENCE-ID"]) continue;
    const ms = instantOf(fields["RECURRENCE-ID"], defaultTimeZone);
    if (ms === null) continue;
    if (!overridden.has(uid)) overridden.set(uid, new Set());
    overridden.get(uid)?.add(ms);
  }

  const events: ParsedIcsEvent[] = [];
  let skippedCount = 0;
  for (const { fields, exdates } of blocks) {
    const parsed = finalizeEvent(fields, defaultTimeZone);
    if (!parsed) {
      skippedCount++;
      continue;
    }
    if (fields.STATUS?.value.trim().toUpperCase() === "CANCELLED") continue;
    if (options.expand && fields.RRULE && !fields["RECURRENCE-ID"]) {
      events.push(
        ...expandEvent(parsed, fields, exdates, defaultTimeZone, options.expand, overridden.get(parsed.uid))
      );
    } else {
      events.push(parsed);
    }
  }

  return { calendarName, events, skippedCount };
}

/** A recurring event's occurrences in the window, or the event itself if its rule can't be expanded. */
function expandEvent(
  event: ParsedIcsEvent,
  fields: EventFields,
  exdates: Property[],
  defaultTimeZone: string,
  window: { from: Date; to: Date },
  overridden: Set<number> | undefined
): ParsedIcsEvent[] {
  const dtstart = fields.DTSTART;
  const startMs = new Date(event.startsAt).getTime();
  const durationMs = new Date(event.endsAt).getTime() - startMs;
  const start = civilParts(dtstart.value);
  if (!start) return [event];

  const toMs = (date: CivilDate): number =>
    instantOf({ value: formatCivil(date, dtstart.value), params: dtstart.params }, defaultTimeZone) ?? NaN;

  const excluded = new Set<number>(overridden ?? []);
  for (const exdate of exdates) {
    for (const value of exdate.value.split(",")) {
      const ms = instantOf({ value: value.trim(), params: exdate.params }, defaultTimeZone);
      if (ms !== null) excluded.add(ms);
    }
  }

  const starts = expandRecurrence({
    rrule: fields.RRULE.value,
    start,
    startMs,
    toMs,
    parseUntil: (value) => {
      const ms = instantOf({ value, params: dtstart.params }, defaultTimeZone);
      // A date-only UNTIL on a timed event includes that whole day.
      return ms !== null && /^\d{8}$/.test(value) && !event.isAllDay ? ms + 24 * 60 * 60 * 1000 - 1 : ms;
    },
    // An occurrence that started before the window but is still going on counts.
    window: { fromMs: window.from.getTime() - Math.max(0, durationMs), toMs: window.to.getTime() },
  });
  if (starts === null) return [event];

  return starts
    .filter((ms) => !Number.isNaN(ms) && !excluded.has(ms))
    .map((ms) => ({
      ...event,
      startsAt: new Date(ms).toISOString(),
      endsAt: new Date(ms + durationMs).toISOString(),
    }));
}

function civilParts(value: string): CivilDate | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

/** An occurrence's date written in DTSTART's own form (same time of day, same Z or not). */
function formatCivil(date: CivilDate, dtstartValue: string): string {
  const ymd = `${String(date.year).padStart(4, "0")}${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;
  return ymd + dtstartValue.slice(8);
}

function instantOf(property: Property, defaultTimeZone: string): number | null {
  try {
    return new Date(parseDateTimeValue(property.value, property.params, defaultTimeZone).iso).getTime();
  } catch {
    return null;
  }
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
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function finalizeEvent(fields: EventFields, defaultTimeZone: string): ParsedIcsEvent | null {
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
      iso: new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
      ).toISOString(),
      isAllDay: false,
    };
  }

  // No "Z": either TZID-qualified or a "floating" local time — both are
  // resolved as wall-clock time in an IANA zone (TZID if given, else the
  // zone NIMBUS treats as the user's local zone).
  const tzid = resolveTimeZone(params.TZID, defaultTimeZone);
  const ms = zonedTimeToUtcMs(parts, tzid);
  return { iso: new Date(ms).toISOString(), isAllDay: false };
}
