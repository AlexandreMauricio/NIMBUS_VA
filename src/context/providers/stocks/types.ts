import type { DividendSeries, DividendTaxSetting } from "./dividends";

/**
 * Stock tracking — read-only market information for positions the user
 * enters by hand.
 *
 * There is deliberately nothing here about trading: no orders, no
 * brokerage account, no way to open, change or close a position anywhere.
 * A position is a note the user keeps ("I own 10 AAPL at $150"), and every
 * figure derived from it is an *estimate* built from that note and the
 * latest market price NIMBUS could retrieve.
 */

/** One holding, as the user entered it. */
export interface StockPosition {
  id: string;
  /** Market symbol as the data source knows it, e.g. "AAPL", "ASML.AS", "BRK-B". Stored uppercase. */
  symbol: string;
  /**
   * Optional second listing of the same company, used for the price only
   * when `symbol` has none or only an outdated one (a retired ticker).
   * Stored uppercase.
   */
  alternativeSymbol?: string;
  /**
   * For a leveraged position such as a CFD: 20 means ×20. Absent (or 1) is a
   * plain holding. With leverage, `shares` are the units and `averageCost`
   * the open price; what was invested is the margin, units × open ÷ leverage.
   */
  leverage?: number;
  /** Optional display name; the market data's company name is used when absent. */
  companyName?: string;
  shares: number;
  /** Average cost per share, in the same currency the symbol trades in. */
  averageCost: number;
  /** Plain "YYYY-MM-DD". Optional — people don't always remember. */
  purchaseDate?: string;
  notes?: string;
}

/** What StockProvider needs from settings — structurally matches `StockPreferences` in settingsSchema.ts. */
export interface StockProviderConfig {
  enabled: boolean;
  newsEnabled: boolean;
  /** ISO 4217 code every position is converted into for the single portfolio total, e.g. "EUR". */
  baseCurrency: string;
  /** Dividends are fetched unless this is false. */
  dividendsEnabled?: boolean;
  /** Per-symbol tax country choices; a symbol not listed uses the country guessed from its listing. */
  dividendTax?: Record<string, DividendTaxSetting>;
  positions: StockPosition[];
}

/** A quote as a market-data source returns it, before any position maths. */
export interface RawQuote {
  symbol: string;
  price: number;
  /** The previous session's close — what "today's change" is measured against. Null when the source doesn't say. */
  previousClose: number | null;
  currency: string | null;
  exchange: string | null;
  /** Company or instrument name, when the source provides one. */
  name: string | null;
  /** ISO instant of the price — tells "today" apart from "at the last close". */
  marketTime: string | null;
  instrumentType: string | null;
}

export interface StockQuote extends RawQuote {
  change: number | null;
  changePercent: number | null;
  /** When NIMBUS retrieved this quote. */
  fetchedAt: string;
  /** True when the latest fetch failed and this is the last quote that succeeded. */
  stale: boolean;
  /**
   * True when the price itself is more than OUTDATED_AFTER_DAYS old even
   * though the fetch worked — the listing has most likely stopped trading
   * (a retired ticker), so the price says nothing about today.
   */
  outdated: boolean;
}

/** A price older than this is treated as a listing that no longer trades. Long enough to cover market holidays. */
export const OUTDATED_AFTER_DAYS = 7;

export type QuoteStatus = "live" | "stale" | "outdated" | "unavailable";

/** A position with the estimates derived from it. Every market-based figure is null when there is no price. */
export interface PositionView {
  id: string;
  symbol: string;
  /** The symbol the price actually came from: `symbol`, or the alternative when that took over. */
  priceSymbol: string;
  usingAlternative: boolean;
  /** 1 for a plain holding; e.g. 20 for a ×20 CFD. */
  leverage: number;
  /** shares × current price — the market exposure. For a leveraged position it is larger than the value. */
  exposure: number | null;
  companyName: string;
  shares: number;
  averageCost: number;
  purchaseDate: string | null;
  notes: string | null;
  currency: string | null;
  quote: StockQuote | null;
  status: QuoteStatus;
  /** shares × average cost. */
  invested: number;
  /** shares × current price. */
  marketValue: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  /** Change in the position's value since the previous close (or since purchase, if bought today). */
  dayChange: number | null;
  dayChangePercent: number | null;
}

/**
 * Portfolio totals for one currency. The per-currency totals only ever sum
 * positions that trade in that currency; the base-currency total
 * (StockContext.baseTotals) sums everything after converting it at a
 * retrieved exchange rate — never an assumed one.
 */
export interface PortfolioTotals {
  currency: string;
  /** Positions with a price that contributed to these totals. */
  positions: number;
  invested: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedGainPercent: number | null;
  dayChange: number;
  dayChangePercent: number | null;
}

/**
 * Every lot of one symbol added together — what the list shows as one
 * row. Market figures are null unless every lot is priced.
 */
