import { test } from "node:test";
import assert from "node:assert/strict";
import { YahooMarketDataSource, YahooNewsSource } from "./yahooFinance";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

// Shaped like a real chart response (trimmed).
const CHART = {
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "AAPL",
          exchangeName: "NMS",
          fullExchangeName: "NasdaqGS",
          instrumentType: "EQUITY",
          regularMarketTime: 1789070401,
          regularMarketPrice: 326.57,
          chartPreviousClose: 315.34,
          longName: "Apple Inc.",
          shortName: "Apple Inc.",
        },
      },
    ],
    error: null,
  },
};

// ------------------------------------------------------------------- quotes

test("a chart response becomes a quote", async () => {
  const fetch = fakeFetch(200, CHART);

  const quote = await new YahooMarketDataSource(fetch.fn).fetchQuote("AAPL");

  assert.deepEqual(quote, {
    symbol: "AAPL",
    price: 326.57,
    previousClose: 315.34,
    currency: "USD",
    exchange: "NasdaqGS",
    name: "Apple Inc.",
    marketTime: new Date(1789070401 * 1000).toISOString(),
    instrumentType: "EQUITY",
  });
});

test("the symbol is URL-encoded and every request has a timeout", async () => {
  const fetch = fakeFetch(200, CHART);

  await new YahooMarketDataSource(fetch.fn).fetchQuote("^GSPC");

  assert.match(fetch.calls[0].url, /\/chart\/%5EGSPC\?range=1d&interval=1d$/);
  assert.ok(fetch.calls[0].init?.signal, "a timeout signal is attached");
});

test("an unknown symbol, an error status or a missing price is a rejection, never a price", async () => {
  await assert.rejects(new YahooMarketDataSource(fakeFetch(404, {}).fn).fetchQuote("NOPE"), /No market data/);
  await assert.rejects(new YahooMarketDataSource(fakeFetch(500, {}).fn).fetchQuote("AAPL"), /status 500/);
  const noPrice = { chart: { result: [{ meta: { currency: "USD" } }] } };
  await assert.rejects(new YahooMarketDataSource(fakeFetch(200, noPrice).fn).fetchQuote("AAPL"), /no price/);
  await assert.rejects(
    new YahooMarketDataSource(fakeFetch(200, { chart: { result: null } }).fn).fetchQuote("AAPL")
  );
});

test("previousClose falls back, and is null rather than guessed when absent", async () => {
  const fallback = { chart: { result: [{ meta: { regularMarketPrice: 10, previousClose: 9 } }] } };
  const none = { chart: { result: [{ meta: { regularMarketPrice: 10 } }] } };

  assert.equal(
    (await new YahooMarketDataSource(fakeFetch(200, fallback).fn).fetchQuote("X")).previousClose,
    9
  );
  const quote = await new YahooMarketDataSource(fakeFetch(200, none).fn).fetchQuote("X");
  assert.equal(quote.previousClose, null);
  assert.equal(quote.name, null);
  assert.equal(quote.marketTime, null);
});

// --------------------------------------------------------------------- news

const NEWS = {
  news: [
    {
      title: "Apple unveils something",
      publisher: "Reuters",
      link: "https://finance.yahoo.com/news/apple-1",
      providerPublishTime: 1789114152,
      relatedTickers: ["AAPL", "MSFT"],
    },
    {
      title: "About another company only",
      publisher: "WSJ",
      link: "https://x.test/2",
      relatedTickers: ["TSLA"],
    },
    {
      title: "No tickers listed",
      publisher: "Bloomberg",
      link: "https://x.test/3",
      providerPublishTime: 1789110000,
    },
    { title: "Bad link", publisher: "Nobody", link: "javascript:alert(1)" },
    { publisher: "No title", link: "https://x.test/5" },
  ],
};

test("headlines keep title, publisher, time and link — and nothing else", async () => {
  const items = await new YahooNewsSource(fakeFetch(200, NEWS).fn).fetchNews("AAPL", 5);

  assert.deepEqual(items[0], {
    title: "Apple unveils something",
    publisher: "Reuters",
    url: "https://finance.yahoo.com/news/apple-1",
    publishedAt: new Date(1789114152 * 1000).toISOString(),
  });
});

test("news about other tickers, untagged general news, non-web links and untitled items are dropped", async () => {
  const items = await new YahooNewsSource(fakeFetch(200, NEWS).fn).fetchNews("aapl", 5);

  assert.deepEqual(
    items.map((i) => i.title),
    ["Apple unveils something"]
  );
});

test("with a company name, the search uses it and headlines naming the company are kept", async () => {
  const fetch = fakeFetch(200, {
    news: [
      { title: "Repsol raises its dividend", link: "https://x.test/1" },
      { title: "Repsolar is a different firm", link: "https://x.test/2" },
      { title: "Unrelated contact lens news", link: "https://x.test/3" },
      { title: "Oil roundup", link: "https://x.test/4", relatedTickers: ["REP.MC"] },
      { title: "Chevron in Venezuela", link: "https://x.test/5", relatedTickers: ["CVX", "REPYY"] },
    ],
  });

  const items = await new YahooNewsSource(fetch.fn).fetchNews("REP.MC", 5, "Repsol, S.A.");

  assert.match(fetch.calls[0].url, /[?&]q=Repsol&/);
  assert.deepEqual(
    items.map((i) => i.title),
    ["Repsol raises its dividend", "Oil roundup"]
  );
});

test("the item count is capped", async () => {
  const items = await new YahooNewsSource(fakeFetch(200, NEWS).fn).fetchNews("AAPL", 1);
  assert.equal(items.length, 1);
});

test("a failed news request is a rejection", async () => {
  await assert.rejects(new YahooNewsSource(fakeFetch(429, {}).fn).fetchNews("AAPL", 5), /status 429/);
});

test("a response with no news is an empty list", async () => {
  assert.deepEqual(await new YahooNewsSource(fakeFetch(200, {}).fn).fetchNews("AAPL", 5), []);
});

// ----------------------------------------------------------------- listings

test("a listing search returns equity and ETF listings only, symbols validated", async () => {
  const fetch = fakeFetch(200, {
    quotes: [
      { symbol: "005930.KS", quoteType: "EQUITY", shortname: "SamsungElec", exchDisp: "KSE" },
      { symbol: "SMSN.IL", quoteType: "EQUITY", longname: "Samsung Electronics", exchange: "IOB" },
      { symbol: "SAMSUNG-FUT", quoteType: "FUTURE" },
      { symbol: "bad symbol", quoteType: "EQUITY" },
    ],
  });

  const found = await new YahooMarketDataSource(fetch.fn).searchListings("Samsung Electronics", 8);

  assert.match(fetch.calls[0].url, /q=Samsung\+Electronics/);
  assert.deepEqual(found, [
    { symbol: "005930.KS", name: "SamsungElec", exchange: "KSE" },
    { symbol: "SMSN.IL", name: "Samsung Electronics", exchange: "IOB" },
  ]);
});
