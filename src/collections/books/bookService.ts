import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { computeCoverage, SeriesCoverage } from "./coverage";
import { isChosenCover, isCoverUrl } from "./covers";
import { DEFAULT_MINUTES_PER_ISSUE, IssueCredits, IssueReading, MAX_READINGS } from "./readings";
import { parseRuns, seriesKey } from "./runs";
import {
  BOOK_FORMATS,
  Book,
  BookFormat,
  BookKind,
  BookState,
  BookStatus,
  BookStore,
  IssueRun,
  MAX_BOOKS,
  MAX_ISSUE_NUMBER,
  MAX_RUNS_PER_BOOK,
} from "./types";

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

function isRun(value: unknown): value is IssueRun {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.series === "string" &&
    r.series.trim().length > 0 &&
    r.series.length <= 200 &&
    (r.year === null ||
      (Number.isInteger(r.year) && (r.year as number) >= 1800 && (r.year as number) <= 2200)) &&
    Number.isInteger(r.from) &&
    Number.isInteger(r.to) &&
    (r.from as number) >= 0 &&
    (r.to as number) >= (r.from as number) &&
    (r.to as number) <= MAX_ISSUE_NUMBER &&
    typeof r.partial === "boolean"
  );
}

/** One saved book, checked field by field; malformed ones are dropped. */
export function parseBook(raw: unknown): Book | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (r.kind !== "comic" && r.kind !== "manga" && r.kind !== "novel") return null;
  const title = text(r.title, 200);
  if (!title) return null;
  if (!BOOK_FORMATS.includes(r.format as BookFormat)) return null;
  if (r.status !== "owned" && r.status !== "wishlist") return null;
  const runs = Array.isArray(r.runs) ? r.runs.filter(isRun).slice(0, MAX_RUNS_PER_BOOK) : [];
  return {
    id: r.id,
    kind: r.kind,
    title,
    volume: text(r.volume, 100),
    format: r.format as BookFormat,
    publisher: text(r.publisher, 100),
    isbn: text(r.isbn, 20),
    status: r.status,
    runs: runs.map((run) => ({ ...run, series: run.series.trim() })),
    notes: text(r.notes, 1000),
    source: text(r.source, 50),
    author: text(r.author, 100),
    shelf: text(r.shelf, 100),
    progress: readProgress(r.progress),
    coverUrl: isCoverUrl(r.coverUrl) ? r.coverUrl : null,
    addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

function readProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : null;
}

export { coverUrlForIsbn, isCoverUrl } from "./covers";

export interface BookFilter {
  kind?: BookKind;
  status?: BookStatus;
  text?: string;
}

/**
 * The shelf: collected editions and manga volumes, and what they add up to.
 * Core only — the injected store persists it, nothing here reaches a
 * network. Contents are entered as text ("Thor (1966) #126-130; Annual #2")
 * and kept as parsed runs; whatever couldn't be read is handed back so the
 * form can say so.
 */
/** How an issue is remembered as read: its series (with year when known) and number. */
export function issueReadKey(series: string, year: number | null, number: number): string {
  return `${seriesKey(series, year)}#${number}`;
}

const MAX_READ_ISSUES = 100_000;

/** {series, year, number} from outside, checked — the shape a book's issue list gives. */
function readIssue(raw: unknown): { series: string; year: number | null; number: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series !== "string" || !r.series.trim() || r.series.length > 200) return null;
  if (!Number.isInteger(r.number) || (r.number as number) < 0 || (r.number as number) > 100_000) return null;
  const year =
    Number.isInteger(r.year) && (r.year as number) >= 1800 && (r.year as number) <= 2200
      ? (r.year as number)
      : null;
  return { series: r.series.trim(), year, number: r.number as number };
}

function parseReading(raw: unknown): IssueReading | null {
  const issue = readIssue(raw);
  if (!issue) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.length > 80) return null;
  if (typeof r.readOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.readOn)) return null;
  if (typeof r.minutes !== "number" || !Number.isFinite(r.minutes) || r.minutes < 1 || r.minutes > 600)
    return null;
  return {
    id: r.id,
    key: issueReadKey(issue.series, issue.year, issue.number),
    ...issue,
    readOn: r.readOn,
    minutes: Math.round(r.minutes),
    bookId: typeof r.bookId === "string" && r.bookId.length <= 80 ? r.bookId : null,
    loggedAt: typeof r.loggedAt === "string" ? r.loggedAt : new Date(0).toISOString(),
  };
}

