import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBaseTotals,
  computeHoldings,
  computePortfolio,
  computePosition,
  majorCurrency,
} from "./positionMath";
import { StockPosition, StockQuote } from "./types";

const TODAY = "2026-09-11";

function quote(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol: "AAPL",
    price: 150,
    previousClose: 140,
    currency: "USD",
    exchange: "NasdaqGS",
    name: "Apple Inc.",
    marketTime: "2026-09-10T20:00:00.000Z",
    instrumentType: "EQUITY",
    change: 10,
    changePercent: (10 / 140) * 100,
    fetchedAt: "2026-09-11T08:00:00.000Z",
    stale: false,
    outdated: false,
    ...overrides,
  };
}

function position(overrides: Partial<StockPosition> = {}): StockPosition {
  return { id: "p1", symbol: "AAPL", shares: 10, averageCost: 100, purchaseDate: "2024-01-15", ...overrides };
}

const close = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

// ---------------------------------------------------------------- positions

test("a position's invested, value, gain and today's change", () => {
  const view = computePosition(position(), quote(), TODAY);

  assert.equal(view.invested, 1000);
  assert.equal(view.marketValue, 1500);
  assert.equal(view.unrealizedGain, 500);
  assert.equal(view.unrealizedGainPercent, 50);
  assert.equal(view.dayChange, 100);
  close(view.dayChangePercent, (10 / 140) * 100);
  assert.equal(view.status, "live");
  assert.equal(view.currency, "USD");
});

test("a losing position reports a negative gain", () => {
  const view = computePosition(position({ averageCost: 200 }), quote(), TODAY);

  assert.equal(view.unrealizedGain, -500);
  assert.equal(view.unrealizedGainPercent, -25);
});

test("a zero cost basis gives no percentage rather than infinity", () => {
  const view = computePosition(position({ averageCost: 0 }), quote(), TODAY);

  assert.equal(view.unrealizedGain, 1500);
  assert.equal(view.unrealizedGainPercent, null);
});

test("without a previous close, today's change is unknown — not zero", () => {
  const view = computePosition(
    position(),
    quote({ previousClose: null, change: null, changePercent: null }),
    TODAY
  );

  assert.equal(view.dayChange, null);
  assert.equal(view.dayChangePercent, null);
  assert.equal(view.marketValue, 1500, "the value is still known");
});

test("with no quote, nothing market-based is invented", () => {
  const view = computePosition(position(), null, TODAY);

  assert.equal(view.status, "unavailable");
  assert.equal(view.invested, 1000);
  for (const field of [
    "marketValue",
    "unrealizedGain",
    "unrealizedGainPercent",
    "dayChange",
    "dayChangePercent",
  ] as const) {
    assert.equal(view[field], null, field);
  }
  assert.equal(view.companyName, "AAPL");
});

test("a stale quote still produces figures, marked stale", () => {
  const view = computePosition(position(), quote({ stale: true }), TODAY);

  assert.equal(view.status, "stale");
  assert.equal(view.marketValue, 1500);
});

test("a position bought today changes from its purchase price, not yesterday's close", () => {
  const view = computePosition(position({ purchaseDate: TODAY, averageCost: 148 }), quote(), TODAY);

  assert.equal(view.dayChange, 20, "10 shares × (150 − 148)");
  close(view.dayChangePercent, (20 / 1480) * 100);
});

test("the company name comes from the user, then the market data, then the symbol", () => {
  assert.equal(
    computePosition(position({ companyName: "My Apple" }), quote(), TODAY).companyName,
    "My Apple"
  );
  assert.equal(computePosition(position(), quote(), TODAY).companyName, "Apple Inc.");
  assert.equal(computePosition(position(), quote({ name: null }), TODAY).companyName, "AAPL");
});

// ---------------------------------------------------------------- portfolio

