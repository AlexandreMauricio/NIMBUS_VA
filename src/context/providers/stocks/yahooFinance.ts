import { httpTimeoutSignal } from "../../../common/timeout";
import { MarketDataSource, NewsSource, RawQuote, StockNewsItem } from "./types";

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
}

/**
 * Recent headlines for a symbol: title, publisher, time and a link — never
 * article text. Items tagged with other tickers only are dropped, so a
 * symbol's list is about that symbol where the source says so.
 */
export class YahooNewsSource implements NewsSource {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetchNews(symbol: string, limit: number): Promise<StockNewsItem[]> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", symbol);
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
        if (!Array.isArray(item.relatedTickers)) return true;
        return item.relatedTickers.some(
          (t) => typeof t === "string" && t.toUpperCase() === symbol.toUpperCase()
        );
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