function parseCredits(raw: unknown): IssueCredits | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const names = (value: unknown, max: number) =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 80)
          .slice(0, max)
      : [];
  return {
    title: typeof r.title === "string" ? r.title.slice(0, 200) : null,
    characters: names(r.characters, 60),
    writers: names(r.writers, 10),
    artists: names(r.artists, 10),
    pageCount: Number.isInteger(r.pageCount) && (r.pageCount as number) > 0 ? (r.pageCount as number) : null,
  };
}

export class BookService {
  private books: Book[] = [];
  /**
   * Issues you've read, by issueReadKey. Kept for the shelf rather than a
   * book: reading Journey Into Mystery #83 in the Epic Collection means
   * you've read it in the Omnibus too.
   */
  private readIssues = new Set<string>();
  private readings: IssueReading[] = [];
  private issueCredits: Record<string, IssueCredits> = {};
  private minutesPerIssue = DEFAULT_MINUTES_PER_ISSUE;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store?: BookStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {
    let raw: unknown = null;
    try {
      raw = store?.load() ?? null;
    } catch (err) {
      logger.warn("Could not read books — starting empty", { error: String(err) });
    }
    const list = raw && typeof raw === "object" ? (raw as { books?: unknown }).books : null;
    if (Array.isArray(list)) {
      const seen = new Set<string>();
      let skipped = 0;
      for (const entry of list.slice(0, MAX_BOOKS)) {
        const book = parseBook(entry);
        if (book && !seen.has(book.id)) {
          seen.add(book.id);
          this.books.push(book);
        } else {
          skipped++;
        }
      }
      if (skipped > 0) logger.warn(`Skipped ${skipped} malformed book${skipped === 1 ? "" : "s"}`);
    }
    const read = raw && typeof raw === "object" ? (raw as { readIssues?: unknown }).readIssues : null;
    if (Array.isArray(read)) {
      for (const key of read.slice(0, MAX_READ_ISSUES)) {
        if (typeof key === "string" && key.length <= 250 && /#\d+$/.test(key)) this.readIssues.add(key);
      }
    }
    const state = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (Array.isArray(state.readings)) {
      for (const entry of state.readings.slice(0, MAX_READINGS)) {
        const reading = parseReading(entry);
        if (reading) this.readings.push(reading);
      }
    }
    if (state.issueCredits && typeof state.issueCredits === "object") {
      const entries = Object.entries(state.issueCredits as Record<string, unknown>).slice(0, MAX_READ_ISSUES);
      for (const [key, value] of entries) {
        const credits = parseCredits(value);
        if (credits && key.length <= 250) this.issueCredits[key] = credits;
      }
    }
    const minutes = state.minutesPerIssue;
    if (Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= 240) {
      this.minutesPerIssue = minutes as number;
    }
  }

  // ------------------------------------------------------------ reading log

  /** The reading log, newest first, the credits known, and the minutes a new reading takes. */
  readingLog(): { readings: IssueReading[]; credits: Record<string, IssueCredits>; minutesPerIssue: number } {
    return {
      readings: [...this.readings]
        .sort((a, b) => b.readOn.localeCompare(a.readOn) || b.loggedAt.localeCompare(a.loggedAt))
        .map((r) => ({ ...r })),
      credits: JSON.parse(JSON.stringify(this.issueCredits)) as Record<string, IssueCredits>,
      minutesPerIssue: this.minutesPerIssue,
    };
  }

  /**
   * Logs a reading of each issue on a day, and marks them read. `minutes`
   * is per issue; without it the minutes-per-issue estimate is used.
   */
  logReadings(issues: unknown, readOn: unknown, minutes?: unknown, bookId?: unknown): number {
    if (!Array.isArray(issues)) throw new Error("Nothing to log.");
    if (
      typeof readOn !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(readOn) ||
      Number.isNaN(Date.parse(readOn))
    ) {
      throw new Error("Choose the day you read it.");
    }
    const now = this.now();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (readOn > today) throw new Error("That day hasn't happened yet.");
    let each = this.minutesPerIssue;
    if (minutes !== undefined && minutes !== null) {
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
        throw new Error("Minutes must be 1 to 600.");
      }
      each = Math.round(minutes);
    }
    const book = typeof bookId === "string" && this.books.some((b) => b.id === bookId) ? bookId : null;
    const logged: Array<{ series: string; year: number | null; number: number }> = [];
    const loggedAt = this.now().toISOString();
    for (const raw of issues.slice(0, 2000)) {
      const issue = readIssue(raw);
      if (!issue || this.readings.length >= MAX_READINGS) continue;
      this.readings.push({
        id: this.newId(),
        key: issueReadKey(issue.series, issue.year, issue.number),
        ...issue,
        readOn,
        minutes: each,
        bookId: book,
        loggedAt,
      });
      logged.push(issue);
    }
    if (!logged.length) return 0;
    // Marking read saves when it changes something; the log needs saving either way.
    if (!this.setIssuesRead(logged, true)) this.save();
    return logged.length;
  }

