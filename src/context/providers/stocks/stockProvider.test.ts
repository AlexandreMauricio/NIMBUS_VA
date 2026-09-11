import { test } from "node:test";
import assert from "node:assert/strict";
import { StockProvider } from "./stockProvider";
import {
  ListingMatch,
  MarketDataSource,
  NewsSource,
  RawQuote,
  StockNewsItem,
  StockPosition,
  StockProviderConfig,
} from "./types";

class FakeMarket implements MarketDataSource {
  readonly name = "Fake Market";
  readonly calls: string[] = [];
  prices = new Map<string, number>([
    ["AAPL", 150],
    ["MSFT", 400],
  ]);
  failing = new Set<string>();
  searchListings?: (query: string, limit: number) => Promise<ListingMatch[]>;

  async fetchQuote(symbol: string): Promise<RawQuote> {
    this.calls.push(symbol);
    const price = this.prices.get(symbol);
    if (this.failing.has(symbol) || price === undefined) throw new Error(`no data for ${symbol}`);
    return {
      symbol,
      price,
      previousClose: price - 10,
      currency: "USD",
      exchange: "Test",
      name: `${symbol} Inc.`,
      marketTime: "2026-09-11T14:00:00.000Z",
      instrumentType: "EQUITY",
    };
  }
}

class FakeNews implements NewsSource {
  calls = 0;
  fail = false;
  async fetchNews(symbol: string): Promise<StockNewsItem[]> {
    this.calls++;
    if (this.fail) throw new Error("news down");
    return [{ title: `${symbol} news`, publisher: "Wire", url: "https://news.test/1", publishedAt: null }];
  }
}

function setup(
  positions: StockPosition[] = [
    { id: "p1", symbol: "AAPL", shares: 10, averageCost: 100 },
    { id: "p2", symbol: "MSFT", shares: 2, averageCost: 300 },
  ]
) {
  const settings: StockProviderConfig = { enabled: true, newsEnabled: true, baseCurrency: "USD", positions };
  const clock = { now: new Date("2026-09-11T15:00:00Z") };
  const market = new FakeMarket();
  const news = new FakeNews();
  const provider = new StockProvider(
    () => settings,
    market,
    news,
    () => clock.now,
    () => "UTC"
  );
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { settings, market, news, provider, advance };
}

// ------------------------------------------------------------- availability

test("unavailable when switched off or with no positions", () => {
  const { settings, provider } = setup();
  assert.equal(provider.isAvailable(), true);
  settings.enabled = false;
  assert.equal(provider.isAvailable(), false);
  settings.enabled = true;
  settings.positions = [];
  assert.equal(provider.isAvailable(), false);
});

// ------------------------------------------------------------------ context

test("the context carries every position's estimates and the portfolio totals", async () => {
  const { provider } = setup();

  const context = await provider.getContext();

  assert.equal(context.source, "Fake Market");
  assert.deepEqual(
    context.positions.map((p) => [p.symbol, p.marketValue, p.status]),
    [
      ["AAPL", 1500, "live"],
      ["MSFT", 800, "live"],
    ]
  );
  assert.equal(context.totals[0].marketValue, 2300);
  assert.equal(context.totals[0].dayChange, 10 * 10 + 2 * 10);
  assert.equal(context.anyStale, false);
  assert.equal(context.unpricedCount, 0);
});

test("quotes are cached: repeated reads within the TTL make no new requests", async () => {
  const { provider, market, advance } = setup();

  await provider.getContext();
  await provider.getContext();
  advance(60_000);
  await provider.getContext();
  assert.equal(market.calls.length, 2, "one request per symbol");

  advance(2 * 60_000);
  await provider.getContext();
  assert.equal(market.calls.length, 4, "refetched after the TTL");
});

test("concurrent reads share one round of requests", async () => {
  const { provider, market } = setup();

  await Promise.all([provider.getContext(), provider.getContext(), provider.getContext()]);

  assert.equal(market.calls.length, 2);
});

test("a symbol that fails after succeeding keeps its last price, marked stale", async () => {
  const { provider, market, advance } = setup();
  await provider.getContext();

  market.failing.add("AAPL");
  advance(3 * 60_000);
  const context = await provider.getContext();

  const aapl = context.positions.find((p) => p.symbol === "AAPL")!;
  assert.equal(aapl.status, "stale");
  assert.equal(aapl.marketValue, 1500);
  assert.equal(context.anyStale, true);
  assert.equal(context.positions.find((p) => p.symbol === "MSFT")!.status, "live");
});

test("a symbol never priced stays unavailable — no invented price — and the rest still work", async () => {
  const { provider, settings } = setup();
  settings.positions.push({ id: "p3", symbol: "NOPE", shares: 1, averageCost: 5 });

  const context = await provider.getContext();

  const nope = context.positions.find((p) => p.symbol === "NOPE")!;
  assert.equal(nope.status, "unavailable");
  assert.equal(nope.marketValue, null);
  assert.equal(context.unpricedCount, 1);
  assert.equal(context.totals[0].positions, 2, "left out of the totals");
});

