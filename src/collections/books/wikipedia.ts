import { logger } from "../../logging/logger";
import { FetchLike, fetchWithRetry } from "../catalogs/http";
import { parseRuns } from "./runs";
import { BookFormat, IssueRun } from "./types";

/**
 * What a collected edition collects, from Wikipedia's lists of Marvel
 * Omnibuses, Epic Collections and Masterworks, and DC Omnibuses.
 *
 * The Grand Comics Database often has a book's ISBN but not its contents —
 * "Doctor Strange: Master of the Mystic Arts Omnibus Vol. 1" has no note and
 * no story list there. Wikipedia's lists have a row per edition with its
 * contents ("Marvel Premiere (1972) #3–14, Doctor Strange (1974) #1–22")
 * and every printing's ISBN. The lists are downloaded whole — nothing about
 * the book is sent — and read here into rows, which are matched by ISBN or
 * searched by title (so a book can be added even while GCD is unavailable).
 */

export const WIKIPEDIA_LISTS = [
  "Marvel Omnibus",
  "Marvel Epic Collection",
  "Marvel Masterworks",
  "DC Omnibus",
];

/** The format each list's books are. */
const LIST_FORMAT: Record<string, BookFormat> = {
  "Marvel Omnibus": "Omnibus",
  "DC Omnibus": "Omnibus",
  "Marvel Epic Collection": "Epic Collection",
  "Marvel Masterworks": "Masterworks",
};

/** One edition as a list's table row describes it. */
export interface WikipediaRow {
  list: string;
  /** The section it sits under — the series, e.g. "Thor". */
  heading: string | null;
  /** The number column, e.g. "1". */
  number: string | null;
  /** The title or subtitle cell, e.g. "The God of Thunder". */
  title: string | null;
  /** The contents cell as plain text. */
  contents: string | null;
  /** Every printing's ISBN-13, the row's own and those continuing it below. */
  isbns: string[];
}

export interface WikipediaContents {
  /** The list the row was found in, e.g. "Marvel Omnibus". */
  list: string;
  /** The edition's name as the row writes it, when the row has one. */
  title: string | null;
  /** The contents cell as plain text. */
  contents: string;
  runs: IssueRun[];
  unread: string[];
}

/** A search result: a book ready for the form. */
export interface WikipediaEdition extends WikipediaContents {
  bookTitle: string;
  volume: string | null;
  format: BookFormat;
  isbn: string | null;
}

const isbnDigits = (value: string): string => value.replace(/[^0-9Xx]/g, "").toUpperCase();

