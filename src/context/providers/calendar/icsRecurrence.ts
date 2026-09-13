/**
 * RRULE expansion (RFC 5545 §3.3.10) for the ICS parser — pure, no I/O.
 *
 * Occurrences are generated in *wall-clock* terms (year/month/day plus the
 * DTSTART's time of day) and only then turned into instants by the
 * caller's `toMs`, so a weekly 09:00 meeting stays at 09:00 across a DST
 * change, the way calendar apps show it.
 *
 * Supported: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL,
 * BYDAY (with ordinals like 2TU / -1FR for MONTHLY, and for YEARLY with
 * BYMONTH), BYMONTHDAY (negative too), BYMONTH, BYSETPOS (MONTHLY/YEARLY)
 * and WKST. Anything else (HOURLY and finer, BYYEARDAY, BYWEEKNO,
 * BYHOUR…) returns `null`, and the caller keeps the single literal
 * occurrence — the behavior from before recurrence was supported.
 */

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface RecurrenceInput {
  rrule: string;
  /** DTSTART's wall-clock date. */
  start: CivilDate;
  /** DTSTART as an instant. */
  startMs: number;
  /** Turns an occurrence's wall-clock date (at DTSTART's time of day) into an instant. */
  toMs: (date: CivilDate) => number;
  /** Parses an UNTIL value into an instant, or null if unreadable. */
  parseUntil: (value: string) => number | null;
  /** Only occurrences starting in [fromMs, toMs) are returned. */
  window: { fromMs: number; toMs: number };
}

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface WeekdayRule {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** 0 when there is no ordinal ("every Tuesday"). */
  ordinal: number;
}

interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  untilMs: number | null;
  byDay: WeekdayRule[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const SUPPORTED_PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);
/** A runaway guard: no feed needs more periods than this to reach the window. */
const MAX_PERIODS = 20000;
/** And no single event needs more occurrences than this inside it. */
export const MAX_OCCURRENCES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Occurrence start instants inside the window, ascending — or null when the rule can't be expanded. */
export function expandRecurrence(input: RecurrenceInput): number[] | null {
  const rule = parseRule(input.rrule, input.parseUntil);
  if (!rule) return null;

  const out: number[] = [];
  let produced = 0;
  // With no COUNT, whole periods before the window can be skipped; with a
  // COUNT every earlier occurrence has to be counted.
  const firstPeriod =
    rule.count === null
      ? Math.max(0, periodsBefore(rule, input.start, input.window.fromMs - input.startMs))
      : 0;

  for (let k = firstPeriod; k < firstPeriod + MAX_PERIODS; k++) {
    const candidates = candidatesForPeriod(rule, input.start, k);
    if (candidates === null) return null;
    let passedEnd = false;
    for (const date of candidates) {
      const ms = input.toMs(date);
      if (ms < input.startMs) continue;
      if (rule.untilMs !== null && ms > rule.untilMs) return out;
      if (ms >= input.window.toMs) {
        passedEnd = true;
        break;
      }
      produced++;
      if (ms >= input.window.fromMs) out.push(ms);
      if (rule.count !== null && produced >= rule.count) return out;
      if (out.length >= MAX_OCCURRENCES) return out;
    }
    if (passedEnd) return out;
    if (periodStartMs(rule, input.start, k) > input.window.toMs) return out;
  }
  return out;
}

function parseRule(rrule: string, parseUntil: (value: string) => number | null): Rule | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    parts.set(
      piece.slice(0, eq).trim().toUpperCase(),
      piece
        .slice(eq + 1)
        .trim()
        .toUpperCase()
    );
  }
  for (const key of parts.keys()) if (!SUPPORTED_PARTS.has(key)) return null;

  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;

  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;

  let untilMs: number | null = null;
  if (parts.has("UNTIL")) {
    untilMs = parseUntil(parts.get("UNTIL") as string);
    if (untilMs === null) return null;
  }

  const byDay: WeekdayRule[] = [];
  for (const token of list(parts.get("BYDAY"))) {
    const m = token.match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
    if (!m) return null;
    byDay.push({ weekday: WEEKDAYS.indexOf(m[2]), ordinal: m[1] ? Number(m[1]) : 0 });
  }
  const byMonthDay = numbers(parts.get("BYMONTHDAY"), 1, 31);
  const byMonth = numbers(parts.get("BYMONTH"), 1, 12);
  const bySetPos = numbers(parts.get("BYSETPOS"), 1, 366);
  if (!byMonthDay || !byMonth || !bySetPos) return null;

  const wkst = parts.has("WKST") ? WEEKDAYS.indexOf(parts.get("WKST") as string) : 0;
  if (wkst === -1) return null;

  // Ordinal weekdays mean "nth in the month/year"; only month-scoped ones are supported.
  const hasOrdinal = byDay.some((d) => d.ordinal !== 0);
  if (hasOrdinal && (freq === "DAILY" || freq === "WEEKLY")) return null;
  if (hasOrdinal && freq === "YEARLY" && byMonth.length === 0) return null;
  if (bySetPos.length > 0 && (freq === "DAILY" || freq === "WEEKLY")) return null;

  return { freq, interval, count, untilMs, byDay, byMonthDay, byMonth, bySetPos, wkst };
}