test("portfolio totals sum positions and measure the day against the previous value", () => {
  const views = [
    computePosition(position(), quote(), TODAY),
    computePosition(
      position({ id: "p2", symbol: "MSFT", shares: 5, averageCost: 300 }),
      quote({ symbol: "MSFT", price: 400, previousClose: 410 }),
      TODAY
    ),
  ];

  const [usd] = computePortfolio(views);

  assert.equal(usd.currency, "USD");
  assert.equal(usd.positions, 2);
  assert.equal(usd.invested, 2500);
  assert.equal(usd.marketValue, 3500);
  assert.equal(usd.unrealizedGain, 1000);
  assert.equal(usd.unrealizedGainPercent, 40);
  assert.equal(usd.dayChange, 100 - 50);
  close(usd.dayChangePercent, (50 / (3500 - 50)) * 100);
});

test("currencies are never mixed, and unpriced positions are left out", () => {
  const views = [
    computePosition(position(), quote(), TODAY),
    computePosition(
      position({ id: "p2", symbol: "ASML.AS", shares: 2, averageCost: 600 }),
      quote({ symbol: "ASML.AS", price: 700, previousClose: 690, currency: "EUR" }),
      TODAY
    ),
    computePosition(position({ id: "p3", symbol: "XYZ" }), null, TODAY),
  ];

  const totals = computePortfolio(views);

  assert.deepEqual(
    totals.map((t) => [t.currency, t.positions, t.marketValue]),
    [
      ["USD", 1, 1500],
      ["EUR", 1, 1400],
    ]
  );
});

test("a position with an unknown day change still counts towards value", () => {
  const views = [
    computePosition(position(), quote(), TODAY),
    computePosition(
      position({ id: "p2", symbol: "NEW" }),
      quote({ symbol: "NEW", price: 20, previousClose: null, change: null, changePercent: null }),
      TODAY
    ),
  ];

  const [usd] = computePortfolio(views);

  assert.equal(usd.marketValue, 1700);
  assert.equal(usd.dayChange, 100);
  close(usd.dayChangePercent, (100 / 1400) * 100);
});

test("an empty or wholly unpriced portfolio has no totals", () => {
  assert.deepEqual(computePortfolio([]), []);
  assert.deepEqual(computePortfolio([computePosition(position(), null, TODAY)]), []);
});

// ------------------------------------------------------------ base currency

test("minor currency units map to their major currency", () => {
  assert.deepEqual(majorCurrency("GBp"), { currency: "GBP", divisor: 100 });
  assert.deepEqual(majorCurrency("GBX"), { currency: "GBP", divisor: 100 });
  assert.deepEqual(majorCurrency("ZAc"), { currency: "ZAR", divisor: 100 });
  assert.deepEqual(majorCurrency("USD"), { currency: "USD", divisor: 1 });
});

test("the base total converts every figure, including today's change", () => {
  const usd = computePosition(position(), quote(), TODAY); // 1500 USD value, +100 today
  const eur = computePosition(
    position({ id: "p2", symbol: "REP.MC", averageCost: 15 }),
    quote({ symbol: "REP.MC", price: 20, previousClose: 20, change: 0, changePercent: 0, currency: "EUR" }),
    TODAY
  );

  const { totals, unconverted } = computeBaseTotals([usd, eur], "EUR", new Map([["USD", 0.5]]));

  assert.deepEqual(unconverted, []);
  assert.equal(totals?.currency, "EUR");
  assert.equal(totals?.positions, 2);
  close(totals!.marketValue, 750 + 200);
  close(totals!.invested, 500 + 150);
  close(totals!.unrealizedGain, 250 + 50);
  close(totals!.dayChange, 50);
  close(totals!.dayChangePercent, (50 / 900) * 100);
});

test("a currency with no rate is left out and reported; unpriced positions are ignored", () => {
  const usd = computePosition(position(), quote(), TODAY);
  const unpriced = computePosition(position({ id: "p3" }), null, TODAY);

  const { totals, unconverted } = computeBaseTotals([usd, unpriced], "EUR", new Map());

  assert.equal(totals, null);
  assert.deepEqual(unconverted, ["USD"]);
});

test("a base-currency minor unit converts without a rate", () => {
  const pence = computePosition(
    position({ symbol: "BP.L", averageCost: 400 }),
    quote({ price: 500, currency: "GBp" }),
    TODAY
  );
  const { totals } = computeBaseTotals([pence], "GBP", new Map());
  close(totals!.marketValue, 50);
});

