import { normalizeSymbol } from "./types";

/**
 * Dividends for tracked holdings, with tax estimated for a Portugal
 * resident. Pure — no I/O, no clock beyond the `today` it is handed.
 *
 * What the data can and can't say: the market-data source provides each
 * dividend's ex-date and amount per share. It does not provide payment
 * dates or announced future dividends. So "received" means a dividend that
 * went ex while the user held the shares, and "expected" is a projection
 * from the recent pattern — always labelled as an estimate, never
 * presented as announced.
 *
 * Tax model (estimate, not advice):
 *  - The source country withholds `withholdingPercent` of the gross.
 *  - Portugal taxes the gross at the 28% liberatory rate, minus a credit
 *    for the foreign tax — capped at the treaty rate (`creditCapPercent`)
 *    and at the Portuguese tax itself.
 *  - Withholding above the treaty rate is not credited; it can usually be
 *    reclaimed from the source country, and is reported as `reclaimable`.
 */

export interface DividendEvent {
  /** Plain "YYYY-MM-DD" ex-dividend date, in the exchange's time zone. */
  exDate: string;
  /** Per share, in the listing's quote currency. */
  amount: number;
}

export interface DividendSeries {
  currency: string | null;
  /** Oldest first. */
  events: DividendEvent[];
}

/** Portugal's liberatory (flat) rate on dividends, in percent. */
export const PORTUGUESE_DIVIDEND_RATE = 28;

export interface TaxCountry {
  code: string;
  name: string;
  /** The numeric country code the IRS forms use, e.g. "840" for the United States. */
  numericCode: string;
  /** What the source country typically withholds from a Portugal resident, in percent. */
  withholdingPercent: number;
  /** The most Portugal credits against its own tax (the treaty rate), in percent. */
  creditCapPercent: number;
}

/**
 * Typical rates for a Portugal resident. Defaults only — brokers apply
 * treaty forms differently, so the user can pick another country or a
 * custom rate for any holding. Portugal itself withholds its 28% at
 * source, which the model expresses as no foreign tax plus the Portuguese
 * rate.
 */
export const TAX_COUNTRIES: readonly TaxCountry[] = [
  { code: "PT", name: "Portugal", numericCode: "620", withholdingPercent: 0, creditCapPercent: 0 },
  { code: "US", name: "United States", numericCode: "840", withholdingPercent: 15, creditCapPercent: 15 },
  { code: "ES", name: "Spain", numericCode: "724", withholdingPercent: 19, creditCapPercent: 15 },
  { code: "FR", name: "France", numericCode: "250", withholdingPercent: 25, creditCapPercent: 15 },
  { code: "DE", name: "Germany", numericCode: "276", withholdingPercent: 26.375, creditCapPercent: 15 },
  { code: "NL", name: "Netherlands", numericCode: "528", withholdingPercent: 15, creditCapPercent: 10 },
  { code: "IT", name: "Italy", numericCode: "380", withholdingPercent: 26, creditCapPercent: 15 },
  { code: "BE", name: "Belgium", numericCode: "056", withholdingPercent: 30, creditCapPercent: 15 },
  { code: "IE", name: "Ireland", numericCode: "372", withholdingPercent: 25, creditCapPercent: 15 },
  { code: "CH", name: "Switzerland", numericCode: "756", withholdingPercent: 35, creditCapPercent: 15 },
  { code: "GB", name: "United Kingdom", numericCode: "826", withholdingPercent: 0, creditCapPercent: 0 },
  { code: "CA", name: "Canada", numericCode: "124", withholdingPercent: 25, creditCapPercent: 15 },
  { code: "JP", name: "Japan", numericCode: "392", withholdingPercent: 15.315, creditCapPercent: 10 },
  { code: "KR", name: "South Korea", numericCode: "410", withholdingPercent: 22, creditCapPercent: 15 },
  // No double-tax treaty: the credit is limited only by the Portuguese tax.
  { code: "TW", name: "Taiwan", numericCode: "158", withholdingPercent: 21, creditCapPercent: 21 },
  { code: "HK", name: "Hong Kong", numericCode: "344", withholdingPercent: 0, creditCapPercent: 0 },
];

/** A holding's tax country setting value for "I'll enter the rate myself". */
export const CUSTOM_TAX_COUNTRY = "CUSTOM";