test("with no price for any position, getContext rejects so ContextService can fall back", async () => {
  const { provider, market } = setup();
  market.failing = new Set(["AAPL", "MSFT"]);

  await assert.rejects(provider.getContext(), /unavailable for every tracked symbol/);
});

test("a failing symbol isn't retried on every read", async () => {
  const { provider, market } = setup([{ id: "p1", symbol: "NOPE", shares: 1, averageCost: 1 }]);

  await assert.rejects(provider.getContext());
  await assert.rejects(provider.getContext());

  assert.equal(market.calls.length, 1);
});

test("refresh forces a refetch, but not more than once every 30 seconds", async () => {
  const { provider, market, advance } = setup();
  await provider.getContext();

  assert.equal(provider.refresh(), true);
  await provider.getContext();
  assert.equal(market.calls.length, 4);

  advance(10_000);
  assert.equal(provider.refresh(), false, "too soon");
  await provider.getContext();
  assert.equal(market.calls.length, 4);
});

test("editing positions is reflected at once, fetching only the new symbol", async () => {
  const { provider, settings, market } = setup();
  await provider.getContext();
  market.prices.set("NVDA", 900);

  settings.positions = [
    { id: "p1", symbol: "AAPL", shares: 20, averageCost: 100 },
    { id: "p4", symbol: "nvda", shares: 1, averageCost: 500 },
  ];
  const context = await provider.getContext();

  assert.deepEqual(
    context.positions.map((p) => [p.symbol, p.marketValue]),
    [
      ["AAPL", 3000],
      ["NVDA", 900],
    ]
  );
  assert.deepEqual(market.calls, ["AAPL", "MSFT", "NVDA"]);
});

test("a malformed position in settings is skipped, not fatal", async () => {
  const { provider, settings } = setup();
  settings.positions.push({ id: "bad", symbol: "AAPL", shares: -5, averageCost: 1 });

  const context = await provider.getContext();

  assert.equal(context.positions.length, 2);
});

// --------------------------------------------------------------------- news

test("news is fetched on demand and cached", async () => {
  const { provider, news } = setup();

  const first = await provider.getNews("AAPL");
  const second = await provider.getNews("AAPL");

  assert.equal(first.status, "ok");
  assert.equal(first.items[0].title, "AAPL news");
  assert.equal(second.status, "ok");
  assert.equal(news.calls, 1);
});

test("a news failure is a status, and prices are untouched", async () => {
  const { provider, news } = setup();
  news.fail = true;

  const result = await provider.getNews("AAPL");
  const context = await provider.getContext();

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.items, []);
  assert.equal(context.positions[0].status, "live");
});

test("a news failure after a success shows the earlier headlines as stale", async () => {
  const { provider, news, advance } = setup();
  await provider.getNews("AAPL");

  news.fail = true;
  advance(31 * 60_000);
  const result = await provider.getNews("AAPL");

  assert.equal(result.status, "stale");
  assert.equal(result.items.length, 1);
});

test("a failed news request isn't retried for a minute", async () => {
  const { provider, news, advance } = setup();
  news.fail = true;

  await provider.getNews("AAPL");
  await provider.getNews("AAPL");
  assert.equal(news.calls, 1);

  advance(61_000);
  await provider.getNews("AAPL");
  assert.equal(news.calls, 2);
});

test("with news switched off, nothing is fetched", async () => {
  const { provider, settings, news } = setup();
  settings.newsEnabled = false;

  const result = await provider.getNews("AAPL");

  assert.equal(result.status, "disabled");
  assert.equal(news.calls, 0);
});

// ---------------------------------------------------------- base currency

function withCurrencies(market: FakeMarket, currencies: Record<string, string>) {
  const original = market.fetchQuote.bind(market);
  market.fetchQuote = async (symbol: string) => {
    const quote = await original(symbol);
    return { ...quote, currency: currencies[symbol] ?? quote.currency };
  };
}

test("positions in other currencies are converted and summed into the base currency", async () => {
  const { settings, market, provider } = setup([
    { id: "p1", symbol: "AAPL", shares: 10, averageCost: 100 },
    { id: "p2", symbol: "REP.MC", shares: 10, averageCost: 15 },
  ]);
  settings.baseCurrency = "EUR";
  market.prices.set("REP.MC", 20);
  market.prices.set("USDEUR=X", 0.5);
  withCurrencies(market, { "REP.MC": "EUR" });

  const context = await provider.getContext();

  assert.equal(context.baseCurrency, "EUR");
  assert.deepEqual(
    context.fxRates.map((r) => [r.currency, r.rate, r.pair]),
    [["USD", 0.5, "USDEUR=X"]]
  );
  // AAPL 10 × 150 USD = 750 EUR, plus REP.MC 10 × 20 EUR.
  assert.equal(context.baseTotals?.marketValue, 750 + 200);
  assert.equal(context.baseTotals?.invested, 500 + 150);
  assert.deepEqual(context.unconvertedCurrencies, []);
  assert.equal(context.totals.length, 2, "per-currency totals are still there");
  assert.deepEqual(market.calls.sort(), ["AAPL", "REP.MC", "USDEUR=X"]);
});

