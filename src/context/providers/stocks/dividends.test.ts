import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_TAX_COUNTRY,
  DividendSeries,
  HoldingDividendsInput,
  computeHoldingDividends,
  guessTaxCountry,
  normalizeDividendTax,
  resolveTax,
  taxDividend,
} from "./dividends";
import { StockPosition } from "./types";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

// --------------------------------------------------------------- countries

test("the tax country is guessed from the listing, with known ADRs and unknown GDRs", () => {
  assert.equal(guessTaxCountry("REP.MC"), "ES");
  assert.equal(guessTaxCountry("AAPL"), "US");
  assert.equal(guessTaxCountry("BRK-B"), "US");
  assert.equal(guessTaxCountry("TSM"), "TW");
  assert.equal(guessTaxCountry("005930.KS"), "KR");
  assert.equal(guessTaxCountry("BP.L"), "GB");
  assert.equal(guessTaxCountry("SMSN.IL"), null);
});

test("a saved country or custom rate replaces the guess; an unknown country is flagged", () => {
  assert.deepEqual([resolveTax("TSM").country, resolveTax("TSM").guessed], ["TW", true]);
  const chosen = resolveTax("TSM", { country: "US" });
  assert.equal(chosen.country, "US");
  assert.equal(chosen.guessed, false);

  const custom = resolveTax("X", { country: CUSTOM_TAX_COUNTRY, withholdingPercent: 12 });
  assert.equal(custom.withholdingPercent, 12);
  assert.equal(custom.creditCapPercent, 12);

  const unknown = resolveTax("SMSN.IL");
  assert.equal(unknown.known, false);
  assert.equal(unknown.withholdingPercent, 0);
});

// --------------------------------------------------------------------- tax

test("US: 15% withheld is fully credited, so the total tax is Portugal's 28%", () => {
  const t = taxDividend(100, resolveTax("AAPL"));
  close(t.foreignTax, 15);
  close(t.portugueseTax, 13);
  close(t.net, 72);
  close(t.reclaimable, 0);
});

test("Spain: 19% withheld, only the 15% treaty rate is credited — the rest is reclaimable", () => {
  const t = taxDividend(100, resolveTax("REP.MC"));
  close(t.foreignTax, 19);
  close(t.portugueseTax, 13);
  close(t.net, 68);
  close(t.reclaimable, 4);
});

test("Switzerland: 35% withheld, credit capped at 15%", () => {
  const t = taxDividend(100, resolveTax("NESN.SW"));
  close(t.foreignTax, 35);
  close(t.portugueseTax, 13);
  close(t.net, 52);
  close(t.reclaimable, 20);
});

test("Portugal and the UK: nothing foreign, Portugal's 28%", () => {
  close(taxDividend(100, resolveTax("EDP.LS")).net, 72);
  close(taxDividend(100, resolveTax("BP.L")).net, 72);
});

test("the credit never exceeds the Portuguese tax", () => {
  const t = taxDividend(100, resolveTax("X", { country: CUSTOM_TAX_COUNTRY, withholdingPercent: 40 }));
  close(t.foreignTax, 40);
  close(t.portugueseTax, 0);
  close(t.net, 60);
});

// --------------------------------------------------------------- dividends

const TSM: DividendSeries = {
  currency: "USD",
  events: [
    { exDate: "2025-09-16", amount: 0.822 },
    { exDate: "2025-12-11", amount: 0.835 },
    { exDate: "2026-03-17", amount: 0.956 },
    { exDate: "2026-06-11", amount: 0.955 },
  ],
};

const LOTS: StockPosition[] = [
  { id: "a", symbol: "TSM", shares: 10, averageCost: 100, purchaseDate: "2025-10-01" },
  { id: "b", symbol: "TSM", shares: 5, averageCost: 200, purchaseDate: "2026-04-01" },
  { id: "c", symbol: "TSM", shares: 2, averageCost: 300 },
];

function tsm(today: string, lots: HoldingDividendsInput["lots"] = LOTS) {
  return computeHoldingDividends({
    symbol: "TSM",
    sourceSymbol: "TSM",
    lots,
    series: TSM,
    stale: false,
    tax: resolveTax("TSM"),
    today,
  });
}

test("each ex-date counts the lots bought before it; undated lots are reported, not guessed", () => {
  const d = tsm("2026-09-11");

  assert.deepEqual(
    d.received.map((r) => [r.exDate, r.shares]),
    [
      ["2026-06-11", 15],
      ["2026-03-17", 10],
      ["2025-12-11", 10],
    ]
  );
  close(d.received[0].gross, 0.955 * 15);
  close(d.thisYear.gross, 0.955 * 15 + 0.956 * 10);
  assert.equal(d.lotsWithoutDate, 1);
});

test("a lot bought on the ex-date doesn't get that dividend", () => {
  const d = tsm("2026-09-11", [{ shares: 1, purchaseDate: "2026-06-11" }]);
  assert.equal(d.received.length, 0);
});

test("the next dividend is projected from the usual gap, at the last amount, on every share", () => {
  const d = tsm("2026-09-01");

  assert.equal(d.frequency, "quarterly");
  // Gaps 86, 96, 86 days → median 86 → 11 Jun + 86 days.
  assert.equal(d.expected?.exDate, "2026-09-05");
  assert.equal(d.expected?.amountPerShare, 0.955);
  assert.equal(d.expected?.shares, 17);
  close(d.estimatedAnnual!.gross, 0.955 * 4 * 17);
});

test("no projection once the pattern is well overdue, or with too little history", () => {
  assert.equal(tsm("2026-11-01").expected, null);
  const single = computeHoldingDividends({
    symbol: "X",
    sourceSymbol: "X",
    lots: LOTS,
    series: { currency: "USD", events: [{ exDate: "2026-06-11", amount: 1 }] },
    stale: false,
    tax: resolveTax("X"),
    today: "2026-09-11",
  });
  assert.equal(single.expected, null);
  assert.equal(single.estimatedAnnual, null);
});

// ---------------------------------------------------------------- settings

test("tax settings are checked and rebuilt", () => {
  assert.deepEqual(normalizeDividendTax({ tsm: { country: "TW", extra: 1 } }).settings, {
    TSM: { country: "TW" },
  });
  assert.deepEqual(
    normalizeDividendTax({ X: { country: CUSTOM_TAX_COUNTRY, withholdingPercent: 12 } }).settings,
    { X: { country: CUSTOM_TAX_COUNTRY, withholdingPercent: 12 } }
  );
  assert.ok(normalizeDividendTax({ X: { country: "Narnia" } }).error);
  assert.ok(normalizeDividendTax({ X: { country: CUSTOM_TAX_COUNTRY, withholdingPercent: 140 } }).error);
  assert.ok(normalizeDividendTax({ "not a symbol": { country: "US" } }).error);
  assert.ok(normalizeDividendTax([]).error);
});

test("a sold lot keeps the dividends that went ex while it was held, and adds nothing ahead", () => {
  const d = tsm("2026-09-11", [{ shares: 10, purchaseDate: "2025-10-01", closeDate: "2026-06-11" }]);
  assert.deepEqual(
    d.received.map((r) => r.exDate),
    ["2026-06-11", "2026-03-17", "2025-12-11"]
  );
  assert.equal(d.expected, null);
  assert.equal(d.estimatedAnnual, null);

  const soldBefore = tsm("2026-09-11", [{ shares: 10, purchaseDate: "2025-10-01", closeDate: "2026-06-10" }]);
  assert.equal(soldBefore.received.length, 2);
});