/** ISBN-10 → ISBN-13, so either form of a book's ISBN matches the list. */
export function toIsbn13(isbn: string): string | null {
  const digits = isbnDigits(isbn);
  if (/^\d{13}$/.test(digits)) return digits;
  if (!/^\d{9}[\dX]$/.test(digits)) return null;
  const core = `978${digits.slice(0, 9)}`;
  const sum = [...core].reduce((total, d, i) => total + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** A wikitext table cell as plain text: links, templates, references and emphasis removed. */
export function wikitextToPlain(cell: string): string {
  // DC's list: {{Collapsible list |title=''Batman'' #484–500, and more |* item |* item}}
  // — the title's first run and every item.
  const collapsible = cell.match(/\{\{\s*collapsible list([\s\S]*)\}\}/i);
  if (collapsible) {
    const body = collapsible[1];
    const title = (body.match(/\|\s*title\s*=\s*([^|\n]*)/i)?.[1] ?? "").replace(/,?\s*and more\s*$/i, "");
    const items = [...body.matchAll(/^\s*\*\s*(.+)$/gm)].map((m) => m[1]);
    cell = cell.replace(collapsible[0], [title, ...items].filter((part) => part.trim()).join("; "));
  }
  let text = cell
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/&nbsp;/g, " ");
  // Templates can nest; strip innermost first. {{Sort|key|shown}} and
  // {{nowrap|shown}} keep what they show.
  for (let i = 0; i < 5 && /\{\{[^{}]*\}\}/.test(text); i++) {
    text = text
      .replace(/\{\{\s*sort\s*\|[^{}|]*\|([^{}]*)\}\}/gi, "$1")
      .replace(/\{\{\s*(?:nowrap|small)\s*\|([^{}]*)\}\}/gi, "$1")
      .replace(/\{\{[^{}]*\}\}/g, "");
  }
  return text
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A table row's cell: "|rowspan=2 style=… |content" → "content". */
function cellText(line: string): string | null {
  if (!line.startsWith("|") || line.startsWith("|-") || line.startsWith("|}") || line.startsWith("|+"))
    return null;
  let body = line.slice(1);
  // Attributes come before a single "|" that isn't part of "[[a|b]]" or "{{a|b}}".
  const attrs = body.match(/^\s*(?:rowspan|colspan|style|class|align)\s*=[^|[{]*\|(?!\|)/i);
  if (attrs) body = body.slice(attrs[0].length);
  return body;
}

const ISBN_IN_CELL = /isbnt?\s*\|\s*([0-9Xx][0-9Xx\s-]{8,20})/gi;

/** A contents cell names a series and issue numbers — not "#184-205", a page count or a cover's ISBN. */
function looksLikeContents(cell: string, plain: string): boolean {
  return !/isbnt?\s*\|/i.test(cell) && /[A-Za-z]{3,}[^#]*#\s*\d/.test(plain);
}

/**
 * Every edition row in a list's wikitext. A row runs from one "|-" to the
 * next; a row with neither a title nor contents is another printing of the
 * row above (rowspan), and its ISBNs are added to that row. Pure.
 */
export function parseRows(wikitext: string, list: string): WikipediaRow[] {
  const rows: WikipediaRow[] = [];
  let heading: string | null = null;
  let inTable = 0;
  let cells: string[] = [];

  const finish = () => {
    if (!cells.length) return;
    const isbns = cells.flatMap((cell) => [...cell.matchAll(ISBN_IN_CELL)].map((m) => toIsbn13(m[1])));
    const valid = isbns.filter((isbn): isbn is string => isbn !== null);
    let number: string | null = null;
    let title: string | null = null;
    let contents: string | null = null;
    for (const cell of cells) {
      const plain = wikitextToPlain(cell);
      if (!plain) continue;
      // The volume number comes before the contents; a number after them is a page count.
      if (!number && !contents && /^'*\d{1,3}'*$/.test(cell.trim())) {
        number = plain;
        continue;
      }
      if (!contents && looksLikeContents(cell, plain)) {
        contents = plain;
        continue;
      }
      if (!title && !contents && /''/.test(cell) && !/isbnt?\s*\|/i.test(cell) && !/#\s*\d/.test(plain)) {
        title = plain;
      }
    }
    if (!title && !contents) {
      if (rows.length && valid.length) rows[rows.length - 1].isbns.push(...valid);
    } else if (
      !title &&
      rows.length &&
      rows[rows.length - 1].heading === heading &&
      rows[rows.length - 1].title
    ) {
      // A title spanning several volumes (rowspan) is written on the first only.
      rows.push({ list, heading, number, title: rows[rows.length - 1].title, contents, isbns: valid });
    } else {
      rows.push({ list, heading, number, title, contents, isbns: valid });
    }
    cells = [];
  };

  const lines = wikitext.split("\n");
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].trim();
    // A template left open on its line continues on the next ones: gather it whole.
    let depth = (line.match(/\{\{/g) ?? []).length - (line.match(/\}\}/g) ?? []).length;
    while (depth > 0 && index + 1 < lines.length) {
      index++;
      line += `\n${lines[index]}`;
      depth += (lines[index].match(/\{\{/g) ?? []).length - (lines[index].match(/\}\}/g) ?? []).length;
    }
    const section = line.match(/^(={2,6})\s*(.+?)\s*\1$/);
    if (section && !inTable) {
      heading = wikitextToPlain(section[2]);
      continue;
    }
    if (line.startsWith("{|")) {
      inTable++;
      continue;
    }
    if (!inTable) continue;
    if (line.startsWith("|}")) {
      finish();
      inTable = Math.max(0, inTable - 1);
      continue;
    }
    if (line.startsWith("|-") || line.startsWith("!")) {
      finish();
      continue;
    }
    const cell = cellText(line);
    if (cell !== null) {
      // "| a || b" puts several cells on one line (never inside a gathered template).
      cells.push(...(line.includes("\n") ? [cell] : cell.split(/\s*\|\|\s*/)));
    }
  }
  finish();
  return rows;
}

function contentsOf(row: WikipediaRow): WikipediaContents | null {
  if (!row.contents) return null;
  const { runs, unread } = parseRuns(row.contents);
  if (!runs.length) return null;
  return { list: row.list, title: row.title, contents: row.contents, runs, unread };
}

/** The row holding this ISBN, as contents. Pure. */
export function findContentsByIsbn(wikitext: string, isbn: string, list: string): WikipediaContents | null {
  const wanted = toIsbn13(isbn);
  if (!wanted) return null;
  const row = parseRows(wikitext, list).find((r) => r.isbns.includes(wanted) && r.contents);
  return row ? contentsOf(row) : null;
}

const STOP_WORDS = new Set(["the", "and", "of", "vol", "volume", "by", "a"]);
const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w));

/**
 * A row as a book for the form. An Omnibus row's title is the whole name
 * ("Doctor Strange: Master of the Mystic Arts Vol. 1"); an Epic Collection
 * or Masterworks row's is a subtitle or "The X-Men Vol. 4" under its series.
 */
export function editionFromRow(row: WikipediaRow): WikipediaEdition | null {
  const contents = contentsOf(row);
  if (!contents) return null;
  const format = LIST_FORMAT[row.list] ?? "Other";
  const title = row.title ?? "";
  const volumeInTitle = title.match(/^(.*?)[\s,:]*\bvol(?:ume)?\.?\s*(\d+)\s*$/i);
  let bookTitle: string;
  let volume: string | null;
  if (format === "Epic Collection") {
    bookTitle = `${row.heading ?? title} Epic Collection`;
    volume = row.number ? (title ? `${row.number} - ${title}` : row.number) : title || null;
  } else if (volumeInTitle) {
    const base = volumeInTitle[1].trim();
    const word = format === "Omnibus" ? "Omnibus" : "Masterworks";
    bookTitle = new RegExp(word, "i").test(base) ? base : `${base} ${word}`;
    volume = volumeInTitle[2];
  } else {
    const word = format === "Omnibus" ? "Omnibus" : format === "Masterworks" ? "Masterworks" : "";
    const base = title || row.heading || "";
    bookTitle = word && !new RegExp(word, "i").test(base) ? `${base} ${word}`.trim() : base;
    volume = row.number;
  }
  return { ...contents, bookTitle, volume, format, isbn: row.isbns[0] ?? null };
}

/**
 * Editions whose list, section and title hold every word of the query —
 * "Master of the Mystic Arts Omnibus", "thor epic 1". A number in the query
 * must be the edition's volume. Pure.
 */
export function searchRows(rows: WikipediaRow[], query: string, limit = 25): WikipediaEdition[] {
  const queryWords = words(query);
  const numbers = queryWords.filter((w) => /^\d+$/.test(w));
  const names = queryWords.filter((w) => !/^\d+$/.test(w));
  if (!names.length) return [];
  const results: WikipediaEdition[] = [];
  for (const row of rows) {
    if (!row.contents || !row.title) continue;
    const haystack = new Set(words(`${row.list} ${row.heading ?? ""} ${row.title}`));
    if (!names.every((w) => haystack.has(w) || [...haystack].some((h) => h.startsWith(w) && w.length >= 4)))
      continue;
    const edition = editionFromRow(row);
    if (!edition) continue;
    const volumeNumber = (edition.volume ?? "").match(/^\d+/)?.[0] ?? row.number;
    if (numbers.length && !numbers.includes(volumeNumber ?? "")) continue;
    results.push(edition);
    if (results.length >= limit) break;
  }
  return results;
}

const CACHE_MS = 24 * 60 * 60_000;
const MIN_GAP_MS = 1000;

export class WikipediaCollections {
  private readonly pages = new Map<string, { at: number; rows: WikipediaRow[] | null }>();
  private lastRequestAt = -Infinity;

  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  /** The contents of the edition with any of these ISBNs, or null if no list has it. */
  async findByIsbn(isbns: Array<string | null | undefined>): Promise<WikipediaContents | null> {
    const wanted = [
      ...new Set(isbns.map((isbn) => (isbn ? toIsbn13(isbn) : null)).filter(Boolean)),
    ] as string[];
    if (!wanted.length) return null;
    const all = await this.allRows();
    const row = all.find((r) => r.contents && r.isbns.some((isbn) => wanted.includes(isbn)));
    return row ? contentsOf(row) : null;
  }

  /** Editions matching a title search, across every list. */
  async search(query: unknown): Promise<WikipediaEdition[]> {
    const text = typeof query === "string" ? query.trim().slice(0, 100) : "";
    if (text.length < 2) return [];
    return searchRows(await this.allRows(), text);
  }

  private async allRows(): Promise<WikipediaRow[]> {
    const all: WikipediaRow[] = [];
    let reached = false;
    for (const list of WIKIPEDIA_LISTS) {
      const rows = await this.rows(list);
      if (rows === null) continue;
      reached = true;
      all.push(...rows);
    }
    if (!reached) throw new Error("Wikipedia couldn't be reached. Try again in a moment.");
    return all;
  }

  private async rows(list: string): Promise<WikipediaRow[] | null> {
    const cached = this.pages.get(list);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.rows;
    const wait = MIN_GAP_MS - (this.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const url = `https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&page=${encodeURIComponent(list)}`;
    try {
      const response = await fetchWithRetry(this.fetchFn, url, {
        headers: {
          "User-Agent": "NIMBUS (personal desktop assistant; collected edition contents)",
          Accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`Wikipedia answered ${response.status}.`);
      const json = (await response.json()) as { parse?: { wikitext?: unknown } };
      const rows = typeof json.parse?.wikitext === "string" ? parseRows(json.parse.wikitext, list) : null;
      this.pages.set(list, { at: this.now(), rows });
      return rows;
    } catch (err) {
      logger.warn("Wikipedia list request failed", { list, error: String(err) });
      return null;
    }
  }
}
