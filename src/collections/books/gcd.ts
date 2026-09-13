import { logger } from "../../logging/logger";
import { FetchLike, asString, getCatalogJson, httpsOrNull } from "../catalogs/http";
import { parseRuns } from "./runs";
import { BookFormat, IssueRun } from "./types";

/**
 * The Grand Comics Database (comics.org) — a volunteer-run index of
 * comics, collected editions included. Free, no key.
 *
 * What it knows about a collected edition's contents varies: many Epic
 * Collections and Masterworks carry a note like "Collects Thor (1966)
 * #126-130", many omnibuses don't. So a volume from GCD fills in its title,
 * ISBN and — when the note says — its issue runs, and the form asks you for
 * whatever is missing. GCD is a community resource: requests are spaced a
 * second apart and results kept for a day.
 */

export interface GcdSeries {
  id: number;
  name: string;
  yearBegan: number | null;
  publisher: string | null;
  volumes: Array<{ issueId: number; descriptor: string }>;
}

export interface GcdVolume {
  issueId: number;
  seriesName: string;
  descriptor: string;
  title: string | null;
  isbn: string | null;
  publicationDate: string | null;
  publisher: string | null;
  format: BookFormat;
  /** The runs read from GCD's note — empty when it doesn't say. */
  runs: IssueRun[];
  unread: string[];
  /** GCD's own note, for reference. */
  notes: string | null;
  coverUrl: string | null;
}

/** One single issue as GCD records it — for the issue page. */
export interface GcdIssueDetail {
  issueId: number;
  seriesName: string;
  number: string;
  /** The issue's own title, when it has one. */
  title: string | null;
  publicationDate: string | null;
  onSaleDate: string | null;
  price: string | null;
  pageCount: number | null;
  publisher: string | null;
  coverUrl: string | null;
  stories: Array<{
    type: string;
    title: string | null;
    feature: string | null;
    synopsis: string | null;
    characters: string | null;
  }>;
  /** Everyone credited on the issue's stories and cover, each with every role they had. */
  credits: Array<{ name: string; roles: string[] }>;
}

