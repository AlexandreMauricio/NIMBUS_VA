import { PortfolioTotals, PositionView, StockPosition, StockQuote } from "./types";

/**
 * Quote currencies that are a hundredth of a major currency: London prices
 * in pence (GBp / GBX), Johannesburg in cents (ZAc), Tel Aviv in agorot
 * (ILA). Exchange rates are only quoted for the major unit.
 */
const MINOR_UNITS: Record<string, { currency: string; divisor: number }> = {
  GBp: { currency: "GBP", divisor: 100 },
  GBX: { currency: "GBP", divisor: 100 },
  ZAc: { currency: "ZAR", divisor: 100 },
  ILA: { currency: "ILS", divisor: 100 },
};

/** The major currency a quote currency belongs to, and how many quote units make one of it. */
export function majorCurrency(currency: string): { currency: string; divisor: number } {
  return MINOR_UNITS[currency] ?? { currency: currency.toUpperCase(), divisor: 1 };
}

/**
 * The estimates derived from one position and its latest quote. Pure — no
 * I/O, no clock beyond the `today` it is handed.
 *
 * Everything market-based is null when there is no quote: a position NIMBUS
 * has never priced shows what the user invested and nothing it would have
 * to guess.
 *
 * "Today's change" is measured from the previous close — except for a
 * position bought today, which was never held at that close, so its change
 * today is simply its gain since purchase.
 */
export function computePosition(
  position: StockPosition,
  quote: StockQuote | null,
  today: string
): PositionView {
  const invested = position.shares * position.averageCost;
  const base = {
    id: position.id,
    symbol: position.symbol,
    shares: position.shares,
    averageCost: position.averageCost,
    purchaseDate: position.purchaseDate ?? null,
    notes: position.notes?.trim() || null,
    invested,
  };

  if (!quote) {
    return {
      ...base,
      companyName: position.companyName?.trim() || position.symbol,
      currency: null,
      quote: null,
      status: "unavailable",
      marketValue: null,
      unrealizedGain: null,
      unrealizedGainPercent: null,
      dayChange: null,
      dayChangePercent: null,
    };
  }

  const marketValue = position.shares * quote.price;
  const unrealizedGain = marketValue - invested;
  const unrealizedGainPercent = invested > 0 ? (unrealizedGain / invested) * 100 : null;
  const boughtToday = position.purchaseDate === today;
  const dayChange = boughtToday
    ? unrealizedGain
    : quote.previousClose !== null
      ? position.shares * (quote.price - quote.previousClose)
      : null;
  const dayChangePercent = boughtToday ? unrealizedGainPercent : quote.changePercent;

  return {
    ...base,
    companyName: position.companyName?.trim() || quote.name || position.symbol,
    currency: quote.currency,
    quote,
    status: quote.outdated ? "outdated" : quote.stale ? "stale" : "live",
    marketValue,
    unrealizedGain,
    unrealizedGainPercent,
    dayChange,
    dayChangePercent,
  };
}

/**
 * Portfolio totals, one entry per currency, largest first. Positions with
 * no price, or only an outdated one, are left out rather than counted. A position whose
 * day change is unknown still counts towards value and gain, just not
 * towards the day's move.
 */
export function computePortfolio(positions: PositionView[]): PortfolioTotals[] {
  const byCurrency = new Map<string, PortfolioTotals & { previousValue: number }>();

  for (const p of positions) {
    if (p.marketValue === null || p.status === "outdated") continue;
    const currency = p.currency ?? "";
    let totals = byCurrency.get(currency);
    if (!totals) {
      totals = {
        currency,
        positions: 0,
        invested: 0,
        marketValue: 0,
        unrealizedGain: 0,
        unrealizedGainPercent: null,
        dayChange: 0,
        dayChangePercent: null,
        previousValue: 0,
      };
      byCurrency.set(currency, totals);
    }
    totals.positions += 1;
    totals.invested += p.invested;
    totals.marketValue += p.marketValue;
    totals.unrealizedGain += p.unrealizedGain ?? 0;
    if (p.dayChange !== null) {
      totals.dayChange += p.dayChange;
      totals.previousValue += p.marketValue - p.dayChange;
    }
  }

  return [...byCurrency.values()]
    .map(({ previousValue, ...totals }) => ({
      ...totals,
      unrealizedGainPercent: totals.invested > 0 ? (totals.unrealizedGain / totals.invested) * 100 : null,
      dayChangePercent: previousValue > 0 ? (totals.dayChange / previousValue) * 100 : null,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

/**
 * One total for the whole portfolio in `base`. `rates` maps each position
 * currency to the base amount for one unit of it; the base currency itself
 * (and its minor unit) needs no entry. A priced position whose currency has
 * no rate is left out and its currency reported — it is never counted at
 * an assumed rate.
 */
export function computeBaseTotals(
  positions: PositionView[],
  base: string,
  rates: ReadonlyMap<string, number>
): { totals: PortfolioTotals | null; unconverted: string[] } {
  const rateFor = (currency: string | null): number | null => {
    if (!currency) return null;
    const known = rates.get(currency);
    if (known !== undefined) return known;
    const major = majorCurrency(currency);
    return major.currency === base ? 1 / major.divisor : null;
  };

  const converted: PositionView[] = [];
  const unconverted = new Set<string>();
  for (const p of positions) {
    if (p.marketValue === null || p.status === "outdated") continue;
    const rate = rateFor(p.currency);
    if (rate === null) {
      unconverted.add(p.currency ?? "");
      continue;
    }
    const scale = (value: number | null) => (value === null ? null : value * rate);
    converted.push({
      ...p,
      currency: base,
      invested: p.invested * rate,
      marketValue: p.marketValue * rate,
      unrealizedGain: scale(p.unrealizedGain),
      dayChange: scale(p.dayChange),
    });
  }

  const [totals] = computePortfolio(converted);
  return { totals: totals ?? null, unconverted: [...unconverted].sort() };
}
