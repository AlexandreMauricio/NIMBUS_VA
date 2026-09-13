import type { GcdIssueDetail } from "./gcd";

/**
 * The reading log — each time you read a single issue, on a day, for about
 * how long — and what it adds up to: time reading, re-reads, and time with
 * each series, character, writer and artist.
 *
 * Reading the same issues in an Epic Collection twice, a year apart, is two
 * readings of each. Nobody times themselves reading, so each reading takes
 * an estimate — the minutes per issue you set (12 by default: a 20–24 page
 * issue at a relaxed pace) — which you can change per reading.
 *
 * Characters and creators come from the issue's Grand Comics Database
 * page, kept once looked up. Pure; the service persists it.
 */

export const DEFAULT_MINUTES_PER_ISSUE = 12;
export const MAX_READINGS = 50_000;

export interface IssueReading {
  id: string;
  /** bookService.issueReadKey — the same issue in any book. */
  key: string;
  series: string;
  year: number | null;
  number: number;
  /** The day read, "YYYY-MM-DD". */
  readOn: string;
  minutes: number;
  /** The book it was read in, when logged from one. */
  bookId: string | null;
  loggedAt: string;
}

/** What an issue's GCD page says about who's in it and who made it. */
export interface IssueCredits {
  title: string | null;
  characters: string[];
  writers: string[];
  artists: string[];
  pageCount: number | null;
}

const ARTIST_ROLES = /^(penciler|inker|artist)$/i;

/**
 * GCD writes characters as "Thor [Donald Blake]; Loki; Villains: Surtur
 * (first appearance)": aliases in brackets, notes in parentheses, and
 * sometimes a group label before a colon.
 */
export function characterNames(value: string | null): string[] {
  if (!value) return [];
  const names = value
    .split(/[;\n]/)
    .map((part) =>
      part
        .replace(/^[^:[\]()]{1,30}:\s*/, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\((?:[^()]|\([^()]*\))*\)/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((name) => name.length > 1 && name.length <= 80 && !/^(none|\?|various|unknown)$/i.test(name));
  return [...new Set(names)];
}

export function creditsFromGcd(detail: GcdIssueDetail): IssueCredits {
  const stories = detail.stories.filter((s) => !/cover|advertisement|letters|text/i.test(s.type));
  const withRole = (test: (role: string) => boolean) =>
    detail.credits.filter((c) => c.roles.some((role) => test(role))).map((c) => c.name);
  return {
    title: detail.title ?? stories.find((s) => s.title)?.title ?? null,
    characters: [...new Set(stories.flatMap((s) => characterNames(s.characters)))].slice(0, 60),
    writers: withRole((role) => role === "Writer").slice(0, 10),
    artists: withRole((role) => ARTIST_ROLES.test(role)).slice(0, 10),
    pageCount: detail.pageCount,
  };
}

export interface TimeLine {
  name: string;
  minutes: number;
  readings: number;
}

export interface ReadingStats {
  totalMinutes: number;
  readings: number;
  /** Different issues read at least once. */
  issues: number;
  /** Issues read more than once. */
  reread: number;
  thisMonthMinutes: number;
  thisYearMinutes: number;
  bySeries: TimeLine[];
  byCharacter: TimeLine[];
  byWriter: TimeLine[];
  byArtist: TimeLine[];
  /** Different issues read whose characters and creators aren't known yet. */
  withoutCredits: number;
  recent: IssueReading[];
}

function tally(map: Map<string, TimeLine>, name: string, minutes: number): void {
  const line = map.get(name) ?? { name, minutes: 0, readings: 0 };
  line.minutes += minutes;
  line.readings += 1;
  map.set(name, line);
}

const top = (map: Map<string, TimeLine>, limit: number): TimeLine[] =>
  [...map.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, limit);

export function readingStats(
  readings: IssueReading[],
  credits: Record<string, IssueCredits>,
  today: string,
  limit = 10
): ReadingStats {
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  const series = new Map<string, TimeLine>();
  const characters = new Map<string, TimeLine>();
  const writers = new Map<string, TimeLine>();
  const artists = new Map<string, TimeLine>();
  const perIssue = new Map<string, number>();
  let total = 0;
  let thisMonth = 0;
  let thisYear = 0;
  for (const r of readings) {
    total += r.minutes;
    if (r.readOn.startsWith(month)) thisMonth += r.minutes;
    if (r.readOn.startsWith(year)) thisYear += r.minutes;
    perIssue.set(r.key, (perIssue.get(r.key) ?? 0) + 1);
    tally(series, r.year ? `${r.series} (${r.year})` : r.series, r.minutes);
    const c = credits[r.key];
    if (!c) continue;
    for (const name of c.characters) tally(characters, name, r.minutes);
    for (const name of c.writers) tally(writers, name, r.minutes);
    // Someone who pencilled and inked the issue is one artist, once.
    for (const name of new Set(c.artists)) tally(artists, name, r.minutes);
  }
  return {
    totalMinutes: total,
    readings: readings.length,
    issues: perIssue.size,
    reread: [...perIssue.values()].filter((n) => n > 1).length,
    thisMonthMinutes: thisMonth,
    thisYearMinutes: thisYear,
    bySeries: top(series, limit),
    byCharacter: top(characters, limit),
    byWriter: top(writers, limit),
    byArtist: top(artists, limit),
    withoutCredits: [...perIssue.keys()].filter((key) => !credits[key]).length,
    recent: [...readings]
      .sort((a, b) => b.readOn.localeCompare(a.readOn) || b.loggedAt.localeCompare(a.loggedAt))
      .slice(0, limit),
  };
}

/** "3 h 20 min", "45 min". */
export function formatReadingTime(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
