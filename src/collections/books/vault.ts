/**
 * The comics vault — an Obsidian folder of book notes — read, never written.
 *
 * Each note in the vault's `Books/` folder is one collected edition, and
 * the properties at the top of the note (YAML frontmatter) are its data:
 * status, what was paid and where, the cart it's in, ratings, what covers
 * it. NIMBUS reads those and shows them beside its own books, matched by
 * ISBN, then by Epic number, then by name. The vault's computed fields
 * (`seq`, `purpose`, `missing_before`) and the Cart Planner's tables are
 * read as `Tools/refresh.py` last wrote them.
 *
 * Pure: the main process reads the files (comicsVault.ts) and hands the
 * text here.
 */

import type { Book, BookFormat } from "./types";

/** The vault's statuses, as "How this vault works" lists them. */
export const VAULT_STATUSES = [
  "owned",
  "covered",
  "incoming",
  "planned",
  "wanted",
  "oop",
  "unreleased",
  "parked",
] as const;
export type VaultStatus = (typeof VAULT_STATUSES)[number];

export const VAULT_STATUS_LABELS: Record<VaultStatus, string> = {
  owned: "Owned",
  covered: "Covered",
  incoming: "Incoming",
  planned: "Planned",
  wanted: "Wanted",
  oop: "Out of print",
  unreleased: "Unreleased",
  parked: "Parked",
};

/** One book note, as NIMBUS uses it. Anything the note doesn't say is null. */
export interface VaultBook {
  /** Path inside the vault, with forward slashes — "Books/Iron Man/IM Epic 01 - The Golden Avenger.md". */
  path: string;
  /** The note's name — how the vault links to it. */
  name: string;
  line: string | null;
  type: string | null;
  number: number | null;
  title: string | null;
  status: VaultStatus | null;
  read: boolean;
  nextRead: boolean;
  isbns: string[];
  issues: string | null;
  writers: string | null;
  artists: string | null;
  years: string | null;
  era: string | null;
  releaseDate: string | null;
  pricePaid: number | null;
  priceSeen: number | null;
  store: string | null;
  priceNote: string | null;
  budget: string | null;
  cart: string | null;
  urgency: string | null;
  urgencyReason: string | null;
  tier: string | null;
  storyRating: string | null;
  ratingReason: string | null;
  highlight: string | null;
  myRating: string | null;
  goodreads: { rating: number; votes: number | null } | null;
  coveredBy: string[];
  covers: string[];
  /** Computed by refresh.py. */
  seq: number | null;
  purpose: string | null;
  missingBefore: number | null;
  verified: boolean;
}

type Value = string | number | boolean | null | Value[];

/** A frontmatter scalar: quoted string, number, true/false, or the text as is. */
function scalar(raw: string): Value {
  const text = raw.trim();
  if (!text || text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
    return text.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** `[a, "b, c", 3]` — split on commas outside quotes. */
function flowList(raw: string): Value[] {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
      } else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) items.push(current);
  return items.map(scalar).filter((value) => value !== null);
}

/**
 * The properties at the top of a note — the YAML subset Obsidian writes:
 * `key: value`, flow lists `[a, b]`, and block lists (`key:` then `- a`).
 * Anything else is skipped rather than guessed. Empty when there are none.
 */
export function parseFrontmatter(text: string): Record<string, Value> {
  // A byte-order mark (0xFEFF) some editors put first is dropped.
  const normalised = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  if (!normalised.startsWith("---\n")) return {};
  const end = normalised.indexOf("\n---", 4);
  if (end < 0) return {};
  const out: Record<string, Value> = {};
  let listKey: string | null = null;
  for (const line of normalised.slice(4, end).split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as Value[]).push(scalar(item[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_\-.]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    listKey = null;
    if (!raw.trim()) {
      out[key] = [];
      listKey = key;
    } else if (raw.trim().startsWith("[") && raw.trim().endsWith("]")) out[key] = flowList(raw);
    else out[key] = scalar(raw);
  }
  return out;
}

/** "[[The Invincible Iron Man Omnibus Vol 1]]" → "The Invincible Iron Man Omnibus Vol 1" (alias dropped). */
export function unlink(text: string): string {
  return text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, "$1").trim();
}