  removeReading(id: unknown): boolean {
    const index = this.readings.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.readings.splice(index, 1);
    this.save();
    return true;
  }

  setMinutesPerIssue(minutes: unknown): number {
    if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 240) {
      throw new Error("Minutes per issue must be 1 to 240.");
    }
    this.minutesPerIssue = minutes as number;
    this.save();
    return this.minutesPerIssue;
  }

  /** What GCD says about an issue, kept for reading stats. Saves only when new or changed. */
  setIssueCredits(series: string, year: number | null, number: number, credits: IssueCredits): void {
    const key = issueReadKey(series, year, number);
    if (JSON.stringify(this.issueCredits[key]) === JSON.stringify(credits)) return;
    this.issueCredits[key] = credits;
    this.save();
  }

  /** Issues in the reading log whose characters and creators aren't known yet. */
  issuesWithoutCredits(limit = 50): Array<{ series: string; year: number | null; number: number }> {
    const out = new Map<string, { series: string; year: number | null; number: number }>();
    for (const r of this.readings) {
      if (out.size >= limit) break;
      if (!this.issueCredits[r.key] && !out.has(r.key)) {
        out.set(r.key, { series: r.series, year: r.year, number: r.number });
      }
    }
    return [...out.values()];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a book. `runs` is the contents as text; what couldn't be read comes back in `unread`. */
  add(input: unknown): { book: Book; unread: string[] } {
    if (this.books.length >= MAX_BOOKS) throw new Error(`The shelf is full (${MAX_BOOKS} books).`);
    const nowIso = this.now().toISOString();
    const { fields, unread } = this.readInput(input, null);
    const book: Book = { id: this.newId(), ...fields, addedAt: nowIso, updatedAt: nowIso };
    this.books.push(book);
    this.save();
    return { book: { ...book }, unread };
  }

  update(id: string, input: unknown): { book: Book; unread: string[] } {
    const index = this.books.findIndex((book) => book.id === id);
    if (index === -1) throw new Error("That book is no longer on the shelf.");
    const current = this.books[index];
    const { fields, unread } = this.readInput(input, current);
    const book: Book = { ...current, ...fields, updatedAt: this.now().toISOString() };
    this.books[index] = book;
    this.save();
    return { book: { ...book }, unread };
  }

  remove(id: string): boolean {
    const index = this.books.findIndex((book) => book.id === id);
    if (index === -1) return false;
    this.books.splice(index, 1);
    this.save();
    return true;
  }

  /** Alphabetical by title, then volume in natural order ("2" before "10"). */
  list(filter: BookFilter = {}): Book[] {
    const needle = filter.text?.trim().toLowerCase() ?? "";
    return this.books
      .filter((book) => !filter.kind || book.kind === filter.kind)
      .filter((book) => !filter.status || book.status === filter.status)
      .filter(
        (book) =>
          !needle ||
          [
            book.title,
            book.volume ?? "",
            book.publisher ?? "",
            book.author ?? "",
            book.shelf ?? "",
            ...book.runs.map((run) => run.series),
          ].some((field) => field.toLowerCase().includes(needle))
      )
      .sort(
        (a, b) =>
          a.title.localeCompare(b.title) ||
          (a.volume ?? "").localeCompare(b.volume ?? "", undefined, { numeric: true })
      )
      .map((book) => ({ ...book, runs: book.runs.map((run) => ({ ...run })) }));
  }

  get(id: string): Book {
    const book = this.books.find((b) => b.id === id);
    if (!book) throw new Error("That book is no longer on the shelf.");
    return { ...book, runs: book.runs.map((run) => ({ ...run })) };
  }

  /** Issues marked read, as issueReadKey strings. */
  readIssueKeys(): string[] {
    return [...this.readIssues];
  }

  /**
   * Marks issues read or unread. Each is {series, year, number} — the same
   * shape a book's issue list gives — and at most 5000 at once.
   */
  setIssuesRead(issues: unknown, read: unknown): number {
    if (!Array.isArray(issues) || typeof read !== "boolean") throw new Error("Nothing to mark.");
    let changed = 0;
    for (const raw of issues.slice(0, 5000)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.series !== "string" || !r.series.trim() || r.series.length > 200) continue;
      const year =
        Number.isInteger(r.year) && (r.year as number) >= 1800 && (r.year as number) <= 2200
          ? (r.year as number)
          : null;
      if (!Number.isInteger(r.number) || (r.number as number) < 0 || (r.number as number) > 100_000) continue;
      const keys = [issueReadKey(r.series, year, r.number as number)];
      // A year learnt later shouldn't make an issue read without one look unread.
      if (year !== null) keys.push(issueReadKey(r.series, null, r.number as number));
      for (const key of keys) {
        if (read && key === keys[0] && !this.readIssues.has(key)) {
          if (this.readIssues.size >= MAX_READ_ISSUES) break;
          this.readIssues.add(key);
          changed++;
        } else if (!read && this.readIssues.delete(key)) {
          changed++;
        }
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** The cover the main process found or you chose. Only an Open Library or chosen-cover address is kept. */
  setCover(id: string, coverUrl: string | null): void {
    const book = this.books.find((b) => b.id === id);
    if (!book || (coverUrl !== null && !isCoverUrl(coverUrl)) || book.coverUrl === coverUrl) return;
    book.coverUrl = coverUrl;
    this.save();
  }

  coverage(): SeriesCoverage[] {
    return computeCoverage(this.books);
  }

  /** Validates a form's fields; on update, absent fields keep their current value. */
  private readInput(
    input: unknown,
    current: Book | null
  ): { fields: Omit<Book, "id" | "addedAt" | "updatedAt">; unread: string[] } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Nothing to save.");
    const i = input as Record<string, unknown>;
    const has = (key: string) => key in i;

    const kind = has("kind") ? i.kind : (current?.kind ?? "comic");
    if (kind !== "comic" && kind !== "manga" && kind !== "novel")
      throw new Error("A book is a comic, a manga or a novel.");

    const title = has("title") ? text(i.title, 200) : (current?.title ?? null);
    if (!title) throw new Error("A book needs a title.");

    const format = has("format")
      ? i.format
      : (current?.format ?? (kind === "manga" ? "Manga volume" : kind === "novel" ? "Novel" : "Other"));
    if (!BOOK_FORMATS.includes(format as BookFormat)) throw new Error("Choose a format.");

    const status = has("status") ? i.status : (current?.status ?? "owned");
    if (status !== "owned" && status !== "wishlist") throw new Error("Status must be owned or wishlist.");

    let runs = current?.runs ?? [];
    let unread: string[] = [];
    if (has("runs")) {
      if (typeof i.runs !== "string") throw new Error("Contents must be text.");
      const parsed = parseRuns(i.runs);
      runs = parsed.runs;
      unread = parsed.unread;
    }

    const isbn = has("isbn") ? text(i.isbn, 20) : (current?.isbn ?? null);
    if (isbn && !/^[0-9Xx-]{10,17}$/.test(isbn)) throw new Error("That ISBN doesn't look right.");
    if (has("progress") && i.progress !== null && i.progress !== "" && !Number.isFinite(Number(i.progress)))
      throw new Error("Reading progress is a percentage.");

    return {
      fields: {
        kind,
        title,
        volume: has("volume") ? text(i.volume, 100) : (current?.volume ?? null),
        format: format as BookFormat,
        publisher: has("publisher") ? text(i.publisher, 100) : (current?.publisher ?? null),
        isbn,
        status,
        runs,
        notes: has("notes") ? text(i.notes, 1000) : (current?.notes ?? null),
        source: has("source") ? text(i.source, 50) : (current?.source ?? null),
        author: has("author") ? text(i.author, 100) : (current?.author ?? null),
        shelf: has("shelf") ? text(i.shelf, 100) : (current?.shelf ?? null),
        progress: has("progress")
          ? i.progress === null || i.progress === ""
            ? null
            : readProgress(Number(i.progress))
          : (current?.progress ?? null),
        // A different ISBN means a different cover — looked for again later —
        // unless it's a picture you chose.
        coverUrl:
          has("isbn") && isbn !== current?.isbn && !isChosenCover(current?.coverUrl)
            ? null
            : (current?.coverUrl ?? null),
      },
      unread,
    };
  }

  private save(): void {
    const state: BookState = {
      version: 1,
      books: this.books,
      readIssues: [...this.readIssues],
      readings: this.readings,
      issueCredits: this.issueCredits,
      minutesPerIssue: this.minutesPerIssue,
    };
    try {
      this.store?.save(state);
    } catch (err) {
      logger.warn("Could not save books", { error: String(err) });
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A books listener threw", { error: String(err) });
      }
    }
  }
}
