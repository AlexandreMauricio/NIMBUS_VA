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
  leverage?: number;
  exposure?: number | null;
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
  leverage?: number;
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
  closedPositions: ClosedPositionInput[];
  irs: { gainsCode: string; counterpartyCountry: string };
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
  | "leverage"
  | "exposure"
>;

interface HoldingViewUI extends Figures {
  symbol: string;
  lotIds: string[];
  shares: number;
  averageCost: number;
  invested: number;
  leveraged?: boolean;
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

interface ClosedPositionInput {
  id: string;
  symbol: string;
  companyName?: string;
  alternativeSymbol?: string;
  leverage?: number;
  shares: number;
  averageCost: number;
  purchaseDate: string;
  closeDate: string;
  closePrice: number;
  fees?: number;
  currency: string;
  notes?: string;
}

interface IrsReportView {
  year: number;
  dividends: {
    code: string;
    rows: {
      countryCode: string;
      countryName: string;
      gross: number;
      taxAbroad: number;
      taxPortugal: number;
      dividends: number;
      symbols: string[];
    }[];
    domestic: { gross: number; taxPortugal: number } | null;
    unknownCountrySymbols: string[];
    missingRates: string[];
  };
  gains: {
    code: string;
    counterpartyCountry: string;
    rows: {
      id: string;
      symbol: string;
      leverage: number;
      acquisitionDate: string;
      acquisitionValue: number;
      realizationDate: string;
      realizationValue: number;
      fees: number;
      gain: number;
    }[];
    groups: {
      code: string;
      sourceCountry: string | null;
      sourceCountryName: string;
      counterpartyCountry: string;
      gain: number;
      taxAbroad: number;
    }[];
    unknownCountrySymbols: string[];
    missingRates: string[];
  };
  unavailableSymbols: string[];
  availableYears: number[];
}

interface DividendTaxSettingView {
  country: string;
  withholdingPercent?: number;
}

interface StocksBridge {
  getStockDividends(): Promise<StockDividendsView>;
  closeStockPosition(request: {
    positionId: string;
    shares: number;
    closeDate: string;
    closePrice: number;
    currency: string;
    fees?: number;
    companyName?: string;
    notes?: string;
  }): Promise<StockPreferencesView>;
  getStockIrsReport(year: number): Promise<IrsReportView>;
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

// ------------------------------------------------------------- list view

const SORTS: { id: string; label: string; descending: boolean }[] = [
  { id: "value", label: "Value", descending: true },
  { id: "today", label: "Today's move", descending: true },
  { id: "returnPct", label: "Total return %", descending: true },
  { id: "return", label: "Total return", descending: true },
  { id: "name", label: "Name", descending: false },
  { id: "symbol", label: "Symbol", descending: false },
  { id: "added", label: "Order added", descending: false },
];

/** How the list is sorted and whether it is folded are per-device conveniences, so they live in localStorage. */
/** Today's plain local date, "YYYY-MM-DD". */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readView(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`nimbus.stocks.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeView(key: string, value: string): void {
  try {
    localStorage.setItem(`nimbus.stocks.${key}`, value);
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
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
  const listHeader = document.getElementById("stockListHeader") as HTMLElement;
  const listToggle = document.getElementById("stockListToggle") as HTMLButtonElement;
  const listCount = document.getElementById("stockListCount") as HTMLElement;
  const sortControls = document.getElementById("stockSortControls") as HTMLElement;
  const sortSelect = document.getElementById("stockSort") as HTMLSelectElement;
  const sortDirBtn = document.getElementById("stockSortDir") as HTMLButtonElement;
  const closeView = document.getElementById("stockCloseView") as HTMLElement;
  const closeHeading = document.getElementById("stockCloseHeading") as HTMLElement;
  const closeSharesInput = document.getElementById("stockCloseShares") as HTMLInputElement;
  const closeDateInput = document.getElementById("stockCloseDate") as HTMLInputElement;
  const closePriceInput = document.getElementById("stockClosePrice") as HTMLInputElement;
  const closeCurrencyInput = document.getElementById("stockCloseCurrency") as HTMLInputElement;
  const closeFeesInput = document.getElementById("stockCloseFees") as HTMLInputElement;
  const closeNotesInput = document.getElementById("stockCloseNotes") as HTMLInputElement;
  const closeError = document.getElementById("stockCloseError") as HTMLElement;
  const saveCloseBtn = document.getElementById("saveCloseBtn") as HTMLButtonElement;
  const closedSection = document.getElementById("stockClosedSection") as HTMLDetailsElement;
  const closedCount = document.getElementById("stockClosedCount") as HTMLElement;
  const closedYearSelect = document.getElementById("stockClosedYear") as HTMLSelectElement;
  const closedTotals = document.getElementById("stockClosedTotals") as HTMLElement;
  const closedList = document.getElementById("stockClosedList") as HTMLElement;
  const irsSection = document.getElementById("stockIrsSection") as HTMLDetailsElement;
  const irsYearSelect = document.getElementById("stockIrsYear") as HTMLSelectElement;
  const irsGainsCode = document.getElementById("stockIrsGainsCode") as HTMLInputElement;
  const irsCounterparty = document.getElementById("stockIrsCounterparty") as HTMLInputElement;
  const irsCopyBtn = document.getElementById("stockIrsCopy") as HTMLButtonElement;
  const irsBody = document.getElementById("stockIrsBody") as HTMLElement;

  const formHeading = document.getElementById("positionFormHeading") as HTMLElement;
  const symbolInput = document.getElementById("positionSymbol") as HTMLInputElement;
  const altInput = document.getElementById("positionAltSymbol") as HTMLInputElement;
  const leverageInput = document.getElementById("positionLeverage") as HTMLInputElement;
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
    closedPositions: [],
    irs: { gainsCode: "G30", counterpartyCountry: "196" },
    positions: [],
  };
  let result: StockProviderResultView | undefined;
  let selectedId: string | null = null;
  /** The holding page being shown, when it is a holding of several lots rather than one lot. */
  let selectedSymbol: string | null = null;
  /** A lot opened from its holding page goes back there. */
  let returnToSymbol: string | null = null;
  let dividends: StockDividendsView | null = null;
  const savedSort = readView("sort", "value");
  let sortKey = SORTS.some((s) => s.id === savedSort) ? savedSort : "value";
  let sortDesc =
    readView("sortDescending", String(SORTS.find((s) => s.id === sortKey)!.descending)) === "true";
  let listCollapsed = readView("collapsed", "false") === "true";
  /** The closed position whose page is open. */
  let selectedClosedId: string | null = null;
  /** The open lot the close form is recording a sale of. */
  let closingId: string | null = null;
  let closingName: string | null = null;
  let closedYear = "all";
  let irsYear = new Date().getFullYear();
  let irsTables: { title: string; rows: string[][] }[] = [];
  let editingId: string | null = null;

  function show(view: "list" | "detail" | "edit" | "close"): void {
    listView.hidden = view !== "list";
    detailView.hidden = view !== "detail";
    editView.hidden = view !== "edit";
    closeView.hidden = view !== "close";
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
    if (irsSection.open) void loadIrs();
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
    renderClosedList();
    if (!detailView.hidden) {
      if (selectedId) renderDetail(selectedId);
      else if (selectedSymbol) renderHolding(selectedSymbol);
      else if (selectedClosedId) renderClosedDetail(selectedClosedId);
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
    const entries = sortedEntries();
    renderListHeader(entries.length);
    if (listCollapsed) return;
    for (const { symbol, lots, figures } of entries) {
      const single = lots.length === 1;
      const row = el("button", "stock-row");
      row.type = "button";

      const who = el("span");
      const symbolLine = el("span", "stock-row-symbol", symbol);
      if (!single) symbolLine.appendChild(el("span", "tag tag-neutral", `${lots.length} lots`));
      const leverages = [...new Set(lots.map((l) => (l.leverage && l.leverage > 1 ? l.leverage : 1)))];
      if (leverages.some((l) => l > 1)) {
        symbolLine.appendChild(
          el("span", "tag tag-neutral", leverages.length === 1 ? `CFD ×${leverages[0]}` : "leveraged")
        );
      }
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

  type ListEntry = { symbol: string; lots: StockPositionInput[]; figures: Figures | null; index: number };

  /**
   * The holdings in the chosen order. Amounts are compared in the base
   * currency, so a dollar position and a euro one sort fairly. Anything
   * without the figure (no price yet) always goes last.
   */
  function sortedEntries(): ListEntry[] {
    const entries: ListEntry[] = [...groupedLots()].map(([symbol, lots], index) => ({
      symbol,
      lots,
      index,
      figures: lots.length === 1 ? viewFor(lots[0].id) : holdingFor(symbol),
    }));
    const inBase = (e: ListEntry, value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : value * (conversionFor(e.figures)?.rate ?? 1);
    const key = (e: ListEntry): number | string | null => {
      const f = e.figures;
      switch (sortKey) {
        case "today":
          return f?.dayChangePercent ?? null;
        case "returnPct":
          return f?.unrealizedGainPercent ?? null;
        case "return":
          return inBase(e, f?.unrealizedGain);
        case "name":
          return (f?.companyName ?? e.lots[0].companyName ?? e.symbol).toLowerCase();
        case "symbol":
          return e.symbol;
        case "added":
          return e.index;
        default:
          return inBase(e, f?.marketValue);
      }
    };
    return entries.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === null || kb === null) return ka === kb ? a.index - b.index : ka === null ? 1 : -1;
      const order =
        typeof ka === "string" && typeof kb === "string" ? ka.localeCompare(kb) : Number(ka) - Number(kb);
      return (sortDesc ? -order : order) || a.index - b.index;
    });
  }

  function renderListHeader(holdingCount: number): void {
    listHeader.hidden = prefs.positions.length === 0;
    listEl.hidden = listCollapsed;
    sortControls.hidden = listCollapsed;
    listToggle.setAttribute("aria-expanded", String(!listCollapsed));
    listToggle.title = listCollapsed ? "Show the positions" : "Hide the positions";
    const lots = prefs.positions.length;
    listCount.textContent = `${holdingCount} holding${holdingCount === 1 ? "" : "s"}${
      lots > holdingCount ? ` · ${lots} lots` : ""
    }`;
    sortSelect.value = sortKey;
    sortDirBtn.textContent = sortDesc ? "↓" : "↑";
    sortDirBtn.title = "Reverse the order";
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
    selectedClosedId = null;
    returnToSymbol = fromSymbol;
    show("detail");
    renderDetail(id);
  }

  function openHolding(symbol: string): void {
    selectedId = null;
    selectedSymbol = symbol;
    selectedClosedId = null;
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
    if (view?.leverage && view.leverage > 1 && view.exposure != null) {
      estimate.appendChild(keyValue("Exposure now", money(view.exposure, currency)));
    }
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
    const leverage = position.leverage && position.leverage > 1 ? position.leverage : 1;
    if (leverage > 1) yours.appendChild(keyValue("Leverage", `×${leverage} (CFD)`));
    yours.appendChild(
      keyValue(leverage > 1 ? "Units" : "Shares", new Intl.NumberFormat().format(position.shares))
    );
    yours.appendChild(
      keyValue(leverage > 1 ? "Open price" : "Average cost", money(position.averageCost, currency))
    );
    yours.appendChild(keyValue("Purchase date", plainDate(position.purchaseDate)));
    yours.appendChild(
      keyValue(
        leverage > 1 ? "Invested (margin)" : "Invested",
        money((position.shares * position.averageCost) / leverage, currency)
      )
    );
    if (leverage > 1) {
      yours.appendChild(
        keyValue("Exposure at open", money(position.shares * position.averageCost, currency))
      );
    }
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
    const closeBtn = el("button", "btn btn-secondary", "Close position");
    closeBtn.type = "button";
    closeBtn.title = "Record a sale you made at your broker";
    closeBtn.addEventListener("click", () => openCloseForm(position, view));
    actions.appendChild(closeBtn);
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
    const invested = lots.reduce(
      (sum, p) => sum + (p.shares * p.averageCost) / (p.leverage && p.leverage > 1 ? p.leverage : 1),
      0
    );
    const costBasis = lots.reduce((sum, p) => sum + p.shares * p.averageCost, 0);
    detailEl.innerHTML = "";

    const title = holding?.companyName ?? lots[0].companyName ?? symbol;
    detailEl.appendChild(el("h3", undefined, title === symbol ? title : `${title} (${symbol})`));

    const grid = el("div", "stock-detail-grid");
    const yours = el("div", "stock-detail-card");
    yours.appendChild(el("div", "stock-stat-label", "Your holding"));
    yours.appendChild(keyValue("Lots", String(lots.length)));
    yours.appendChild(keyValue("Total shares", new Intl.NumberFormat().format(shares)));
    yours.appendChild(keyValue("Average cost", money(shares > 0 ? costBasis / shares : 0, currency)));
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

  // --------------------------------------------------------------- closing

  function openCloseForm(position: StockPositionInput, view: StockPositionView | null): void {
    closingId = position.id;
    closingName = view?.companyName && view.companyName !== position.symbol ? view.companyName : null;
    closeHeading.textContent = `Close ${position.symbol}`;
    closeSharesInput.value = String(position.shares);
    closeSharesInput.max = String(position.shares);
    closeDateInput.value = localToday();
    closePriceInput.value = view?.quote ? String(view.quote.price) : "";
    closeCurrencyInput.value = view?.currency ?? "";
    closeFeesInput.value = "";
    closeNotesInput.value = "";
    closeError.hidden = true;
    if (!position.purchaseDate) {
      showError(
        closeError,
        "This position has no purchase date. Add it first (Edit) — the IRS asks for it with every sale."
      );
    }
    show("close");
    closePriceInput.focus();
  }

  function leaveCloseForm(): void {
    const id = closingId;
    closingId = null;
    if (id && prefs.positions.some((p) => p.id === id)) openDetail(id);
    else show("list");
  }

  async function saveClose(): Promise<void> {
    if (!closingId) return;
    const shares = Number(closeSharesInput.value);
    const closePrice = Number(closePriceInput.value);
    const fees = closeFeesInput.value ? Number(closeFeesInput.value) : undefined;
    const typed = closeCurrencyInput.value.trim();
    const currency = /^(GBp|ZAc|ILA)$/.test(typed) ? typed : typed.toUpperCase();
    if (!closeSharesInput.value || !Number.isFinite(shares) || shares <= 0) {
      return showError(closeError, "Enter how many shares or units you sold.");
    }
    if (!closeDateInput.value) return showError(closeError, "Enter the date you sold.");
    if (!closePriceInput.value || !Number.isFinite(closePrice) || closePrice < 0) {
      return showError(closeError, "Enter the price per share you sold at.");
    }
    if (!/^[A-Za-z]{3}$/.test(currency))
      return showError(closeError, "Enter the currency as a code such as USD.");
    if (fees !== undefined && (!Number.isFinite(fees) || fees < 0)) {
      return showError(closeError, "Fees must be a number of 0 or more.");
    }
    closeError.hidden = true;
    saveCloseBtn.disabled = true;
    try {
      prefs = await bridge().closeStockPosition({
        positionId: closingId,
        shares,
        closeDate: closeDateInput.value,
        closePrice,
        currency,
        ...(fees !== undefined ? { fees } : {}),
        ...(closingName ? { companyName: closingName } : {}),
        ...(closeNotesInput.value.trim() ? { notes: closeNotesInput.value.trim() } : {}),
      });
      closingId = null;
      selectedId = null;
      selectedSymbol = null;
      returnToSymbol = null;
      closedSection.open = true;
      show("list");
      await load();
    } catch (err) {
      showError(closeError, errorText(err));
    } finally {
      saveCloseBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------- closed list

  function realized(c: ClosedPositionInput): { gain: number; invested: number; percent: number | null } {
    const leverage = c.leverage && c.leverage > 1 ? c.leverage : 1;
    const invested = (c.shares * c.averageCost) / leverage;
    const gain = c.shares * (c.closePrice - c.averageCost) - (c.fees ?? 0);
    return { gain, invested, percent: invested > 0 ? (gain / invested) * 100 : null };
  }

  function renderClosedList(): void {
    const closed = prefs.closedPositions ?? [];
    closedSection.hidden = closed.length === 0;
    closedCount.textContent = `Closed positions · ${closed.length}`;
    const years = [...new Set(closed.map((c) => c.closeDate.slice(0, 4)))].sort().reverse();
    if (closedYear !== "all" && !years.includes(closedYear)) closedYear = "all";
    closedYearSelect.innerHTML = "";
    closedYearSelect.appendChild(new Option("All years", "all"));
    for (const year of years) closedYearSelect.appendChild(new Option(year, year));
    closedYearSelect.value = closedYear;

    const shown = closed
      .filter((c) => closedYear === "all" || c.closeDate.startsWith(closedYear))
      .sort((a, b) => b.closeDate.localeCompare(a.closeDate));
    const byCurrency = new Map<string, number>();
    for (const c of shown) byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + realized(c).gain);
    closedTotals.textContent =
      shown.length === 0
        ? ""
        : `Realized ${closedYear === "all" ? "in total" : `in ${closedYear}`}: ${[...byCurrency]
            .map(([cur, value]) => money(value, cur, true))
            .join(" · ")} — before tax, in each position's currency. The IRS helper converts to euros.`;

    closedList.innerHTML = "";
    for (const c of shown) {
      const r = realized(c);
      const row = el("button", "stock-row");
      row.type = "button";
      const who = el("span");
      const line = el("span", "stock-row-symbol", c.symbol);
      if (c.leverage && c.leverage > 1) line.appendChild(el("span", "tag tag-neutral", `CFD ×${c.leverage}`));
      who.appendChild(line);
      who.appendChild(el("div", "stock-row-name", c.companyName ?? ""));
      row.appendChild(who);
      row.appendChild(numberCell("Closed", plainDate(c.closeDate)));
      row.appendChild(
        numberCell(
          c.leverage && c.leverage > 1 ? "Units" : "Shares",
          new Intl.NumberFormat().format(c.shares)
        )
      );
      row.appendChild(numberCell("Sold at", money(c.closePrice, c.currency)));
      row.appendChild(
        numberCell(
          "Realized",
          `${money(r.gain, c.currency, true)} (${percent(r.percent)})`,
          trendClass(r.gain)
        )
      );
      row.addEventListener("click", () => openClosed(c.id));
      closedList.appendChild(row);
    }
  }

