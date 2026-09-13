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

/** An issue ticked as read with no reading logged — read once, day unknown. */
export interface UndatedRead {
  key: string;
  series: string;
  year: number | null;
  number: number;
}

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
  /** Changed by you: a GCD lookup no longer replaces it. */
  edited?: boolean;
}

export type CreditField = "characters" | "writers" | "artists";
export const CREDIT_FIELDS: CreditField[] = ["characters", "writers", "artists"];

/**
 * How names are matched: "Venom", "venom" and "VENOM" are one; so are
 * "Spider-Man" and "Spider Man". Accents, capitals and punctuation don't
 * make a different person.
 */
export function personKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Every name known for a field, one spelling each — the first seen, which is GCD's when it had it. */
export function knownNames(credits: Record<string, IssueCredits>, field: CreditField): string[] {
  const names = new Map<string, string>();
  for (const c of Object.values(credits)) {
    for (const name of c[field]) if (!names.has(personKey(name))) names.set(personKey(name), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Names as you typed them, cleaned and put in the spelling already known —
 * typing "venom" gives the "Venom" GCD's issues use — without repeats.
 */
export function canonicalNames(typed: unknown, known: Map<string, string>): string[] {
  if (!Array.isArray(typed)) return [];
  const out = new Map<string, string>();
  for (const raw of typed.slice(0, 80)) {
    if (typeof raw !== "string") continue;
    const name = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    const key = personKey(name);
    if (!key || out.has(key)) continue;
    out.set(key, known.get(key) ?? name);
  }
  return [...out.values()];
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
  /** Issues ticked as read without a logged reading — each counted once at the estimate. */
  undated: number;
  /** Different issues read whose characters and creators aren't known yet. */
  withoutCredits: number;
  recent: IssueReading[];
}

/** Adds a reading's time to a name — matched by personKey, shown in the first spelling seen. */
function tally(map: Map<string, TimeLine>, name: string, minutes: number): void {
  const key = personKey(name) || name;
  const line = map.get(key) ?? { name, minutes: 0, readings: 0 };
  line.minutes += minutes;
  line.readings += 1;
  map.set(key, line);
}

const top = (map: Map<string, TimeLine>, limit: number): TimeLine[] =>
  [...map.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, limit);

export function readingStats(
  readings: IssueReading[],
  credits: Record<string, IssueCredits>,
  today: string,
  limit = 10,
  undated: UndatedRead[] = [],
  minutesPerIssue = DEFAULT_MINUTES_PER_ISSUE
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
  // A ticked issue with no logged reading is one reading of unknown day: it
  // counts towards time and who you've read, not this month or this year.
  const dated = new Set(readings.map((r) => r.key));
  const undatedReads = undated.filter((u) => !dated.has(u.key));
  const all = [...readings, ...undatedReads.map((u) => ({ ...u, readOn: "", minutes: minutesPerIssue }))];
  for (const r of all) {
    total += r.minutes;
    if (r.readOn && r.readOn.startsWith(month)) thisMonth += r.minutes;
    if (r.readOn && r.readOn.startsWith(year)) thisYear += r.minutes;
    perIssue.set(r.key, (perIssue.get(r.key) ?? 0) + 1);
    tally(series, r.year ? `${r.series} (${r.year})` : r.series, r.minutes);
    const c = credits[r.key];
    if (!c) continue;
    // One person twice on an issue (pencils and inks, "Venom" and "venom") counts once.
    const once = (names: string[]) => [...new Map(names.map((n) => [personKey(n) || n, n])).values()];
    for (const name of once(c.characters)) tally(characters, name, r.minutes);
    for (const name of once(c.writers)) tally(writers, name, r.minutes);
    for (const name of once(c.artists)) tally(artists, name, r.minutes);
  }
  return {
    totalMinutes: total,
    readings: readings.length,
    issues: perIssue.size,
    reread: [...perIssue.values()].filter((n) => n > 1).length,
    undated: undatedReads.length,
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