/** What the user saved for one holding. */
export interface DividendTaxSetting {
  /** A TAX_COUNTRIES code or CUSTOM_TAX_COUNTRY. */
  country: string;
  /** Only for CUSTOM_TAX_COUNTRY: the foreign withholding, in percent. */
  withholdingPercent?: number;
}

export interface ResolvedTax {
  /** A TAX_COUNTRIES code, CUSTOM_TAX_COUNTRY, or "" when unknown. */
  country: string;
  countryName: string;
  /** True when the country was guessed from the listing rather than chosen by the user. */
  guessed: boolean;
  /** False when the country is unknown: foreign withholding is then taken as 0 and flagged. */
  known: boolean;
  withholdingPercent: number;
  creditCapPercent: number;
  portuguesePercent: number;
}

/**
 * Exchange suffix → country. A guess about the *listing*, which is not
 * always the company's home: ADRs such as TSM trade in New York for a
 * Taiwanese company, and London's international board (.IL) lists GDRs of
 * companies from anywhere — which is why the user can correct it.
 */
const SUFFIX_COUNTRY: Record<string, string> = {
  MC: "ES",
  MA: "ES",
  LS: "PT",
  PA: "FR",
  DE: "DE",
  F: "DE",
  BE: "DE",
  DU: "DE",
  HM: "DE",
  MU: "DE",
  SG: "DE",
  AS: "NL",
  MI: "IT",
  BR: "BE",
  IR: "IE",
  SW: "CH",
  L: "GB",
  TO: "CA",
  V: "CA",
  T: "JP",
  KS: "KR",
  KQ: "KR",
  TW: "TW",
  TWO: "TW",
  HK: "HK",
};

/**
 * Well-known US-listed ADRs of companies from the countries above — the
 * suffix rule would call them all American.
 */
const ADR_COUNTRY: Record<string, string> = {
  TSM: "TW",
  ASML: "NL",
  ING: "NL",
  PHG: "NL",
  SAP: "DE",
  DB: "DE",
  TM: "JP",
  SONY: "JP",
  MUFG: "JP",
  HMC: "JP",
  HSBC: "GB",
  BP: "GB",
  SHEL: "GB",
  UL: "GB",
  AZN: "GB",
  GSK: "GB",
  RIO: "GB",
  DEO: "GB",
  SAN: "ES",
  BBVA: "ES",
  TEF: "ES",
  UBS: "CH",
  NVS: "CH",
  TTE: "FR",
  SNY: "FR",
  E: "IT",
  KB: "KR",
  SHG: "KR",
  PKX: "KR",
};

/** The country a listing suggests, or null when it says nothing about it (e.g. .IL). */
export function guessTaxCountry(symbol: string): string | null {
  if (ADR_COUNTRY[symbol]) return ADR_COUNTRY[symbol];
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return /^[A-Z0-9-]+$/.test(symbol) ? "US" : null;
  return SUFFIX_COUNTRY[symbol.slice(dot + 1)] ?? null;
}

