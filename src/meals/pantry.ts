/**
 * What's in the kitchen, read three ways: how much of a food there is,
 * what's about to go off, and what cooking a recipe would take out.
 *
 * Everything here is pure and takes "today" as an argument, so the same
 * pantry always produces the same answer in a test as it does at 23:59.
 *
 * The rule that shapes it: NIMBUS may subtract what a recipe used, but it
 * may never quietly promote its own arithmetic to fact. Deducting marks
 * the item **estimated**, and an estimate stays visible as one until the
 * user confirms the real amount (see `correctStock` in mealService).
 */

import { Amount, add, comparable, scaleAmount, subtract, toBase } from "./units";
import type { Leftover, PantryItem, Recipe, RecipeIngredient, StockConfidence } from "./types";

/** How urgent an expiry date is. "none" = nothing to worry about yet. */
export type ExpiryState = "expired" | "urgent" | "soon" | "later" | "none";

/** Within 48 hours is urgent, within a week is soon — the mockup's two counters. */
export const URGENT_HOURS = 48;
export const SOON_DAYS = 7;

/** Midnight-to-midnight days from `today` to an ISO date; negative when it's past. */
export function daysUntil(isoDate: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

export function expiryState(expiresAt: string | null, today: Date): ExpiryState {
  if (!expiresAt) return "none";
  const days = daysUntil(expiresAt, today);
  if (days === null) return "none";
  if (days < 0) return "expired";
  if (days <= URGENT_HOURS / 24) return "urgent";
  if (days <= SOON_DAYS) return "soon";
  return "later";
}

/** One food, everything you have of it across places, and the state of that stock. */
export interface StockSummary {
  ingredientId: string;
  name: string;
  /** Totals per base unit — "g" and "piece" can both be present for one food. */
  totals: Array<{ unit: string; quantity: number }>;
  items: PantryItem[];
  /** "estimated" when any item making up the total is an estimate. */
  confidence: StockConfidence;
  /** The soonest expiry among the items, and how urgent it is. */
  expiresAt: string | null;
  expiry: ExpiryState;
}

/** The pantry grouped by ingredient, soonest expiry first, then by name. */
export function summariseStock(items: PantryItem[], today: Date): StockSummary[] {
  const byIngredient = new Map<string, PantryItem[]>();
  for (const item of items) {
    const list = byIngredient.get(item.ingredientId);
    if (list) list.push(item);
    else byIngredient.set(item.ingredientId, [item]);
  }
  const summaries: StockSummary[] = [];
  for (const [ingredientId, list] of byIngredient) {
    const totals = new Map<string, number>();
    for (const item of list) {
      const base = toBase({ quantity: item.quantity, unit: item.unit });
      if (!base) continue;
      totals.set(base.unit, (totals.get(base.unit) ?? 0) + base.quantity);
    }
    const dated = list.filter((i) => i.expiresAt).sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!));
    const expiresAt = dated[0]?.expiresAt ?? null;
    summaries.push({
      ingredientId,
      name: list[0].name,
      totals: [...totals.entries()].map(([unit, quantity]) => ({
        unit,
        quantity: Math.round(quantity * 1000) / 1000,
      })),
      items: list,
      confidence: list.some((i) => i.confidence === "estimated") ? "estimated" : "confirmed",
      expiresAt,
      expiry: expiryState(expiresAt, today),
    });
  }
  const order: Record<ExpiryState, number> = { expired: 0, urgent: 1, soon: 2, later: 3, none: 4 };
  return summaries.sort(
    (a, b) =>
      order[a.expiry] - order[b.expiry] ||
      (a.expiresAt ?? "").localeCompare(b.expiresAt ?? "") ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Food families: each food that counts as a more general one, to that one
 * (Soy milk → Milk). A recipe line for Milk takes either; a line for Soy
 * milk takes only soy.
 */
export type Family = ReadonlyMap<string, string>;

export const NO_FAMILY: Family = new Map();

export function familyOf(ingredients: Iterable<{ id: string; countsAs: string | null }>): Family {
  const family = new Map<string, string>();
  for (const ingredient of ingredients)
    if (ingredient.countsAs && ingredient.countsAs !== ingredient.id)
      family.set(ingredient.id, ingredient.countsAs);
  return family;
}

/** Whether pantry food `have` will do for a recipe line asking for `wanted`. */
export function fits(have: string, wanted: string, family: Family): boolean {
  return have === wanted || family.get(have) === wanted;
}

/**
 * How much of one ingredient there is, in the base unit of `unit`. Zero
 * means "none of it" — a real answer. Null means the question can't be
 * asked at all, because the unit isn't one NIMBUS can measure.
 */
export function stockOf(
  items: PantryItem[],
  ingredientId: string,
  unit: string,
  family: Family = NO_FAMILY
): number | null {
  const wanted = toBase({ quantity: 1, unit });
  if (!wanted) return null;
  let total = 0;
  for (const item of items) {
    if (!fits(item.ingredientId, ingredientId, family)) continue;
    const base = toBase({ quantity: item.quantity, unit: item.unit });
    if (!base || base.unit !== wanted.unit) continue;
    total += base.quantity;
  }
  return total;
}

/** Whether a recipe line is covered by the pantry, and by how much. */
export interface IngredientCoverage {
  ingredient: RecipeIngredient;
  /** What's needed, already scaled to the servings being cooked. */
  needed: Amount;
  /** What the pantry holds in a comparable unit, or null when it can't be compared. */
  have: number | null;
  status: "have" | "partial" | "missing" | "unknown";
  /** What's still missing, in the recipe's own unit — for the shopping list. */
  short: Amount | null;
}

/**
 * A recipe against the pantry: which lines you have, which you're short
 * of, and which can't be compared (a "pinch of salt" against a 500 g box).
 * An optional line never counts as missing.
 */
export function coverRecipe(
  ingredients: RecipeIngredient[],
  pantry: PantryItem[],
  scale: (ingredient: RecipeIngredient) => Amount,
  family: Family = NO_FAMILY
): IngredientCoverage[] {
  return ingredients.map((ingredient) => {
    const needed = scale(ingredient);
    const base = toBase(needed);
    const have = base ? stockOf(pantry, ingredient.ingredientId, needed.unit, family) : null;
    if (!base || have === null) {
      return { ingredient, needed, have, status: "unknown" as const, short: null };
    }
    if (have >= base.quantity) return { ingredient, needed, have, status: "have" as const, short: null };
    const short = subtract(needed, {
      quantity: have,
      unit: base.unit,
    });
    return {
      ingredient,
      needed,
      have,
      status: have > 0 ? ("partial" as const) : ("missing" as const),
      short,
    };
  });
}

/** How many of a recipe's lines the pantry covers — "6 of 9 at home". */
export function coverageCount(coverage: IngredientCoverage[]): { have: number; total: number } {
  const counted = coverage.filter((c) => !c.ingredient.optional);
  return { have: counted.filter((c) => c.status === "have").length, total: counted.length };
}

/** One pantry item and how much of it cooking would use. */
export interface Deduction {
  itemId: string;
  name: string;
  /** What comes off this item, in the item's own unit. */
  use: Amount;
  /** What the item is left with. */
  remaining: Amount;
  /** True when this item is emptied — the caller removes it instead of saving a zero. */
  empties: boolean;
}

export interface DeductionPlan {
  deductions: Deduction[];
  /** Whole frozen bags that give more than the line needs: what's over, cooked anyway. */
  surplus: Array<{ ingredient: RecipeIngredient; bag: string; extra: Amount }>;
  /** Lines the pantry couldn't cover, for the shopping list or a warning. */
  short: Array<{ ingredient: RecipeIngredient; missing: Amount | null; reason: "short" | "unknown" }>;
}

/**
 * What cooking takes out of the pantry.
 *
 * Items of the same food are used **soonest expiry first**, so cooking
 * empties the yoghurt that goes off on Friday before the one that keeps
 * until next month — the one thing a person does without thinking and a
 * naive "first item in the list" would get wrong. Optional lines and lines
 * in units that can't be compared are left alone and reported.
 */
export function planDeductions(
  ingredients: RecipeIngredient[],
  pantry: PantryItem[],
  scale: (ingredient: RecipeIngredient) => Amount,
  options: {
    family?: Family;
    /** For a line the family can fill more than one way: the food you chose (line's food → chosen food). */
    choose?: ReadonlyMap<string, string>;
  } = {}
): DeductionPlan {
  const family = options.family ?? NO_FAMILY;
  const remaining = new Map<string, Amount>();
  const plan: DeductionPlan = { deductions: [], short: [], surplus: [] };
  for (const ingredient of ingredients) {
    if (ingredient.optional) continue;
    const needed = scale(ingredient);
    const neededBase = toBase(needed);
    if (!neededBase) {
      plan.short.push({ ingredient, missing: null, reason: "unknown" });
      continue;
    }
    // The food you chose first, else the one the recipe names; then the rest of the family.
    const first = options.choose?.get(ingredient.ingredientId) ?? ingredient.ingredientId;
    const candidates = pantry
      .filter((item) => fits(item.ingredientId, ingredient.ingredientId, family) && comparable(item, needed))
      .sort(
        (a, b) =>
          Number(b.ingredientId === first) - Number(a.ingredientId === first) ||
          (a.expiresAt ?? "9999-12-31").localeCompare(b.expiresAt ?? "9999-12-31") ||
          a.addedAt.localeCompare(b.addedAt)
      );
    let left = neededBase.quantity;
    for (const item of candidates) {
      if (left <= 0) break;
      const current = remaining.get(item.id) ?? { quantity: item.quantity, unit: item.unit };
      const available = toBase(current);
      if (!available || available.quantity <= 0) continue;
      // A frozen bag is defrosted whole: all of it is used, even past what the line needs.
      const used = item.wholeBag ? available.quantity : Math.min(available.quantity, left);
      const use = { quantity: used, unit: available.unit };
      const after = subtract(current, use);
      if (!after) continue;
      remaining.set(item.id, after);
      if (item.wholeBag && used > left)
        plan.surplus.push({
          ingredient,
          bag: item.name,
          extra: { quantity: round3(used - left), unit: available.unit },
        });
      left -= used;
      plan.deductions.push({
        itemId: item.id,
        name: item.name,
        use,
        remaining: after,
        empties: toBase(after)!.quantity <= 0,
      });
    }
    if (left > 0)
      plan.short.push({
        ingredient,
        missing: { quantity: Math.round(left * 1000) / 1000, unit: neededBase.unit },
        reason: "short",
      });
  }
  return plan;
}

/**
 * Recipe lines the pantry can fill with more than one food of a family —
 * milk or soy milk — for the cook dialog to ask which. Each food in stock
 * that fits, the one the recipe names first.
 */
export function familyChoices(
  ingredients: RecipeIngredient[],
  pantry: PantryItem[],
  family: Family
): Array<{ ingredient: RecipeIngredient; foods: string[] }> {
  const choices: Array<{ ingredient: RecipeIngredient; foods: string[] }> = [];
  for (const ingredient of ingredients) {
    if (ingredient.optional) continue;
    const foods = [
      ...new Set(
        pantry
          .filter((item) => item.quantity > 0 && fits(item.ingredientId, ingredient.ingredientId, family))
          .map((item) => item.ingredientId)
      ),
    ].sort((a, b) => Number(b === ingredient.ingredientId) - Number(a === ingredient.ingredientId));
    if (foods.length > 1) choices.push({ ingredient, foods });
  }
  return choices;
}

/**
 * Leftovers worth eating now: still within their safe window, most urgent
 * first. Anything past its eat-by is dropped rather than suggested.
 */
export function usableLeftovers(leftovers: Leftover[], today: Date): Leftover[] {
  return leftovers
    .filter((l) => l.portions > 0 && expiryState(l.eatBy, today) !== "expired")
    .sort((a, b) => (a.eatBy ?? "9999-12-31").localeCompare(b.eatBy ?? "9999-12-31"));
}

/**
 * How long cooked food keeps: three days in the fridge, three months in
 * the freezer, counted from the day it was cooked. The conservative end of
 * the usual food-safety advice, since the cost of being wrong is real.
 */
export function suggestEatBy(cookedAt: Date, place: "fridge" | "freezer"): string {
  const date = new Date(cookedAt.getFullYear(), cookedAt.getMonth(), cookedAt.getDate());
  date.setDate(date.getDate() + (place === "freezer" ? 90 : 3));
  return isoDate(date);
}

/** A local date as YYYY-MM-DD — never `toISOString()`, which would shift the day in UTC+1. */
export function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Adding stock: the same food, place and unit merges into one line instead of a second row. */
export function mergeInto(items: PantryItem[], incoming: PantryItem): PantryItem[] {
  // A frozen bag stays a bag.
  if (incoming.wholeBag) return [...items, incoming];
  const match = items.find(
    (item) =>
      !item.wholeBag &&
      item.ingredientId === incoming.ingredientId &&
      item.place === incoming.place &&
      item.expiresAt === incoming.expiresAt &&
      item.openedAt === null &&
      incoming.openedAt === null &&
      comparable(item, incoming)
  );
  if (!match) return [...items, incoming];
  const total = add(match, incoming);
  if (!total) return [...items, incoming];
  return items.map((item) =>
    item.id === match.id
      ? {
          ...item,
          quantity: total.quantity,
          // Topping up a half-empty pack makes the fuller amount the reference.
          startQuantity: Math.max(item.startQuantity, total.quantity),
          // Confirmed only when both halves are: adding a known purchase to
          // an estimated remainder still leaves the total a guess.
          confidence:
            match.confidence === "confirmed" && incoming.confidence === "confirmed"
              ? ("confirmed" as const)
              : ("estimated" as const),
          updatedAt: incoming.updatedAt,
        }
      : item
  );
}

/** True when a recipe has at least one line the pantry can't measure. */
export function hasUnknownUnits(recipe: Recipe): boolean {
  return recipe.ingredients.some((i) => !i.optional && toBase(i) === null);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * How many servings to cook so the frozen bags a recipe would take are
 * used up: a recipe for 2 needing 2 chicken breasts, with 6 in one bag,
 * cooks 6. Null when no whole bag is involved or it's already used up.
 */
export function wholeBagServings(
  recipe: Pick<Recipe, "ingredients" | "servings">,
  servings: number,
  pantry: PantryItem[],
  family: Family = NO_FAMILY
): number | null {
  const scale = (line: RecipeIngredient) => scaleAmount(line, recipe.servings, servings);
  const plan = planDeductions(recipe.ingredients, pantry, scale, { family });
  let best: number | null = null;
  for (const surplus of plan.surplus) {
    const needed = toBase(scale(surplus.ingredient));
    const extra = toBase(surplus.extra);
    if (!needed || !extra || needed.quantity <= 0 || needed.unit !== extra.unit) continue;
    // The servings the whole bag makes, at this recipe's ratio — rounded down, so nothing runs short.
    const cooks = Math.floor((servings * (needed.quantity + extra.quantity)) / needed.quantity + 1e-9);
    if (cooks > servings) best = Math.max(best ?? 0, cooks);
  }
  return best;
}

/**
 * Ways to freeze what was bought, for the purchase review: one bag, bags
 * the size your planned meals use, singles. `needs` are what each planned
 * meal takes of it (same kind of unit). The option matching most of those
 * meals is recommended.
 */
export function suggestBags(
  total: Amount,
  needs: Amount[]
): Array<{ sizes: number[]; label: string; recommended: boolean }> {
  const whole = toBase(total);
  if (!whole || whole.quantity <= 0) return [];
  const factor = whole.quantity / total.quantity;
  const sizes = new Map<number, number>();
  for (const need of needs) {
    const base = toBase(need);
    if (!base || base.unit !== whole.unit || base.quantity <= 0 || base.quantity >= whole.quantity) continue;
    const size = round3(base.quantity);
    sizes.set(size, (sizes.get(size) ?? 0) + 1);
  }
  const common = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const candidates = new Set<number>([whole.quantity, ...sizes.keys()]);
  if (whole.unit === "piece" && whole.quantity <= 8) candidates.add(1);
  const inUnit = (base: number) => round3(base / factor);
  const unitLabel = whole.unit === "piece" ? "" : ` ${total.unit}`;
  return [...candidates]
    .sort((a, b) => b - a)
    .map((size) => {
      const count = Math.floor(whole.quantity / size + 1e-9);
      let rest = round3(whole.quantity - count * size);
      const bags: number[] = Array(count).fill(inUnit(size));
      // A scrap (under a quarter of a bag) goes in with the last bag, not a bag of its own.
      if (rest > 0 && rest < size / 4) {
        bags[bags.length - 1] = inUnit(size + rest);
        rest = 0;
      } else if (rest > 0) bags.push(inUnit(rest));
      const last = bags[bags.length - 1];
      const label =
        bags.length === 1
          ? `1 bag of ${last}${unitLabel}`
          : rest > 0
            ? `${count} bag${count === 1 ? "" : "s"} of ${inUnit(size)}${unitLabel} + 1 of ${inUnit(rest)}${unitLabel}`
            : last !== inUnit(size)
              ? `${count} bags of ${inUnit(size)}${unitLabel} (the last ${last}${unitLabel})`
              : `${count} bags of ${inUnit(size)}${unitLabel}`;
      return { sizes: bags, label, recommended: common !== null ? size === common : size === whole.quantity };
    });
}
