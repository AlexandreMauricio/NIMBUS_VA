/**
 * The plan: which meal is eaten when.
 *
 * In this version nothing is generated — the user puts meals in slots, and
 * NIMBUS's job is to read that back usefully: what's on today, what the
 * week looks like, how many servings the household needs, and what the
 * plan will cost. The generator, the shopping list and the budget
 * negotiation come later and will read the same shapes.
 *
 * Pure, and every function takes the day it should consider "today".
 */

import { isoDate } from "./pantry";
import { recipeCost } from "./recipes";
import type { IngredientLookup } from "./recipes";
import { MEAL_SLOTS, MealSlot, PlannedMeal, Recipe } from "./types";
import type { Eater, MealPreferences } from "./types";

/**
 * How many servings a meal should be cooked for: each eater's factor
 * added up, rounded up to a whole serving — you can't cook 2.8 portions,
 * and the rounding is the reason there are leftovers at all.
 */
export function servingsNeeded(eaters: Eater[]): number {
  if (!eaters.length) return 1;
  const total = eaters.reduce(
    (sum, eater) => sum + (Number.isFinite(eater.portionFactor) ? eater.portionFactor : 1),
    0
  );
  return Math.max(1, Math.ceil(Math.round(total * 100) / 100));
}

/** The plan's entries for one day, in slot order, earliest time first within a slot. */
export function mealsOn(plan: PlannedMeal[], date: string, slots: MealSlot[] = MEAL_SLOTS): PlannedMeal[] {
  const order = new Map(slots.map((slot, index) => [slot, index]));
  return plan
    .filter((meal) => meal.date === date && order.has(meal.slot))
    .sort(
      (a, b) =>
        (order.get(a.slot) ?? 0) - (order.get(b.slot) ?? 0) ||
        (a.time ?? "99:99").localeCompare(b.time ?? "99:99")
    );
}

/** The seven (or however many) days from `from`, as ISO dates. */
export function dayRange(from: Date, days: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    dates.push(isoDate(day));
  }
  return dates;
}

/** The next meal still to come today: the first one not yet cooked or eaten. */
export function nextMeal(plan: PlannedMeal[], now: Date, slots: MealSlot[] = MEAL_SLOTS): PlannedMeal | null {
  const today = isoDate(now);
  const clock = `${`${now.getHours()}`.padStart(2, "0")}:${`${now.getMinutes()}`.padStart(2, "0")}`;
  const todays = mealsOn(plan, today, slots).filter((meal) => !meal.cookedAt);
  return todays.find((meal) => !meal.time || meal.time >= clock) ?? todays[0] ?? null;
}

export interface PlanCost {
  /** What the entries add up to, in euros, or null when nothing could be priced. */
  value: number | null;
  /** Entries that carry their own cost ("out" meals, or a cost typed in). */
  known: number;
  /** Entries costed from their recipe's ingredients. */
  estimated: number;
  /** Entries nothing could be said about. */
  unknown: number;
  /** The daily budget for the days covered, when one is set. */
  budget: number | null;
  overBudget: boolean;
}

/**
 * What a stretch of the plan costs. A meal's own `cost` wins over the
 * recipe estimate — a typed price is a fact, and an "out" meal has no
 * ingredients to add up.
 */
export function planCost(
  meals: PlannedMeal[],
  recipes: Map<string, Recipe>,
  lookup: IngredientLookup,
  preferences: MealPreferences
): PlanCost {
  let value: number | null = null;
  let known = 0;
  let estimated = 0;
  let unknown = 0;
  for (const meal of meals) {
    if (meal.cost !== null) {
      value = (value ?? 0) + meal.cost;
      known += 1;
      continue;
    }
    const recipe = meal.kind === "recipe" && meal.recipeId ? recipes.get(meal.recipeId) : undefined;
    const cost = recipe ? recipeCost(recipe, meal.cookServings ?? meal.servings, lookup) : null;
    if (cost?.value === null || cost === null) {
      unknown += 1;
      continue;
    }
    value = (value ?? 0) + cost.value;
    estimated += 1;
  }
  const days = new Set(meals.map((meal) => meal.date)).size;
  const budget =
    preferences.dailyBudget === null ? null : Math.round(preferences.dailyBudget * days * 100) / 100;
  return {
    value: value === null ? null : Math.round(value * 100) / 100,
    known,
    estimated,
    unknown,
    budget,
    overBudget: budget !== null && value !== null && value > budget,
  };
}

/** A meal's display name, whatever it is made of. */
export function mealName(
  meal: PlannedMeal,
  recipes: Map<string, Recipe>,
  leftovers: Map<string, { name: string }> = new Map()
): string {
  if (meal.kind === "recipe" && meal.recipeId) {
    const recipe = recipes.get(meal.recipeId);
    if (recipe) return recipe.name;
  }
  // Leftovers read as what they are — "Chilli con carne", not "Meal".
  if (meal.kind === "leftover" && meal.leftoverId) {
    const leftover = leftovers.get(meal.leftoverId);
    if (leftover) return `${leftover.name} (leftovers)`;
  }
  if (meal.name) return meal.name;
  return meal.kind === "out" ? "Eating out" : "Meal";
}
