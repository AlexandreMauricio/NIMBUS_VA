/**
 * Books — comics collected editions and manga volumes.
 *
 * What matters about a collected edition isn't the book, it's **which
 * issues it collects**: an Epic Collection and an Omnibus can overlap, a
 * Masterworks fills a gap neither covers. So every book carries runs of
 * issues ("Thor (1966) #126–130"), and coverage is worked out across all of
 * them — what you have once, what you have twice, what's missing.
 *
 * A manga volume is the same idea one level up: the series is the run and
 * the volume numbers are the "issues", so "One Piece #1–45" is 45 volumes
 * owned, and the next one to buy is simply the first gap.
 */

export type BookKind = "comic" | "manga";

export const BOOK_FORMATS = [
  "Epic Collection",
  "Omnibus",
  "Masterworks",
  "Trade paperback",
  "Hardcover",
  "Manga volume",
  "Other",
] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

/** A contiguous range of issues (or volumes) of one series. */
export interface IssueRun {
  /** The series as written, e.g. "Journey Into Mystery". */
  series: string;
  /** Its launch year when known — "Thor (1966)" and "Thor (1998)" are different series. */
  year: number | null;
  from: number;
  to: number;
  /** "Reprints material from …": the book has some of these issues, not necessarily all. */
  partial: boolean;
}

export type BookStatus = "owned" | "wishlist";

export interface Book {
  id: string;
  kind: BookKind;
  /** e.g. "Thor Epic Collection" or "One Piece". */
  title: string;
  /** e.g. "1 - The God of Thunder", "3", "Vol. 12". */
  volume: string | null;
  format: BookFormat;
  publisher: string | null;
  isbn: string | null;
  status: BookStatus;
  runs: IssueRun[];
  notes: string | null;
  /** Where the details came from, e.g. "gcd:1205407", or null if typed in. */
  source: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface BookState {
  version: 1;
  books: Book[];
}

export interface BookStore {
  load(): unknown;
  save(state: BookState): void;
}

export const MAX_BOOKS = 5000;
export const MAX_RUNS_PER_BOOK = 50;
export const MAX_ISSUE_NUMBER = 100_000;
