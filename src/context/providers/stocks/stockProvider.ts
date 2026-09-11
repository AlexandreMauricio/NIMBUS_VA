import { ContextProvider } from "../../types";
import { logger } from "../../../logging/logger";
import { localCalendarDate, localTimeZone } from "../calendar/icsTimeUtils";
import { computeBaseTotals, computePortfolio, computePosition, majorCurrency } from "./positionMath";
import { YahooMarketDataSource, YahooNewsSource } from "./yahooFinance";
import {
  FxRate,
  ListingCandidate,
  ListingSearchResult,
  MarketDataSource,
  OUTDATED_AFTER_DAYS,
  NewsSource,
  RawQuote,
  StockContext,
  StockNewsItem,
  StockNewsResult,
  StockPosition,
  StockProviderConfig,
  StockQuote,
  companySearchName,
  normalizeCurrencyCode,
  normalizeSymbol,
  validateStockPosition,
} from "./types";

/** How long a quote is reused before the symbol is asked for again — failures included, so a broken symbol isn't retried on every read. */
const QUOTE_TTL_MS = 2 * 60 * 1000;
/** News changes slowly next to prices, and each symbol is a separate request. */
const NEWS_TTL_MS = 30 * 60 * 1000;
/** A failed news request isn't retried more often than this. */
const NEWS_RETRY_MS = 60 * 1000;
/** The Refresh button can bypass the quote cache at most this often. */
const MIN_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_NEWS_ITEMS = 5;
/** Symbols fetched at once, so a long list doesn't burst the source. */
const FETCH_CONCURRENCY = 4;
/** Listing suggestions for an outdated symbol change rarely; each search costs several requests. */
const LISTINGS_TTL_MS = 30 * 60 * 1000;
const MAX_LISTING_CANDIDATES = 3;
const OUTDATED_AFTER_MS = OUTDATED_AFTER_DAYS * 24 * 60 * 60 * 1000;
/** Used when settings carry no valid base currency. */
const DEFAULT_BASE_CURRENCY = "EUR";

interface QuoteEntry {
  /** The last quote that succeeded, if any — marked stale when a later fetch failed. */
  quote: StockQuote | null;
  attemptedAtMs: number;
}

/**
 * Context provider for the user's stock positions. Implements the same
 * ContextProvider contract as every other provider, so the snapshot, the
 * Context tab and the briefing treat it like the rest.
 *
 * Quotes are cached per symbol rather than as one whole context: editing a
 * position re-computes the estimates from the current settings at once,
 * and a newly added symbol is fetched without refetching the others.
 *
 * Failure, symbol by symbol: a symbol whose fetch fails keeps its last
 * good quote, marked stale; one never priced stays unavailable — there is
 * no path that invents a price. Only when no position has any price at all
 * does getContext() reject, which ContextService turns into its standard
 * error/stale result.
 *
 * Exchange rates for the base-currency total are market pairs too
 * ("USDEUR=X"), so they go through the same quote cache, TTL and
 * stale-on-failure handling as prices. A currency with no rate is left out
 * of the base total and named, never converted at a guessed rate.
 *
 * News is not part of the context. It is fetched on demand for one symbol
 * (getNews), cached separately, and its failure never touches prices.
 */
export class StockProvider implements ContextProvider<StockContext> {
  readonly id = "stocks";
  readonly displayName = "Stocks";

  private readonly quotes = new Map<string, QuoteEntry>();
  private readonly news = new Map<
    string,
    { items: StockNewsItem[]; fetchedAtMs: number; retrievedAt: string }
  >();
  private readonly newsFailures = new Map<string, number>();
  private readonly listings = new Map<string, { result: ListingSearchResult; fetchedAtMs: number }>();
  private inFlight: Promise<StockContext> | null = null;
  private lastForcedRefreshMs = -Infinity;

  constructor(
    private readonly getSettings: () => StockProviderConfig,
    private readonly marketData: MarketDataSource = new YahooMarketDataSource(),
    private readonly newsSource: NewsSource = new YahooNewsSource(),
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: () => string = localTimeZone
  ) {}

  isAvailable(): boolean {
    const settings = this.getSettings();
    return settings.enabled && this.validPositions(settings).length > 0;
  }