test("pence are divided into pounds before converting", async () => {
  const { settings, market, provider } = setup([{ id: "p1", symbol: "BP.L", shares: 100, averageCost: 400 }]);
  settings.baseCurrency = "EUR";
  market.prices.set("BP.L", 500);
  market.prices.set("GBPEUR=X", 1.2);
  withCurrencies(market, { "BP.L": "GBp" });

  const context = await provider.getContext();

  assert.equal(context.fxRates[0].pair, "GBPEUR=X");
  assert.ok(Math.abs((context.baseTotals?.marketValue ?? 0) - 600) < 1e-9);
});

test("with no exchange rate, a currency is left out of the base total and named — never guessed", async () => {
  const { settings, market, provider } = setup([
    { id: "p1", symbol: "AAPL", shares: 10, averageCost: 100 },
    { id: "p2", symbol: "REP.MC", shares: 10, averageCost: 15 },
  ]);
  settings.baseCurrency = "EUR";
  market.prices.set("REP.MC", 20);
  withCurrencies(market, { "REP.MC": "EUR" });

  const context = await provider.getContext();

  assert.deepEqual(context.unconvertedCurrencies, ["USD"]);
  assert.equal(context.baseTotals?.marketValue, 200);
  assert.deepEqual(context.fxRates, []);
});

test("a rate that fails after succeeding is kept and marked stale, and rates are cached like quotes", async () => {
  const { settings, market, provider, advance } = setup([
    { id: "p1", symbol: "AAPL", shares: 1, averageCost: 1 },
  ]);
  settings.baseCurrency = "EUR";
  market.prices.set("USDEUR=X", 0.9);
  await provider.getContext();
  await provider.getContext();
  assert.equal(market.calls.filter((c) => c === "USDEUR=X").length, 1);

  market.failing.add("USDEUR=X");
  advance(3 * 60_000);
  const context = await provider.getContext();

  assert.equal(context.fxRates[0].rate, 0.9);
  assert.equal(context.fxRates[0].stale, true);
  assert.equal(context.baseTotals?.marketValue, 150 * 0.9);
});

test("no rate is fetched when everything is already in the base currency", async () => {
  const { market, provider } = setup();
  const context = await provider.getContext();
  assert.deepEqual(market.calls.sort(), ["AAPL", "MSFT"]);
  assert.equal(context.baseTotals?.marketValue, 2300);
});

test("an invalid base currency in settings falls back to EUR", async () => {
  const { settings, market, provider } = setup([{ id: "p1", symbol: "AAPL", shares: 1, averageCost: 1 }]);
  settings.baseCurrency = "euros";
  market.prices.set("USDEUR=X", 0.9);
  assert.equal((await provider.getContext()).baseCurrency, "EUR");
});

// ---------------------------------------------------------------- outdated

test("a price from a listing that stopped trading is outdated and left out of the totals", async () => {
  const { market, provider } = setup([
    { id: "p1", symbol: "AAPL", shares: 10, averageCost: 100 },
    { id: "p2", symbol: "SMSN.L", shares: 1, averageCost: 2742 },
  ]);
  market.prices.set("SMSN.L", 1179.5);
  const original = market.fetchQuote.bind(market);
  market.fetchQuote = async (symbol: string) => {
    const quote = await original(symbol);
    return symbol === "SMSN.L" ? { ...quote, marketTime: "2022-07-21T15:07:19.000Z" } : quote;
  };

  const context = await provider.getContext();

  assert.equal(context.positions[1].status, "outdated");
  assert.equal(context.outdatedCount, 1);
  assert.equal(context.totals[0].marketValue, 1500);
});