function list(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Integers with |n| in [min, max]; null if any token isn't one. */
function numbers(value: string | undefined, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const token of list(value)) {
    const n = Number(token);
    if (!Number.isInteger(n) || Math.abs(n) < min || Math.abs(n) > max) return null;
    out.push(n);
  }
  return out;
}

/** Wall-clock dates for the k-th period after DTSTART's, ascending. */
function candidatesForPeriod(rule: Rule, start: CivilDate, k: number): CivilDate[] | null {
  switch (rule.freq) {
    case "DAILY": {
      const date = addDays(start, k * rule.interval);
      return matchesFilters(rule, date) ? [date] : [];
    }
    case "WEEKLY": {
      const weekStart = addDays(start, -((weekday(start) - rule.wkst + 7) % 7) + 7 * k * rule.interval);
      const days = rule.byDay.length ? rule.byDay.map((d) => d.weekday) : [weekday(start)];
      const dates = [...new Set(days)]
        .map((wd) => addDays(weekStart, (wd - rule.wkst + 7) % 7))
        .filter((date) => rule.byMonth.length === 0 || rule.byMonth.includes(date.month));
      return sortDates(dates);
    }
    case "MONTHLY": {
      const monthIndex = start.year * 12 + (start.month - 1) + k * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(month)) return [];
      return applySetPos(rule, monthCandidates(rule, start, year, month));
    }
    case "YEARLY": {
      const year = start.year + k * rule.interval;
      const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [start.month];
      const dates = months.flatMap((month) => monthCandidates(rule, start, year, month));
      return applySetPos(rule, sortDates(dates));
    }
  }
}

/** Days in one month picked by BYMONTHDAY/BYDAY, or DTSTART's day of month. */
function monthCandidates(rule: Rule, start: CivilDate, year: number, month: number): CivilDate[] {
  const length = daysInMonth(year, month);
  let days: number[];
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((d) => (d > 0 ? d : length + d + 1)).filter((d) => d >= 1 && d <= length);
    if (rule.byDay.length) {
      days = days.filter((d) => rule.byDay.some((r) => r.weekday === weekday({ year, month, day: d })));
    }
  } else if (rule.byDay.length) {
    days = [];
    for (const r of rule.byDay) {
      const matching: number[] = [];
      for (let d = 1; d <= length; d++) if (weekday({ year, month, day: d }) === r.weekday) matching.push(d);
      if (r.ordinal === 0) days.push(...matching);
      else {
        const picked = r.ordinal > 0 ? matching[r.ordinal - 1] : matching[matching.length + r.ordinal];
        if (picked !== undefined) days.push(picked);
      }
    }
  } else {
    // A month without DTSTART's day (the 31st in April) is skipped, per the RFC.
    days = start.day <= length ? [start.day] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b).map((day) => ({ year, month, day }));
}

function applySetPos(rule: Rule, dates: CivilDate[]): CivilDate[] {
  if (!rule.bySetPos.length) return dates;
  const picked = rule.bySetPos
    .map((pos) => (pos > 0 ? dates[pos - 1] : dates[dates.length + pos]))
    .filter((d): d is CivilDate => d !== undefined);
  return sortDates([...new Map(picked.map((d) => [dayNumber(d), d])).values()]);
}

function matchesFilters(rule: Rule, date: CivilDate): boolean {
  if (rule.byMonth.length && !rule.byMonth.includes(date.month)) return false;
  if (rule.byMonthDay.length) {
    const length = daysInMonth(date.year, date.month);
    if (!rule.byMonthDay.some((d) => (d > 0 ? d : length + d + 1) === date.day)) return false;
  }
  if (rule.byDay.length && !rule.byDay.some((r) => r.weekday === weekday(date))) return false;
  return true;
}

/** How many whole periods lie entirely before `elapsedMs` after DTSTART, conservatively. */
function periodsBefore(rule: Rule, start: CivilDate, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const days = Math.floor(elapsedMs / DAY_MS);
  const periodDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval;
  // One period of slack either side of month/year length and DST.
  return Math.max(0, Math.floor(days / periodDays) - 1);
}

/** A rough instant for the start of period k, used only to stop iterating past the window. */
function periodStartMs(rule: Rule, start: CivilDate, k: number): number {
  const base = Date.UTC(start.year, start.month - 1, start.day);
  const periodDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[rule.freq] * rule.interval;
  // Minus a week of slack for zones, week starts and short months.
  return base + (k * periodDays - 7) * DAY_MS;
}

function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Monday … 6 = Sunday. */
function weekday(date: CivilDate): number {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayNumber(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function sortDates(dates: CivilDate[]): CivilDate[] {
  return dates.sort((a, b) => dayNumber(a) - dayNumber(b));
}
