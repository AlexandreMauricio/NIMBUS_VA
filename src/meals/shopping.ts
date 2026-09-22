/**
 * The shopping list: what the plan needs that the kitchen doesn't have.
 *
 * It is **derived, not stored**. Every time it's read, the planned meals
 * for the days asked about are added up, the pantry and the leftovers are
 * taken off, and what's left is the list. That has one property worth the
 * trouble: putting a purchase into the pantry makes the line disappear by
 * itself, with nothing to tick, un-tick or keep in step.
 *
 * The only stored part is what you added by hand ("bin bags", "something
 * for Sunday") — things no recipe can know about.
 *
 * The subtraction is done once across the whole range, not per meal:
 * three dinners each wanting 200 g of rice need 600 g, and the 500 g in
 * the cupboard covers the first two and a half — so the list asks for
 * 100 g, not 200 g three times.
 *
 * Pure.
 */

import { stockOf } from "./pantry";
import { scaleFor } from "./recipes";
import type { Amount } from "./units";
import { toBase } from "./units";
import type { Ingredient, ManualShoppingItem, PantryItem, PlannedMeal, Recipe } from "./types";

export interface ShoppingLine {
  /** Null for a manual item that isn't a known food. */
  ingredientId: string | null;
  name: string;
  /** What the plan needs in total, in base units. */
  needed: Amount | null;
  /** What the pantry already holds, in the same unit. */
  have: number | null;
  /** What to buy: needed minus what's at home. */
  buy: Amount | null;
  /** Which planned meals want it, by name — "Lemon chicken, Rice and beans". */
  forMeals: string[];
  /** Estimated cost of `buy` at the last price paid, or null. */
  cost: number | null;
  /** A manual line is one you typed; it is never worked out from the plan. */
  manual: boolean;
  /** The manual item's id, so it can be removed. */
  itemId: string | null;
}

export interface ShoppingList {
  lines: ShoppingLine[];
  /** Lines the plan needs and the pantry doesn't cover. */
  toBuy: number;
  /** Ingredients the pantry covers completely — what the plan saves you buying. */
  covered: Array<{ name: string; value: number | null }>;
  /** The total of every line that could be priced, and how many couldn't. */
  cost: number | null;
  unpriced: number;
  /** Lines whose unit can't be measured ("a bunch of parsley" against nothing). */
  unknown: number;
}

/**
 * The list for `meals` — typically the days from today onwards.
 *
 * Meals already cooked are left out: their ingredients are gone, and the
 * pantry already reflects it. Optional recipe lines ("to taste") are left
 * out too — nobody shops for a pinch of salt.
 */
export function buildShoppingList(
  meals: PlannedMeal[],
  recipes: Map<string, Recipe>,
  pantry: PantryItem[],
  ingredients: Map<string, Ingredient>,
  manual: ManualShoppingItem[]
): ShoppingList {
  const needs = new Map<string, { name: string; unit: string; quantity: number; meals: Set<string> }>();
  const unmeasurable = new Map<string, { name: string; meals: Set<string> }>();

  for (const meal of meals) {
    if (meal.cookedAt || meal.kind !== "recipe" || !meal.recipeId) continue;
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;
    const scale = scaleFor(recipe, meal.cookServings ?? meal.servings);
    for (const line of recipe.ingredients) {
      if (line.optional) continue;
      const amount = scale(line);
      const base = toBase(amount);
      const name = ingredients.get(line.ingredientId)?.name ?? line.text;
      if (!base) {
        const entry = unmeasurable.get(line.ingredientId) ?? { name, meals: new Set<string>() };
        entry.meals.add(recipe.name);
        unmeasurable.set(line.ingredientId, entry);
        continue;
      }
      const entry = needs.get(line.ingredientId) ?? {
        name,
        unit: base.unit,
        quantity: 0,
        meals: new Set<string>(),
      };
      // Two lines of the same food in different units (300 g and 1 piece)
      // can't be added: the second is left for the unmeasurable list.
      if (entry.unit !== base.unit && entry.quantity > 0) {
        const other = unmeasurable.get(line.ingredientId) ?? { name, meals: new Set<string>() };
        other.meals.add(recipe.name);
        unmeasurable.set(line.ingredientId, other);
        continue;
      }
      entry.unit = base.unit;
      entry.quantity += base.quantity;
      entry.meals.add(recipe.name);
      needs.set(line.ingredientId, entry);
    }
  }

  const lines: ShoppingLine[] = [];
  const covered: ShoppingList["covered"] = [];
  let cost: number | null = null;
  let unpriced = 0;

  for (const [ingredientId, need] of needs) {
    const have = stockOf(pantry, ingredientId, need.unit) ?? 0;
    const price = ingredients.get(ingredientId)?.lastPrice ?? null;
    const short = Math.round((need.quantity - have) * 1000) / 1000;
    if (short <= 0) {
      covered.push({
        name: need.name,
        value: price === null ? null : Math.round(price * need.quantity * 100) / 100,
      });
      continue;
    }
    const lineCost = price === null ? null : Math.round(price * short * 100) / 100;
    if (lineCost === null) unpriced += 1;
    else cost = (cost ?? 0) + lineCost;
    lines.push({
      ingredientId,
      name: need.name,
      needed: { quantity: Math.round(need.quantity * 1000) / 1000, unit: need.unit },
      have,
      buy: { quantity: short, unit: need.unit },
      forMeals: [...need.meals],
      cost: lineCost,
      manual: false,
      itemId: null,
    });
  }

  for (const [, entry] of unmeasurable) {
    lines.push({
      ingredientId: null,
      name: entry.name,
      needed: null,
      have: null,
      buy: null,
      forMeals: [...entry.meals],
      cost: null,
      manual: false,
      itemId: null,
    });
  }

  for (const item of manual) {
    const amount = item.quantity !== null && item.unit ? { quantity: item.quantity, unit: item.unit } : null;
    const base = amount ? toBase(amount) : null;
    const price = item.ingredientId ? (ingredients.get(item.ingredientId)?.lastPrice ?? null) : null;
    const lineCost = price === null || !base ? null : Math.round(price * base.quantity * 100) / 100;
    if (lineCost === null) unpriced += 1;
    else cost = (cost ?? 0) + lineCost;
    lines.push({
      ingredientId: item.ingredientId,
      name: item.name,
      needed: base,
      have: null,
      buy: base,
      forMeals: [],
      cost: lineCost,
      manual: true,
      itemId: item.id,
    });
  }

  lines.sort((a, b) => Number(a.manual) - Number(b.manual) || a.name.localeCompare(b.name));
  return {
    lines,
    toBuy: lines.length,
    covered: covered.sort((a, b) => a.name.localeCompare(b.name)),
    cost: cost === null ? null : Math.round(cost * 100) / 100,
    unpriced,
    unknown: unmeasurable.size,
  };
}