test("an outdated symbol gets live listings of the same company, same currency first", async () => {
  const { market, provider } = setup([{ id: "p1", symbol: "SMSN.L", shares: 1, averageCost: 2742 }]);
  const times: Record<string, string> = { "SMSN.L": "2022-07-21T15:07:19.000Z" };
  const currencies: Record<string, string> = { "005930.KS": "KRW" };
  market.prices.set("SMSN.L", 1179.5);
  market.prices.set("005930.KS", 259500);
  market.prices.set("SMSN.IL", 4860);
  const original = market.fetchQuote.bind(market);
  market.fetchQuote = async (symbol: string) => {
    const quote = await original(symbol);
    return {
      ...quote,
      name: "Samsung Electronics Co., Ltd.",
      marketTime: times[symbol] ?? quote.marketTime,
      currency: currencies[symbol] ?? quote.currency,
    };
  };
  const queries: string[] = [];
  market.searchListings = async (query: string) => {
    queries.push(query);
    return [
      { symbol: "005930.KS", name: "SamsungElec", exchange: "KSE" },
      { symbol: "SMSN.L", name: "Samsung", exchange: "LSE" },
      { symbol: "SMSN.IL", name: "Samsung", exchange: "IOB" },
      { symbol: "NOPE.X", name: "Samsung", exchange: "?" },
    ];
  };

  await provider.getContext();
  const found = await provider.findListings("SMSN.L");

  assert.deepEqual(queries, ["Samsung Electronics"]);
  assert.equal(found.status, "ok");
  assert.deepEqual(
    found.candidates.map((c) => [c.symbol, c.currency]),
    [
      ["SMSN.IL", "USD"],
      ["005930.KS", "KRW"],
    ]
  );
  await provider.findListings("SMSN.L");
  assert.equal(queries.length, 1, "cached");
});

test("a current symbol needs no listing search", async () => {
  const { provider } = setup();
  await provider.getContext();
  assert.equal((await provider.findListings("AAPL")).status, "not-needed");
});

test("news is searched by the company's name once it is known", async () => {
  const { provider } = setup();
  const seen: Array<string | null | undefined> = [];
  const news = {
    async fetchNews(_symbol: string, _limit: number, companyName?: string | null) {
      seen.push(companyName);
      return [];
    },
  };
  (provider as unknown as { newsSource: typeof news }).newsSource = news;
  await provider.getContext();
  await provider.getNews("AAPL");
  assert.deepEqual(seen, ["AAPL Inc."]);
});

// ------------------------------------------------------ alternative symbol

function retire(market: FakeMarket, symbol: string) {
  const original = market.fetchQuote.bind(market);
  market.fetchQuote = async (s: string) => {
    const quote = await original(s);
    return s === symbol ? { ...quote, marketTime: "2022-07-21T15:07:19.000Z" } : quote;
  };
}

test("an outdated symbol takes its price from the alternative, which then counts in the totals", async () => {
  const { market, provider } = setup([
    { id: "p1", symbol: "SMSN.L", alternativeSymbol: "SMSN.IL", shares: 2, averageCost: 3000 },
  ]);
  market.prices.set("SMSN.L", 1179.5);
  market.prices.set("SMSN.IL", 4860);
  retire(market, "SMSN.L");

  const context = await provider.getContext();

  const view = context.positions[0];
  assert.equal(view.symbol, "SMSN.L");
  assert.equal(view.priceSymbol, "SMSN.IL");
  assert.equal(view.usingAlternative, true);
  assert.equal(view.status, "live");
  assert.equal(view.marketValue, 2 * 4860);
  assert.equal(context.outdatedCount, 0);
  assert.equal(context.totals[0].marketValue, 2 * 4860);
});

test("an unknown symbol also falls back to the alternative", async () => {
  const { market, provider } = setup([
    { id: "p1", symbol: "GONE", alternativeSymbol: "MSFT", shares: 1, averageCost: 1 },
  ]);

  const context = await provider.getContext();

  assert.equal(context.positions[0].priceSymbol, "MSFT");
  assert.deepEqual(market.calls, ["GONE", "MSFT"]);
});

test("the alternative isn't fetched while the symbol itself has a current price", async () => {
  const { market, provider } = setup([
    { id: "p1", symbol: "AAPL", alternativeSymbol: "MSFT", shares: 1, averageCost: 1 },
  ]);

  const context = await provider.getContext();

  assert.equal(context.positions[0].priceSymbol, "AAPL");
  assert.deepEqual(market.calls, ["AAPL"]);
});

test("with the alternative outdated too, the position stays outdated", async () => {
  const { market, provider } = setup([
    { id: "p1", symbol: "AAPL", shares: 1, averageCost: 1 },
    { id: "p2", symbol: "SMSN.L", alternativeSymbol: "SMSN.IL", shares: 1, averageCost: 1 },
  ]);
  market.prices.set("SMSN.L", 1179.5);
  market.prices.set("SMSN.IL", 4860);
  const original = market.fetchQuote.bind(market);
  market.fetchQuote = async (s: string) => {
    const quote = await original(s);
    return s.startsWith("SMSN") ? { ...quote, marketTime: "2022-07-21T15:07:19.000Z" } : quote;
  };

  const context = await provider.getContext();

  assert.equal(context.positions[1].status, "outdated");
  assert.equal(context.positions[1].priceSymbol, "SMSN.L");
});