export function resolveTax(symbol: string, setting?: DividendTaxSetting | null): ResolvedTax {
  const portuguesePercent = PORTUGUESE_DIVIDEND_RATE;
  if (setting?.country === CUSTOM_TAX_COUNTRY) {
    const rate = clampPercent(setting.withholdingPercent ?? 0);
    return {
      country: CUSTOM_TAX_COUNTRY,
      countryName: "Custom rate",
      guessed: false,
      known: true,
      withholdingPercent: rate,
      creditCapPercent: rate,
      portuguesePercent,
    };
  }
  const code = setting?.country ?? guessTaxCountry(symbol);
  const country = TAX_COUNTRIES.find((c) => c.code === code);
  if (!country) {
    return {
      country: "",
      countryName: "Unknown",
      guessed: !setting,
      known: false,
      withholdingPercent: 0,
      creditCapPercent: 0,
      portuguesePercent,
    };
  }
  return {
    country: country.code,
    countryName: country.name,
    guessed: !setting,
    known: true,
    withholdingPercent: country.withholdingPercent,
    creditCapPercent: country.creditCapPercent,
    portuguesePercent,
  };
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

export interface DividendAmounts {
  gross: number;
  foreignTax: number;
  portugueseTax: number;
  net: number;
  /** Foreign tax above the treaty rate — not credited in Portugal, usually reclaimable from the source country. */
  reclaimable: number;
}

const ZERO: DividendAmounts = { gross: 0, foreignTax: 0, portugueseTax: 0, net: 0, reclaimable: 0 };

export function taxDividend(gross: number, tax: ResolvedTax): DividendAmounts {
  const foreignTax = (gross * tax.withholdingPercent) / 100;
  const portugueseGross = (gross * tax.portuguesePercent) / 100;
  const capped = (gross * tax.creditCapPercent) / 100;
  const credit = Math.min(foreignTax, capped, portugueseGross);
  const portugueseTax = portugueseGross - credit;
  return {
    gross,
    foreignTax,
    portugueseTax,
    net: gross - foreignTax - portugueseTax,
    reclaimable: Math.max(0, foreignTax - capped),
  };
}

export function sumAmounts(list: DividendAmounts[]): DividendAmounts {
  return list.reduce(
    (sum, a) => ({
      gross: sum.gross + a.gross,
      foreignTax: sum.foreignTax + a.foreignTax,
      portugueseTax: sum.portugueseTax + a.portugueseTax,
      net: sum.net + a.net,
      reclaimable: sum.reclaimable + a.reclaimable,
    }),
    ZERO
  );
}

export function scaleAmounts(a: DividendAmounts, factor: number): DividendAmounts {
  return {
    gross: a.gross * factor,
    foreignTax: a.foreignTax * factor,
    portugueseTax: a.portugueseTax * factor,
    net: a.net * factor,
    reclaimable: a.reclaimable * factor,
  };
}

export type DividendFrequency = "monthly" | "quarterly" | "semiannual" | "annual";

const PER_YEAR: Record<DividendFrequency, number> = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };

export interface ReceivedDividend extends DividendAmounts {
  exDate: string;
  amountPerShare: number;
  /** Shares held before the ex-date — lots bought on or after it don't qualify. */
  shares: number;
}

export interface ExpectedDividend extends DividendAmounts {
  /** Projected ex-date: the last one plus the usual gap. An estimate. */
  exDate: string;
  /** The last amount paid, assumed to repeat. */
  amountPerShare: number;
  shares: number;
}

export interface HoldingDividends {
  symbol: string;
  /** The listing the dividends came from — the alternative symbol when that supplies the price. */
  sourceSymbol: string;
  currency: string | null;
  /** "stale": the latest dividend fetch failed and these are from an earlier one. */
  status: "ok" | "stale";
  tax: ResolvedTax;
  /** Newest first. */
  received: ReceivedDividend[];
  receivedTotal: DividendAmounts;
  thisYear: DividendAmounts;
  frequency: DividendFrequency | null;
  expected: ExpectedDividend | null;
  /** A year of dividends at the last amount and the usual frequency, on the shares held now. */
  estimatedAnnual: DividendAmounts | null;
  /** Lots with no purchase date: they can't be matched to past ex-dates, so they add nothing to `received`. */
  lotsWithoutDate: number;
}

