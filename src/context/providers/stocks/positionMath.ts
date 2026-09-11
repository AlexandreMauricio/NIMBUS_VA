import { HoldingView, PortfolioTotals, PositionView, StockPosition, StockQuote } from "./types";

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
  today: string,
  /** The symbol `quote` belongs to — the position's alternative symbol when that supplied the price. */
  priceSymbol: string = position.symbol
): PositionView {
  const leverage = position.leverage && position.leverage > 1 ? position.leverage : 1;
  // With leverage only the margin was paid: units × open price ÷ leverage.
  const invested = (position.shares * position.averageCost) / leverage;
  const base = {
    id: position.id,
    symbol: position.symbol,
    priceSymbol,
    usingAlternative: priceSymbol !== position.symbol,
    leverage,
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
      exposure: null,
      status: "unavailable",
      marketValue: null,
      unrealizedGain: null,
      unrealizedGainPercent: null,
      dayChange: null,
      dayChangePercent: null,
    };
  }

  const exposure = position.shares * quote.price;
  // A leveraged position is worth its margin plus the profit or loss on the full exposure.
  const marketValue =
    leverage === 1 ? exposure : invested + position.shares * (quote.price - position.averageCost);
  const unrealizedGain = marketValue - invested;
  const unrealizedGainPercent = invested > 0 ? (unrealizedGain / invested) * 100 : null;
  const boughtToday = position.purchaseDate === today;
  const dayChange = boughtToday
    ? unrealizedGain
    : quote.previousClose !== null
      ? position.shares * (quote.price - quote.previousClose)
      : null;
  // Leveraged, the day's move is measured on the position's value, not on the price.
  const dayChangePercent = boughtToday
    ? unrealizedGainPercent
    : leverage === 1
      ? quote.changePercent
      : dayChange !== null && marketValue - dayChange > 0
        ? (dayChange / (marketValue - dayChange)) * 100
        : null;

  return {
    ...base,
    companyName: position.companyName?.trim() || quote.name || position.symbol,
    currency: quote.currency,
    quote,
    exposure,
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

/** Lots grouped by symbol, in the order each symbol first appears. */
export function computeHoldings(positions: PositionView[]): HoldingView[] {
  const bySymbol = new Map<string, PositionView[]>();
  for (const p of positions) {
    const lots = bySymbol.get(p.symbol);
    if (lots) lots.push(p);
    else bySymbol.set(p.symbol, [p]);
  }

  return [...bySymbol.values()].map((lots) => {
    const first = lots.find((l) => l.quote !== null) ?? lots[0];
    const shares = lots.reduce((sum, l) => sum + l.shares, 0);
    const invested = lots.reduce((sum, l) => sum + l.invested, 0);
    const priced = lots.every((l) => l.marketValue !== null);
    const marketValue = priced ? lots.reduce((sum, l) => sum + l.marketValue!, 0) : null;
    const unrealizedGain = marketValue === null ? null : marketValue - invested;
    const dayKnown = priced && lots.every((l) => l.dayChange !== null);
    const dayChange = dayKnown ? lots.reduce((sum, l) => sum + l.dayChange!, 0) : null;
    const previousValue = marketValue !== null && dayChange !== null ? marketValue - dayChange : 0;
    return {
      symbol: first.symbol,
      priceSymbol: first.priceSymbol,
      usingAlternative: first.usingAlternative,
      leveraged: lots.some((l) => l.leverage > 1),
      companyName: first.companyName,
      currency: first.currency,
      quote: first.quote,
      status: first.status,
      lotIds: lots.map((l) => l.id),
      shares,
      averageCost: shares > 0 ? lots.reduce((sum, l) => sum + l.shares * l.averageCost, 0) / shares : 0,
      invested,
      marketValue,
      unrealizedGain,
      unrealizedGainPercent:
        unrealizedGain !== null && invested > 0 ? (unrealizedGain / invested) * 100 : null,
      dayChange,
      dayChangePercent: dayChange !== null && previousValue > 0 ? (dayChange / previousValue) * 100 : null,
    };
  });
}
