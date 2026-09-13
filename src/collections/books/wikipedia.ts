import { logger } from "../../logging/logger";
import { FetchLike, fetchWithRetry } from "../catalogs/http";
import { parseRuns } from "./runs";
import { IssueRun } from "./types";

/**
 * What a collected edition collects, from Wikipedia's lists of Marvel
 * Omnibuses, Epic Collections and Masterworks, and DC Omnibuses.
 *
 * The Grand Comics Database often has a book's ISBN but not its contents —
 * "Doctor Strange: Master of the Mystic Arts Omnibus Vol. 1" has no note and
 * no story list there. Wikipedia's lists have a row per edition with its
 * contents ("Marvel Premiere (1972) #3–14, Doctor Strange (1974) #1–22")
 * and every printing's ISBN. So the lists are downloaded whole — nothing
 * about the book is sent — and the ISBN is matched here.
 */

export const WIKIPEDIA_LISTS = [
  "Marvel Omnibus",
  "Marvel Epic Collection",
  "Marvel Masterworks",
  "DC Omnibus",
];

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
  let text = cell
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/&nbsp;/g, " ");
  // Templates can nest; strip innermost first.
  for (let i = 0; i < 5 && /\{\{[^{}]*\}\}/.test(text); i++) {
    text = text.replace(/\{\{\s*(?:nowrap|small)\s*\|([^{}]*)\}\}/gi, "$1").replace(/\{\{[^{}]*\}\}/g, "");
  }
  return text
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A table row's cell: "|rowspan=2 style=… |content" → "content". */
function cellText(line: string): string | null {
  if (!line.startsWith("|") || line.startsWith("|-") || line.startsWith("|}")) return null;
  let body = line.slice(1);
  // Attributes come before a single "|" that isn't part of "[[a|b]]" or "{{a|b}}".
  const attrs = body.match(/^\s*(?:rowspan|colspan|style|class|align)\s*=[^|[{]*\|(?!\|)/i);
  if (attrs) body = body.slice(attrs[0].length);
  return body;
}

/** A contents cell names a series and issue numbers — not just "#184-205" or a page count. */
function looksLikeContents(plain: string): boolean {
  return /[A-Za-z]{3,}[^#]*#\s*\d/.test(plain);
}

/**
 * The row holding this ISBN in a list's wikitext: the contents cell and the
 * edition's name, read upwards from the ISBN to the start of the row (rows
 * for a second printing share the first printing's cells through rowspan,
 * so reading upwards finds them too). Pure.
 */
export function findContentsByIsbn(wikitext: string, isbn: string, list: string): WikipediaContents | null {
  const wanted = toIsbn13(isbn);
  if (!wanted) return null;
  const lines = wikitext.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const found = [...lines[i].matchAll(/isbnt?\s*\|\s*([0-9Xx][0-9Xx\s-]{8,20})/gi)].some(
      (m) => toIsbn13(m[1]) === wanted
    );
    if (!found) continue;
    let contents: string | null = null;
    let title: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const line = lines[j].trim();
      // A header or the table's start: nothing further up belongs to this row.
      if (line.startsWith("!") || line.startsWith("{|")) break;
      const cell = cellText(line);
      if (cell === null) continue;
      const plain = wikitextToPlain(cell);
      if (!contents && looksLikeContents(plain)) {
        contents = plain;
        continue;
      }
      if (contents && !title && /'''/.test(cell)) {
        title = plain;
        break;
      }
    }
    if (!contents) continue;
    const { runs, unread } = parseRuns(contents);
    if (!runs.length) continue;
    return { list, title, contents, runs, unread };
  }
  return null;
}

const CACHE_MS = 24 * 60 * 60_000;
const MIN_GAP_MS = 1000;

export class WikipediaCollections {
  private readonly pages = new Map<string, { at: number; wikitext: string | null }>();
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
    let reached = false;
    for (const list of WIKIPEDIA_LISTS) {
      const wikitext = await this.page(list);
      if (wikitext === null) continue;
      reached = true;
      for (const isbn of wanted) {
        const hit = findContentsByIsbn(wikitext, isbn, list);
        if (hit) return hit;
      }
    }
    if (!reached) throw new Error("Wikipedia couldn't be reached. Try again in a moment.");
    return null;
  }

  private async page(title: string): Promise<string | null> {
    const cached = this.pages.get(title);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.wikitext;
    const wait = MIN_GAP_MS - (this.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const url = `https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&page=${encodeURIComponent(title)}`;
    try {
      const response = await fetchWithRetry(this.fetchFn, url, {
        headers: {
          "User-Agent": "NIMBUS (personal desktop assistant; collected edition contents)",
          Accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`Wikipedia answered ${response.status}.`);
      const json = (await response.json()) as { parse?: { wikitext?: unknown } };
      const wikitext = typeof json.parse?.wikitext === "string" ? json.parse.wikitext : null;
      this.pages.set(title, { at: this.now(), wikitext });
      return wikitext;
    } catch (err) {
      logger.warn("Wikipedia list request failed", { list: title, error: String(err) });
      return null;
    }
  }
}
