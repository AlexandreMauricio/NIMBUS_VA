import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../contextService";
import { DateTimeProvider } from "../dateTimeProvider";
import { SystemInfoProvider } from "../systemInfoProvider";
import { BriefingGenerator } from "../../../briefing/briefingGenerator";
import { StockProvider } from "./stockProvider";
import { MarketDataSource, RawQuote, StockProviderConfig } from "./types";

/**
 * Stocks inside the real Context aggregator and briefing: a stock failure
 * must never cost the other providers or the briefing anything, and a
 * working one must reach the briefing only through its context.
 */

const settings: StockProviderConfig = {
  enabled: true,
  newsEnabled: false,
  baseCurrency: "USD",
  positions: [{ id: "p1", symbol: "AAPL", shares: 10, averageCost: 100 }],
};

function market(
  price: number | null,
  previousClose: number | null,
  marketTime: string | null
): MarketDataSource {
  return {
    name: "Fake",
    async fetchQuote(symbol: string): Promise<RawQuote> {
      if (price === null) throw new Error("market down");
      return {
        symbol,
        price,
        previousClose,
        currency: "USD",
        exchange: null,
        name: null,
        marketTime,
        instrumentType: null,
      };
    },
  };
}

function service(stocks: StockProvider): ContextService {
  const s = new ContextService();
  s.register(new DateTimeProvider());
  s.register(new SystemInfoProvider());
  s.register(stocks);
  return s;
}

test("a failing stock provider leaves every other provider untouched", async () => {
  const snapshot = await service(new StockProvider(() => settings, market(null, null, null))).getSnapshot();

  assert.equal(snapshot.providers.stocks.status, "error");
  assert.equal(snapshot.providers.stocks.data, null, "no invented data");
  assert.equal(snapshot.providers.dateTime.status, "ok");
  assert.equal(snapshot.providers.system.status, "ok");
});

test("with stocks failing, the briefing is still produced — just without a stocks line", async () => {
  const snapshot = await service(new StockProvider(() => settings, market(null, null, null))).getSnapshot();

  const briefing = new BriefingGenerator("en-US").generate(snapshot);

  assert.equal(briefing.items[0].category, "greeting");
  assert.ok(!briefing.items.some((i) => i.category === "stocks"));
});

test("a working stock provider gives the briefing its portfolio line", async () => {
  const now = new Date();
  const snapshot = await service(
    new StockProvider(() => settings, market(101.8, 100, now.toISOString()))
  ).getSnapshot();

  const briefing = new BriefingGenerator("en-US").generate(snapshot, now);

  const stocks = briefing.items.find((i) => i.category === "stocks");
  assert.equal(stocks?.message, "Your portfolio is up 1.8% today.");
});

test("disabled stocks are unavailable, not an error", async () => {
  const snapshot = await service(
    new StockProvider(() => ({ ...settings, enabled: false }), market(100, 99, null))
  ).getSnapshot();

  assert.equal(snapshot.providers.stocks.status, "unavailable");
});