/** GCD writes "Walter Simonson (signed as Simonson (brontosaurus))", and "None" or "?" for unknowns. */
export function creditNames(value: unknown): string[] {
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split(";")
    .map((part) =>
      part
        .replace(/\s*\((?:[^()]|\([^()]*\))*\)/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .trim()
    )
    .filter((name) => name && !/^(?:none|\?|typeset|various)$/i.test(name));
}

const CREDIT_ROLES: Array<[string, string]> = [
  ["script", "Writer"],
  ["pencils", "Penciler"],
  ["inks", "Inker"],
  ["colors", "Colorist"],
  ["letters", "Letterer"],
];

export function mapGcdIssueDetail(json: unknown, issueId: number): GcdIssueDetail {
  const r = (json ?? {}) as Record<string, unknown>;
  const stories = Array.isArray(r.story_set) ? (r.story_set as Array<Record<string, unknown>>) : [];
  const credits = new Map<string, { name: string; roles: string[] }>();
  const credit = (name: string, role: string) => {
    const key = name.toLowerCase();
    const entry = credits.get(key) ?? { name, roles: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    credits.set(key, entry);
  };
  for (const story of stories.slice(0, 60)) {
    const type = asString(story.type) ?? "";
    // Ads and in-house columns are not the comic.
    if (/advertis|in-house|letters page|statement of ownership/i.test(type)) continue;
    for (const [field, role] of CREDIT_ROLES) {
      for (const name of creditNames(story[field])) {
        credit(name, type === "cover" ? `Cover ${role.toLowerCase()}` : role);
      }
    }
  }
  for (const name of creditNames(r.editing)) credit(name, "Editor");
  const pages = Number(asString(r.page_count));
  return {
    issueId,
    seriesName: (asString(r.series_name) ?? "").replace(/\s*\((\d{4}) series\)\s*$/i, " ($1)"),
    number: asString(r.number) ?? asString(r.descriptor) ?? "",
    title: asString(r.title),
    publicationDate: asString(r.publication_date),
    onSaleDate: asString(r.on_sale_date),
    price: asString(r.price),
    pageCount: Number.isFinite(pages) && pages > 0 ? Math.round(pages) : null,
    publisher: asString(r.indicia_publisher),
    coverUrl: httpsOrNull(r.cover),
    stories: stories
      .filter((s) => /story/i.test(asString(s.type) ?? ""))
      .slice(0, 20)
      .map((s) => ({
        type: asString(s.type) ?? "story",
        title: asString(s.title),
        feature: asString(s.feature),
        synopsis: asString(s.synopsis),
        characters: asString(s.characters),
      })),
    credits: [...credits.values()],
  };
}

/**
 * The GCD issue for "Thor (1966) #337": the series by name and year, then
 * the issue by its number — the plain printing first, then the direct
 * edition, then any variant. Null when GCD has no such series or issue.
 */
export function pickIssue(
  series: GcdSeries[],
  name: string,
  year: number | null,
  number: number
): { seriesId: number; issueId: number } | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/^the\s+/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const candidates = series
    .filter((s) => norm(s.name) === norm(name) && (year === null || s.yearBegan === year))
    .sort((a, b) => b.volumes.length - a.volumes.length);
  for (const candidate of candidates) {
    const n = String(number);
    const hit =
      candidate.volumes.find((v) => v.descriptor === n) ??
      candidate.volumes.find((v) => v.descriptor === `${n} [Direct]`) ??
      candidate.volumes.find((v) => v.descriptor.startsWith(`${n} [`));
    if (hit) return { seriesId: candidate.id, issueId: hit.issueId };
  }
  return null;
}

/** The few publishers worth naming without an extra request, by GCD id. */
const KNOWN_PUBLISHERS: Record<number, string> = { 78: "Marvel", 54: "DC", 2547: "Image" };

const idFrom = (url: unknown, kind: "series" | "issue" | "publisher"): number | null => {
  const match = typeof url === "string" ? url.match(new RegExp(`/api/${kind}/(\\d+)/`)) : null;
  return match ? Number(match[1]) : null;
};

export function guessFormat(seriesName: string): BookFormat {
  if (/epic collection/i.test(seriesName)) return "Epic Collection";
  if (/omnibus/i.test(seriesName)) return "Omnibus";
  if (/masterworks/i.test(seriesName)) return "Masterworks";
  return "Other";
}

export function mapGcdSeriesSearch(json: unknown): GcdSeries[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const series: GcdSeries[] = [];
  for (const raw of results.slice(0, 50)) {
    const r = raw as Record<string, unknown>;
    const id = idFrom(r.api_url, "series");
    const name = asString(r.name);
    if (!id || !name) continue;
    const issues = Array.isArray(r.active_issues) ? r.active_issues : [];
    const descriptors = Array.isArray(r.issue_descriptors) ? r.issue_descriptors : [];
    const volumes: GcdSeries["volumes"] = [];
    for (let i = 0; i < Math.min(issues.length, descriptors.length, 3000); i++) {
      const issueId = idFrom(issues[i], "issue");
      const descriptor = asString(descriptors[i]);
      if (issueId && descriptor) volumes.push({ issueId, descriptor });
    }
    const publisherId = idFrom(r.publisher, "publisher");
    series.push({
      id,
      name,
      yearBegan: typeof r.year_began === "number" ? r.year_began : null,
      publisher: publisherId ? (KNOWN_PUBLISHERS[publisherId] ?? null) : null,
      volumes,
    });
  }
  return series;
}

export function mapGcdIssue(json: unknown, issueId: number): GcdVolume {
  const r = (json ?? {}) as Record<string, unknown>;
  // GCD writes "Thor Epic Collection (2013 series)"; the year of the book
  // series isn't part of its title.
  const seriesName = (asString(r.series_name) ?? "").replace(/\s*\(\d{4} series\)\s*$/i, "");
  const notes = asString(r.notes);
  const { runs, unread } = parseRuns(notes ?? "");
  const isbn = asString(r.isbn)?.replace(/[^0-9Xx]/g, "") || null;
  const publisherId = idFrom(r.indicia_publisher, "publisher");
  return {
    issueId,
    seriesName,
    descriptor: asString(r.descriptor) ?? "",
    title: asString(r.title),
    isbn,
    publicationDate: asString(r.publication_date),
    publisher: publisherId ? (KNOWN_PUBLISHERS[publisherId] ?? null) : null,
    format: guessFormat(seriesName),
    runs,
    unread,
    notes,
    coverUrl: httpsOrNull(r.cover),
  };
}

const CACHE_MS = 24 * 60 * 60_000;
const MIN_GAP_MS = 1000;

export class GcdCatalog {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private lastRequestAt = -Infinity;

  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  async searchSeries(name: unknown): Promise<GcdSeries[]> {
    const query = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
    if (query.length < 2) throw new Error("Type at least 2 characters.");
    if (query.length > 100) throw new Error("Searches are at most 100 characters.");
    const json = await this.get(
      `https://www.comics.org/api/series/name/${encodeURIComponent(query)}/?format=json`
    );
    return mapGcdSeriesSearch(json);
  }

  async getVolume(issueId: unknown): Promise<GcdVolume> {
    const id = typeof issueId === "number" ? issueId : Number(issueId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("That isn't a GCD volume.");
    const json = await this.get(`https://www.comics.org/api/issue/${id}/?format=json`);
    if (!json) throw new Error("GCD doesn't have that volume.");
    return mapGcdIssue(json, id);
  }

  /**
   * A single issue's page — "Thor (1966) #337": the series by name (and
   * year, when known), then the issue by number. Only the series name,
   * year and number are sent. Null when GCD has no match.
   */
  async findIssue(series: unknown, year: unknown, number: unknown): Promise<GcdIssueDetail | null> {
    const name = typeof series === "string" ? series.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 100) throw new Error("That is not a series name.");
    const y =
      typeof year === "number" && Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null;
    const n =
      typeof number === "number" && Number.isInteger(number) && number >= 0 && number <= 100_000
        ? number
        : null;
    if (n === null) throw new Error("That is not an issue number.");
    const url = y
      ? `https://www.comics.org/api/series/name/${encodeURIComponent(name)}/year/${y}/?format=json`
      : `https://www.comics.org/api/series/name/${encodeURIComponent(name)}/?format=json`;
    const picked = pickIssue(mapGcdSeriesSearch(await this.get(url)), name, y, n);
    return picked ? this.getIssueDetail(picked.issueId) : null;
  }

  async getIssueDetail(issueId: unknown): Promise<GcdIssueDetail> {
    const id = typeof issueId === "number" ? issueId : Number(issueId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("That is not a GCD issue.");
    const json = await this.get(`https://www.comics.org/api/issue/${id}/?format=json`);
    if (!json) throw new Error("GCD does not have that issue.");
    return mapGcdIssueDetail(json, id);
  }

  private async get(url: string): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.value;
    const wait = MIN_GAP_MS - (this.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    let value: unknown;
    try {
      value = await getCatalogJson(url, this.fetchFn);
    } catch (err) {
      logger.warn("GCD request failed", { error: String(err) });
      throw new Error("The Grand Comics Database couldn't be reached. Try again in a moment.");
    }
    this.cache.set(url, { at: this.now(), value });
    return value;
  }
}
