import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import {
  ClosedPosition,
  MAX_CLOSED_POSITIONS,
  StockPosition,
  closeLot,
  normalizeCurrencyCode,
  normalizeDividendTax,
  normalizeIrsSettings,
  normalizeSymbol,
  rebuildClosedPosition,
  validateClosedPositions,
  validateStockPositions,
} from "../../context/providers/stocks";
import { handle } from "./handle";
import { asRecord } from "./input";
import type { IpcContext } from "./context";

/** Stocks: positions, prices, news, dividends, closing and the IRS helper. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerStocksIpc(ctx: IpcContext): void {
  // Stocks (src/context/providers/stocks/) — read-only tracking of
  // positions the user entered by hand. Nothing here trades or talks to a
  // brokerage: these handlers save the user's own position notes and read
  // market data, and that is all.
  handle("nimbus:get-stock-settings", () => ctx.settings.userPreferences.stocks);
  handle("nimbus:update-stock-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    const current = ctx.settings.userPreferences.stocks;
    let positions = current.positions;
    if (partial?.positions !== undefined) {
      const result = validateStockPositions(partial.positions);
      if (!result.valid) throw new Error(`Invalid stock position: ${result.error}`);
      // Rebuilt field by field, so nothing beyond the known shape is saved.
      positions = (partial.positions as StockPosition[]).map((p) => ({
        id: p.id,
        symbol: normalizeSymbol(p.symbol)!,
        alternativeSymbol: p.alternativeSymbol ? normalizeSymbol(p.alternativeSymbol)! : undefined,
        leverage: typeof p.leverage === "number" && p.leverage > 1 ? p.leverage : undefined,
        companyName: p.companyName?.trim() || undefined,
        shares: p.shares,
        averageCost: p.averageCost,
        purchaseDate: p.purchaseDate || undefined,
        notes: p.notes?.trim() || undefined,
      }));
    }
    let baseCurrency = current.baseCurrency;
    if (partial?.baseCurrency !== undefined) {
      const code = normalizeCurrencyCode(partial.baseCurrency);
      if (!code) throw new Error("Base currency must be a three-letter code such as EUR.");
      baseCurrency = code;
    }
    let closedPositions = current.closedPositions;
    if (partial?.closedPositions !== undefined) {
      const result = validateClosedPositions(partial.closedPositions);
      if (!result.valid) throw new Error(`Invalid closed position: ${result.error}`);
      closedPositions = (partial.closedPositions as ClosedPosition[]).map(rebuildClosedPosition);
    }
    let irs = current.irs;
    if (partial?.irs !== undefined) {
      const checked = normalizeIrsSettings(partial.irs);
      if (checked.error) throw new Error(checked.error);
      irs = checked.settings!;
    }
    let dividendTax = current.dividendTax;
    if (partial?.dividendTax !== undefined) {
      const checked = normalizeDividendTax(partial.dividendTax);
      if (checked.error) throw new Error(`Invalid dividend tax setting: ${checked.error}`);
      dividendTax = checked.settings!;
    }
    ctx.settings.userPreferences.stocks = {
      enabled: typeof partial?.enabled === "boolean" ? partial.enabled : current.enabled,
      newsEnabled: typeof partial?.newsEnabled === "boolean" ? partial.newsEnabled : current.newsEnabled,
      baseCurrency,
      dividendsEnabled:
        typeof partial?.dividendsEnabled === "boolean" ? partial.dividendsEnabled : current.dividendsEnabled,
      dividendTax,
      closedPositions,
      irs,
      positions,
    };
    saveSettings(ctx.settings);
    logger.info("Stock settings updated", {
      enabled: ctx.settings.userPreferences.stocks.enabled,
      newsEnabled: ctx.settings.userPreferences.stocks.newsEnabled,
      baseCurrency,
      positionCount: positions.length,
    });
    return ctx.settings.userPreferences.stocks;
  });
  // Asks for fresh prices on the next read (at most every 30 s); the tab
  // then re-reads the context snapshot as usual.
  handle("nimbus:refresh-stocks", () => ctx.stockProvider.refresh());
  // Headlines for a symbol the user actually tracks — never an arbitrary one.
  handle("nimbus:get-stock-news", (_event, symbol: unknown) => {
    const normalized = normalizeSymbol(symbol);
    const tracked = ctx.settings.userPreferences.stocks.positions.some(
      (p) => normalizeSymbol(p.symbol) === normalized
    );
    if (!normalized || !tracked) {
      return { symbol: String(symbol), status: "unavailable", items: [], retrievedAt: null };
    }
    return ctx.stockProvider.getNews(normalized);
  });
  // Live listings of the same company, for a tracked symbol whose price is
  // outdated. A suggestion only — switching is an ordinary position edit.
  handle("nimbus:find-stock-listings", (_event, symbol: unknown) => {
    const normalized = normalizeSymbol(symbol);
    const tracked = ctx.settings.userPreferences.stocks.positions.some(
      (p) => normalizeSymbol(p.symbol) === normalized
    );
    if (!normalized || !tracked) return { symbol: String(symbol), status: "unavailable", candidates: [] };
    return ctx.stockProvider.findListings(normalized);
  });
  // Dividend history per holding, with tax estimated for a Portugal resident.
  handle("nimbus:get-stock-dividends", () => ctx.stockProvider.getDividends());

  // Records a sale the user already made at their broker: shares move from
  // an open lot to the closed list. NIMBUS itself never trades.
  handle("nimbus:close-stock-position", (_event, request: unknown) => {
    const current = ctx.settings.userPreferences.stocks;
    if (current.closedPositions.length >= MAX_CLOSED_POSITIONS) {
      throw new Error(`At most ${MAX_CLOSED_POSITIONS} closed positions can be kept.`);
    }
    const r = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
    const result = closeLot(
      current.positions,
      {
        positionId: String(r.positionId ?? ""),
        shares: Number(r.shares),
        closeDate: String(r.closeDate ?? ""),
        closePrice: Number(r.closePrice),
        fees: r.fees === undefined || r.fees === null || r.fees === "" ? undefined : Number(r.fees),
        currency: String(r.currency ?? ""),
        companyName: typeof r.companyName === "string" ? r.companyName : undefined,
        notes: typeof r.notes === "string" ? r.notes : undefined,
      },
      `closed-${Date.now()}`
    );
    if ("error" in result) throw new Error(result.error);
    ctx.settings.userPreferences.stocks = {
      ...current,
      positions: result.positions,
      closedPositions: [...current.closedPositions, result.closed],
    };
    saveSettings(ctx.settings);
    logger.info("Stock position closed", {
      openCount: result.positions.length,
      closedCount: ctx.settings.userPreferences.stocks.closedPositions.length,
    });
    return ctx.settings.userPreferences.stocks;
  });
  // Anexo J figures for one year — a helper for the user's IRS return.
  handle("nimbus:get-stock-irs-report", (_event, year: unknown) => {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error("Choose a year between 2000 and 2100.");
    return ctx.stockProvider.getIrsReport(y);
  });
}
