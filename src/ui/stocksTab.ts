/**
 * The Stocks tab — read-only tracking of positions the user entered by
 * hand. There are no trading controls anywhere in it: the only things a
 * user can change are their own position notes and two switches.
 *
 * Prices are read from the context snapshot's `stocks` result, the same
 * way the Calendar tab reads its provider — so this tab gets
 * ContextService's stale fallback for free and never asks the market
 * source directly. Every figure shown is an estimate built from the
 * user's entries and the latest price retrieved.
 *
 * The shapes below mirror src/context/providers/stocks/types.ts. They are
 * repeated rather than imported because the renderer only ever talks to
 * the preload bridge, never to Core.
 */

interface StockQuoteView {
  price: number;
  previousClose: number | null;
  currency: string | null;
  exchange: string | null;
  name: string | null;
  marketTime: string | null;
  change: number | null;
  changePercent: number | null;
  fetchedAt: string;
  stale: boolean;
  outdated?: boolean;
}

interface StockPositionView {
  id: string;
  symbol: string;
  priceSymbol?: string;
  usingAlternative?: boolean;
  companyName: string;
  shares: number;
  averageCost: number;
  purchaseDate: string | null;
  notes: string | null;
  currency: string | null;
  quote: StockQuoteView | null;
  status: "live" | "stale" | "outdated" | "unavailable";
  invested: number;
  marketValue: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
}

interface StockTotalsView {
  currency: string;
  positions: number;
  invested: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedGainPercent: number | null;
  dayChange: number;
  dayChangePercent: number | null;
}

interface FxRateView {
  currency: string;
  rate: number;
  pair: string;
  stale: boolean;
  marketTime: string | null;
}

interface StockContextView {
  retrievedAt: string;
  positions: StockPositionView[];
  totals: StockTotalsView[];
  holdings?: HoldingViewUI[];
  unpricedCount: number;
  outdatedCount?: number;
  anyStale: boolean;
  source: string;
  // Optional: a snapshot from before base-currency totals existed has none.
  baseCurrency?: string;
  baseTotals?: StockTotalsView | null;
  fxRates?: FxRateView[];
  unconvertedCurrencies?: string[];
}

interface StockProviderResultView {
  status: "ok" | "error" | "unavailable";
  data: StockContextView | null;
  stale: boolean;
  timestamp: string;
}

interface StockPositionInput {
  id: string;
  symbol: string;
  alternativeSymbol?: string;
  companyName?: string;
  shares: number;
  averageCost: number;
  purchaseDate?: string;
  notes?: string;
}

interface StockPreferencesView {
  enabled: boolean;
  newsEnabled: boolean;
  baseCurrency: string;
  dividendsEnabled: boolean;
  dividendTax: Record<string, DividendTaxSettingView>;
  positions: StockPositionInput[];
}

interface StockNewsItemView {
  title: string;
  publisher: string | null;
  url: string;
  publishedAt: string | null;
}

interface StockNewsResultView {
  symbol: string;
  status: "ok" | "stale" | "unavailable" | "disabled";
  items: StockNewsItemView[];
  retrievedAt: string | null;
}

interface ListingCandidateView {
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price: number;
  marketTime: string | null;
}

interface ListingSearchResultView {
  symbol: string;
  status: "ok" | "not-needed" | "unavailable";
  candidates: ListingCandidateView[];
}

/** The figures a list row and the market/estimate cards need — shared by a lot and a holding. */
type Figures = Pick<
  StockPositionView,
  | "companyName"
  | "currency"
  | "quote"
  | "status"
  | "marketValue"
  | "unrealizedGain"
  | "unrealizedGainPercent"
  | "dayChange"
  | "dayChangePercent"
  | "priceSymbol"
  | "usingAlternative"
>;

interface HoldingViewUI extends Figures {
  symbol: string;
  lotIds: string[];
  shares: number;
  averageCost: number;
  invested: number;
}

interface DividendAmountsView {
  gross: number;
  foreignTax: number;
  portugueseTax: number;
  net: number;
  reclaimable: number;
}

interface DividendLineView extends DividendAmountsView {
  exDate: string;
  amountPerShare: number;
  shares: number;
}

interface HoldingDividendsView {
  symbol: string;
  sourceSymbol: string;
  currency: string | null;
  status: "ok" | "stale";
  tax: {
    country: string;
    countryName: string;
    guessed: boolean;
    known: boolean;
    withholdingPercent: number;
    creditCapPercent: number;
    portuguesePercent: number;
  };
  received: DividendLineView[];
  receivedTotal: DividendAmountsView;
  thisYear: DividendAmountsView;
  frequency: string | null;
  expected: DividendLineView | null;
  estimatedAnnual: DividendAmountsView | null;
  lotsWithoutDate: number;
}

interface StockDividendsView {
  status: "ok" | "disabled" | "unavailable";
  retrievedAt: string | null;
  baseCurrency: string;
  holdings: HoldingDividendsView[];
  unavailableSymbols: string[];
  base: {
    thisYear: DividendAmountsView;
    receivedTotal: DividendAmountsView;
    estimatedAnnual: DividendAmountsView | null;
    next: { symbol: string; exDate: string; net: number } | null;
  } | null;
  unconvertedCurrencies: string[];
  taxCountries: { code: string; name: string; withholdingPercent: number; creditCapPercent: number }[];
}

interface DividendTaxSettingView {
  country: string;
  withholdingPercent?: number;
}

interface StocksBridge {
  getStockDividends(): Promise<StockDividendsView>;
  findStockListings(symbol: string): Promise<ListingSearchResultView>;
  getContext(): Promise<{ providers: Record<string, unknown> }>;
  getStockSettings(): Promise<StockPreferencesView>;
  updateStockSettings(partial: Partial<StockPreferencesView>): Promise<StockPreferencesView>;
  refreshStocks(): Promise<boolean>;
  getStockNews(symbol: string): Promise<StockNewsResultView>;
  executeAction(actionId: string, params?: Record<string, unknown>): Promise<{ status: string }>;
}

function bridge(): StocksBridge {
  return (window as unknown as { nimbus: StocksBridge }).nimbus;
}

