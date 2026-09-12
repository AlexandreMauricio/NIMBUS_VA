import { logger } from "../../logging/logger";
import { FetchLike, asString, getCatalogJson } from "../catalogs/http";
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
  for (const raw of results.slice(0, 30)) {
    const r = raw as Record<string, unknown>;
    const id = idFrom(r.api_url, "series");
    const name = asString(r.name);
    if (!id || !name) continue;
    const issues = Array.isArray(r.active_issues) ? r.active_issues : [];
    const descriptors = Array.isArray(r.issue_descriptors) ? r.issue_descriptors : [];
    const volumes: GcdSeries["volumes"] = [];
    for (let i = 0; i < Math.min(issues.length, descriptors.length, 300); i++) {
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
