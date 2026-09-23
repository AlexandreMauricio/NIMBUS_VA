/**
 * What a recipe costs, what it's worth nutritionally, and what it needs
 * for a given number of people.
 *
 * Both figures are estimates and say so. Cost comes from the last price
 * paid per ingredient, which is the only price NIMBUS can honestly claim
 * to know; nutrition comes from each ingredient's per-100 g values. When
 * some lines have no data the total is still given, together with **how
 * many lines it was worked out from** — "from 8 of 9 ingredients · parsley
 * unknown" is useful, a confident wrong number is not.
 *
 * Pure. Ingredients are handed in as a lookup so nothing here reads state.
 */

import { Amount, scaleAmount, toBase } from "./units";
import type { Ingredient, NutritionPer100, Recipe, RecipeIngredient } from "./types";

export type IngredientLookup = (id: string) => Ingredient | undefined;

/** How much of one line is needed to cook `servings` of a recipe written for `recipe.servings`. */
export function scaleFor(recipe: Recipe, servings: number): (ingredient: RecipeIngredient) => Amount {
  return (ingredient) => scaleAmount(ingredient, recipe.servings, servings);
}

export interface Estimate {
  /** The total, or null when nothing could be worked out. */
  value: number | null;
  /** How many non-optional lines the total used, and how many there are. */
  from: number;
  total: number;
  /** The lines that contributed nothing, by name — shown so the gap is visible. */
  missing: string[];
}

/**
 * What a recipe costs to cook, in euros, at the last price paid for each
 * ingredient. Prices are per base unit (€/g, €/ml, €/piece).
 */
export function recipeCost(recipe: Recipe, servings: number, lookup: IngredientLookup): Estimate {
  const scale = scaleFor(recipe, servings);
  let value: number | null = null;
  let from = 0;
  const missing: string[] = [];
  const lines = recipe.ingredients.filter((i) => !i.optional);
  for (const line of lines) {
    const ingredient = lookup(line.ingredientId);
    const base = toBase(scale(line));
    if (!ingredient || ingredient.lastPrice === null || !base) {
      missing.push(line.text || ingredient?.name || "unknown");
      continue;
    }
    value = (value ?? 0) + ingredient.lastPrice * base.quantity;
    from += 1;
  }
  return { value: value === null ? null : Math.round(value * 100) / 100, from, total: lines.length, missing };
}

export interface NutritionEstimate {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fibre: number | null;
  from: number;
  total: number;
  missing: string[];
}

/**
 * The nutrition of the whole dish at `servings`. Per-100 values apply to
 * weight and volume; a line counted in pieces can only be used when the
 * ingredient says what one piece weighs — until that exists, pieces are
 * reported as missing rather than guessed.
 */
export function recipeNutrition(
  recipe: Recipe,
  servings: number,
  lookup: IngredientLookup
): NutritionEstimate {
  const scale = scaleFor(recipe, servings);
  const totals: Record<keyof NutritionPer100, number | null> = {
    kcal: null,
    protein: null,
    carbs: null,
    fat: null,
    fibre: null,
  };
  let from = 0;
  const missing: string[] = [];
  const lines = recipe.ingredients.filter((i) => !i.optional);
  for (const line of lines) {
    const ingredient = lookup(line.ingredientId);
    const base = toBase(scale(line));
    if (!ingredient?.nutrition || !base || base.unit === "piece") {
      missing.push(line.text || ingredient?.name || "unknown");
      continue;
    }
    const hundreds = base.quantity / 100;
    let used = false;
    for (const key of ["kcal", "protein", "carbs", "fat", "fibre"] as Array<keyof NutritionPer100>) {
      const per100 = ingredient.nutrition[key];
      if (per100 === null || per100 === undefined) continue;
      totals[key] = (totals[key] ?? 0) + per100 * hundreds;
      used = true;
    }
    if (used) from += 1;
    else missing.push(line.text || ingredient.name);
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    kcal: round(totals.kcal),
    protein: round(totals.protein),
    carbs: round(totals.carbs),
    fat: round(totals.fat),
    fibre: round(totals.fibre),
    from,
    total: lines.length,
    missing,
  };
}

/** The same figures per serving, which is how both are shown. */
export function perServing(estimate: NutritionEstimate, servings: number): NutritionEstimate {
  if (!Number.isFinite(servings) || servings <= 0) return estimate;
  const share = (v: number | null) => (v === null ? null : Math.round(v / servings));
  return {
    ...estimate,
    kcal: share(estimate.kcal),
    protein: share(estimate.protein),
    carbs: share(estimate.carbs),
    fat: share(estimate.fat),
    fibre: share(estimate.fibre),
  };
}

/** Prep plus cook, when either is known — "55 min" on a recipe card. */
export function totalMinutes(recipe: Recipe): number | null {
  if (recipe.prepMinutes === null && recipe.cookMinutes === null) return null;
  return (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
}

/**
 * When to start so the food is ready at `eatAt`. Null when the recipe
 * doesn't say how long it takes — better no answer than a made-up one.
 */
export function startCookingAt(recipe: Recipe, eatAt: Date): Date | null {
  const minutes = totalMinutes(recipe);
  if (minutes === null) return null;
  return new Date(eatAt.getTime() - minutes * 60_000);
}

/**
 * A price per base unit from a purchase: €4.99 for a 1 kg pack is
 * €0.00499 per gram. That's what `Ingredient.lastPrice` holds, so a
 * recipe's cost doesn't care what size the package was.
 */
export function pricePerBaseUnit(paid: number, amount: Amount): number | null {
  const base = toBase(amount);
  if (!base || base.quantity <= 0 || !Number.isFinite(paid) || paid < 0) return null;
  // Rounded well past cent precision: enough for €/g, short of floating-point noise.
  return Math.round((paid / base.quantity) * 1e8) / 1e8;
}
