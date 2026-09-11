import { StockPosition, StockValidationResult, normalizeSymbol, validateStockPosition } from "./types";

/**
 * Closed positions — sales the user already made at their broker,
 * recorded so NIMBUS can keep them (for the user's records and the IRS).
 * "Closing" here only moves the user's own notes from the open list to
 * this one: NIMBUS never trades and never talks to a brokerage.
 */
export interface ClosedPosition {
  id: string;
  symbol: string;
  companyName?: string;
  alternativeSymbol?: string;
  /** As on the open lot: 20 for a ×20 CFD. */
  leverage?: number;
  /** Shares (or CFD units) sold. */
  shares: number;
  /** The open lot's average cost (or open price). */
  averageCost: number;
  /** Required: the IRS asks for the acquisition date of every sale. */
  purchaseDate: string;
  closeDate: string;
  /** Per share, in `currency`. */
  closePrice: number;
  /** Fees and charges on the trade, in `currency`. */
  fees?: number;
  /** The prices' currency, as quoted — may be a minor unit such as "GBp". */
  currency: string;
  notes?: string;
}

export const MAX_CLOSED_POSITIONS = 500;

function isPlainDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function nonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
}

export function validateClosedPosition(value: unknown, now: Date = new Date()): StockValidationResult {
  const base = validateStockPosition(value, now);
  if (!base.valid) return base;
  const p = value as Record<string, unknown>;
  if (typeof p.purchaseDate !== "string") {
    return { valid: false, error: "A closed position needs its purchase date — the IRS asks for it." };
  }
  if (typeof p.closeDate !== "string" || !isPlainDate(p.closeDate)) {
    return { valid: false, error: "Close date must be a real date (YYYY-MM-DD)." };
  }
  if (p.closeDate < p.purchaseDate) {
    return { valid: false, error: "The close date can't be before the purchase date." };
  }
  if (Date.parse(`${p.closeDate}T00:00:00Z`) > now.getTime() + 24 * 60 * 60 * 1000) {
    return { valid: false, error: "The close date can't be in the future." };
  }
  if (!nonNegative(p.closePrice))
    return { valid: false, error: "Close price must be a number of 0 or more." };
  if (p.fees !== undefined && !nonNegative(p.fees)) {
    return { valid: false, error: "Fees must be a number of 0 or more." };
  }
  if (typeof p.currency !== "string" || !/^[A-Za-z]{3}$/.test(p.currency.trim())) {
    return { valid: false, error: "Currency must be a three-letter code such as USD." };
  }
  return { valid: true };
}

export function validateClosedPositions(value: unknown, now: Date = new Date()): StockValidationResult {
  if (!Array.isArray(value)) return { valid: false, error: "Closed positions must be a list." };
  if (value.length > MAX_CLOSED_POSITIONS) {
    return { valid: false, error: `At most ${MAX_CLOSED_POSITIONS} closed positions can be kept.` };
  }
  const ids = new Set<string>();
  for (const item of value) {
    const result = validateClosedPosition(item, now);
    if (!result.valid) return result;
    const id = (item as ClosedPosition).id;
    if (ids.has(id)) return { valid: false, error: `Duplicate closed position id "${id}".` };
    ids.add(id);
  }
  return { valid: true };
}

/** A validated closed position rebuilt field by field, so nothing beyond the known shape is kept. */
export function rebuildClosedPosition(p: ClosedPosition): ClosedPosition {
  return {
    id: p.id,
    symbol: normalizeSymbol(p.symbol)!,
    ...(p.companyName?.trim() ? { companyName: p.companyName.trim() } : {}),
    ...(p.alternativeSymbol ? { alternativeSymbol: normalizeSymbol(p.alternativeSymbol)! } : {}),
    ...(p.leverage && p.leverage > 1 ? { leverage: p.leverage } : {}),
    shares: p.shares,
    averageCost: p.averageCost,
    purchaseDate: p.purchaseDate,
    closeDate: p.closeDate,
    closePrice: p.closePrice,
    ...(p.fees ? { fees: p.fees } : {}),
    currency: p.currency.trim(),
    ...(p.notes?.trim() ? { notes: p.notes.trim() } : {}),
  };
}

export interface CloseRequest {
  positionId: string;
  shares: number;
  closeDate: string;
  closePrice: number;
  fees?: number;
  currency: string;
  /** The company name the tab knows (from market data), kept with the record. */
  companyName?: string;
  notes?: string;
}

/**
 * Records a sale: moves `shares` of an open lot to a new closed position.
 * Selling part of a lot leaves the rest open with the same cost and date.
 */
export function closeLot(
  positions: StockPosition[],
  request: CloseRequest,
  closedId: string,
  now: Date = new Date()
): { positions: StockPosition[]; closed: ClosedPosition } | { error: string } {
  const lot = positions.find((p) => p.id === request.positionId);
  if (!lot) return { error: "That position no longer exists." };
  if (!lot.purchaseDate) {
    return { error: "Add this position's purchase date first — the IRS asks for it with every sale." };
  }
  const shares = request.shares;
  if (
    typeof shares !== "number" ||
    !Number.isFinite(shares) ||
    shares <= 0 ||
    shares > lot.shares * (1 + 1e-9)
  ) {
    return { error: `Shares sold must be more than 0 and at most ${lot.shares}.` };
  }
  const sold = Math.min(shares, lot.shares);

  const candidate: ClosedPosition = {
    id: closedId,
    symbol: lot.symbol,
    companyName: (request.companyName?.trim() || lot.companyName?.trim() || "").slice(0, 100) || undefined,
    alternativeSymbol: lot.alternativeSymbol,
    leverage: lot.leverage,
    shares: sold,
    averageCost: lot.averageCost,
    purchaseDate: lot.purchaseDate,
    closeDate: request.closeDate,
    closePrice: request.closePrice,
    fees: request.fees,
    currency: typeof request.currency === "string" ? request.currency.trim() : "",
    notes: request.notes?.trim() || lot.notes,
  };
  const check = validateClosedPosition(candidate, now);
  if (!check.valid) return { error: check.error! };

  const remaining = lot.shares - sold;
  const whole = remaining <= lot.shares * 1e-9;
  return {
    positions: whole
      ? positions.filter((p) => p.id !== lot.id)
      : positions.map((p) => (p.id === lot.id ? { ...p, shares: remaining } : p)),
    closed: rebuildClosedPosition(candidate),
  };
}
