import { Book, IssueRun } from "./types";
import { seriesKey } from "./runs";

/**
 * Coverage: across every book you own, which issues of each series you
 * have — once, more than once, or not at all.
 *
 * Worked out per issue number, then folded back into ranges so it reads
 * like the books do: "#83–109 in Epic Collection 1 and Omnibus 1", "#110–120
 * in Omnibus 1", "missing #121–125". Pure, so the same collection always
 * gives the same answer.
 */

export interface BookRef {
  id: string;
  label: string;
}

export interface CoverageSegment {
  from: number;
  to: number;
  /** Every owned book that holds these issues. Two or more is a duplicate. */
  books: BookRef[];
  /** Some book here only has "material from" these issues. */
  partial: boolean;
}

export interface CoverageGap {
  from: number;
  to: number;
  /** Books on your wishlist that would fill some of it. */
  wishlist: BookRef[];
}

export interface SeriesCoverage {
  key: string;
  series: string;
  year: number | null;
  /** Owned issues, in order, split wherever the set of books holding them changes. */
  segments: CoverageSegment[];
  /** Missing issues between the first and last one you own. */
  gaps: CoverageGap[];
  ownedIssues: number;
  duplicatedIssues: number;
}

/** A series can span thousands of numbers; beyond this a single run is treated as unreadable. */
const MAX_RUN_LENGTH = 5000;

export function bookLabel(book: Pick<Book, "title" | "volume">): string {
  return book.volume ? `${book.title} ${book.volume}` : book.title;
}

/**
 * Runs written without a year borrow one when the collection knows exactly
 * one year for that name — "Thor #131" beside "Thor (1966) #126" is the
 * 1966 series. With none or several, the run stays yearless.
 */
function resolveYears(books: Book[]): Map<string, number | null> {
  const years = new Map<string, Set<number>>();
  for (const book of books) {
    for (const run of book.runs) {
      if (run.year === null) continue;
      const name = seriesKey(run.series, null);
      if (!years.has(name)) years.set(name, new Set());
      years.get(name)!.add(run.year);
    }
  }
  const resolved = new Map<string, number | null>();
  for (const [name, set] of years) resolved.set(name, set.size === 1 ? [...set][0] : null);
  return resolved;
}

interface IssueHolding {
  books: Map<string, BookRef>;
  partial: boolean;
}

export function computeCoverage(books: Book[]): SeriesCoverage[] {
  const years = resolveYears(books);
  const owned = new Map<string, { series: string; year: number | null; issues: Map<number, IssueHolding> }>();
  const wanted = new Map<string, Map<number, Map<string, BookRef>>>();

  const place = (run: IssueRun): { key: string; year: number | null } => {
    const year = run.year ?? years.get(seriesKey(run.series, null)) ?? null;
    return { key: seriesKey(run.series, year), year };
  };

  for (const book of books) {
    const ref: BookRef = { id: book.id, label: bookLabel(book) };
    for (const run of book.runs) {
      if (run.to < run.from || run.to - run.from > MAX_RUN_LENGTH) continue;
      const { key, year } = place(run);
      if (book.status === "owned") {
        if (!owned.has(key)) owned.set(key, { series: run.series, year, issues: new Map() });
        const issues = owned.get(key)!.issues;
        for (let n = run.from; n <= run.to; n++) {
          const holding = issues.get(n) ?? { books: new Map(), partial: false };
          holding.books.set(ref.id, ref);
          holding.partial = holding.partial || run.partial;
          issues.set(n, holding);
        }
      } else {
        if (!wanted.has(key)) wanted.set(key, new Map());
        const issues = wanted.get(key)!;
        for (let n = run.from; n <= run.to; n++) {
          if (!issues.has(n)) issues.set(n, new Map());
          issues.get(n)!.set(ref.id, ref);
        }
      }
    }
  }

  const result: SeriesCoverage[] = [];
  for (const [key, entry] of owned) {
    const numbers = [...entry.issues.keys()].sort((a, b) => a - b);
    const segments: CoverageSegment[] = [];
    let duplicatedIssues = 0;

    for (const n of numbers) {
      const holding = entry.issues.get(n)!;
      if (holding.books.size > 1) duplicatedIssues++;
      const ids = [...holding.books.keys()].sort().join("|");
      const last = segments[segments.length - 1];
      const lastIds = last
        ? last.books
            .map((b) => b.id)
            .sort()
            .join("|")
        : null;
      if (last && last.to === n - 1 && lastIds === ids && last.partial === holding.partial) {
        last.to = n;
      } else {
        segments.push({
          from: n,
          to: n,
          books: [...holding.books.values()].sort((a, b) => a.label.localeCompare(b.label)),
          partial: holding.partial,
        });
      }
    }

    const gaps: CoverageGap[] = [];
    for (let i = 1; i < segments.length; i++) {
      const from = segments[i - 1].to + 1;
      const to = segments[i].from - 1;
      if (to < from) continue;
      const wishlist = new Map<string, BookRef>();
      const wantedIssues = wanted.get(key);
      for (let n = from; n <= to && wantedIssues; n++) {
        for (const [id, ref] of wantedIssues.get(n) ?? []) wishlist.set(id, ref);
      }
      gaps.push({ from, to, wishlist: [...wishlist.values()] });
    }

    result.push({
      key,
      series: entry.series,
      year: entry.year,
      segments,
      gaps,
      ownedIssues: numbers.length,
      duplicatedIssues,
    });
  }

  return result.sort((a, b) => a.series.localeCompare(b.series) || (a.year ?? 0) - (b.year ?? 0));
}