export interface HoldingView {
  symbol: string;
  priceSymbol: string;
  usingAlternative: boolean;
  /** True when any lot is leveraged (a CFD). */
  leveraged: boolean;
  companyName: string;
  currency: string | null;
  quote: StockQuote | null;
  status: QuoteStatus;
  /** The lots, in the order they were entered. */
  lotIds: string[];
  shares: number;
  /** The average cost (or open price) weighted by each lot's shares. */
  averageCost: number;
  invested: number;
  marketValue: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
}

export interface StockContext {
  retrievedAt: string;
  positions: PositionView[];
  /** The positions grouped by symbol. */
  holdings: HoldingView[];
  totals: PortfolioTotals[];
  /** Positions with no price at all (never retrieved successfully). They are excluded from totals. */
  unpricedCount: number;
  /** Positions whose only price is outdated (a listing that stopped trading). Also excluded from totals. */
  outdatedCount: number;
  /** True when any figure is based on a quote from an earlier, successful fetch. */
  anyStale: boolean;
  /** Where the prices came from, for attribution in the UI. */
  source: string;
  /** The currency baseTotals are expressed in. */
  baseCurrency: string;
  /**
   * Every priced position converted into baseCurrency and summed. Null when
   * no position could be converted. Invested amounts are converted at the
   * current rate too (NIMBUS has no historical rates), so the gain shown
   * here excludes currency moves since purchase.
   */
  baseTotals: PortfolioTotals | null;
  /** The rates used for baseTotals, one per position currency other than the base. */
  fxRates: FxRate[];
  /** Position currencies with no retrieved rate: those positions are left out of baseTotals. "" = unknown currency. */
  unconvertedCurrencies: string[];
}

/** One conversion into the base currency, as retrieved. */
export interface FxRate {
  /** The position currency, as the quote reports it — may be a minor unit such as "GBp". */
  currency: string;
  /** Base-currency amount for 1 unit of `currency` (minor units already divided out). */
  rate: number;
  /** The market pair the rate came from, e.g. "USDEUR=X". */
  pair: string;
  /** True when the latest fetch of the pair failed and this is the last rate that succeeded. */
  stale: boolean;
  marketTime: string | null;
}

export interface StockNewsItem {
  title: string;
  publisher: string | null;
  /** Link to the article page — never the article itself. */
  url: string;
  publishedAt: string | null;
}

export interface StockNewsResult {
  symbol: string;
  status: "ok" | "stale" | "unavailable" | "disabled";
  items: StockNewsItem[];
  retrievedAt: string | null;
}

/** A listing a search found for a company, before it is priced. */
export interface ListingMatch {
  symbol: string;
  name: string | null;
  exchange: string | null;
}

/** A listing that still trades, offered in place of an outdated symbol. */
export interface ListingCandidate extends ListingMatch {
  currency: string | null;
  price: number;
  marketTime: string | null;
}

export interface ListingSearchResult {
  symbol: string;
  /** "not-needed" when the symbol's price is current; "unavailable" when nothing could be searched or priced. */
  status: "ok" | "not-needed" | "unavailable";
  candidates: ListingCandidate[];
}

/** The narrow interface a market-data vendor implements. Nothing above it knows which vendor that is. */
export interface MarketDataSource {
  /** Human-readable source name, shown as attribution. */
  readonly name: string;
  /** Rejects when the symbol is unknown or the source is unreachable — never returns an invented price. */
  fetchQuote(symbol: string): Promise<RawQuote>;
  /** Other listings for a company name. Optional — without it, outdated symbols get no suggestions. */
  searchListings?(query: string, limit: number): Promise<ListingMatch[]>;
  /** Ex-dividend dates and amounts from `fromDate` ("YYYY-MM-DD"). Optional — without it, no dividends are shown. */
  fetchDividends?(symbol: string, fromDate: string): Promise<DividendSeries>;
}

export interface NewsSource {
  /** `companyName`, when known, focuses the search on the company rather than the ticker string. */
  fetchNews(symbol: string, limit: number, companyName?: string | null): Promise<StockNewsItem[]>;
}

const CORPORATE_SUFFIX =
  /[\s,]+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|s\.?a|s\.?p\.?a|n\.?v|b\.?v|ag|se|ab|asa|oyj|kgaa|llc|lp|holdings?|group)\.?$/i;

/**
 * A company name without its legal form, for searching and matching:
 * "Repsol, S.A." → "Repsol", "Samsung Electronics Co., Ltd." → "Samsung
 * Electronics", "Apple Inc." → "Apple". Null when nothing usable is left.
 */
export function companySearchName(name: string | null | undefined): string | null {
  if (!name) return null;
  let text = name.trim();
  for (;;) {
    const next = text.replace(CORPORATE_SUFFIX, "").replace(/[\s,.]+$/, "");
    if (next === text || next.length === 0) break;
    text = next;
  }
  return text.length >= 2 ? text : null;
}

