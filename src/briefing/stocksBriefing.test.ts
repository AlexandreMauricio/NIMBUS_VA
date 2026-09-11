import { test } from "node:test";
import assert from "node:assert/strict";
import { BriefingGenerator } from "./briefingGenerator";
import { ContextSnapshot } from "../context/types";
import { PortfolioTotals, PositionView, StockContext } from "../context/providers/stocks/types";

const NOW = new Date("2026-09-11T15:00:00Z");

function totals(overrides: Partial<PortfolioTotals> = {}): PortfolioTotals {
  return {
    currency: "USD",
    positions: 1,
    invested: 1000,
    marketValue: 1018,
    unrealizedGain: 18,
    unrealizedGainPercent: 1.8,
    dayChange: 18,
    dayChangePercent: 1.8,
    ...overrides,
  };
}

function positionAt(marketTime: string): PositionView {
  return {
    id: "p1",
    symbol: "AAPL",
    priceSymbol: "AAPL",
    usingAlternative: false,
    companyName: "Apple",
    shares: 10,
    averageCost: 100,
    purchaseDate: null,
    notes: null,
    currency: "USD",
    quote: {
      symbol: "AAPL",
      price: 101.8,
      previousClose: 100,
      currency: "USD",
      exchange: null,
      name: null,
      marketTime,
      instrumentType: null,
      change: 1.8,
      changePercent: 1.8,
      fetchedAt: NOW.toISOString(),
      stale: false,
      outdated: false,
    },
    status: "live",
    invested: 1000,
    marketValue: 1018,
    unrealizedGain: 18,
    unrealizedGainPercent: 1.8,
    dayChange: 18,
    dayChangePercent: 1.8,
  };
}

function snapshotWith(stocks: Partial<StockContext>, status: "ok" | "error" = "ok"): ContextSnapshot {
  const data: StockContext = {
    retrievedAt: NOW.toISOString(),
    positions: [positionAt(new Date(NOW.getTime() - 30 * 60_000).toISOString())],
    totals: [totals()],
    unpricedCount: 0,
    outdatedCount: 0,
    anyStale: false,
    source: "Test",
    baseCurrency: "USD",
    baseTotals: null,
    fxRates: [],
    unconvertedCurrencies: [],
    ...stocks,
  };
  return {
    generatedAt: NOW.toISOString(),
    providers: {
      stocks: {
        providerId: "stocks",
        displayName: "Stocks",
        status,
        data: status === "ok" ? data : null,
        timestamp: NOW.toISOString(),
        stale: false,
      },
    },
  };
}

const stocksLine = (snapshot: ContextSnapshot) =>
  new BriefingGenerator("en-US").generate(snapshot, NOW).items.find((i) => i.category === "stocks")?.message;

test("a rising portfolio today", () => {
  assert.equal(stocksLine(snapshotWith({})), "Your portfolio is up 1.8% today.");
});

test("a falling portfolio today", () => {
  assert.equal(
    stocksLine(snapshotWith({ totals: [totals({ dayChangePercent: -0.64 })] })),
    "Your portfolio is down 0.6% today."
  );
});

test("a tiny move reads as flat", () => {
  assert.equal(
    stocksLine(snapshotWith({ totals: [totals({ dayChangePercent: 0.01 })] })),
    "Your portfolio is flat today."
  );
});

test("prices from an earlier session are described as the last close, not today", () => {
  const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString();
  assert.equal(
    stocksLine(snapshotWith({ positions: [positionAt(threeDaysAgo)] })),
    "Your portfolio was up 1.8% at the last close."
  );
});

test("several currencies are each named, never summed", () => {
  assert.equal(
    stocksLine(
      snapshotWith({
        totals: [totals(), totals({ currency: "EUR", dayChangePercent: -0.4 })],
      })
    ),
    "Your portfolio is up 1.8% in USD and down 0.4% in EUR today."
  );
});

test("stale prices are called out", () => {
  assert.equal(
    stocksLine(snapshotWith({ anyStale: true })),
    "Your portfolio is up 1.8% today. Some prices may be out of date."
  );
});

test("no line without a known day change, or without stock data", () => {
  assert.equal(stocksLine(snapshotWith({ totals: [totals({ dayChangePercent: null })] })), undefined);
  assert.equal(stocksLine(snapshotWith({ totals: [] })), undefined);
  assert.equal(stocksLine(snapshotWith({}, "error")), undefined);
});

test("with a base-currency total, the briefing gives one figure", () => {
  assert.equal(
    stocksLine(
      snapshotWith({
        totals: [totals(), totals({ currency: "EUR", dayChangePercent: -0.4 })],
        baseCurrency: "EUR",
        baseTotals: totals({ currency: "EUR", dayChangePercent: 0.9 }),
      })
    ),
    "Your portfolio is up 0.9% today."
  );
});

test("a base total missing some currencies falls back to naming each currency", () => {
  assert.equal(
    stocksLine(
      snapshotWith({
        totals: [totals(), totals({ currency: "EUR", dayChangePercent: -0.4 })],
        baseCurrency: "EUR",
        baseTotals: totals({ currency: "EUR", dayChangePercent: -0.4 }),
        unconvertedCurrencies: ["USD"],
      })
    ),
    "Your portfolio is up 1.8% in USD and down 0.4% in EUR today."
  );
});
