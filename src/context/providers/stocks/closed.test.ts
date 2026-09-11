import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloseRequest,
  ClosedPosition,
  closeLot,
  validateClosedPosition,
  validateClosedPositions,
} from "./closed";
import { StockPosition } from "./types";

const NOW = new Date("2026-09-11T10:00:00Z");
const LOT: StockPosition = {
  id: "p1",
  symbol: "AAPL",
  shares: 10,
  averageCost: 100,
  purchaseDate: "2026-01-10",
  notes: "long",
};

function request(overrides: Partial<CloseRequest> = {}): CloseRequest {
  return {
    positionId: "p1",
    shares: 10,
    closeDate: "2026-09-01",
    closePrice: 150,
    currency: "USD",
    ...overrides,
  };
}

function ok(result: ReturnType<typeof closeLot>): { positions: StockPosition[]; closed: ClosedPosition } {
  if ("error" in result) assert.fail(result.error);
  return result;
}

test("closing every share moves the lot to the closed list", () => {
  const { positions, closed } = ok(closeLot([LOT], request(), "c1", NOW));

  assert.deepEqual(positions, []);
  assert.deepEqual(closed, {
    id: "c1",
    symbol: "AAPL",
    shares: 10,
    averageCost: 100,
    purchaseDate: "2026-01-10",
    closeDate: "2026-09-01",
    closePrice: 150,
    currency: "USD",
    notes: "long",
  });
});

test("closing part of a lot leaves the rest open with the same cost and date", () => {
  const other: StockPosition = { id: "p2", symbol: "MSFT", shares: 1, averageCost: 1 };
  const { positions, closed } = ok(closeLot([LOT, other], request({ shares: 4, fees: 2 }), "c1", NOW));

  assert.deepEqual(positions, [{ ...LOT, shares: 6 }, other]);
  assert.equal(closed.shares, 4);
  assert.equal(closed.fees, 2);
});

test("leverage, alternative symbol and the company name travel with the sale", () => {
  const cfd: StockPosition = {
    id: "p1",
    symbol: "EUSTX50",
    alternativeSymbol: "^STOXX50E",
    leverage: 20,
    shares: 2,
    averageCost: 6000,
    purchaseDate: "2026-08-01",
  };
  const { closed } = ok(
    closeLot([cfd], request({ shares: 2, currency: "EUR", companyName: "EURO STOXX 50" }), "c1", NOW)
  );

  assert.equal(closed.leverage, 20);
  assert.equal(closed.alternativeSymbol, "^STOXX50E");
  assert.equal(closed.companyName, "EURO STOXX 50");
});

test("a close that can't be right is refused with a reason", () => {
  const cases: Array<[string, StockPosition[], Partial<CloseRequest>]> = [
    ["unknown lot", [LOT], { positionId: "nope" }],
    ["more shares than held", [LOT], { shares: 11 }],
    ["no shares", [LOT], { shares: 0 }],
    ["not a number", [LOT], { shares: Number.NaN }],
    ["no purchase date", [{ ...LOT, purchaseDate: undefined }], {}],
    ["closed before bought", [LOT], { closeDate: "2025-12-31" }],
    ["closed in the future", [LOT], { closeDate: "2027-01-01" }],
    ["bad currency", [LOT], { currency: "US" }],
    ["negative price", [LOT], { closePrice: -1 }],
    ["negative fees", [LOT], { fees: -1 }],
  ];
  for (const [label, positions, overrides] of cases) {
    const result = closeLot(positions, request(overrides), "c1", NOW);
    assert.ok("error" in result, label);
  }
});

test("closed lists are checked like position lists", () => {
  const closed = ok(closeLot([LOT], request(), "c1", NOW)).closed;
  assert.equal(validateClosedPosition(closed, NOW).valid, true);
  assert.equal(validateClosedPositions([closed, { ...closed, id: "c2" }], NOW).valid, true);
  assert.equal(validateClosedPositions([closed, closed], NOW).valid, false, "duplicate ids");
  assert.equal(validateClosedPosition({ ...closed, purchaseDate: undefined }, NOW).valid, false);
  assert.equal(validateClosedPositions("nope", NOW).valid, false);
});
