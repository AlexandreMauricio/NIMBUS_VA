import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { computeCoverage, SeriesCoverage } from "./coverage";
import { parseRuns } from "./runs";
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
  if (r.kind !== "comic" && r.kind !== "manga") return null;
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
    addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

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
export class BookService {
  private books: Book[] = [];
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
          [book.title, book.volume ?? "", book.publisher ?? "", ...book.runs.map((run) => run.series)].some(
            (field) => field.toLowerCase().includes(needle)
          )
      )
      .sort(
        (a, b) =>
          a.title.localeCompare(b.title) ||
          (a.volume ?? "").localeCompare(b.volume ?? "", undefined, { numeric: true })
      )
      .map((book) => ({ ...book, runs: book.runs.map((run) => ({ ...run })) }));
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
    if (kind !== "comic" && kind !== "manga") throw new Error("A book is a comic or a manga.");

    const title = has("title") ? text(i.title, 200) : (current?.title ?? null);
    if (!title) throw new Error("A book needs a title.");

    const format = has("format")
      ? i.format
      : (current?.format ?? (kind === "manga" ? "Manga volume" : "Other"));
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
      },
      unread,
    };
  }

  private save(): void {
    const state: BookState = { version: 1, books: this.books };
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
