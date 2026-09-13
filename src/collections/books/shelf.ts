import { bookLabel, BookRef, resolveYears } from "./coverage";
import { seriesKey } from "./runs";
import { Book, BookKind } from "./types";

/**
 * The shelf as the Books tab shows it: books grouped by what you'd call
 * the series ("Thor"), each book's issues with how many copies of each you
 * own, and the numbers for Stats. Pure — the same books always give the
 * same shelf.
 */

/** Words a collected edition's title carries that aren't the series' name. */
const EDITION_WORDS =
  /\b(?:epic collection|omnibus|masterworks|compendium|deluxe edition|complete collection|ultimate collection|by .+$|vol(?:ume)?\.? ?\d+.*$)/gi;

/** "Thor Epic Collection" → "Thor"; "Thor by Jason Aaron Omnibus" → "Thor". A book's own shelf name wins. */
export function shelfName(book: Pick<Book, "title" | "shelf">): string {
  if (book.shelf) return book.shelf;
  // "Marvel Masterworks: The Mighty Thor" — the edition comes first and the
  // series after the colon.
  const leading = book.title.match(/^(.*?)\b(?:masterworks|epic collection|omnibus|compendium)\s*:\s*(.+)$/i);
  if (leading && !leading[1].replace(/\b(?:the|mighty|marvel|dc|image)\b/gi, "").trim()) {
    return shelfName({ title: leading[2].replace(/^the\s+mighty\s+/i, ""), shelf: null });
  }
  // "Thor Epic Collection: Ragnarok" — the series first; the subtitle is the book's.
  if (leading) return shelfName({ title: leading[1], shelf: null });
  const derived = book.title
    .replace(EDITION_WORDS, " ")
    .replace(/[:\-–—,]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return derived || book.title;
}

export interface ShelfGroup {
  name: string;
  kind: BookKind;
  publisher: string | null;
  author: string | null;
  books: Book[];
  owned: number;
  wishlist: number;
  /** The first cover among its books, owned ones first. */
  coverUrl: string | null;
  /** Average reading progress of the books you've given progress to, or null. */
  progress: number | null;
}

const naturalVolume = (a: Book, b: Book) =>
  a.title.localeCompare(b.title) ||
  (a.volume ?? "").localeCompare(b.volume ?? "", undefined, { numeric: true });

export function groupShelf(books: Book[]): ShelfGroup[] {
  const groups = new Map<string, Book[]>();
  for (const book of books) {
    const key = shelfName(book).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(book);
  }
  const result: ShelfGroup[] = [];
  for (const members of groups.values()) {
    members.sort(naturalVolume);
    const owned = members.filter((b) => b.status === "owned");
    const withProgress = members.filter((b) => b.progress !== null);
    const kinds = new Map<BookKind, number>();
    for (const b of members) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
    result.push({
      name: shelfName(members[0]),
      kind: [...kinds.entries()].sort((a, b) => b[1] - a[1])[0][0],
      publisher: members.find((b) => b.publisher)?.publisher ?? null,
      author: members.find((b) => b.author)?.author ?? null,
      books: members,
      owned: owned.length,
      wishlist: members.length - owned.length,
      coverUrl: (owned.find((b) => b.coverUrl) ?? members.find((b) => b.coverUrl))?.coverUrl ?? null,
      progress: withProgress.length
        ? Math.round(withProgress.reduce((sum, b) => sum + (b.progress ?? 0), 0) / withProgress.length)
        : null,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export interface BookIssue {
  series: string;
  year: number | null;
  number: number;
  /** The book only has "material from" this issue. */
  partial: boolean;
  /** Owned books holding it — this one included when it's owned. */
  copies: number;
  /** The other books holding it, owned or wishlist. */
  elsewhere: Array<BookRef & { status: Book["status"] }>;
}

/** Past this many issues a book's list is cut short — no real collected edition is near it. */
export const MAX_LISTED_ISSUES = 1500;

/** Every issue a book collects, in the order its runs list them, with how many copies you own. */
export function bookIssues(book: Book, allBooks: Book[]): { issues: BookIssue[]; truncated: boolean } {
  const years = resolveYears(allBooks);
  const place = (series: string, year: number | null) => {
    const resolved = year ?? years.get(seriesKey(series, null)) ?? null;
    return { key: seriesKey(series, resolved), year: resolved };
  };
  // Who holds each issue, across the whole shelf.
  const holders = new Map<string, Map<string, { book: Book; partial: boolean }>>();
  for (const other of allBooks) {
    for (const run of other.runs) {
      if (run.to - run.from > MAX_LISTED_ISSUES) continue;
      const { key } = place(run.series, run.year);
      for (let n = run.from; n <= run.to; n++) {
        const id = `${key}#${n}`;
        if (!holders.has(id)) holders.set(id, new Map());
        holders.get(id)!.set(other.id, { book: other, partial: run.partial });
      }
    }
  }
  const issues: BookIssue[] = [];
  const seen = new Set<string>();
  for (const run of book.runs) {
    const { key, year } = place(run.series, run.year);
    for (let n = run.from; n <= run.to; n++) {
      if (issues.length >= MAX_LISTED_ISSUES) return { issues, truncated: true };
      const id = `${key}#${n}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const holding = [...(holders.get(id)?.values() ?? [])];
      issues.push({
        series: run.series,
        year,
        number: n,
        partial: run.partial,
        copies: holding.filter((h) => h.book.status === "owned").length,
        elsewhere: holding
          .filter((h) => h.book.id !== book.id)
          .map((h) => ({ id: h.book.id, label: bookLabel(h.book), status: h.book.status })),
      });
    }
  }
  return { issues, truncated: false };
}

/** For a book's card: how many of its issues you already have from other owned books. */
export function bookOverlap(book: Book, allBooks: Book[]): { issues: number; ownedElsewhere: number } {
  const { issues } = bookIssues(book, allBooks);
  return {
    issues: issues.length,
    ownedElsewhere: issues.filter((issue) => issue.elsewhere.some((b) => b.status === "owned")).length,
  };
}

export interface ShelfStats {
  owned: number;
  reading: number;
  finished: number;
  wishlist: number;
  byKind: Record<BookKind, number>;
}

export function shelfStats(books: Book[]): ShelfStats {
  const owned = books.filter((b) => b.status === "owned");
  return {
    owned: owned.length,
    reading: books.filter((b) => b.progress !== null && b.progress > 0 && b.progress < 100).length,
    finished: books.filter((b) => b.progress === 100).length,
    wishlist: books.length - owned.length,
    byKind: {
      comic: owned.filter((b) => b.kind === "comic").length,
      manga: owned.filter((b) => b.kind === "manga").length,
      novel: owned.filter((b) => b.kind === "novel").length,
    },
  };
}
