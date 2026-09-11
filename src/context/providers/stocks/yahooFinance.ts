import { httpTimeoutSignal } from "../../../common/timeout";
import {
  ListingMatch,
  MarketDataSource,
  NewsSource,
  RawQuote,
  StockNewsItem,
  companySearchName,
  normalizeSymbol,
} from "./types";

/**
 * Yahoo Finance's public quote and news endpoints — the external-integration
 * layer for stocks, the same role OpenMeteoClient plays for weather.
 * Nothing outside this file knows the vendor: StockProvider depends only on
 * the MarketDataSource / NewsSource interfaces, so a keyed vendor could
 * replace this without anything above it changing.
 *
 * Chosen because it needs no API key and no account: these endpoints are
 * what Yahoo's own pages use. That is also their limitation — they are
 * undocumented, may be rate-limited, and could change without notice.
 * Every response is checked rather than trusted, and a failure is always a
 * rejection, never a made-up number.
 */

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

interface ChartMeta {
  regularMarketPrice?: unknown;
  chartPreviousClose?: unknown;
  previousClose?: unknown;
  currency?: unknown;
  exchangeName?: unknown;
  fullExchangeName?: unknown;
  longName?: unknown;
  shortName?: unknown;
  regularMarketTime?: unknown;
  instrumentType?: unknown;
}

interface SearchQuoteItem {
  symbol?: unknown;
  quoteType?: unknown;
  longname?: unknown;
  shortname?: unknown;
  exchDisp?: unknown;
  exchange?: unknown;
}

interface SearchNewsItem {
  title?: unknown;
  publisher?: unknown;
  link?: unknown;
  providerPublishTime?: unknown;
  relatedTickers?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export class YahooMarketDataSource implements MarketDataSource {
  readonly name = "Yahoo Finance";

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetchQuote(symbol: string): Promise<RawQuote> {
    const url = `${CHART_URL}${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const response = await this.fetchFn(url, {
      signal: httpTimeoutSignal(),
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) throw new Error(`No market data found for ${symbol}`);
    if (!response.ok) throw new Error(`Market data request failed with status ${response.status}`);

    const body = (await response.json()) as { chart?: { result?: Array<{ meta?: ChartMeta }> | null } };
    const meta = body?.chart?.result?.[0]?.meta;
    const price = finite(meta?.regularMarketPrice);
    if (!meta || price === null) throw new Error(`Market data for ${symbol} had no price`);

    const marketSeconds = finite(meta.regularMarketTime);
    return {
      symbol,
      price,
      previousClose: finite(meta.chartPreviousClose) ?? finite(meta.previousClose),
      currency: text(meta.currency),
      exchange: text(meta.fullExchangeName) ?? text(meta.exchangeName),
      name: text(meta.longName) ?? text(meta.shortName),
      marketTime: marketSeconds !== null ? new Date(marketSeconds * 1000).toISOString() : null,
      instrumentType: text(meta.instrumentType),
    };
  }

  /** Equity and ETF listings Yahoo's search returns for a company name. Unpriced — the caller prices them. */
  async searchListings(query: string, limit: number): Promise<ListingMatch[]> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("quotesCount", String(limit));
    url.searchParams.set("newsCount", "0");
    const response = await this.fetchFn(url.toString(), {
      signal: httpTimeoutSignal(),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Listing search failed with status ${response.status}`);

    const body = (await response.json()) as { quotes?: unknown };
    const raw = Array.isArray(body?.quotes) ? (body.quotes as SearchQuoteItem[]) : [];
    return raw
      .filter((q) => q.quoteType === "EQUITY" || q.quoteType === "ETF")
      .map((q): ListingMatch | null => {
        const symbol = normalizeSymbol(q.symbol);
        if (!symbol) return null;
        return {
          symbol,
          name: text(q.longname) ?? text(q.shortname),
          exchange: text(q.exchDisp) ?? text(q.exchange),
        };
      })
      .filter((q): q is ListingMatch => q !== null)
      .slice(0, limit);
  }
}

/** Words too common to identify a company on their own in a headline. */
const GENERIC_FIRST_WORDS = new Set([
  "the",
  "bank",
  "first",
  "general",
  "american",
  "united",
  "national",
  "international",
  "china",
  "royal",
  "global",
  "new",
]);

/** Does a headline name the company? By its full search name, or its first word when that is distinctive. */
function mentionsCompany(title: string, searchName: string | null): boolean {
  if (!searchName) return false;
  const words = (value: string) =>
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const titleWords = words(title);
  const nameWords = words(searchName);
  if (nameWords.length === 0) return false;
  // The whole name as consecutive words ("bank of america"), never as part of a longer word.
  for (let i = 0; i + nameWords.length <= titleWords.length; i++) {
    if (nameWords.every((w, k) => titleWords[i + k] === w)) return true;
  }
  const first = nameWords[0];
  if (nameWords.length === 1 || first.length < 4 || GENERIC_FIRST_WORDS.has(first)) return false;
  return titleWords.includes(first);
}

/**
 * Recent headlines for a symbol: title, publisher, time and a link — never
 * article text.
 *
 * Searching by a ticker string ("REP.MC") returns mostly unrelated news,
 * so the search uses the company name when it is known ("Repsol"). An
 * item is kept only when the source tags it with this symbol, or its
 * headline names the company — untagged general news is dropped.
 */
export class YahooNewsSource implements NewsSource {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetchNews(symbol: string, limit: number, companyName?: string | null): Promise<StockNewsItem[]> {
    const searchName = companySearchName(companyName);
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", searchName ?? symbol);
    url.searchParams.set("quotesCount", "0");
    url.searchParams.set("newsCount", String(Math.max(limit * 2, 8)));

    const response = await this.fetchFn(url.toString(), {
      signal: httpTimeoutSignal(),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`News request failed with status ${response.status}`);

    const body = (await response.json()) as { news?: unknown };
    const raw = Array.isArray(body?.news) ? (body.news as SearchNewsItem[]) : [];

    return raw
      .filter((item) => {
        const tagged =
          Array.isArray(item.relatedTickers) &&
          item.relatedTickers.some((t) => typeof t === "string" && t.toUpperCase() === symbol.toUpperCase());
        return tagged || mentionsCompany(text(item.title) ?? "", searchName);
      })
      .map((item): StockNewsItem | null => {
        const title = text(item.title);
        const link = text(item.link);
        if (!title || !link || !isHttpUrl(link)) return null;
        const seconds = finite(item.providerPublishTime);
        return {
          title,
          publisher: text(item.publisher),
          url: link,
          publishedAt: seconds !== null ? new Date(seconds * 1000).toISOString() : null,
        };
      })
      .filter((item): item is StockNewsItem => item !== null)
      .slice(0, limit);
  }
}