/** How far back the pattern is read from. A little over a year, so an annual payer shows two dividends. */
const PATTERN_WINDOW_DAYS = 400;
/** A projected ex-date this far in the past means the pattern broke; no estimate then. */
const OVERDUE_TOLERANCE_DAYS = 20;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function fromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function frequencyFor(gapDays: number): DividendFrequency {
  if (gapDays < 45) return "monthly";
  if (gapDays < 135) return "quarterly";
  if (gapDays < 270) return "semiannual";
  return "annual";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A lot as dividends see it. A sold lot still earned the dividends that went ex while it was held. */
export interface DividendLot {
  shares: number;
  purchaseDate?: string;
  /** Set for a sold lot: it gets dividends that went ex on or before this date. */
  closeDate?: string;
}

export interface HoldingDividendsInput {
  symbol: string;
  sourceSymbol: string;
  /** Every lot of this holding, open or sold. */
  lots: DividendLot[];
  series: DividendSeries;
  stale: boolean;
  tax: ResolvedTax;
  /** Plain local "YYYY-MM-DD". */
  today: string;
}

export function computeHoldingDividends(input: HoldingDividendsInput): HoldingDividends {
  const { lots, series, tax, today } = input;
  const todayNumber = dayNumber(today);
  const past = series.events
    .filter((e) => e.amount > 0 && e.exDate <= today)
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  const received: ReceivedDividend[] = [];
  for (const event of past) {
    const shares = lots
      .filter(
        (lot) =>
          lot.purchaseDate !== undefined &&
          lot.purchaseDate < event.exDate &&
          (lot.closeDate === undefined || lot.closeDate >= event.exDate)
      )
      .reduce((sum, lot) => sum + lot.shares, 0);
    if (shares <= 0) continue;
    received.push({
      exDate: event.exDate,
      amountPerShare: event.amount,
      shares,
      ...taxDividend(event.amount * shares, tax),
    });
  }
  received.reverse();

  const year = today.slice(0, 4);
  const recent = past.filter((e) => todayNumber - dayNumber(e.exDate) <= PATTERN_WINDOW_DAYS);
  let frequency: DividendFrequency | null = null;
  let expected: ExpectedDividend | null = null;
  let estimatedAnnual: DividendAmounts | null = null;
  const openLots = lots.filter((lot) => lot.closeDate === undefined);
  const totalShares = openLots.reduce((sum, lot) => sum + lot.shares, 0);

  if (recent.length >= 2) {
    const gaps = recent.slice(1).map((e, i) => dayNumber(e.exDate) - dayNumber(recent[i].exDate));
    const gap = Math.round(median(gaps));
    frequency = frequencyFor(gap);
    const last = recent[recent.length - 1];
    const nextDay = dayNumber(last.exDate) + gap;
    if (totalShares > 0 && todayNumber - nextDay <= OVERDUE_TOLERANCE_DAYS) {
      expected = {
        exDate: fromDayNumber(nextDay),
        amountPerShare: last.amount,
        shares: totalShares,
        ...taxDividend(last.amount * totalShares, tax),
      };
    }
    if (totalShares > 0) estimatedAnnual = taxDividend(last.amount * PER_YEAR[frequency] * totalShares, tax);
  }

  return {
    symbol: input.symbol,
    sourceSymbol: input.sourceSymbol,
    currency: series.currency,
    status: input.stale ? "stale" : "ok",
    tax,
    received,
    receivedTotal: sumAmounts(received),
    thisYear: sumAmounts(received.filter((r) => r.exDate.startsWith(year))),
    frequency,
    expected,
    estimatedAnnual,
    lotsWithoutDate: openLots.filter((lot) => lot.purchaseDate === undefined).length,
  };
}

/** Everything the Stocks tab shows about dividends. */
export interface StockDividendsResult {
  status: "ok" | "disabled" | "unavailable";
  retrievedAt: string | null;
  baseCurrency: string;
  holdings: HoldingDividends[];
  /** Holdings whose dividend history couldn't be retrieved. */
  unavailableSymbols: string[];
  /** Every convertible holding summed in the base currency (at today's rate). Null when none converts. */
  base: {
    thisYear: DividendAmounts;
    receivedTotal: DividendAmounts;
    estimatedAnnual: DividendAmounts | null;
    next: { symbol: string; exDate: string; net: number } | null;
  } | null;
  unconvertedCurrencies: string[];
  /** The country table, so the tab can offer it without importing Core. */
  taxCountries: readonly TaxCountry[];
}

const MAX_TAX_SETTINGS = 200;

/** Checks and rebuilds a saved per-symbol tax country map; an error names the first problem. */
export function normalizeDividendTax(value: unknown): {
  settings?: Record<string, DividendTaxSetting>;
  error?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Dividend tax settings must be an object." };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_TAX_SETTINGS) return { error: "Too many dividend tax settings." };
  const settings: Record<string, DividendTaxSetting> = {};
  for (const [key, raw] of entries) {
    const symbol = normalizeSymbol(key);
    if (!symbol) return { error: `"${key}" isn't a symbol.` };
    const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const country = typeof entry.country === "string" ? entry.country : "";
    if (country === CUSTOM_TAX_COUNTRY) {
      const rate = entry.withholdingPercent;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        return { error: "Withholding must be a percentage from 0 to 100." };
      }
      settings[symbol] = { country, withholdingPercent: rate };
    } else if (TAX_COUNTRIES.some((c) => c.code === country)) {
      settings[symbol] = { country };
    } else {
      return { error: `Unknown tax country "${country}".` };
    }
  }
  return { settings };
}
