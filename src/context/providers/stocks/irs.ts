import { ClosedPosition } from "./closed";
import { ResolvedTax, TAX_COUNTRIES } from "./dividends";

/**
 * Figures for Anexo J of the Portuguese IRS return. Pure — the rates come
 * in through `rateOn`. A helper for filling in the form, not tax advice:
 * the codes are the user's to choose, and every figure is to be checked
 * against the broker's annual statement.
 *
 *  - Foreign dividends: Quadro 8A, income code E11, one line per source
 *    country, with gross income, tax paid abroad and tax withheld in
 *    Portugal. Portuguese dividends are not declared there.
 *  - Positions closed in the year: Quadro 9.2, one line per income code,
 *    source country and counterparty (broker) country, with the gain or
 *    loss as gross income — plus the per-sale detail behind it.
 *
 * Euro amounts use the rate of each amount's own date (acquisition,
 * realization, dividend), as the IRS asks.
 */

export interface IrsSettings {
  /** Income code for gains on closed positions, e.g. "G30". */
  gainsCode: string;
  /** Numeric country code of the broker (the counterparty), e.g. "196" for Cyprus. */
  counterpartyCountry: string;
}

export const DEFAULT_IRS_SETTINGS: IrsSettings = { gainsCode: "G30", counterpartyCountry: "196" };
export const DIVIDEND_INCOME_CODE = "E11";

/** Euros for one unit of `currency` on `date` ("YYYY-MM-DD"), or null when no rate is known. */
export type RateOn = (currency: string | null, date: string) => number | null;

export interface IrsDividendEvent {
  symbol: string;
  exDate: string;
  currency: string | null;
  /** In the dividend's currency. */
  gross: number;
  foreignTax: number;
  portugueseTax: number;
  /** A TAX_COUNTRIES code, CUSTOM or "". */
  country: string;
  known: boolean;
}

export interface IrsDividendRow {
  countryCode: string;
  countryName: string;
  gross: number;
  taxAbroad: number;
  taxPortugal: number;
  dividends: number;
  symbols: string[];
}

export interface IrsDividendSection {
  code: string;
  rows: IrsDividendRow[];
  /** Dividends from Portuguese companies: taxed at source, not declared in Anexo J. */
  domestic: { gross: number; taxPortugal: number } | null;
  /** Symbols left out because their country (or its code) isn't known. */
  unknownCountrySymbols: string[];
  /** "USD on 2026-02-10" for every amount that had no rate. */
  missingRates: string[];
}

export interface IrsGainRow {
  id: string;
  symbol: string;
  companyName: string | null;
  leverage: number;
  shares: number;
  currency: string;
  acquisitionDate: string;
  /** Euros: shares × average cost at the acquisition date's rate (the full exposure for a CFD). */
  acquisitionValue: number;
  realizationDate: string;
  realizationValue: number;
  fees: number;
  gain: number;
  sourceCountry: string | null;
  sourceCountryName: string;
}

export interface IrsGainGroup {
  code: string;
  sourceCountry: string | null;
  sourceCountryName: string;
  counterpartyCountry: string;
  /** The gross income line: the net gain or loss of the group. */
  gain: number;
  /** Tax paid abroad on gains — none is modelled, so 0. */
  taxAbroad: number;
  positions: number;
}

export interface IrsGainSection {
  code: string;
  counterpartyCountry: string;
  rows: IrsGainRow[];
  groups: IrsGainGroup[];
  unknownCountrySymbols: string[];
  missingRates: string[];
}

export interface IrsReport {
  year: number;
  settings: IrsSettings;
  dividends: IrsDividendSection;
  gains: IrsGainSection;
  /** Symbols whose dividend history couldn't be retrieved. */
  unavailableSymbols: string[];
  /** Years worth offering in the year picker, newest first. */
  availableYears: number[];
}

function countryFor(code: string): { numericCode: string; name: string } | null {
  const country = TAX_COUNTRIES.find((c) => c.code === code);
  return country ? { numericCode: country.numericCode, name: country.name } : null;
}