// ------------------------------------------------------------- formatting

function money(value: number | null | undefined, currency: string | null, signed = false): string {
  if (value === null || value === undefined) return "—";
  const options: Intl.NumberFormatOptions = signed ? { signDisplay: "exceptZero" } : {};
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { ...options, style: "currency", currency }).format(value);
    } catch {
      // Unknown currency code — fall through to a plain number.
    }
  }
  const number = new Intl.NumberFormat(undefined, { ...options, maximumFractionDigits: 2 }).format(value);
  return currency ? `${number} ${currency}` : number;
}

/** Base currencies offered in the picker; a saved code outside the list is added to it. */
const BASE_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN"];

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function trendClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "";
  return value > 0 ? "stock-up" : "stock-down";
}

function plainDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The user-facing part of an IPC error ("Error invoking remote method …: Error: Shares must be…"). */
function errorText(err: unknown): string {
  return String(err).replace(/^.*Error: /, "");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function keyValue(label: string, value: string, valueClass = ""): HTMLElement {
  const row = el("div", "stock-kv");
  row.appendChild(el("span", undefined, label));
  row.appendChild(el("span", valueClass, value));
  return row;
}

// ------------------------------------------------------------------ the tab

export function initStocksTab(): void {
  const listView = document.getElementById("stocksListView") as HTMLElement;
  const detailView = document.getElementById("stockDetailView") as HTMLElement;
  const editView = document.getElementById("stockEditView") as HTMLElement;
  const errorEl = document.getElementById("stocksError") as HTMLElement;
  const overviewEl = document.getElementById("stockOverview") as HTMLElement;
  const listEl = document.getElementById("stockPositionList") as HTMLElement;
  const emptyEl = document.getElementById("stockEmpty") as HTMLElement;
  const sourceEl = document.getElementById("stockSourceNote") as HTMLElement;
  const detailEl = document.getElementById("stockDetail") as HTMLElement;
  const enabledInput = document.getElementById("stocksEnabled") as HTMLInputElement;
  const newsInput = document.getElementById("stocksNewsEnabled") as HTMLInputElement;
  const refreshBtn = document.getElementById("refreshStocksBtn") as HTMLButtonElement;
  const baseSelect = document.getElementById("stocksBaseCurrency") as HTMLSelectElement;
  const dividendsInput = document.getElementById("stocksDividendsEnabled") as HTMLInputElement;
  const dividendOverviewEl = document.getElementById("stockDividendOverview") as HTMLElement;

  const formHeading = document.getElementById("positionFormHeading") as HTMLElement;
  const symbolInput = document.getElementById("positionSymbol") as HTMLInputElement;
  const altInput = document.getElementById("positionAltSymbol") as HTMLInputElement;
  const nameInput = document.getElementById("positionName") as HTMLInputElement;
  const sharesInput = document.getElementById("positionShares") as HTMLInputElement;
  const costInput = document.getElementById("positionCost") as HTMLInputElement;
  const dateInput = document.getElementById("positionDate") as HTMLInputElement;
  const notesInput = document.getElementById("positionNotes") as HTMLInputElement;
  const formError = document.getElementById("positionFormError") as HTMLElement;
  const saveBtn = document.getElementById("savePositionBtn") as HTMLButtonElement;

  let prefs: StockPreferencesView = {
    enabled: true,
    newsEnabled: true,
    baseCurrency: "EUR",
    dividendsEnabled: true,
    dividendTax: {},
    positions: [],
  };
  let result: StockProviderResultView | undefined;
  let selectedId: string | null = null;
  /** The holding page being shown, when it is a holding of several lots rather than one lot. */
  let selectedSymbol: string | null = null;
  /** A lot opened from its holding page goes back there. */
  let returnToSymbol: string | null = null;
  let dividends: StockDividendsView | null = null;
  let editingId: string | null = null;

  function show(view: "list" | "detail" | "edit"): void {
    listView.hidden = view !== "list";
    detailView.hidden = view !== "detail";
    editView.hidden = view !== "edit";
  }

  // Not alert(): a native dialog in Electron takes keyboard focus away from the page.
  function showError(target: HTMLElement, message: string): void {
    target.textContent = message;
    target.hidden = false;
  }

  function viewFor(id: string): StockPositionView | null {
    return result?.data?.positions.find((p) => p.id === id) ?? null;
  }

  /** Base currency and the rate into it for a position, or null when it is already in the base or has no rate. */
  function conversionFor(view: { currency: string | null } | null): { base: string; rate: number } | null {
    const data = result?.data;
    if (!view?.currency || !data?.baseCurrency) return null;
    const fx = data.fxRates?.find((r) => r.currency === view.currency);
    return fx ? { base: data.baseCurrency, rate: fx.rate } : null;
  }

  async function load(): Promise<void> {
    errorEl.hidden = true;
    try {
      const [settings, snapshot] = await Promise.all([bridge().getStockSettings(), bridge().getContext()]);
      prefs = settings;
      result = snapshot.providers.stocks as StockProviderResultView | undefined;
    } catch (err) {
      showError(errorEl, `Couldn't load stocks: ${errorText(err)}`);
    }
    render();
    void loadDividends();
  }

  function render(): void {
    enabledInput.checked = prefs.enabled;
    newsInput.checked = prefs.newsEnabled;
    dividendsInput.checked = prefs.dividendsEnabled;
    const codes = BASE_CURRENCIES.includes(prefs.baseCurrency)
      ? BASE_CURRENCIES
      : [prefs.baseCurrency, ...BASE_CURRENCIES];
    baseSelect.innerHTML = "";
    for (const code of codes)
      baseSelect.appendChild(new Option(code, code, false, code === prefs.baseCurrency));
    renderStatus();
    renderOverview();
    renderDividendOverview();
    renderList();
    if (!detailView.hidden) {
      if (selectedId) renderDetail(selectedId);
      else if (selectedSymbol) renderHolding(selectedSymbol);
    }
  }

  function renderStatus(): void {
    const data = result?.data;
    const notes: string[] = [];
    if (!prefs.enabled && prefs.positions.length > 0) {
      notes.push("Price tracking is off, so no prices are shown.");
    } else if (result?.status === "error" && !data) {
      showError(
        errorEl,
        "Market data is unavailable right now. No prices are shown rather than guessed ones."
      );
    } else if (data) {
      if (result?.status === "error" || result?.stale) {
        notes.push(
          `Market data is unavailable right now — these are the last prices NIMBUS retrieved (${dateTime(data.retrievedAt)}).`
        );
      } else {
        notes.push(`Prices from ${data.source}, last retrieved ${dateTime(data.retrievedAt)}.`);
      }
      if (data.anyStale)
        notes.push("Some prices are from an earlier successful fetch and may be out of date.");
      const rates = data.fxRates ?? [];
      if (data.baseTotals && rates.length > 0) {
        const list = rates
          .map(
            (r) =>
              `1 ${r.currency} = ${r.rate.toFixed(4)} ${data.baseCurrency}${r.stale ? " (may be out of date)" : ""}`
          )
          .join(", ");
        notes.push(
          `Totals converted to ${data.baseCurrency} at today's rate: ${list}. Purchase costs use today's rate too, so the gain doesn't include currency moves since you bought.`
        );
      }
      const unconverted = data.unconvertedCurrencies ?? [];
      if (data.baseTotals && unconverted.length > 0) {
        notes.push(
          `No exchange rate for ${unconverted.map((c) => c || "an unknown currency").join(", ")} — those positions are shown separately, not in the ${data.baseCurrency} total.`
        );
      }
      const outdated = data.outdatedCount ?? 0;
      if (outdated > 0) {
        notes.push(
          `${outdated} position${outdated === 1 ? "'s" : "s'"} price hasn't changed in over a week — that listing has probably stopped trading, so it's left out of the totals. Open it to find the listing that still trades.`
        );
      }
      if (data.unpricedCount > 0) {
        notes.push(
          `${data.unpricedCount} position${data.unpricedCount === 1 ? " has" : "s have"} no price — check the symbol.`
        );
      }
    }
    sourceEl.textContent = notes.join(" ");
    sourceEl.hidden = notes.length === 0;
  }

  function stat(label: string, value: string, sub: string, trend = ""): HTMLElement {
    const card = el("div", "stock-stat");
    card.appendChild(el("div", "stock-stat-label", label));
    card.appendChild(el("div", `stock-stat-value ${trend}`.trim(), value));
    card.appendChild(el("div", `stock-stat-sub ${trend}`.trim(), sub));
    return card;
  }

  function renderOverview(): void {
    overviewEl.innerHTML = "";
    const data = result?.data;
    // The single base-currency total, plus any currency that couldn't be converted.
    const totals = data?.baseTotals
      ? [
          data.baseTotals,
          ...data.totals.filter((t) => (data.unconvertedCurrencies ?? []).includes(t.currency)),
        ]
      : (data?.totals ?? []);
    overviewEl.hidden = totals.length === 0 || !prefs.enabled;
    const several = totals.length > 1;
    for (const t of totals) {
      const suffix = several ? ` · ${t.currency}` : "";
      overviewEl.appendChild(
        stat(
          `Current value${suffix}`,
          money(t.marketValue, t.currency),
          `Invested ${money(t.invested, t.currency)}`
        )
      );
      overviewEl.appendChild(
        stat(
          `Total gain/loss${suffix}`,
          money(t.unrealizedGain, t.currency, true),
          percent(t.unrealizedGainPercent),
          trendClass(t.unrealizedGain)
        )
      );
      overviewEl.appendChild(
        stat(
          `Today${suffix}`,
          money(t.dayChange, t.currency, true),
          percent(t.dayChangePercent),
          trendClass(t.dayChange)
        )
      );
    }
  }

  function numberCell(label: string, value: string, valueClass = "", note?: string): HTMLElement {
    const cell = el("span", "stock-num");
    cell.appendChild(el("span", "stock-num-label", label));
    cell.appendChild(el("span", valueClass, value));
    if (note) cell.appendChild(el("span", "stock-num-note", note));
    return cell;
  }

  function renderList(): void {
    listEl.innerHTML = "";
    emptyEl.hidden = prefs.positions.length > 0;
    for (const [symbol, lots] of groupedLots()) {
      const single = lots.length === 1;
      const figures: Figures | null = single ? viewFor(lots[0].id) : holdingFor(symbol);
      const row = el("button", "stock-row");
      row.type = "button";

      const who = el("span");
      const symbolLine = el("span", "stock-row-symbol", symbol);
      if (!single) symbolLine.appendChild(el("span", "tag tag-neutral", `${lots.length} lots`));
      if (figures?.status === "stale") symbolLine.appendChild(el("span", "tag tag-neutral", "stale"));
      if (figures?.status === "outdated") symbolLine.appendChild(el("span", "tag tag-neutral", "outdated"));
      if (figures?.usingAlternative && figures.priceSymbol) {
        symbolLine.appendChild(el("span", "tag tag-neutral", `via ${figures.priceSymbol}`));
      }
      if (prefs.enabled && result?.data && (!figures || figures.status === "unavailable")) {
        symbolLine.appendChild(el("span", "tag tag-neutral", "no price"));
      }
      who.appendChild(symbolLine);
      who.appendChild(el("div", "stock-row-name", figures?.companyName ?? lots[0].companyName ?? ""));
      row.appendChild(who);

      const currency = figures?.currency ?? null;
      row.appendChild(numberCell("Price", money(figures?.quote?.price, currency)));
      row.appendChild(
        numberCell("Today", percent(figures?.dayChangePercent), trendClass(figures?.dayChangePercent))
      );
      const fx = conversionFor(figures);
      row.appendChild(
        numberCell(
          "Value",
          money(figures?.marketValue, currency),
          "",
          fx && figures?.marketValue != null
            ? `≈ ${money(figures.marketValue * fx.rate, fx.base)}`
            : undefined
        )
      );
      row.appendChild(
        numberCell(
          "Total return",
          figures?.unrealizedGain !== null && figures?.unrealizedGain !== undefined
            ? `${money(figures.unrealizedGain, currency, true)} (${percent(figures.unrealizedGainPercent)})`
            : "—",
          trendClass(figures?.unrealizedGain)
        )
      );

      row.addEventListener("click", () => (single ? openDetail(lots[0].id) : openHolding(symbol)));
      listEl.appendChild(row);
    }
  }

  /** Lots grouped by symbol, in the order each symbol was first entered. */
  function groupedLots(): Map<string, StockPositionInput[]> {
    const groups = new Map<string, StockPositionInput[]>();
    for (const p of prefs.positions) {
      const group = groups.get(p.symbol);
      if (group) group.push(p);
      else groups.set(p.symbol, [p]);
    }
    return groups;
  }

  function holdingFor(symbol: string): HoldingViewUI | null {
    return result?.data?.holdings?.find((h) => h.symbol === symbol) ?? null;
  }

  // --------------------------------------------------------------- detail

  /** What the detail page shows: a lot's id, or "holding:SYMBOL". */
  function detailKey(): string | null {
    return selectedId ?? (selectedSymbol ? `holding:${selectedSymbol}` : null);
  }

  function openDetail(id: string, fromSymbol: string | null = null): void {
    selectedId = id;
    selectedSymbol = null;
    returnToSymbol = fromSymbol;
    show("detail");
    renderDetail(id);
  }

  function openHolding(symbol: string): void {
    selectedId = null;
    selectedSymbol = symbol;
    returnToSymbol = null;
    show("detail");
    renderHolding(symbol);
  }

  function marketCard(view: Figures | null, symbol: string): HTMLElement {
    const currency = view?.currency ?? null;
    const market = el("div", "stock-detail-card");
    market.appendChild(el("div", "stock-stat-label", "Market"));
    const quote = view?.quote ?? null;
    if (!quote) {
      market.appendChild(
        el(
          "p",
          "feed-empty",
          prefs.enabled
            ? "No price available for this symbol. Check it is written as the market lists it (e.g. ASML.AS)."
            : "Price tracking is off."
        )
      );
      return market;
    }
    if (view?.usingAlternative && view.priceSymbol) {
      market.appendChild(keyValue("Price from", `${view.priceSymbol} (${symbol} has no current price)`));
    }
    market.appendChild(keyValue("Price", money(quote.price, currency)));
    market.appendChild(keyValue("Previous close", money(quote.previousClose, currency)));
    market.appendChild(
      keyValue(
        "Day change",
        `${money(quote.change, currency, true)} (${percent(quote.changePercent)})`,
        trendClass(quote.change)
      )
    );
    market.appendChild(keyValue("Exchange", quote.exchange ?? "—"));
    market.appendChild(keyValue("Price time", dateTime(quote.marketTime)));
    market.appendChild(
      keyValue(
        "Status",
        view?.status === "outdated"
          ? "Not traded recently — listing looks inactive"
          : quote.stale
            ? "From an earlier fetch — may be out of date"
            : "Latest retrieved"
      )
    );
    return market;
  }

  function estimateCard(view: Figures | null, label: string): HTMLElement {
    const currency = view?.currency ?? null;
    const estimate = el("div", "stock-detail-card");
    estimate.appendChild(el("div", "stock-stat-label", label));
    estimate.appendChild(keyValue("Value", money(view?.marketValue, currency)));
    estimate.appendChild(
      keyValue(
        "Unrealized gain/loss",
        money(view?.unrealizedGain, currency, true),
        trendClass(view?.unrealizedGain)
      )
    );
    estimate.appendChild(
      keyValue("Return", percent(view?.unrealizedGainPercent), trendClass(view?.unrealizedGainPercent))
    );
    estimate.appendChild(
      keyValue(
        "Today's change",
        `${money(view?.dayChange, currency, true)} (${percent(view?.dayChangePercent)})`,
        trendClass(view?.dayChange)
      )
    );
    const fx = conversionFor(view);
    if (fx && view?.marketValue != null) {
      estimate.appendChild(keyValue(`Value in ${fx.base}`, money(view.marketValue * fx.rate, fx.base)));
      estimate.appendChild(
        keyValue(
          `Gain/loss in ${fx.base}`,
          money((view.unrealizedGain ?? 0) * fx.rate, fx.base, true),
          trendClass(view.unrealizedGain)
        )
      );
    }
    return estimate;
  }

  function newsBlock(symbol: string, key: string): HTMLElement {
    const newsSection = el("div");
    newsSection.appendChild(el("div", "stock-stat-label", "Recent news"));
    const newsBody = el("div", "stock-news-list");
    newsBody.appendChild(
      el("p", "feed-empty", prefs.newsEnabled ? "Loading headlines…" : "News is switched off.")
    );
    newsSection.appendChild(newsBody);
    if (prefs.newsEnabled) void loadNews(symbol, newsBody, key);
    return newsSection;
  }

  function renderDetail(id: string): void {
    const position = prefs.positions.find((p) => p.id === id);
    if (!position) {
      show("list");
      return;
    }
    const view = viewFor(id);
    const currency = view?.currency ?? null;
    const lotCount = prefs.positions.filter((p) => p.symbol === position.symbol).length;
    detailEl.innerHTML = "";

    const title = view?.companyName ?? position.companyName ?? position.symbol;
    detailEl.appendChild(
      el("h3", undefined, title === position.symbol ? title : `${title} (${position.symbol})`)
    );
    if (lotCount > 1) {
      detailEl.appendChild(
        el(
          "p",
          "setting-note",
          `One of ${lotCount} lots of ${position.symbol}. The holding page adds them together and shows their dividends.`
        )
      );
    }

    const grid = el("div", "stock-detail-grid");
    const yours = el("div", "stock-detail-card");
    yours.appendChild(el("div", "stock-stat-label", lotCount > 1 ? "This lot" : "Your position"));
    if (position.alternativeSymbol)
      yours.appendChild(keyValue("Alternative symbol", position.alternativeSymbol));
    yours.appendChild(keyValue("Shares", new Intl.NumberFormat().format(position.shares)));
    yours.appendChild(keyValue("Average cost", money(position.averageCost, currency)));
    yours.appendChild(keyValue("Purchase date", plainDate(position.purchaseDate)));
    yours.appendChild(keyValue("Invested", money(position.shares * position.averageCost, currency)));
    if (position.notes) yours.appendChild(keyValue("Notes", position.notes));
    grid.appendChild(yours);
    grid.appendChild(marketCard(view, position.symbol));
    grid.appendChild(estimateCard(view, "Estimated from your entries"));
    detailEl.appendChild(grid);

    const actions = el("div", "stock-detail-actions");
    const editBtn = el("button", "btn btn-secondary", "Edit");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => openForm(position));
    actions.appendChild(editBtn);
    actions.appendChild(deleteButton(position));
    detailEl.appendChild(actions);

    if (view?.status === "outdated") {
      const listings = el("div", "stock-listings");
      listings.appendChild(el("div", "stock-stat-label", "Listings that still trade"));
      const body = el("div", "stock-news-list");
      body.appendChild(el("p", "feed-empty", "Looking for this company's current listings…"));
      listings.appendChild(body);
      detailEl.appendChild(listings);
      void loadListings(position, view, body);
    }

    if (lotCount === 1) detailEl.appendChild(dividendSection(position.symbol));
    detailEl.appendChild(newsBlock(position.symbol, id));
  }

  function renderHolding(symbol: string): void {
    const lots = prefs.positions.filter((p) => p.symbol === symbol);
    if (lots.length === 0) {
      selectedSymbol = null;
      show("list");
      return;
    }
    if (lots.length === 1) {
      openDetail(lots[0].id);
      return;
    }
    const holding = holdingFor(symbol);
    const currency = holding?.currency ?? viewFor(lots[0].id)?.currency ?? null;
    const shares = lots.reduce((sum, p) => sum + p.shares, 0);
    const invested = lots.reduce((sum, p) => sum + p.shares * p.averageCost, 0);
    detailEl.innerHTML = "";

    const title = holding?.companyName ?? lots[0].companyName ?? symbol;
    detailEl.appendChild(el("h3", undefined, title === symbol ? title : `${title} (${symbol})`));

    const grid = el("div", "stock-detail-grid");
    const yours = el("div", "stock-detail-card");
    yours.appendChild(el("div", "stock-stat-label", "Your holding"));
    yours.appendChild(keyValue("Lots", String(lots.length)));
    yours.appendChild(keyValue("Total shares", new Intl.NumberFormat().format(shares)));
    yours.appendChild(keyValue("Average cost", money(shares > 0 ? invested / shares : 0, currency)));
    yours.appendChild(keyValue("Invested", money(invested, currency)));
    grid.appendChild(yours);
    grid.appendChild(marketCard(holding, symbol));
    grid.appendChild(estimateCard(holding, "Estimated, all lots"));
    detailEl.appendChild(grid);

    const lotsSection = el("div", "stock-lots");
    lotsSection.appendChild(el("div", "stock-stat-label", "Lots"));
    const list = el("div", "stock-news-list");
    for (const lot of lots) {
      const view = viewFor(lot.id);
      const item = el("button", "stock-news-item");
      item.type = "button";
      item.title = "Open this lot to edit or remove it";
      item.appendChild(
        el(
          "div",
          "stock-news-title",
          `${new Intl.NumberFormat().format(lot.shares)} shares at ${money(lot.averageCost, currency)}`
        )
      );
      const meta = [
        lot.purchaseDate ? `bought ${plainDate(lot.purchaseDate)}` : "no purchase date",
        view?.unrealizedGain != null
          ? `${money(view.unrealizedGain, currency, true)} (${percent(view.unrealizedGainPercent)})`
          : null,
        lot.notes ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
      item.appendChild(el("div", "stock-news-meta", meta));
      item.addEventListener("click", () => openDetail(lot.id, symbol));
      list.appendChild(item);
    }
    lotsSection.appendChild(list);
    detailEl.appendChild(lotsSection);

    detailEl.appendChild(dividendSection(symbol));
    detailEl.appendChild(newsBlock(symbol, `holding:${symbol}`));
  }

  // ------------------------------------------------------------ dividends

  const FREQUENCY_LABELS: Record<string, string> = {
    monthly: "Monthly",
    quarterly: "Quarterly",
    semiannual: "Twice a year",
    annual: "Once a year",
  };

  function rate(value: number): string {
    return `${Number(value.toFixed(3))}%`;
  }

  async function loadDividends(): Promise<void> {
    if (!prefs.enabled || !prefs.dividendsEnabled || prefs.positions.length === 0) {
      dividends = null;
      renderDividendOverview();
      return;
    }
    try {
      dividends = await bridge().getStockDividends();
    } catch {
      dividends = {
        status: "unavailable",
        retrievedAt: null,
        baseCurrency: prefs.baseCurrency,
        holdings: [],
        unavailableSymbols: [],
        base: null,
        unconvertedCurrencies: [],
        taxCountries: [],
      };
    }
    renderDividendOverview();
    // Fill in the open page's dividend section in place, without reloading its news.
    const section = detailEl.querySelector<HTMLElement>(".stock-dividends");
    if (section?.dataset.symbol && !detailView.hidden)
      section.replaceWith(dividendSection(section.dataset.symbol));
  }

  function renderDividendOverview(): void {
    dividendOverviewEl.innerHTML = "";
    const base = dividends?.base ?? null;
    dividendOverviewEl.hidden = !base || !prefs.enabled || !prefs.dividendsEnabled;
    if (!base || !dividends) return;
    const cur = dividends.baseCurrency;
    dividendOverviewEl.appendChild(
      stat(
        `Dividends ${new Date().getFullYear()} · after tax`,
        money(base.thisYear.net, cur),
        `Gross ${money(base.thisYear.gross, cur)} · tax ${money(base.thisYear.foreignTax + base.thisYear.portugueseTax, cur)}`
      )
    );
    dividendOverviewEl.appendChild(
      stat(
        "Next dividend · estimate",
        base.next ? money(base.next.net, cur) : "—",
        base.next
          ? `${base.next.symbol} · ex-date around ${plainDate(base.next.exDate)}`
          : "No regular pattern to project from"
      )
    );
    dividendOverviewEl.appendChild(
      stat(
        "Per year · estimate",
        base.estimatedAnnual ? money(base.estimatedAnnual.net, cur) : "—",
        base.estimatedAnnual
          ? `After tax · gross ${money(base.estimatedAnnual.gross, cur)} at the latest amounts`
          : "Not enough history yet"
      )
    );
  }

  function dividendSection(symbol: string): HTMLElement {
    const section = el("div", "stock-dividends");
    section.dataset.symbol = symbol;
    section.appendChild(el("div", "stock-stat-label", "Dividends"));
    if (!prefs.dividendsEnabled) {
      section.appendChild(el("p", "feed-empty", "Dividends are switched off."));
      return section;
    }
    if (!dividends) {
      section.appendChild(el("p", "feed-empty", "Loading dividends…"));
      return section;
    }
    const d = dividends.holdings.find((h) => h.symbol === symbol);
    if (!d) {
      section.appendChild(el("p", "feed-empty", "Dividend history isn't available right now."));
      return section;
    }
    const cur = d.currency;
    section.appendChild(taxControls(symbol, d));

    const cards = el("div", "stock-detail-grid");
    const got = el("div", "stock-detail-card");
    got.appendChild(el("div", "stock-stat-label", "Received while you held it"));
    got.appendChild(keyValue("Gross", money(d.receivedTotal.gross, cur)));
    got.appendChild(keyValue("Withheld abroad", money(-d.receivedTotal.foreignTax, cur)));
    got.appendChild(keyValue("Portuguese tax", money(-d.receivedTotal.portugueseTax, cur)));
    got.appendChild(keyValue("Net", money(d.receivedTotal.net, cur)));
    got.appendChild(keyValue(`Net in ${new Date().getFullYear()}`, money(d.thisYear.net, cur)));
    cards.appendChild(got);

    const next = el("div", "stock-detail-card");
    next.appendChild(el("div", "stock-stat-label", "Next dividend · estimate"));
    if (d.expected) {
      next.appendChild(keyValue("Ex-date around", plainDate(d.expected.exDate)));
      next.appendChild(keyValue("Per share", money(d.expected.amountPerShare, cur)));
      next.appendChild(keyValue("Gross", money(d.expected.gross, cur)));
      next.appendChild(keyValue("Net", money(d.expected.net, cur)));
    } else {
      next.appendChild(el("p", "feed-empty", "No regular pattern to project from."));
    }
    cards.appendChild(next);

    const yearly = el("div", "stock-detail-card");
    yearly.appendChild(el("div", "stock-stat-label", "Per year · estimate"));
    if (d.estimatedAnnual && d.frequency) {
      yearly.appendChild(keyValue("Pays", FREQUENCY_LABELS[d.frequency] ?? d.frequency));
      yearly.appendChild(keyValue("Gross", money(d.estimatedAnnual.gross, cur)));
      yearly.appendChild(keyValue("Net", money(d.estimatedAnnual.net, cur)));
    } else {
      yearly.appendChild(el("p", "feed-empty", "Not enough dividend history."));
    }
    cards.appendChild(yearly);
    section.appendChild(cards);

    if (d.received.length > 0) {
      const wrap = el("div", "stock-table-wrap");
      const table = el("table", "stock-dividend-table");
      const thead = el("thead");
      const head = el("tr");
      for (const label of [
        "Ex-date",
        "Per share",
        "Shares",
        "Gross",
        "Withheld abroad",
        "Portuguese tax",
        "Net",
      ]) {
        head.appendChild(el("th", undefined, label));
      }
      thead.appendChild(head);
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of d.received.slice(0, 12)) {
        const tr = el("tr");
        for (const value of [
          plainDate(r.exDate),
          money(r.amountPerShare, cur),
          new Intl.NumberFormat().format(r.shares),
          money(r.gross, cur),
          money(r.foreignTax, cur),
          money(r.portugueseTax, cur),
          money(r.net, cur),
        ]) {
          tr.appendChild(el("td", undefined, value));
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      section.appendChild(wrap);
    } else {
      section.appendChild(el("p", "feed-empty", "No dividends went ex while you held these shares."));
    }

    const notes: string[] = [];
    if (d.status === "stale")
      notes.push("Couldn't refresh the dividend history — showing the last one retrieved.");
    if (d.lotsWithoutDate > 0) {
      notes.push(
        `${d.lotsWithoutDate} lot${d.lotsWithoutDate === 1 ? " has" : "s have"} no purchase date, so ${d.lotsWithoutDate === 1 ? "it isn't" : "they aren't"} counted in past dividends.`
      );
    }
    if (d.receivedTotal.reclaimable > 0) {
      notes.push(
        `${money(d.receivedTotal.reclaimable, cur)} was withheld above the treaty rate. Portugal doesn't credit it, but it can usually be reclaimed from ${d.tax.countryName}.`
      );
    }
    if (d.sourceSymbol !== d.symbol) notes.push(`History from ${d.sourceSymbol}, the alternative symbol.`);
    notes.push(
      "Dates are ex-dividend dates: shares held before that day get the dividend, which is usually paid a few days to weeks later. The free data source has no payment dates, so the next dividend is projected from the recent pattern. Taxes are estimates for a Portugal resident at the 28% flat rate — check your broker's statement; foreign dividends are declared in IRS Anexo J."
    );
    section.appendChild(el("p", "setting-note", notes.join(" ")));
    return section;
  }

  function taxControls(symbol: string, d: HoldingDividendsView): HTMLElement {
    const row = el("div", "stock-tax-row");
    const label = el("label", "stock-tax-label");
    label.appendChild(el("span", undefined, "Company's tax country"));
    const select = el("select", "select");
    select.appendChild(
      new Option(
        d.tax.guessed && d.tax.known ? `Guessed: ${d.tax.countryName}` : "Guess from the listing",
        ""
      )
    );
    for (const c of dividends?.taxCountries ?? []) {
      const withheld = c.code === "PT" ? "28% at source" : `${rate(c.withholdingPercent)} withheld`;
      select.appendChild(new Option(`${c.name} — ${withheld}`, c.code));
    }
    select.appendChild(new Option("Custom rate", "CUSTOM"));
    select.value = d.tax.guessed ? "" : d.tax.country;
    label.appendChild(select);
    row.appendChild(label);

    const custom = el("input", "input stock-tax-custom");
    custom.type = "number";
    custom.min = "0";
    custom.max = "100";
    custom.step = "any";
    custom.placeholder = "% withheld";
    custom.hidden = select.value !== "CUSTOM";
    if (d.tax.country === "CUSTOM") custom.value = String(d.tax.withholdingPercent);
    row.appendChild(custom);

    const save = async (setting: DividendTaxSettingView | null): Promise<void> => {
      const next = { ...prefs.dividendTax };
      if (setting) next[symbol] = setting;
      else delete next[symbol];
      try {
        prefs = await bridge().updateStockSettings({ dividendTax: next });
        await loadDividends();
      } catch (err) {
        showError(errorEl, errorText(err));
      }
    };
    select.addEventListener("change", () => {
      custom.hidden = select.value !== "CUSTOM";
      if (select.value === "CUSTOM") {
        custom.focus();
        if (custom.value) void save({ country: "CUSTOM", withholdingPercent: Number(custom.value) });
        return;
      }
      void save(select.value ? { country: select.value } : null);
    });
    custom.addEventListener("change", () => {
      const value = Number(custom.value);
      if (custom.value && Number.isFinite(value) && value >= 0 && value <= 100) {
        void save({ country: "CUSTOM", withholdingPercent: value });
      }
    });

    let summary: string;
    if (!d.tax.known) {
      summary =
        "The listing doesn't say which country the company is from, so foreign withholding is counted as 0% until you choose it. Portugal's 28% still applies.";
    } else if (d.tax.country === "PT") {
      summary = "Portugal: 28% is withheld at source as the final tax.";
    } else {
      summary = `${d.tax.countryName}${d.tax.guessed ? " (guessed from the listing)" : ""}: ${rate(d.tax.withholdingPercent)} withheld at source; Portugal taxes ${rate(d.tax.portuguesePercent)} of the gross and credits foreign tax up to ${rate(d.tax.creditCapPercent)}.`;
    }
    row.appendChild(el("p", "setting-note", summary));
    return row;
  }

  /** Two clicks instead of a confirm() dialog: the first arms it, the second deletes. */
  function deleteButton(position: StockPositionInput): HTMLButtonElement {
    const button = el("button", "btn btn-ghost", "Remove");
    button.type = "button";
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    button.addEventListener("click", async () => {
      if (!armTimer) {
        button.textContent = "Click again to remove";
        armTimer = setTimeout(() => {
          armTimer = null;
          button.textContent = "Remove";
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      armTimer = null;
      try {
        prefs = await bridge().updateStockSettings({
          positions: prefs.positions.filter((p) => p.id !== position.id),
        });
        selectedId = null;
        show("list");
        await load();
      } catch (err) {
        showError(errorEl, `Couldn't remove ${position.symbol}: ${errorText(err)}`);
        show("list");
      }
    });
    return button;
  }

  async function loadListings(
    position: StockPositionInput,
    view: StockPositionView,
    container: HTMLElement
  ): Promise<void> {
    let found: ListingSearchResultView;
    try {
      found = await bridge().findStockListings(position.symbol);
    } catch {
      found = { symbol: position.symbol, status: "unavailable", candidates: [] };
    }
    if (selectedId !== position.id || detailView.hidden) return;
    container.innerHTML = "";
    container.appendChild(
      el(
        "p",
        "setting-note",
        `${position.symbol} last traded ${dateTime(view.quote?.marketTime)}. The same company may trade under another symbol — your broker may show it with the old code.`
      )
    );
    if (found.candidates.length === 0) {
      container.appendChild(
        el("p", "feed-empty", "No other listing found. You can edit the symbol by hand.")
      );
      return;
    }
    for (const c of found.candidates) {
      const row = el("div", "stock-listing");
      const info = el("div");
      info.appendChild(el("div", "stock-news-title", `${c.symbol} · ${c.exchange ?? "unknown exchange"}`));
      const meta = [money(c.price, c.currency), `updated ${dateTime(c.marketTime)}`];
      if (view.currency && c.currency && c.currency !== view.currency) {
        meta.push(`priced in ${c.currency} — update your average cost after switching`);
      }
      info.appendChild(el("div", "stock-news-meta", meta.join(" · ")));
      row.appendChild(info);
      const use = el("button", "btn btn-secondary", "Track this instead");
      use.type = "button";
      use.addEventListener("click", async () => {
        use.disabled = true;
        try {
          prefs = await bridge().updateStockSettings({
            positions: prefs.positions.map((p) => (p.id === position.id ? { ...p, symbol: c.symbol } : p)),
          });
          await load();
          renderDetail(position.id);
        } catch (err) {
          showError(errorEl, errorText(err));
          use.disabled = false;
        }
      });
      const alternative = el("button", "btn btn-ghost", "Use as alternative");
      alternative.type = "button";
      alternative.title = `Keep ${position.symbol}, and take the price from ${c.symbol} whenever ${position.symbol} has none`;
      alternative.addEventListener("click", async () => {
        alternative.disabled = true;
        try {
          prefs = await bridge().updateStockSettings({
            positions: prefs.positions.map((p) =>
              p.id === position.id ? { ...p, alternativeSymbol: c.symbol } : p
            ),
          });
          await load();
          renderDetail(position.id);
        } catch (err) {
          showError(errorEl, errorText(err));
          alternative.disabled = false;
        }
      });
      const buttons = el("div", "stock-listing-actions");
      buttons.appendChild(alternative);
      buttons.appendChild(use);
      row.appendChild(buttons);
      container.appendChild(row);
    }
  }

  async function loadNews(symbol: string, container: HTMLElement, forId: string): Promise<void> {
    let news: StockNewsResultView;
    try {
      news = await bridge().getStockNews(symbol);
    } catch {
      news = { symbol, status: "unavailable", items: [], retrievedAt: null };
    }
    if (detailKey() !== forId || detailView.hidden) return; // the user moved on
    container.innerHTML = "";

    if (news.status === "disabled") {
      container.appendChild(el("p", "feed-empty", "News is switched off."));
      return;
    }
    if (news.status === "unavailable") {
      container.appendChild(el("p", "feed-empty", "News isn't available right now. Prices are unaffected."));
      return;
    }
    if (news.status === "stale") {
      container.appendChild(
        el("p", "setting-note", "Couldn't refresh the news — showing earlier headlines.")
      );
    }
    if (news.items.length === 0) {
      container.appendChild(el("p", "feed-empty", "No recent headlines found."));
      return;
    }
    for (const item of news.items) {
      const link = el("button", "stock-news-item");
      link.type = "button";
      link.title = "Open the article in your browser";
      link.appendChild(el("div", "stock-news-title", item.title));
      const meta = [item.publisher, item.publishedAt ? dateTime(item.publishedAt) : null]
        .filter(Boolean)
        .join(" · ");
      if (meta) link.appendChild(el("div", "stock-news-meta", meta));
      // Through the existing "Open website" action: http(s) only, and in
      // the default browser — never inside NIMBUS's own window.
      link.addEventListener("click", () => {
        void bridge().executeAction("system.openUrl", { url: item.url });
      });
      container.appendChild(link);
    }
  }

  // ----------------------------------------------------------------- form

  function openForm(position?: StockPositionInput): void {
    editingId = position?.id ?? null;
    formHeading.textContent = position ? `Edit ${position.symbol}` : "Add a position";
    symbolInput.value = position?.symbol ?? "";
    altInput.value = position?.alternativeSymbol ?? "";
    nameInput.value = position?.companyName ?? "";
    sharesInput.value = position ? String(position.shares) : "";
    costInput.value = position ? String(position.averageCost) : "";
    dateInput.value = position?.purchaseDate ?? "";
    notesInput.value = position?.notes ?? "";
    formError.hidden = true;
    show("edit");
    symbolInput.focus();
  }

  function closeForm(): void {
    editingId = null;
    if (selectedId && prefs.positions.some((p) => p.id === selectedId)) {
      show("detail");
      renderDetail(selectedId);
    } else {
      show("list");
    }
  }

  async function save(): Promise<void> {
    const symbol = symbolInput.value.trim().toUpperCase();
    const shares = Number(sharesInput.value);
    const averageCost = Number(costInput.value);
    const alternativeSymbol = altInput.value.trim().toUpperCase();
    if (!symbol) return showError(formError, "Enter the stock's symbol, e.g. AAPL.");
    if (alternativeSymbol && alternativeSymbol === symbol) {
      return showError(formError, "The alternative symbol must be different from the symbol.");
    }
    if (!sharesInput.value || !Number.isFinite(shares) || shares <= 0) {
      return showError(formError, "Shares must be a number greater than 0.");
    }
    if (!costInput.value || !Number.isFinite(averageCost) || averageCost < 0) {
      return showError(formError, "Average cost must be a number of 0 or more.");
    }
    formError.hidden = true;

    const position: StockPositionInput = {
      id: editingId ?? `position-${Date.now()}`,
      symbol,
      shares,
      averageCost,
      ...(alternativeSymbol ? { alternativeSymbol } : {}),
      ...(nameInput.value.trim() ? { companyName: nameInput.value.trim() } : {}),
      ...(dateInput.value ? { purchaseDate: dateInput.value } : {}),
      ...(notesInput.value.trim() ? { notes: notesInput.value.trim() } : {}),
    };
    const positions = editingId
      ? prefs.positions.map((p) => (p.id === editingId ? position : p))
      : [...prefs.positions, position];

    saveBtn.disabled = true;
    try {
      prefs = await bridge().updateStockSettings({ positions });
      editingId = null;
      selectedId = position.id;
      await load();
      show("detail");
      renderDetail(position.id);
    } catch (err) {
      showError(formError, errorText(err));
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- wiring

  document.getElementById("newPositionBtn")?.addEventListener("click", () => openForm());
  document.getElementById("savePositionBtn")?.addEventListener("click", () => void save());
  document.getElementById("cancelPositionBtn")?.addEventListener("click", closeForm);
  document.getElementById("backFromPositionFormBtn")?.addEventListener("click", closeForm);
  document.getElementById("backFromStockDetailBtn")?.addEventListener("click", () => {
    if (selectedId && returnToSymbol) {
      openHolding(returnToSymbol);
      return;
    }
    selectedId = null;
    selectedSymbol = null;
    show("list");
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    try {
      await bridge().refreshStocks();
      await load();
    } catch (err) {
      showError(errorEl, `Couldn't refresh: ${errorText(err)}`);
    } finally {
      refreshBtn.disabled = false;
    }
  });

  enabledInput.addEventListener("change", async () => {
    try {
      prefs = await bridge().updateStockSettings({ enabled: enabledInput.checked });
    } catch (err) {
      showError(errorEl, errorText(err));
    }
    await load();
  });
  baseSelect.addEventListener("change", async () => {
    try {
      prefs = await bridge().updateStockSettings({ baseCurrency: baseSelect.value });
    } catch (err) {
      showError(errorEl, errorText(err));
    }
    await load();
  });
  dividendsInput.addEventListener("change", async () => {
    try {
      prefs = await bridge().updateStockSettings({ dividendsEnabled: dividendsInput.checked });
    } catch (err) {
      showError(errorEl, errorText(err));
    }
    dividends = null;
    render();
    void loadDividends();
  });
  newsInput.addEventListener("change", async () => {
    try {
      prefs = await bridge().updateStockSettings({ newsEnabled: newsInput.checked });
    } catch (err) {
      showError(errorEl, errorText(err));
    }
    render();
  });

  // Catch up whenever the tab is opened, like the Tasks tab does.
  document.querySelector('.side-link[data-tab="stocks"]')?.addEventListener("click", () => void load());

  void load();
}
