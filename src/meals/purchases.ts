/**
 * Purchases and prices — pure.
 *
 * A receipt line says "COXA FRANGO KG"; the kitchen knows "Chicken
 * thighs". `matchLine` guesses which food a line is and how sure it is.
 * The guess is only ever a suggestion: you confirm each line, and a
 * confirmed line's text is kept as an alias of the food, so the same
 * receipt line matches for certain the next time.
 *
 * Every confirmed line with an amount and a price becomes a price record
 * (per base unit, per shop, per day). What a food "costs" is then the
 * cheapest recent price across shops — and the shopping list can say
 * where each thing is cheapest.
 */

import { ingredientKey } from "./names";
import { toBase } from "./units";
import type { Ingredient, PriceRecord, Store } from "./types";

/** A price older than this no longer counts as what something costs. */
export const PRICE_WINDOW_DAYS = 90;

/** Below this, a match is outlined for you to look at. */
export const SURE_MATCH = 0.8;

/** Receipt abbreviations and Portuguese names, spelled out for matching — a start, grown by aliases. */
const EXPANSIONS: Record<string, string> = {
  iog: "iogurte",
  qj: "queijo",
  moz: "mozzarella",
  nat: "natural",
  frg: "frango",
  pao: "pao",
  lte: "leite",
  mg: "meio gordo",
  cx: "caixa",
  emb: "embalagem",
  bio: "biologico",
  ref: "refrigerante",
};

/** Portuguese words to English, for a kitchen named in English. Only the common foods. */
const PT_EN: Record<string, string> = {
  frango: "chicken",
  coxa: "thigh",
  peito: "breast",
  carne: "meat",
  picada: "mince",
  vaca: "beef",
  porco: "pork",
  peixe: "fish",
  salmao: "salmon",
  atum: "tuna",
  bacalhau: "cod",
  ovos: "eggs",
  ovo: "egg",
  leite: "milk",
  queijo: "cheese",
  iogurte: "yoghurt",
  manteiga: "butter",
  natas: "cream",
  pao: "bread",
  arroz: "rice",
  massa: "pasta",
  esparguete: "spaghetti",
  batata: "potato",
  batatas: "potatoes",
  cebola: "onion",
  alho: "garlic",
  tomate: "tomato",
  pelado: "tomatoes",
  cenoura: "carrot",
  espinafres: "spinach",
  alface: "lettuce",
  limao: "lemon",
  laranja: "orange",
  maca: "apple",
  banana: "banana",
  feijao: "beans",
  grao: "chickpeas",
  lentilhas: "lentils",
  azeite: "olive oil",
  oleo: "oil",
  acucar: "sugar",
  farinha: "flour",
  sal: "salt",
  aveia: "oats",
  grego: "greek",
  pimento: "pepper",
  pimentos: "peppers",
  cogumelos: "mushrooms",
  salsa: "parsley",
  coentros: "coriander",
};

/** A line or name as a set of comparable words, abbreviations spelled out and Portuguese translated. */
export function wordsOf(text: string): Set<string> {
  const plain = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, " ");
  const words = new Set<string>();
  for (const raw of plain.split(/\s+/)) {
    if (raw.length < 2 || /^(kg|gr|un|und|emb|lt|ml|cl|x|de|da|do|com|sem|the|and|of)$/.test(raw)) continue;
    const spelled = EXPANSIONS[raw] ?? raw;
    for (const word of spelled.split(" ")) {
      words.add(word.replace(/s$/, ""));
      const english = PT_EN[word];
      if (english) for (const part of english.split(" ")) words.add(part.replace(/s$/, ""));
    }
  }
  return words;
}

export interface LineMatch {
  ingredientId: string | null;
  confidence: number;
}

/**
 * Which known food a receipt line most likely is, and how sure: 1 when the
 * line is word for word a name or alias (which is what confirming teaches
 * it), less as fewer of the food's words appear in the line.
 */