export function buildIrsDividends(events: IrsDividendEvent[], rateOn: RateOn): IrsDividendSection {
  const rows = new Map<string, IrsDividendRow>();
  let domesticGross = 0;
  let domesticTax = 0;
  let domesticCount = 0;
  const unknown = new Set<string>();
  const missing = new Set<string>();

  for (const e of events) {
    const country = e.known ? countryFor(e.country) : null;
    if (!country) {
      unknown.add(e.symbol);
      continue;
    }
    const rate = rateOn(e.currency, e.exDate);
    if (rate === null) {
      missing.add(`${e.currency ?? "unknown currency"} on ${e.exDate}`);
      continue;
    }
    if (e.country === "PT") {
      domesticGross += e.gross * rate;
      domesticTax += e.portugueseTax * rate;
      domesticCount += 1;
      continue;
    }
    let row = rows.get(country.numericCode);
    if (!row) {
      row = {
        countryCode: country.numericCode,
        countryName: country.name,
        gross: 0,
        taxAbroad: 0,
        // Foreign dividends at a foreign broker: nothing is withheld in Portugal.
        taxPortugal: 0,
        dividends: 0,
        symbols: [],
      };
      rows.set(country.numericCode, row);
    }
    row.gross += e.gross * rate;
    row.taxAbroad += e.foreignTax * rate;
    row.dividends += 1;
    if (!row.symbols.includes(e.symbol)) row.symbols.push(e.symbol);
  }

  return {
    code: DIVIDEND_INCOME_CODE,
    rows: [...rows.values()].sort((a, b) => b.gross - a.gross),
    domestic: domesticCount > 0 ? { gross: domesticGross, taxPortugal: domesticTax } : null,
    unknownCountrySymbols: [...unknown].sort(),
    missingRates: [...missing].sort(),
  };
}

export function buildIrsGains(
  closed: ClosedPosition[],
  settings: IrsSettings,
  taxFor: (position: ClosedPosition) => ResolvedTax,
  rateOn: RateOn
): IrsGainSection {
  const rows: IrsGainRow[] = [];
  const unknown = new Set<string>();
  const missing = new Set<string>();

  for (const c of [...closed].sort((a, b) => a.closeDate.localeCompare(b.closeDate))) {
    const buyRate = rateOn(c.currency, c.purchaseDate);
    const sellRate = rateOn(c.currency, c.closeDate);
    if (buyRate === null) missing.add(`${c.currency} on ${c.purchaseDate}`);
    if (sellRate === null) missing.add(`${c.currency} on ${c.closeDate}`);
    if (buyRate === null || sellRate === null) continue;

    const tax = taxFor(c);
    const country = tax.known ? countryFor(tax.country) : null;
    if (!country) unknown.add(c.symbol);
    const acquisitionValue = c.shares * c.averageCost * buyRate;
    const realizationValue = c.shares * c.closePrice * sellRate;
    const fees = (c.fees ?? 0) * sellRate;
    rows.push({
      id: c.id,
      symbol: c.symbol,
      companyName: c.companyName ?? null,
      leverage: c.leverage && c.leverage > 1 ? c.leverage : 1,
      shares: c.shares,
      currency: c.currency,
      acquisitionDate: c.purchaseDate,
      acquisitionValue,
      realizationDate: c.closeDate,
      realizationValue,
      fees,
      gain: realizationValue - acquisitionValue - fees,
      sourceCountry: country?.numericCode ?? null,
      sourceCountryName: country?.name ?? "Unknown",
    });
  }

  const groups = new Map<string, IrsGainGroup>();
  for (const row of rows) {
    const key = `${settings.gainsCode}|${row.sourceCountry ?? "?"}|${settings.counterpartyCountry}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        code: settings.gainsCode,
        sourceCountry: row.sourceCountry,
        sourceCountryName: row.sourceCountryName,
        counterpartyCountry: settings.counterpartyCountry,
        gain: 0,
        taxAbroad: 0,
        positions: 0,
      };
      groups.set(key, group);
    }
    group.gain += row.gain;
    group.positions += 1;
  }

  return {
    code: settings.gainsCode,
    counterpartyCountry: settings.counterpartyCountry,
    rows,
    groups: [...groups.values()],
    unknownCountrySymbols: [...unknown].sort(),
    missingRates: [...missing].sort(),
  };
}

/** Checks the user's income code and broker country code. */
export function normalizeIrsSettings(value: unknown): { settings?: IrsSettings; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "IRS settings must be an object." };
  }
  const v = value as Record<string, unknown>;
  const gainsCode = typeof v.gainsCode === "string" ? v.gainsCode.trim().toUpperCase() : "";
  const counterpartyCountry = typeof v.counterpartyCountry === "string" ? v.counterpartyCountry.trim() : "";
  if (!/^[A-Z]\d{2}$/.test(gainsCode)) return { error: "The income code must look like G30." };
  if (!/^\d{3}$/.test(counterpartyCountry)) {
    return { error: "The country code must be three digits, like 196." };
  }
  return { settings: { gainsCode, counterpartyCountry } };
}