  function openClosed(id: string): void {
    selectedClosedId = id;
    selectedId = null;
    selectedSymbol = null;
    returnToSymbol = null;
    show("detail");
    renderClosedDetail(id);
  }

  /** Two clicks instead of a confirm() dialog: the first arms it, the second acts. */
  function twoClickButton(label: string, action: () => Promise<void>): HTMLButtonElement {
    const button = el("button", "btn btn-ghost", label);
    button.type = "button";
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    button.addEventListener("click", async () => {
      if (!armTimer) {
        button.textContent = "Click again to confirm";
        armTimer = setTimeout(() => {
          armTimer = null;
          button.textContent = label;
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      armTimer = null;
      await action();
    });
    return button;
  }

  function renderClosedDetail(id: string): void {
    const c = (prefs.closedPositions ?? []).find((p) => p.id === id);
    if (!c) {
      selectedClosedId = null;
      show("list");
      return;
    }
    const r = realized(c);
    const leverage = c.leverage && c.leverage > 1 ? c.leverage : 1;
    const cur = c.currency;
    detailEl.innerHTML = "";
    detailEl.appendChild(
      el("h3", undefined, `${c.companyName ? `${c.companyName} (${c.symbol})` : c.symbol} — closed`)
    );

    const grid = el("div", "stock-detail-grid");
    const trade = el("div", "stock-detail-card");
    trade.appendChild(el("div", "stock-stat-label", "The trade"));
    if (leverage > 1) trade.appendChild(keyValue("Leverage", `×${leverage} (CFD)`));
    trade.appendChild(keyValue(leverage > 1 ? "Units" : "Shares", new Intl.NumberFormat().format(c.shares)));
    trade.appendChild(keyValue("Bought", plainDate(c.purchaseDate)));
    trade.appendChild(keyValue(leverage > 1 ? "Open price" : "Average cost", money(c.averageCost, cur)));
    trade.appendChild(keyValue("Sold", plainDate(c.closeDate)));
    trade.appendChild(keyValue("Close price", money(c.closePrice, cur)));
    trade.appendChild(keyValue("Fees", money(c.fees ?? 0, cur)));
    const days = Math.round((Date.parse(c.closeDate) - Date.parse(c.purchaseDate)) / 86_400_000);
    trade.appendChild(keyValue("Held", `${days} day${days === 1 ? "" : "s"}`));
    if (c.notes) trade.appendChild(keyValue("Notes", c.notes));
    grid.appendChild(trade);

    const outcome = el("div", "stock-detail-card");
    outcome.appendChild(el("div", "stock-stat-label", "Result"));
    outcome.appendChild(keyValue(leverage > 1 ? "Invested (margin)" : "Invested", money(r.invested, cur)));
    outcome.appendChild(keyValue("Bought for", money(c.shares * c.averageCost, cur)));
    outcome.appendChild(keyValue("Sold for", money(c.shares * c.closePrice, cur)));
    outcome.appendChild(keyValue("Realized gain/loss", money(r.gain, cur, true), trendClass(r.gain)));
    outcome.appendChild(keyValue("Return", percent(r.percent), trendClass(r.percent)));
    grid.appendChild(outcome);
    detailEl.appendChild(grid);

    const actions = el("div", "stock-detail-actions");
    const reopen = el("button", "btn btn-secondary", "Reopen");
    reopen.type = "button";
    reopen.title = "Move these shares back to your open positions";
    reopen.addEventListener("click", async () => {
      const lot: StockPositionInput = {
        id: `position-${Date.now()}`,
        symbol: c.symbol,
        shares: c.shares,
        averageCost: c.averageCost,
        purchaseDate: c.purchaseDate,
        ...(c.companyName ? { companyName: c.companyName } : {}),
        ...(c.alternativeSymbol ? { alternativeSymbol: c.alternativeSymbol } : {}),
        ...(leverage > 1 ? { leverage } : {}),
        ...(c.notes ? { notes: c.notes } : {}),
      };
      try {
        prefs = await bridge().updateStockSettings({
          positions: [...prefs.positions, lot],
          closedPositions: prefs.closedPositions.filter((p) => p.id !== c.id),
        });
        selectedClosedId = null;
        await load();
        openDetail(lot.id);
      } catch (err) {
        showError(errorEl, errorText(err));
      }
    });
    actions.appendChild(reopen);
    actions.appendChild(
      twoClickButton("Remove", async () => {
        try {
          prefs = await bridge().updateStockSettings({
            closedPositions: prefs.closedPositions.filter((p) => p.id !== c.id),
          });
          selectedClosedId = null;
          show("list");
          await load();
        } catch (err) {
          showError(errorEl, errorText(err));
        }
      })
    );
    detailEl.appendChild(actions);
    detailEl.appendChild(
      el(
        "p",
        "setting-note",
        "Reopen moves the shares back to your open positions. Remove deletes this record from NIMBUS only — nothing changes at your broker."
      )
    );
  }

  // ------------------------------------------------------------ IRS helper

  function fillIrsYears(years: number[]): void {
    const list = [...new Set([...years, irsYear])].sort((a, b) => b - a);
    irsYearSelect.innerHTML = "";
    for (const year of list) irsYearSelect.appendChild(new Option(String(year), String(year)));
    irsYearSelect.value = String(irsYear);
  }

  async function loadIrs(): Promise<void> {
    irsGainsCode.value = prefs.irs?.gainsCode ?? "G30";
    irsCounterparty.value = prefs.irs?.counterpartyCountry ?? "196";
    irsBody.innerHTML = "";
    irsBody.appendChild(el("p", "feed-empty", "Preparing…"));
    let report: IrsReportView;
    try {
      report = await bridge().getStockIrsReport(irsYear);
    } catch (err) {
      irsBody.innerHTML = "";
      irsBody.appendChild(el("p", "feed-empty", `Couldn't prepare the figures: ${errorText(err)}`));
      return;
    }
    fillIrsYears(report.availableYears);
    renderIrs(report);
  }

  /** A table on screen, also kept as plain rows for "Copy tables". */
  function irsTable(title: string, headers: string[], shown: string[][], copied: string[][]): HTMLElement {
    irsTables.push({ title, rows: [headers, ...copied] });
    const wrap = el("div", "stock-table-wrap");
    const table = el("table", "stock-dividend-table");
    const thead = el("thead");
    const head = el("tr");
    for (const label of headers) head.appendChild(el("th", undefined, label));
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const row of shown) {
      const tr = el("tr");
      for (const value of row) tr.appendChild(el("td", undefined, value));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function renderIrs(r: IrsReportView): void {
    const eur = (value: number) => money(value, "EUR");
    const plain = (value: number) => value.toFixed(2);
    irsTables = [];
    irsBody.innerHTML = "";

    const d = r.dividends;
    irsBody.appendChild(el("h4", "stock-irs-heading", "Capital income · dividends (Quadro 8A)"));
    if (d.rows.length > 0) {
      irsBody.appendChild(
        irsTable(
          `Dividends ${r.year} (Anexo J, Quadro 8A)`,
          ["Income code", "Source country", "Gross income", "Tax paid abroad", "Tax withheld in Portugal"],
          d.rows.map((row) => [
            d.code,
            `${row.countryCode} · ${row.countryName}`,
            eur(row.gross),
            eur(row.taxAbroad),
            eur(row.taxPortugal),
          ]),
          d.rows.map((row) => [
            d.code,
            row.countryCode,
            plain(row.gross),
            plain(row.taxAbroad),
            plain(row.taxPortugal),
          ])
        )
      );
      irsBody.appendChild(
        el(
          "p",
          "setting-note",
          d.rows
            .map(
              (row) =>
                `${row.countryCode}: ${row.symbols.join(", ")} (${row.dividends} dividend${row.dividends === 1 ? "" : "s"})`
            )
            .join(" · ")
        )
      );
    } else {
      irsBody.appendChild(el("p", "feed-empty", `No foreign dividends found for ${r.year}.`));
    }
    const dividendNotes: string[] = [];
    if (d.domestic) {
      dividendNotes.push(
        `Portuguese dividends (${eur(d.domestic.gross)} gross, ${eur(d.domestic.taxPortugal)} withheld) aren't declared in Anexo J — the 28% withheld at source is final unless you opt to aggregate.`
      );
    }
    if (d.unknownCountrySymbols.length > 0) {
      dividendNotes.push(
        `Left out until you choose the company's tax country on its page: ${d.unknownCountrySymbols.join(", ")}.`
      );
    }
    if (r.unavailableSymbols.length > 0) {
      dividendNotes.push(`Dividend history unavailable right now for ${r.unavailableSymbols.join(", ")}.`);
    }
    if (d.missingRates.length > 0) {
      dividendNotes.push(`No exchange rate for ${d.missingRates.join(", ")} — those dividends are left out.`);
    }
    if (dividendNotes.length > 0) irsBody.appendChild(el("p", "setting-note", dividendNotes.join(" ")));

    const g = r.gains;
    irsBody.appendChild(el("h4", "stock-irs-heading", "Capital gains · closed positions (Quadro 9.2)"));
    if (g.rows.length > 0) {
      irsBody.appendChild(
        irsTable(
          `Capital gains ${r.year} (Anexo J, Quadro 9.2)`,
          [
            "Income code",
            "Source country",
            "Gross income (gain/loss)",
            "Tax paid abroad",
            "Counterparty country",
          ],
          g.groups.map((x) => [
            x.code,
            x.sourceCountry ? `${x.sourceCountry} · ${x.sourceCountryName}` : "Unknown",
            eur(x.gain),
            eur(x.taxAbroad),
            x.counterpartyCountry,
          ]),
          g.groups.map((x) => [
            x.code,
            x.sourceCountry ?? "",
            plain(x.gain),
            plain(x.taxAbroad),
            x.counterpartyCountry,
          ])
        )
      );
      irsBody.appendChild(
        irsTable(
          `Closed positions ${r.year}`,
          ["Symbol", "Bought", "Acquisition value", "Sold", "Realization value", "Fees", "Gain/loss"],
          g.rows.map((x) => [
            x.leverage > 1 ? `${x.symbol} (CFD ×${x.leverage})` : x.symbol,
            plainDate(x.acquisitionDate),
            eur(x.acquisitionValue),
            plainDate(x.realizationDate),
            eur(x.realizationValue),
            eur(x.fees),
            eur(x.gain),
          ]),
          g.rows.map((x) => [
            x.symbol,
            x.acquisitionDate,
            plain(x.acquisitionValue),
            x.realizationDate,
            plain(x.realizationValue),
            plain(x.fees),
            plain(x.gain),
          ])
        )
      );
    } else {
      irsBody.appendChild(el("p", "feed-empty", `No positions closed in ${r.year}.`));
    }
    const gainNotes: string[] = [];
    if (g.unknownCountrySymbols.length > 0) {
      gainNotes.push(
        `Source country unknown for ${g.unknownCountrySymbols.join(", ")} — choose it on the holding's page.`
      );
    }
    if (g.missingRates.length > 0) {
      gainNotes.push(`No exchange rate for ${g.missingRates.join(", ")} — those sales are left out.`);
    }
    if (g.rows.some((x) => x.leverage > 1)) {
      gainNotes.push(
        "For CFDs the acquisition and realization values are the full exposure (units × price)."
      );
    }
    if (gainNotes.length > 0) irsBody.appendChild(el("p", "setting-note", gainNotes.join(" ")));

    irsBody.appendChild(
      el(
        "p",
        "setting-note",
        "A helper for filling in Anexo J, not tax advice. Euro amounts use Yahoo Finance's exchange rate for each date (the last one before, on weekends); dividends use the ex-dividend date, since payment dates aren't available. The codes are the ones set above — compare everything with your broker's annual tax statement before submitting."
      )
    );
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
    if (prefs.positions.some((p) => p.symbol === symbol && p.leverage && p.leverage > 1)) {
      section.appendChild(el("p", "feed-empty", "Dividends aren't tracked for leveraged (CFD) positions."));
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
    leverageInput.value = position?.leverage ? String(position.leverage) : "";
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
    const leverage = leverageInput.value ? Number(leverageInput.value) : 1;
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) {
      return showError(
        formError,
        "Leverage must be a number from 1 to 100 — leave it empty for shares you own."
      );
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
      ...(leverage > 1 ? { leverage } : {}),
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
    if (selectedClosedId) {
      selectedClosedId = null;
      show("list");
      return;
    }
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
  document.getElementById("saveCloseBtn")?.addEventListener("click", () => void saveClose());
  document.getElementById("cancelCloseBtn")?.addEventListener("click", leaveCloseForm);
  document.getElementById("backFromCloseFormBtn")?.addEventListener("click", leaveCloseForm);
  closedYearSelect.addEventListener("change", () => {
    closedYear = closedYearSelect.value;
    renderClosedList();
  });
  irsSection.addEventListener("toggle", () => {
    if (irsSection.open) void loadIrs();
  });
  irsYearSelect.addEventListener("change", () => {
    irsYear = Number(irsYearSelect.value);
    void loadIrs();
  });
  const saveIrsCodes = async (): Promise<void> => {
    const gainsCode = irsGainsCode.value.trim().toUpperCase();
    const counterpartyCountry = irsCounterparty.value.trim();
    if (!/^[A-Z]\d{2}$/.test(gainsCode) || !/^\d{3}$/.test(counterpartyCountry)) {
      showError(errorEl, "Use an income code like G30 and a three-digit country code like 196.");
      return;
    }
    try {
      prefs = await bridge().updateStockSettings({ irs: { gainsCode, counterpartyCountry } });
      errorEl.hidden = true;
      await loadIrs();
    } catch (err) {
      showError(errorEl, errorText(err));
    }
  };
  irsGainsCode.addEventListener("change", () => void saveIrsCodes());
  irsCounterparty.addEventListener("change", () => void saveIrsCodes());
  irsCopyBtn.addEventListener("click", async () => {
    const text = irsTables
      .map((t) => [t.title, ...t.rows.map((row) => row.join("\t"))].join("\n"))
      .join("\n\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      irsCopyBtn.textContent = "Copied";
      setTimeout(() => (irsCopyBtn.textContent = "Copy tables"), 2000);
    } catch {
      showError(errorEl, "Couldn't copy to the clipboard.");
    }
  });
  fillIrsYears([]);

  for (const option of SORTS) sortSelect.appendChild(new Option(option.label, option.id));
  sortSelect.addEventListener("change", () => {
    sortKey = sortSelect.value;
    sortDesc = SORTS.find((option) => option.id === sortKey)?.descending ?? true;
    writeView("sort", sortKey);
    writeView("sortDescending", String(sortDesc));
    renderList();
  });
  sortDirBtn.addEventListener("click", () => {
    sortDesc = !sortDesc;
    writeView("sortDescending", String(sortDesc));
    renderList();
  });
  listToggle.addEventListener("click", () => {
    listCollapsed = !listCollapsed;
    writeView("collapsed", String(listCollapsed));
    renderList();
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
