import { ContextProvider } from "../types";
import { resolveLocale } from "../../common/locale";

export interface DateTimeContext {
  /** ISO calendar date, e.g. "2026-09-08". */
  date: string;
  /** Local time of day, e.g. "14:23:05". */
  time: string;
  /** Full local timestamp in ISO 8601 with offset, e.g. "2026-09-08T14:23:05-03:00". */
  isoTimestamp: string;
  /** IANA timezone name, e.g. "America/Sao_Paulo". */
  timezone: string;
  /** Offset from UTC in minutes (positive = ahead of UTC). */
  utcOffsetMinutes: number;
  /** Full weekday name, e.g. "Tuesday". */
  dayOfWeek: string;
  /** 0 (Sunday) through 6 (Saturday), matching Date#getDay(). */
  dayOfWeekIndex: number;
}

/**
 * Provides the current date, time, timezone, and day of week.
 *
 * `now` is injectable so tests can control the clock instead of racing
 * real time; defaults to the actual system clock in production.
 * `localeOverride` is injectable for the same reason (deterministic
 * tests) — production omits it, so `dayOfWeek` is formatted using
 * whatever locale a host has configured via `common/locale.ts`
 * (`configureLocale`), resolved lazily at format time rather than
 * captured here at construction (this provider is typically constructed
 * before a host like Electron's `app` is ready to report a locale).
 */
export class DateTimeProvider implements ContextProvider<DateTimeContext> {
  readonly id = "dateTime";
  readonly displayName = "Date & Time";

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly localeOverride?: string
  ) {}

  isAvailable(): boolean {
    return true;
  }

  getContext(): DateTimeContext {
    const current = this.now();
    const locale = this.localeOverride ?? resolveLocale();

    const isoOffset = formatUtcOffset(-current.getTimezoneOffset());

    return {
      date: toIsoDate(current),
      time: toLocalTime(current),
      isoTimestamp: `${toIsoDate(current)}T${toLocalTime(current)}${isoOffset}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -current.getTimezoneOffset(),
      dayOfWeek: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(current),
      dayOfWeekIndex: current.getDay(),
    };
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