  /** Concurrent reads share one build, so several windows asking at once cost one round of requests. */
  getContext(): Promise<StockContext> {
    if (!this.inFlight) {
      this.inFlight = this.build().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Makes the next read fetch every symbol again, unless the last forced
   * refresh was under MIN_REFRESH_INTERVAL_MS ago. Returns whether it did —
   * a user mashing Refresh gets the cached figures, not a burst of requests.
   */
  refresh(): boolean {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastForcedRefreshMs < MIN_REFRESH_INTERVAL_MS) return false;
    this.lastForcedRefreshMs = nowMs;
    for (const entry of this.quotes.values()) entry.attemptedAtMs = -Infinity;
    return true;
  }

  /** Recent headlines for one tracked symbol. Never throws; a failure is a status, not an error. */
  async getNews(symbol: string): Promise<StockNewsResult> {
    const settings = this.getSettings();
    if (!settings.newsEnabled) return { symbol, status: "disabled", items: [], retrievedAt: null };

    const nowMs = this.now().getTime();
    const cached = this.news.get(symbol);
    if (cached && nowMs - cached.fetchedAtMs < NEWS_TTL_MS) {
      return { symbol, status: "ok", items: cached.items, retrievedAt: cached.retrievedAt };
    }
    const lastFailure = this.newsFailures.get(symbol);
    if (lastFailure !== undefined && nowMs - lastFailure < NEWS_RETRY_MS) {
      return this.newsFallback(symbol, cached);
    }

    const companyName =
      this.quotes.get(symbol)?.quote?.name ??
      settings.positions.find((p) => p.symbol === symbol)?.companyName ??
      null;
    try {
      const items = await this.newsSource.fetchNews(symbol, MAX_NEWS_ITEMS, companyName);
      const retrievedAt = this.now().toISOString();
      this.news.set(symbol, { items, fetchedAtMs: nowMs, retrievedAt });
      this.newsFailures.delete(symbol);
      return { symbol, status: "ok", items, retrievedAt };
    } catch (err) {
      logger.warn(`Stock news for ${symbol} failed`, { error: String(err) });
      this.newsFailures.set(symbol, nowMs);
      return this.newsFallback(symbol, cached);
    }
  }

  /**
   * Listings of the same company that still trade, for a tracked symbol
   * whose price is outdated (e.g. SMSN.L, retired, → SMSN.IL). Only ever a
   * suggestion: the user decides whether to switch. Never throws.
   */
  async findListings(symbol: string): Promise<ListingSearchResult> {
    const nowMs = this.now().getTime();
    const quote = this.quotes.get(symbol)?.quote ?? null;
    if (quote && !this.isOutdated(quote, nowMs)) return { symbol, status: "not-needed", candidates: [] };

    const cached = this.listings.get(symbol);
    if (cached && nowMs - cached.fetchedAtMs < LISTINGS_TTL_MS) return cached.result;

    const settingsName = this.getSettings().positions.find((p) => p.symbol === symbol)?.companyName;
    const query = companySearchName(quote?.name ?? settingsName);
    if (!query || !this.marketData.searchListings) return { symbol, status: "unavailable", candidates: [] };

    let result: ListingSearchResult;
    try {
      const matches = (await this.marketData.searchListings(query, 8))
        .filter((m) => m.symbol !== symbol)
        .slice(0, MAX_LISTING_CANDIDATES + 2);
      await this.fetchDue(
        matches.map((m) => m.symbol),
        nowMs
      );
      const candidates: ListingCandidate[] = [];
      for (const match of matches) {
        const q = this.quotes.get(match.symbol)?.quote;
        if (!q || q.stale || this.isOutdated(q, nowMs)) continue;
        candidates.push({
          ...match,
          name: match.name ?? q.name,
          exchange: q.exchange ?? match.exchange,
          currency: q.currency,
          price: q.price,
          marketTime: q.marketTime,
        });
      }
      // The same currency first: the user's average cost is in it.
      const sameCurrency = (c: ListingCandidate) => (quote && c.currency === quote.currency ? 0 : 1);
      candidates.sort((a, b) => sameCurrency(a) - sameCurrency(b));
      result = {
        symbol,
        status: candidates.length > 0 ? "ok" : "unavailable",
        candidates: candidates.slice(0, MAX_LISTING_CANDIDATES),
      };
    } catch (err) {
      logger.warn(`Listing search for ${symbol} failed`, { error: String(err) });
      return { symbol, status: "unavailable", candidates: [] };
    }
    this.listings.set(symbol, { result, fetchedAtMs: nowMs });
    return result;
  }

  private isOutdated(quote: StockQuote, nowMs: number): boolean {
    if (!quote.marketTime) return false;
    return nowMs - Date.parse(quote.marketTime) > OUTDATED_AFTER_MS;
  }

  private newsFallback(
    symbol: string,
    cached: { items: StockNewsItem[]; retrievedAt: string } | undefined
  ): StockNewsResult {
    return cached
      ? { symbol, status: "stale", items: cached.items, retrievedAt: cached.retrievedAt }
      : { symbol, status: "unavailable", items: [], retrievedAt: null };
  }

  /** Positions that pass validation, symbols normalized. A hand-edited bad entry is skipped, not fatal. */
  private validPositions(settings: StockProviderConfig): StockPosition[] {
    const positions = Array.isArray(settings.positions) ? settings.positions : [];
    return positions
      .filter((p) => validateStockPosition(p, this.now()).valid)
      .map((p) => ({
        ...p,
        symbol: normalizeSymbol(p.symbol)!,
        alternativeSymbol: p.alternativeSymbol ? normalizeSymbol(p.alternativeSymbol)! : undefined,
      }));
  }

  private async build(): Promise<StockContext> {
    const settings = this.getSettings();
    const positions = this.validPositions(settings);
    if (positions.length === 0) throw new Error("No stock positions are configured");
    const base = normalizeCurrencyCode(settings.baseCurrency) ?? DEFAULT_BASE_CURRENCY;

    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const nowMs = this.now().getTime();
    await this.fetchDue(symbols, nowMs);

    // Age is judged at read time: a quote cached as current becomes outdated once the listing stops trading.
    const quoteFor = (symbol: string): StockQuote | null => {
      const quote = this.quotes.get(symbol)?.quote ?? null;
      return quote ? { ...quote, outdated: this.isOutdated(quote, nowMs) } : null;
    };

    // A position whose own symbol has no current price takes it from its
    // alternative symbol, if it has one. Alternatives are only fetched then.
    const needsAlternative = (p: StockPosition): boolean => {
      const own = quoteFor(p.symbol);
      return Boolean(p.alternativeSymbol) && (!own || own.outdated);
    };
    await this.fetchDue(
      [...new Set(positions.filter(needsAlternative).map((p) => p.alternativeSymbol!))],
      nowMs
    );
    const chosen = positions.map((p) => {
      if (needsAlternative(p)) {
        const alternative = quoteFor(p.alternativeSymbol!);
        if (alternative && !alternative.outdated)
          return { p, symbol: p.alternativeSymbol!, quote: alternative };
      }
      return { p, symbol: p.symbol, quote: quoteFor(p.symbol) };
    });
    if (chosen.every((c) => c.quote === null)) {
      throw new Error("Market data is unavailable for every tracked symbol");
    }

    const today = localCalendarDate(this.now().toISOString(), this.timeZone());
    const views = chosen.map((c) => computePosition(c.p, c.quote, today, c.symbol));

    // One pair per position currency that isn't already the base.
    const pairs = new Map<string, { pair: string; divisor: number }>();
    for (const v of views) {
      if (v.marketValue === null || !v.currency || pairs.has(v.currency)) continue;
      const major = majorCurrency(v.currency);
      if (major.currency === base || !/^[A-Z]{3}$/.test(major.currency)) continue;
      pairs.set(v.currency, { pair: `${major.currency}${base}=X`, divisor: major.divisor });
    }
    await this.fetchDue([...new Set([...pairs.values()].map((p) => p.pair))], nowMs);

    const fxRates: FxRate[] = [];
    for (const [currency, { pair, divisor }] of pairs) {
      const quote = quoteFor(pair);
      if (!quote || !(quote.price > 0) || quote.outdated) continue;
      fxRates.push({
        currency,
        rate: quote.price / divisor,
        pair,
        stale: quote.stale,
        marketTime: quote.marketTime,
      });
    }
    const baseResult = computeBaseTotals(views, base, new Map(fxRates.map((r) => [r.currency, r.rate])));

    return {
      retrievedAt: this.now().toISOString(),
      positions: views,
      totals: computePortfolio(views),
      unpricedCount: views.filter((v) => v.status === "unavailable").length,
      outdatedCount: views.filter((v) => v.status === "outdated").length,
      anyStale: views.some((v) => v.status === "stale"),
      source: this.marketData.name,
      baseCurrency: base,
      baseTotals: baseResult.totals,
      fxRates,
      unconvertedCurrencies: baseResult.unconverted,
    };
  }

  /** Fetches the symbols whose cached entry is older than the TTL, a few at a time. */
  private async fetchDue(symbols: string[], nowMs: number): Promise<void> {
    const due = symbols.filter((s) => {
      const entry = this.quotes.get(s);
      return !entry || nowMs - entry.attemptedAtMs >= QUOTE_TTL_MS;
    });
    for (let i = 0; i < due.length; i += FETCH_CONCURRENCY) {
      const batch = due.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((s) => this.marketData.fetchQuote(s)));
      results.forEach((result, j) => this.recordQuote(batch[j], result, nowMs));
    }
  }

  private recordQuote(symbol: string, result: PromiseSettledResult<RawQuote>, nowMs: number): void {
    const previous = this.quotes.get(symbol)?.quote ?? null;
    if (result.status === "fulfilled") {
      const raw = result.value;
      const change = raw.previousClose !== null ? raw.price - raw.previousClose : null;
      this.quotes.set(symbol, {
        quote: {
          ...raw,
          symbol,
          change,
          changePercent:
            change !== null && raw.previousClose !== null && raw.previousClose !== 0
              ? (change / raw.previousClose) * 100
              : null,
          fetchedAt: new Date(nowMs).toISOString(),
          stale: false,
          outdated: false,
        },
        attemptedAtMs: nowMs,
      });
      return;
    }
    logger.warn(`Stock quote for ${symbol} failed`, { error: String(result.reason) });
    this.quotes.set(symbol, { quote: previous ? { ...previous, stale: true } : null, attemptedAtMs: nowMs });
  }
}
