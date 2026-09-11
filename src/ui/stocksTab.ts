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
}

interface StockPositionView {
  id: string;
  symbol: string;
  companyName: string;
  shares: number;
  averageCost: number;
  purchaseDate: string | null;
  notes: string | null;
  currency: string | null;
  quote: StockQuoteView | null;
  status: "live" | "stale" | "unavailable";
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
  unpricedCount: number;
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

interface StocksBridge {
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

  const formHeading = document.getElementById("positionFormHeading") as HTMLElement;
  const symbolInput = document.getElementById("positionSymbol") as HTMLInputElement;
  const nameInput = document.getElementById("positionName") as HTMLInputElement;
  const sharesInput = document.getElementById("positionShares") as HTMLInputElement;
  const costInput = document.getElementById("positionCost") as HTMLInputElement;
  const dateInput = document.getElementById("positionDate") as HTMLInputElement;
  const notesInput = document.getElementById("positionNotes") as HTMLInputElement;
  const formError = document.getElementById("positionFormError") as HTMLElement;
  const saveBtn = document.getElementById("savePositionBtn") as HTMLButtonElement;

  let prefs: StockPreferencesView = { enabled: true, newsEnabled: true, baseCurrency: "EUR", positions: [] };
  let result: StockProviderResultView | undefined;
  let selectedId: string | null = null;
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
  function conversionFor(view: StockPositionView | null): { base: string; rate: number } | null {
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
  }

  function render(): void {
    enabledInput.checked = prefs.enabled;
    newsInput.checked = prefs.newsEnabled;
    const codes = BASE_CURRENCIES.includes(prefs.baseCurrency)
      ? BASE_CURRENCIES
      : [prefs.baseCurrency, ...BASE_CURRENCIES];
    baseSelect.innerHTML = "";
    for (const code of codes)
      baseSelect.appendChild(new Option(code, code, false, code === prefs.baseCurrency));
    renderStatus();
    renderOverview();
    renderList();
    if (!detailView.hidden && selectedId) renderDetail(selectedId);
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
    for (const position of prefs.positions) {
      const view = viewFor(position.id);
      const row = el("button", "stock-row");
      row.type = "button";

      const who = el("span");
      const symbolLine = el("span", "stock-row-symbol", position.symbol);
      if (view?.status === "stale") symbolLine.appendChild(el("span", "tag tag-neutral", "stale"));
      if (prefs.enabled && result?.data && (!view || view.status === "unavailable")) {
        symbolLine.appendChild(el("span", "tag tag-neutral", "no price"));
      }
      who.appendChild(symbolLine);
      who.appendChild(el("div", "stock-row-name", view?.companyName ?? position.companyName ?? ""));
      row.appendChild(who);

      const currency = view?.currency ?? null;
      row.appendChild(numberCell("Price", money(view?.quote?.price, currency)));
      row.appendChild(
        numberCell("Today", percent(view?.dayChangePercent), trendClass(view?.dayChangePercent))
      );
      const fx = conversionFor(view);
      row.appendChild(
        numberCell(
          "Value",
          money(view?.marketValue, currency),
          "",
          fx && view?.marketValue != null ? `≈ ${money(view.marketValue * fx.rate, fx.base)}` : undefined
        )
      );
      row.appendChild(
        numberCell(
          "Total return",
          view?.unrealizedGain !== null && view?.unrealizedGain !== undefined
            ? `${money(view.unrealizedGain, currency, true)} (${percent(view.unrealizedGainPercent)})`
            : "—",
          trendClass(view?.unrealizedGain)
        )
      );

      row.addEventListener("click", () => openDetail(position.id));
      listEl.appendChild(row);
    }
  }

  // --------------------------------------------------------------- detail

  function openDetail(id: string): void {
    selectedId = id;
    show("detail");
    renderDetail(id);
  }

  function renderDetail(id: string): void {
    const position = prefs.positions.find((p) => p.id === id);
    if (!position) {
      show("list");
      return;
    }
    const view = viewFor(id);
    const currency = view?.currency ?? null;
    detailEl.innerHTML = "";

    const title = view?.companyName ?? position.companyName ?? position.symbol;
    detailEl.appendChild(
      el("h3", undefined, title === position.symbol ? title : `${title} (${position.symbol})`)
    );

    const grid = el("div", "stock-detail-grid");

    const yours = el("div", "stock-detail-card");
    yours.appendChild(el("div", "stock-stat-label", "Your position"));
    yours.appendChild(keyValue("Shares", new Intl.NumberFormat().format(position.shares)));
    yours.appendChild(keyValue("Average cost", money(position.averageCost, currency)));
    yours.appendChild(keyValue("Purchase date", plainDate(position.purchaseDate)));
    yours.appendChild(keyValue("Invested", money(position.shares * position.averageCost, currency)));
    if (position.notes) yours.appendChild(keyValue("Notes", position.notes));
    grid.appendChild(yours);

    const market = el("div", "stock-detail-card");
    market.appendChild(el("div", "stock-stat-label", "Market"));
    const quote = view?.quote ?? null;
    if (quote) {
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
        keyValue("Status", quote.stale ? "From an earlier fetch — may be out of date" : "Latest retrieved")
      );
    } else {
      market.appendChild(
        el(
          "p",
          "feed-empty",
          prefs.enabled
            ? "No price available for this symbol. Check it is written as the market lists it (e.g. ASML.AS)."
            : "Price tracking is off."
        )
      );
    }
    grid.appendChild(market);

    const estimate = el("div", "stock-detail-card");
    estimate.appendChild(el("div", "stock-stat-label", "Estimated from your entries"));
    estimate.appendChild(keyValue("Position value", money(view?.marketValue, currency)));
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
    grid.appendChild(estimate);
    detailEl.appendChild(grid);

    const actions = el("div", "stock-detail-actions");
    const editBtn = el("button", "btn btn-secondary", "Edit");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => openForm(position));
    actions.appendChild(editBtn);
    actions.appendChild(deleteButton(position));
    detailEl.appendChild(actions);

    const newsSection = el("div");
    newsSection.appendChild(el("div", "stock-stat-label", "Recent news"));
    const newsBody = el("div", "stock-news-list");
    newsBody.appendChild(
      el("p", "feed-empty", prefs.newsEnabled ? "Loading headlines…" : "News is switched off.")
    );
    newsSection.appendChild(newsBody);
    detailEl.appendChild(newsSection);
    if (prefs.newsEnabled) void loadNews(position.symbol, newsBody, id);
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

  async function loadNews(symbol: string, container: HTMLElement, forId: string): Promise<void> {
    let news: StockNewsResultView;
    try {
      news = await bridge().getStockNews(symbol);
    } catch {
      news = { symbol, status: "unavailable", items: [], retrievedAt: null };
    }
    if (selectedId !== forId || detailView.hidden) return; // the user moved on
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
    if (!symbol) return showError(formError, "Enter the stock's symbol, e.g. AAPL.");
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
    selectedId = null;
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