export const MAX_POSITIONS = 50;
const MAX_NOTES_LENGTH = 1000;
const MAX_NAME_LENGTH = 100;

/**
 * A symbol in the form market-data sources use, uppercased, or null. Covers
 * ordinary tickers (AAPL), share classes (BRK-B), exchange suffixes
 * (ASML.AS, 0700.HK), indices (^GSPC) and currency pairs (EURUSD=X).
 */
export function normalizeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.=^-]{0,19}$/.test(symbol) ? symbol : null;
}

/**
 * eToro's names for indices, mapped to the symbols the market-data source
 * knows. Used only as the fallback price symbol when the entered symbol
 * itself has no price — an alternative symbol the user didn't have to
 * type. Commodities and crypto are left out on purpose: their eToro names
 * (GOLD, BTC…) are also real tickers of unrelated shares.
 */
export const KNOWN_ALIASES: Readonly<Record<string, string>> = {
  EUSTX50: "^STOXX50E",
  SPX500: "^GSPC",
  NSDQ100: "^NDX",
  DJ30: "^DJI",
  GER40: "^GDAXI",
  UK100: "^FTSE",
  FRA40: "^FCHI",
  JPN225: "^N225",
  ESP35: "^IBEX",
  HKG50: "^HSI",
};

/** An ISO 4217-style three-letter code, uppercased, or null. */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export interface StockValidationResult {
  valid: boolean;
  error?: string;
}

function isPlainDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Checks one position before it is saved. `now` only decides what counts
 * as "the future" for the purchase date (with a day's slack, since the
 * date is a plain local date).
 */
export function validateStockPosition(value: unknown, now: Date = new Date()): StockValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "A position must be an object." };
  }
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.trim().length === 0 || p.id.length > 64) {
    return { valid: false, error: "A position needs an id." };
  }
  if (!normalizeSymbol(p.symbol)) {
    return { valid: false, error: "Symbol must be a ticker such as AAPL, BRK-B or ASML.AS." };
  }
  if (p.alternativeSymbol !== undefined) {
    const alternative = normalizeSymbol(p.alternativeSymbol);
    if (!alternative) {
      return { valid: false, error: "Alternative symbol must be a ticker such as SMSN.IL." };
    }
    if (alternative === normalizeSymbol(p.symbol)) {
      return { valid: false, error: "The alternative symbol must be different from the symbol." };
    }
  }
  if (
    p.leverage !== undefined &&
    (typeof p.leverage !== "number" || !Number.isFinite(p.leverage) || p.leverage < 1 || p.leverage > 100)
  ) {
    return { valid: false, error: "Leverage must be a number from 1 to 100." };
  }
  if (typeof p.shares !== "number" || !Number.isFinite(p.shares) || p.shares <= 0 || p.shares > 1e12) {
    return { valid: false, error: "Shares must be a number greater than 0." };
  }
  if (
    typeof p.averageCost !== "number" ||
    !Number.isFinite(p.averageCost) ||
    p.averageCost < 0 ||
    p.averageCost > 1e12
  ) {
    return { valid: false, error: "Average cost must be a number of 0 or more." };
  }
  if (
    p.companyName !== undefined &&
    (typeof p.companyName !== "string" || p.companyName.length > MAX_NAME_LENGTH)
  ) {
    return { valid: false, error: `Company name must be text of at most ${MAX_NAME_LENGTH} characters.` };
  }
  if (p.purchaseDate !== undefined) {
    if (typeof p.purchaseDate !== "string" || !isPlainDate(p.purchaseDate)) {
      return { valid: false, error: "Purchase date must be a real date (YYYY-MM-DD)." };
    }
    if (Date.parse(`${p.purchaseDate}T00:00:00Z`) > now.getTime() + 24 * 60 * 60 * 1000) {
      return { valid: false, error: "Purchase date can't be in the future." };
    }
  }
  if (p.notes !== undefined && (typeof p.notes !== "string" || p.notes.length > MAX_NOTES_LENGTH)) {
    return { valid: false, error: `Notes must be text of at most ${MAX_NOTES_LENGTH} characters.` };
  }
  return { valid: true };
}

/** Checks a whole position list: at most MAX_POSITIONS, each valid, ids unique. */
export function validateStockPositions(value: unknown, now: Date = new Date()): StockValidationResult {
  if (!Array.isArray(value)) return { valid: false, error: "Positions must be a list." };
  if (value.length > MAX_POSITIONS)
    return { valid: false, error: `At most ${MAX_POSITIONS} positions can be tracked.` };
  const ids = new Set<string>();
  for (const position of value) {
    const result = validateStockPosition(position, now);
    if (!result.valid) return result;
    const id = (position as StockPosition).id;
    if (ids.has(id)) return { valid: false, error: `Duplicate position id "${id}".` };
    ids.add(id);
  }
  return { valid: true };
}