export function matchLine(
  raw: string,
  ingredients: Array<Pick<Ingredient, "id" | "name" | "aliases">>
): LineMatch {
  const key = ingredientKey(raw);
  let best: LineMatch = { ingredientId: null, confidence: 0 };
  if (!key) return best;
  const line = wordsOf(raw);
  for (const ingredient of ingredients) {
    const names = [ingredient.name, ...ingredient.aliases];
    if (names.some((name) => ingredientKey(name) === key))
      return { ingredientId: ingredient.id, confidence: 1 };
    for (const name of names) {
      const words = wordsOf(name);
      if (!words.size) continue;
      const hits = [...words].filter((word) => line.has(word)).length;
      if (!hits) continue;
      // Every word of the food found scores high; extra words on the line cost a little.
      const cover = hits / words.size;
      const noise = Math.max(0, line.size - hits) * 0.04;
      const confidence = Math.max(0, Math.min(0.95, cover * 0.9 - noise));
      if (confidence > best.confidence) best = { ingredientId: ingredient.id, confidence };
    }
  }
  return best.confidence >= 0.35
    ? { ...best, confidence: Math.round(best.confidence * 100) / 100 }
    : { ingredientId: null, confidence: 0 };
}

/** A line's price per base unit (€/g, €/ml, €/piece), or null when it can't be worked out. */
export function linePricePerBase(line: {
  quantity: number | null;
  unit: string | null;
  price: number | null;
}): number | null {
  if (line.quantity === null || !line.unit || line.price === null || line.price <= 0) return null;
  const base = toBase({ quantity: line.quantity, unit: line.unit });
  if (!base || base.quantity <= 0) return null;
  // Rounded to a millionth of a euro: 2,40 € for 12 eggs is 0.2, not 0.19999…
  return Math.round((line.price / base.quantity) * 1e6) / 1e6;
}

export interface StorePrice {
  storeId: string | null;
  storeName: string;
  pricePerBase: number;
  date: string;
  /** Typed in by hand rather than read off a receipt or invoice. */
  manual: boolean;
}

/**
 * The latest price of a food at each shop, within the price window,
 * cheapest first.
 */
export function pricesByStore(
  prices: PriceRecord[],
  ingredientId: string,
  stores: Store[],
  today: string,
  manualPurchases: Set<string> = new Set()
): StorePrice[] {
  const since = new Date(`${today}T00:00:00`);
  since.setDate(since.getDate() - PRICE_WINDOW_DAYS);
  const cutoff = since.toISOString().slice(0, 10);
  const latest = new Map<string, PriceRecord>();
  for (const record of prices) {
    if (record.ingredientId !== ingredientId || record.date < cutoff) continue;
    const key = record.storeId ?? "";
    const seen = latest.get(key);
    if (!seen || record.date > seen.date) latest.set(key, record);
  }
  return [...latest.values()]
    .map((record) => ({
      storeId: record.storeId,
      storeName: stores.find((store) => store.id === record.storeId)?.name ?? "No shop",
      pricePerBase: record.pricePerBase,
      date: record.date,
      manual: record.purchaseId === null || manualPurchases.has(record.purchaseId),
    }))
    .sort((a, b) => a.pricePerBase - b.pricePerBase);
}

/** What a food costs now: the cheapest recent price at any shop, else the last price you typed. */
export function currentPrice(
  prices: PriceRecord[],
  ingredient: Pick<Ingredient, "id" | "lastPrice">,
  stores: Store[],
  today: string
): number | null {
  return pricesByStore(prices, ingredient.id, stores, today)[0]?.pricePerBase ?? ingredient.lastPrice;
}

/**
 * The "buy at two shops" hint: how much the list costs at the cheapest
 * shop for each line, against buying everything at the one shop that
 * prices most of it. Null when there's nothing to compare.
 */
export function splitShopSaving(
  lines: Array<{ baseQuantity: number; prices: StorePrice[] }>
): { mainStore: string; otherStores: string[]; saving: number } | null {
  const counts = new Map<string, number>();
  for (const line of lines)
    for (const price of line.prices) counts.set(price.storeName, (counts.get(price.storeName) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return null;
  let saving = 0;
  const others = new Set<string>();
  for (const line of lines) {
    const atMain = line.prices.find((price) => price.storeName === main);
    const cheapest = line.prices[0];
    if (!atMain || !cheapest || cheapest.storeName === main) continue;
    saving += (atMain.pricePerBase - cheapest.pricePerBase) * line.baseQuantity;
    others.add(cheapest.storeName);
  }
  saving = Math.round(saving * 100) / 100;
  return saving > 0 ? { mainStore: main, otherStores: [...others], saving } : null;
}
