# Stocks

A read-only context provider —
[src/context/providers/stocks/](../src/context/providers/stocks/) — plus the
**Stocks** tab. You enter the positions you own by hand; NIMBUS retrieves
current market prices and estimates what those positions are worth.

**There is no trading anywhere.** NIMBUS connects to no brokerage account,
places no orders, and has no action — in the UI, over IPC or in the Action
system — that could open, change or close a position. A position is a note
you keep; every figure derived from it is an estimate.

## Positions

Stored in `settings.json` under `UserPreferences.stocks` — plain user
data, with no credential involved:

| Field | Meaning |
| --- | --- |
| `symbol` | As the market lists it: `AAPL`, `BRK-B`, `ASML.AS`, `0700.HK`. Stored uppercase. |
| `companyName` | Optional; the market data's name is used when blank. |
| `shares` | Greater than 0; fractions allowed. |
| `alternativeSymbol` | Optional. Another listing of the same company, used for the price only when `symbol` has none or only an outdated one. |
| `averageCost` | Per share, in the currency the symbol trades in. |
| `purchaseDate` | Optional plain date; can't be in the future. |
| `notes` | Optional. |

Up to 50 positions; two lots of the same symbol are fine. Positions are
validated before saving (`validateStockPositions`), and a hand-edited
invalid entry is skipped when prices are computed rather than breaking
the rest. The group also holds `enabled` ("Track prices", default on —
nothing is fetched until a position exists) and `newsEnabled` (default
on).

## Market data and news

[yahooFinance.ts](../src/context/providers/stocks/yahooFinance.ts) reads
Yahoo Finance's public chart endpoint (price, previous close, currency,
exchange, company name, price time) and its search endpoint (headlines:
title, publisher, time, link). **No API key and no account are needed.**

Both sit behind narrow interfaces in
[types.ts](../src/context/providers/stocks/types.ts) — `MarketDataSource`
and `NewsSource` — and `StockProvider` never names the vendor, so a
different source (a keyed API, say) can replace this one without the
provider, the context, the briefing or the UI changing.

## Estimates

[positionMath.ts](../src/context/providers/stocks/positionMath.ts), pure:

| Figure | How |
| --- | --- |
| Invested | shares × average cost |
| Position value | shares × current price |
| Unrealized gain/loss | position value − invested; as a % of invested (none when the cost is 0) |
| Today's change | shares × (price − previous close) — or, for a position bought today, its gain since purchase |
| Portfolio totals | Sums of the above over priced positions, **per currency** |
| Base-currency total | Every priced position converted into the base currency (default EUR) and summed |
| Portfolio today % | Day change ÷ the portfolio's value at the previous close |

The per-currency totals only ever add positions of one currency. The
base-currency total converts first, at today's rate from a Yahoo pair
(`USDEUR=X` = euros per dollar). Rates go through the same quote cache,
TTL and stale-on-failure handling as prices, and are fetched only for
currencies you hold. Minor units are divided out first (`GBp`/`GBX` →
GBP, `ZAc` → ZAR, `ILA` → ILS). A currency with no rate is left out of
the base total and named — never converted at a guessed rate. The
invested amount is converted at today's rate as well (there are no
historical rates), so the base-currency gain excludes currency moves
since purchase.

A position with no price is left out of the totals rather than counted as
zero, and every market-based figure for it is blank.

### Outdated listings

A fetch can succeed and still return a price that is years old: the
ticker belongs to a listing that stopped trading (e.g. `SMSN.L`, last
traded July 2022, while Samsung's GDR now trades as `SMSN.IL`). A price
older than `OUTDATED_AFTER_DAYS` (7) marks the position **outdated**: it is
tagged in the list and left out of every total. Opening it searches Yahoo
for the company's other listings (`findListings`, IPC
`nimbus:find-stock-listings`, tracked symbols only), prices them, and offers
up to three that still trade, same currency first. "Track this instead"
is an ordinary position edit that changes only the symbol — nothing
switches automatically, and the average cost is left as entered (a note
warns when the new listing trades in another currency). Results are
cached for 30 minutes.

**Use as alternative** keeps the original symbol and saves the suggestion
as the position's `alternativeSymbol` (also editable in the form). From
then on, whenever the symbol has no price or only an outdated one, the
price comes from the alternative — fetched only in that case — and the
position counts in the totals again, shown "via" the alternative. Its
`priceSymbol` / `usingAlternative` fields say which symbol priced it. If
the alternative is outdated too, the position stays outdated. The average
cost is used as entered, so it must match the alternative's currency.

## Caching and rate limiting

- Quotes are cached **per symbol for 2 minutes**, failed attempts
  included, so a bad symbol isn't retried on every read. Editing positions
  re-computes immediately; only a new symbol is fetched.
- Concurrent reads share one round of requests, and at most 4 symbols are
  fetched at once.
- **Refresh** bypasses the cache at most once every 30 seconds.
- News is cached per symbol for 30 minutes; a failed news request isn't
  retried for a minute.

So the Home page's frequent context reads never reach Yahoo more than once
per symbol per 2 minutes.

## Failure behaviour

- **One symbol fails** after succeeding before: its last good quote is kept
  and marked stale ("may be out of date").
- **A symbol never priced** (a typo, say): "no price", excluded from totals.
  No price is ever invented.
- **No position has any price**: the provider fails, and ContextService
  serves its last good result marked stale — or an error, which the tab
  shows as "Market data is unavailable" with no figures.