const str = (value: Value | undefined): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
const num = (value: Value | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", ".").replace(/[^\d.-]/g, ""));
    return value.trim() && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const list = (value: Value | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map((item) => (typeof item === "string" || typeof item === "number" ? unlink(String(item)) : ""))
    .filter(Boolean);

/** One note's properties as a VaultBook. `path` is inside the vault, with forward slashes. */
export function vaultBook(path: string, props: Record<string, Value>): VaultBook {
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  const status = str(props.status)?.toLowerCase();
  const goodreads = num(props.goodreads_rating);
  return {
    path,
    name,
    line: str(props.line),
    type: str(props.type),
    number: num(props.number),
    title: str(props.title),
    status: VAULT_STATUSES.includes(status as VaultStatus) ? (status as VaultStatus) : null,
    read: props.read === true,
    nextRead: props.next_read === true,
    isbns: list(props.isbn),
    issues: str(props.issues),
    writers: str(props.writers),
    artists: str(props.artists),
    years: str(props.years),
    era: str(props.era),
    releaseDate: str(props.release_date),
    pricePaid: num(props.price_paid),
    priceSeen: num(props.price_seen),
    store: str(props.store),
    priceNote: str(props.price_note),
    budget: str(props.budget),
    cart: str(props.cart),
    urgency: str(props.urgency),
    urgencyReason: str(props.urgency_reason),
    tier: str(props.tier),
    storyRating: str(props.story_rating),
    ratingReason: str(props.rating_reason),
    highlight: str(props.rating_highlight),
    myRating: str(props.my_rating),
    goodreads: goodreads === null ? null : { rating: goodreads, votes: num(props.goodreads_votes) },
    coveredBy: list(props.covered_by),
    covers: list(props.covers),
    seq: num(props.seq),
    purpose: str(props.purpose),
    missingBefore: num(props.missing_before),
    verified: props.verified === true,
  };
}

/** A table under a heading of the Cart Planner: rows of cells, links unwrapped. */
export interface PlannerTable {
  heading: string;
  columns: string[];
  rows: string[][];
}

/**
 * The Cart Planner note's tables, as refresh.py wrote them — each with the
 * `##` heading above it. Cells keep their text; `[[links]]` become names.
 */
export function parsePlannerTables(text: string): PlannerTable[] {
  const tables: PlannerTable[] = [];
  let heading = "";
  let current: PlannerTable | null = null;
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => unlink(cell.trim()));
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      heading = line.replace(/^#+\s*/, "").trim();
      current = null;
      continue;
    }
    if (!line.trim().startsWith("|")) {
      current = null;
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    if (!current) {
      current = { heading, columns: cells(line), rows: [] };
      tables.push(current);
    } else current.rows.push(cells(line));
  }
  return tables;
}

// ---------- matching with NIMBUS's books ----------

const isbnKey = (isbn: string) => isbn.replace(/[^0-9Xx]/g, "").toUpperCase();
const nameKey = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bvolume\b|\bvol\b\.?/g, "vol")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Which NIMBUS book each vault note is: the same ISBN (any printing), else
 * the same line's Epic Collection with the same number, else the same name
 * ("The Mighty Thor Omnibus Vol 4" is "The Mighty Thor Omnibus" · "Vol. 4").
 * Each NIMBUS book is matched at most once. Returns vault path → book id.
 */
export function matchVault(
  vault: VaultBook[],
  books: Array<Pick<Book, "id" | "title" | "volume" | "format" | "isbn">>
): Map<string, string> {
  const matched = new Map<string, string>();
  const used = new Set<string>();
  const take = (note: VaultBook, book: { id: string } | undefined) => {
    if (!book || used.has(book.id) || matched.has(note.path)) return;
    matched.set(note.path, book.id);
    used.add(book.id);
  };
  const byIsbn = new Map(books.filter((b) => b.isbn).map((b) => [isbnKey(b.isbn!), b]));
  for (const note of vault) for (const isbn of note.isbns) take(note, byIsbn.get(isbnKey(isbn)));
  for (const note of vault) {
    if (matched.has(note.path) || !note.line || note.number === null || !/epic/i.test(note.type ?? ""))
      continue;
    const line = nameKey(note.line);
    take(
      note,
      books.find(
        (b) =>
          !used.has(b.id) &&
          b.format === "Epic Collection" &&
          nameKey(b.title).includes(line) &&
          Number(/^\s*(\d+)/.exec(b.volume ?? "")?.[1]) === note.number
      )
    );
  }
  for (const note of vault) {
    if (matched.has(note.path)) continue;
    const keys = [note.name, note.title].filter(Boolean).map((text) => nameKey(text!));
    take(
      note,
      books.find((b) => !used.has(b.id) && keys.includes(nameKey(`${b.title} ${b.volume ?? ""}`)))
    );
  }
  return matched;
}

/** How a vault note would be added to NIMBUS: title, volume, format, the newest ISBN, owned or wishlist. */
export function bookFromVault(note: VaultBook): {
  title: string;
  volume: string | null;
  format: BookFormat;
  isbn: string | null;
  status: "owned" | "wishlist";
} {
  const type = (note.type ?? "").toLowerCase();
  const epic = type.includes("epic") && note.line;
  const format: BookFormat = type.includes("epic")
    ? "Epic Collection"
    : type.includes("omnibus")
      ? "Omnibus"
      : type.includes("masterworks")
        ? "Masterworks"
        : type.includes("tpb") || type.includes("trade")
          ? "Trade paperback"
          : type.includes("hardcover")
            ? "Hardcover"
            : "Other";
  return {
    title: epic ? `${note.line} Epic Collection` : note.name,
    volume: epic && note.number !== null ? `${note.number}${note.title ? ` - ${note.title}` : ""}` : null,
    format,
    isbn: note.isbns.length ? isbnKey(note.isbns[note.isbns.length - 1]) : null,
    status: note.status === "owned" ? "owned" : "wishlist",
  };
}

/** Books in carts, by month ("2026-10"), with what each costs — paid, else seen. */
export function cartsByMonth(
  vault: VaultBook[]
): Array<{ month: string; books: VaultBook[]; total: number; unpriced: number }> {
  const months = new Map<string, VaultBook[]>();
  for (const note of vault) if (note.cart) months.set(note.cart, [...(months.get(note.cart) ?? []), note]);
  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, books]) => {
      const prices = books.map((b) => b.pricePaid ?? b.priceSeen);
      return {
        month,
        books,
        total: Math.round(prices.reduce<number>((sum, price) => sum + (price ?? 0), 0) * 100) / 100,
        unpriced: prices.filter((price) => price === null).length,
      };
    });
}