test("a position whose price is outdated is left out of every total", () => {
  const live = computePosition(position(), quote(), TODAY);
  const old = computePosition(position({ id: "p2" }), quote({ outdated: true }), TODAY);

  assert.equal(old.status, "outdated");
  assert.equal(computePortfolio([live, old])[0].positions, 1);
  assert.equal(computeBaseTotals([live, old], "USD", new Map()).totals?.positions, 1);
});

test("the price symbol defaults to the position's own, and records an alternative", () => {
  const own = computePosition(position(), quote(), TODAY);
  assert.equal(own.priceSymbol, "AAPL");
  assert.equal(own.usingAlternative, false);

  const alt = computePosition(position({ alternativeSymbol: "AAPL.MX" }), quote(), TODAY, "AAPL.MX");
  assert.equal(alt.priceSymbol, "AAPL.MX");
  assert.equal(alt.usingAlternative, true);
});

// ----------------------------------------------------------------- holdings

test("lots of the same symbol combine into one holding", () => {
  const a = computePosition(position({ id: "a", shares: 10, averageCost: 100 }), quote(), TODAY);
  const b = computePosition(position({ id: "b", shares: 5, averageCost: 130 }), quote(), TODAY);
  const other = computePosition(position({ id: "c", symbol: "MSFT" }), quote({ symbol: "MSFT" }), TODAY);

  const [aapl, msft] = computeHoldings([a, b, other]);

  assert.deepEqual(aapl.lotIds, ["a", "b"]);
  assert.equal(aapl.shares, 15);
  assert.equal(aapl.invested, 1650);
  close(aapl.averageCost, 110);
  assert.equal(aapl.marketValue, 2250);
  assert.equal(aapl.unrealizedGain, 600);
  close(aapl.unrealizedGainPercent, (600 / 1650) * 100);
  assert.equal(aapl.dayChange, 150);
  close(aapl.dayChangePercent, (150 / 2100) * 100);
  assert.deepEqual(msft.lotIds, ["c"]);
});

test("a holding with an unpriced lot shows no market figures rather than a partial sum", () => {
  const a = computePosition(position({ id: "a" }), quote(), TODAY);
  const b = computePosition(position({ id: "b" }), null, TODAY);

  const [holding] = computeHoldings([a, b]);

  assert.equal(holding.marketValue, null);
  assert.equal(holding.unrealizedGain, null);
  assert.equal(holding.dayChange, null);
  assert.equal(holding.invested, 2000);
});

// ---------------------------------------------------------------- leverage

const INDEX = quote({
  symbol: "^STOXX50E",
  price: 6300,
  previousClose: 6200,
  change: 100,
  changePercent: (100 / 6200) * 100,
});

test("a ×20 CFD: invested is the margin, value is margin plus P/L, the return is on the margin", () => {
  const view = computePosition(
    position({ symbol: "^STOXX50E", shares: 2, averageCost: 6000, leverage: 20 }),
    INDEX,
    TODAY
  );

  assert.equal(view.leverage, 20);
  assert.equal(view.invested, 600);
  assert.equal(view.exposure, 12600);
  assert.equal(view.unrealizedGain, 600);
  assert.equal(view.marketValue, 1200);
  assert.equal(view.unrealizedGainPercent, 100);
  assert.equal(view.dayChange, 200);
  close(view.dayChangePercent, (200 / 1000) * 100);
});

test("a plain holding is leverage 1 with its exposure equal to its value", () => {
  const view = computePosition(position(), quote(), TODAY);
  assert.equal(view.leverage, 1);
  assert.equal(view.exposure, view.marketValue);
});

test("leveraged lots add their margins, and the holding's average is of the open prices", () => {
  const a = computePosition(position({ id: "a", shares: 2, averageCost: 6000, leverage: 20 }), INDEX, TODAY);
  const b = computePosition(position({ id: "b", shares: 1, averageCost: 6300, leverage: 20 }), INDEX, TODAY);

  const [holding] = computeHoldings([a, b]);

  assert.equal(holding.leveraged, true);
  assert.equal(holding.invested, 600 + 315);
  assert.equal(holding.averageCost, 6100);
  assert.equal(holding.marketValue, 1200 + 315);
});