- **News fails**: the detail view says news isn't available; prices are
  untouched.

## The context and the briefing

`StockContext` carries each position with its estimates, the per-currency
totals, `baseCurrency`, `baseTotals`, the `fxRates` used,
`unconvertedCurrencies`, `unpricedCount`, `anyStale` and the data
`source`. News is not part
of it — it is fetched on demand, for tracked symbols only
(`nimbus:get-stock-news`).

News is searched by the company's name without its legal form
(`companySearchName`: "Repsol, S.A." → "Repsol"), because a ticker string
like `REP.MC` returns mostly unrelated headlines. An item is kept only when
the source tags it with the symbol, or its headline names the company as a
whole word; untagged general news is dropped.

The briefing reads only the totals, through its usual builder pattern
(`buildStocksItem` in `briefingGenerator.ts`):

- "Your portfolio is up 1.8% today." / "…is down 0.6% today." / "…is flat today."
- "Your portfolio was up 1.8% at the last close." when the prices are from
  an earlier session (weekends, before the open).
- One figure from the base-currency total when every position could be
  converted; otherwise "Your portfolio is up 1.8% in USD and down 0.4% in
  EUR today." per currency.
- "Some prices may be out of date." appended when any price is stale.
- No line at all when the day's change isn't known.

## The Stocks tab

- **Overview**: current value, total gain/loss and today's change in the
  base currency (plus a row for any currency with no rate), with the rates
  used and a reminder that these are estimates.
- **Positions**: symbol and name, price, today's %, value and total return;
  "stale", "outdated" and "no price" markers; a converted value (≈ €…) under positions
  in another currency.
- **A position**: your entries, the market data (price, previous close,
  day change, exchange, price time, status), the estimates, and recent
  news. Headlines open in your default browser through the existing
  `system.openUrl` action — never inside NIMBUS.
- **Add / edit / remove** (removing takes two clicks), **Refresh**, and the
  **Track prices** and **Show recent news** switches, and the **Total in**
  base-currency picker (`baseCurrency` in settings, default `EUR`).

## Lots and holdings

Each entry is a *lot* — a purchase with its own shares, cost and date.
Lots of the same symbol are combined into a *holding*
(`computeHoldings`, `StockContext.holdings`): total shares, the average
cost weighted by shares, and the summed value, gain and day change. The
list shows one row per holding ("2 lots"); its page lists every lot, and
each lot keeps its own page for editing. Market figures are left blank
unless every lot is priced.

## Dividends

`dividends.ts` (pure) and `StockProvider.getDividends()` (IPC
`nimbus:get-stock-dividends`). Fetched on demand like news, not inside the
context, and cached for 12 hours per symbol (a failure is retried after an
hour, and an earlier history is kept as stale). The source is the Yahoo
chart endpoint with dividend events: **ex-dividend dates and per-share
amounts only — no payment dates and no announced dividends.** Holdings
priced through an alternative symbol use that symbol's history.

- **Received**: every ex-date after a lot's purchase date counts that
  lot's shares (a lot bought on the ex-date doesn't qualify). Lots without
  a purchase date can't be matched and are reported, not guessed.
- **Next dividend (estimate)**: the last ex-date plus the median gap of
  the last ~400 days, at the last amount, on all shares held now. No
  estimate with fewer than two dividends, or when the projected date is
  more than 20 days overdue (the pattern broke).
- **Per year (estimate)**: the last amount × payments per year × shares.
- **Tax, for a Portugal resident** (`taxDividend`): the source country
  withholds its rate; Portugal taxes the gross at 28% (the liberatory
  rate) and credits the foreign tax up to the treaty rate; anything
  withheld above the treaty rate is shown as reclaimable. Rates come from
  `TAX_COUNTRIES` (typical values, not advice). The country is guessed from
  the listing (exchange suffix, plus a short list of well-known US ADRs
  such as TSM → Taiwan); `.IL` GDRs are unknown. The user can pick a country
  or a custom rate per holding (`dividendTax` in settings).
- The overview adds three figures in the base currency: dividends this
  year after tax, the next estimated dividend, and the yearly estimate.

## Limitations

- The Yahoo endpoints are **unofficial**: undocumented, possibly
  rate-limited, and liable to change without notice. Prices may be delayed,
  depending on the exchange.
- Average cost must be in the symbol's trading currency. London-listed
  prices are quoted in pence (`GBp`), so enter the cost in pence too.
- Currency conversion uses today's rate only — no historical rates. No splits, fees, taxes, realized gains
  or history. The purchase date only matters for a position bought today.
- News links open Yahoo Finance's page for the article, which credits the
  publisher — the endpoint provides no direct publisher URL. Relevance
  relies on the source's own ticker tags.
- The last good quotes live in memory: after a restart, a symbol that
  fails shows no price rather than yesterday's.

## Tests

`types.test.ts` (symbols, position and list validation),
`positionMath.test.ts` (every figure, losses, zero cost, unknown previous
close, no quote, stale quotes, bought-today, per-currency and base-currency totals, minor units),
`yahooFinance.test.ts` (quote and news parsing, errors, no invented
prices, dropped links), `stockProvider.test.ts` (availability, caching,
shared reads, stale and unpriced symbols, refresh throttling, edits,
news caching and failure), `stockProvider.integration.test.ts` (a failing
stock provider leaves other providers and the briefing intact),
`stocksBriefing.test.ts` (every briefing phrasing) and
`stockSettings.test.ts` (defaults, persistence, no secrets). No test
reaches the real market.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
