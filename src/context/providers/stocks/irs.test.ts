import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosedPosition } from "./closed";
import { resolveTax } from "./dividends";
import {
  DEFAULT_IRS_SETTINGS,
  IrsDividendEvent,
  buildIrsDividends,
  buildIrsGains,
  normalizeIrsSettings,
} from "./irs";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

/** 0.9 € per dollar until June, 0.8 after; euros are euros; nothing else is known. */
const rateOn = (currency: string | null, date: string) =>
  currency === "USD" ? (date < "2026-06-01" ? 0.9 : 0.8) : currency === "EUR" ? 1 : null;

function event(overrides: Partial<IrsDividendEvent>): IrsDividendEvent {
  return {
    symbol: "AAPL",
    exDate: "2026-02-10",
    currency: "USD",
    gross: 10,
    foreignTax: 1.5,
    portugueseTax: 1.3,
    country: "US",
    known: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------- dividends

test("foreign dividends are grouped by source country, in euros at each ex-date's rate", () => {
  const section = buildIrsDividends(
    [
      event({}),
      event({ symbol: "MSFT", exDate: "2026-08-10", gross: 20, foreignTax: 3 }),
      event({
        symbol: "REP.MC",
        exDate: "2026-06-30",
        currency: "EUR",
        gross: 5,
        foreignTax: 0.95,
        country: "ES",
      }),
    ],
    rateOn
  );

  assert.equal(section.code, "E11");
  const [us, es] = section.rows;
  assert.equal(us.countryCode, "840");
  close(us.gross, 10 * 0.9 + 20 * 0.8);
  close(us.taxAbroad, 1.5 * 0.9 + 3 * 0.8);
  assert.equal(us.taxPortugal, 0);
  assert.equal(us.dividends, 2);
  assert.deepEqual(us.symbols, ["AAPL", "MSFT"]);
  assert.equal(es.countryCode, "724");
  close(es.gross, 5);
});

test("Portuguese dividends are kept apart; unknown countries and missing rates are reported", () => {
  const section = buildIrsDividends(
    [
      event({ symbol: "EDP.LS", currency: "EUR", country: "PT", foreignTax: 0, portugueseTax: 2.8 }),
      event({ symbol: "SMSN.IL", country: "", known: false }),
      event({ symbol: "005930.KS", currency: "KRW", country: "KR", exDate: "2026-03-01" }),
    ],
    rateOn
  );

  assert.deepEqual(section.rows, []);
  assert.deepEqual(section.domestic, { gross: 10, taxPortugal: 2.8 });
  assert.deepEqual(section.unknownCountrySymbols, ["SMSN.IL"]);
  assert.deepEqual(section.missingRates, ["KRW on 2026-03-01"]);
});

// -------------------------------------------------------------------- gains

function sale(overrides: Partial<ClosedPosition>): ClosedPosition {
  return {
    id: "c1",
    symbol: "AAPL",
    shares: 10,
    averageCost: 100,
    purchaseDate: "2026-01-10",
    closeDate: "2026-07-01",
    closePrice: 150,
    currency: "USD",
    ...overrides,
  };
}

test("each sale is valued at the rate of its own dates, and gains are grouped for Quadro 9.2", () => {
  const section = buildIrsGains(
    [
      sale({ fees: 2 }),
      sale({
        id: "c2",
        symbol: "TSM",
        shares: 1,
        averageCost: 200,
        purchaseDate: "2026-02-01",
        closeDate: "2026-08-01",
        closePrice: 190,
      }),
      sale({
        id: "c3",
        symbol: "REP.MC",
        averageCost: 15,
        closePrice: 20,
        currency: "EUR",
        closeDate: "2026-09-01",
      }),
    ],
    DEFAULT_IRS_SETTINGS,
    (c) => resolveTax(c.symbol),
    rateOn
  );

  const [aapl, tsm, rep] = section.rows;
  close(aapl.acquisitionValue, 1000 * 0.9);
  close(aapl.realizationValue, 1500 * 0.8);
  close(aapl.fees, 2 * 0.8);
  close(aapl.gain, 1200 - 900 - 1.6);
  assert.equal(aapl.sourceCountry, "840");
  close(tsm.gain, 190 * 0.8 - 200 * 0.9);
  assert.equal(tsm.sourceCountry, "158");
  close(rep.gain, 50);

  assert.equal(section.groups.length, 3);
  const us = section.groups.find((g) => g.sourceCountry === "840")!;
  assert.equal(us.code, "G30");
  assert.equal(us.counterpartyCountry, "196");
  assert.equal(us.taxAbroad, 0);
  close(us.gain, 298.4);
});

test("a CFD is valued at its full exposure", () => {
  const section = buildIrsGains(
    [
      sale({
        symbol: "^STOXX50E",
        shares: 2,
        averageCost: 6000,
        closePrice: 6300,
        currency: "EUR",
        leverage: 20,
      }),
    ],
    DEFAULT_IRS_SETTINGS,
    () => resolveTax("X", { country: "DE" }),
    rateOn
  );
  const [row] = section.rows;
  assert.equal(row.leverage, 20);
  close(row.acquisitionValue, 12000);
  close(row.realizationValue, 12600);
  close(row.gain, 600);
});

test("a sale with no rate is left out and reported; an unknown country is flagged", () => {
  const section = buildIrsGains(
    [sale({ currency: "KRW" }), sale({ id: "c2", symbol: "SMSN.IL" })],
    DEFAULT_IRS_SETTINGS,
    (c) => resolveTax(c.symbol),
    rateOn
  );
  assert.deepEqual(section.missingRates, ["KRW on 2026-01-10", "KRW on 2026-07-01"]);
  assert.equal(section.rows.length, 1);
  assert.deepEqual(section.unknownCountrySymbols, ["SMSN.IL"]);
});

test("IRS settings are checked", () => {
  assert.deepEqual(normalizeIrsSettings({ gainsCode: " g30 ", counterpartyCountry: "196" }).settings, {
    gainsCode: "G30",
    counterpartyCountry: "196",
  });
  assert.ok(normalizeIrsSettings({ gainsCode: "G3", counterpartyCountry: "196" }).error);
  assert.ok(normalizeIrsSettings({ gainsCode: "G30", counterpartyCountry: "CY" }).error);
  assert.ok(normalizeIrsSettings(null).error);
});
