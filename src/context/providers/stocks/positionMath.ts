import { PortfolioTotals, PositionView, StockPosition, StockQuote } from "./types";

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
    status: quote.stale ? "stale" : "live",
    marketValue,
    unrealizedGain,
    unrealizedGainPercent,
    dayChange,
    dayChangePercent,
  };
}

/**
 * Portfolio totals, one entry per currency, largest first. Positions with
 * no price are left out rather than counted as zero. A position whose
 * day change is unknown still counts towards value and gain, just not
 * towards the day's move.
 */
export function computePortfolio(positions: PositionView[]): PortfolioTotals[] {
  const byCurrency = new Map<string, PortfolioTotals & { previousValue: number }>();

  for (const p of positions) {
    if (p.marketValue === null) continue;
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
