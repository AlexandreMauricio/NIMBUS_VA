import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_POSITIONS, normalizeSymbol, validateStockPosition, validateStockPositions } from "./types";

const NOW = new Date("2026-09-11T10:00:00Z");

function valid(overrides: Record<string, unknown> = {}) {
  return { id: "p1", symbol: "AAPL", shares: 10, averageCost: 150, purchaseDate: "2024-01-15", ...overrides };
}

test("symbols are uppercased and cover tickers, classes, suffixes, indices and pairs", () => {
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  for (const symbol of ["BRK-B", "ASML.AS", "0700.HK", "^GSPC", "EURUSD=X", "BTC-USD"]) {
    assert.equal(normalizeSymbol(symbol), symbol, symbol);
  }
});

test("anything that isn't a symbol is refused", () => {
  for (const value of ["", "AA PL", "aapl;rm", "A".repeat(25), "../x", 5, null, undefined]) {
    assert.equal(normalizeSymbol(value), null, String(value));
  }
});

test("a well-formed position is accepted, with or without the optional fields", () => {
  assert.equal(validateStockPosition(valid(), NOW).valid, true);
  assert.equal(
    validateStockPosition({ id: "p2", symbol: "MSFT", shares: 0.5, averageCost: 0 }, NOW).valid,
    true
  );
  assert.equal(validateStockPosition(valid({ companyName: "Apple", notes: "long term" }), NOW).valid, true);
});

test("invalid positions are refused with a reason", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no id", { id: "" }],
    ["bad symbol", { symbol: "not a symbol" }],
    ["zero shares", { shares: 0 }],
    ["negative shares", { shares: -1 }],
    ["text shares", { shares: "10" }],
    ["NaN shares", { shares: NaN }],
    ["negative cost", { averageCost: -1 }],
    ["impossible date", { purchaseDate: "2026-02-30" }],
    ["not a date", { purchaseDate: "last spring" }],
    ["future date", { purchaseDate: "2999-01-01" }],
    ["long notes", { notes: "x".repeat(1001) }],
    ["non-text name", { companyName: 42 }],
  ];
  for (const [label, overrides] of cases) {
    const result = validateStockPosition(valid(overrides), NOW);
    assert.equal(result.valid, false, label);
    assert.ok(result.error, label);
  }
  assert.equal(validateStockPosition(null, NOW).valid, false);
});

test("a position list must be a list of unique, valid positions within the cap", () => {
  assert.equal(validateStockPositions([valid(), valid({ id: "p2", symbol: "MSFT" })], NOW).valid, true);
  assert.equal(validateStockPositions("nope", NOW).valid, false);
  assert.equal(validateStockPositions([valid(), valid()], NOW).valid, false, "duplicate ids");
  assert.equal(validateStockPositions([valid(), valid({ id: "p2", shares: -3 })], NOW).valid, false);
  const tooMany = Array.from({ length: MAX_POSITIONS + 1 }, (_, i) => valid({ id: `p${i}` }));
  assert.equal(validateStockPositions(tooMany, NOW).valid, false);
});

test("two lots of the same symbol are allowed", () => {
  assert.equal(validateStockPositions([valid(), valid({ id: "p2" })], NOW).valid, true);
});
