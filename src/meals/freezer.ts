/**
 * The freezer side of planning — pure.
 *
 * Meat bought in bulk goes into the freezer in bags, and a bag is
 * defrosted whole. Two questions follow: how to bag what was bought, given
 * the meals it's for (`bagNeeds` feeds `suggestBags`), and what has to come
 * out of the freezer, and when, for the meals coming up (`defrostList`).
 */

import { Family, NO_FAMILY, fits, planDeductions } from "./pantry";
import { cookServingsOf } from "./plan";
import { scaleFor } from "./recipes";
import { MEAL_SLOTS } from "./types";
import type { MealSlot, PantryItem, PlannedMeal, Recipe } from "./types";
import type { Amount } from "./units";

const order = (meal: Pick<PlannedMeal, "date" | "slot">) => `${meal.date}|${MEAL_SLOTS.indexOf(meal.slot)}`;

/**
 * What each planned meal from `from` onwards takes of a food (or of a
 * general food it counts as) — the sizes a bag of it would be useful in.
 */
export function bagNeeds(
  ingredientId: string,
  plan: PlannedMeal[],
  recipes: Map<string, Recipe>,
  from: string,
  family: Family = NO_FAMILY
): Amount[] {
  const needs: Amount[] = [];
  for (const meal of plan) {
    if (meal.cookedAt || meal.kind !== "recipe" || !meal.recipeId || meal.date < from) continue;
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;
    const scale = scaleFor(recipe, cookServingsOf(meal, recipe));
    for (const line of recipe.ingredients)
      if (!line.optional && fits(ingredientId, line.ingredientId, family)) needs.push(scale(line));
  }
  return needs;
}

export interface DefrostItem {
  mealId: string;
  date: string;
  slot: MealSlot;
  meal: string;
  /** The freezer items this meal takes: "Chicken breasts · frozen bag of 6". */
  items: string[];
}

/**
 * What to take out of the freezer for the meals on `dates`: each meal's
 * deductions, worked out in order from today so a bag two meals might use
 * is only counted for the first.
 */
export function defrostList(
  plan: PlannedMeal[],
  recipes: Map<string, Recipe>,
  pantry: PantryItem[],
  today: string,
  dates: string[],
  family: Family = NO_FAMILY
): DefrostItem[] {
  let stock = pantry.map((item) => ({ ...item }));
  const list: DefrostItem[] = [];
  const last = [...dates].sort().pop() ?? today;
  const meals = plan
    .filter(
      (meal) =>
        !meal.cookedAt && meal.kind === "recipe" && meal.recipeId && meal.date >= today && meal.date <= last
    )
    .sort((a, b) => order(a).localeCompare(order(b)));
  for (const meal of meals) {
    const recipe = recipes.get(meal.recipeId!);
    if (!recipe) continue;
    const plan = planDeductions(recipe.ingredients, stock, scaleFor(recipe, cookServingsOf(meal, recipe)), {
      family,
    });
    const frozen = plan.deductions
      .map((deduction) => stock.find((item) => item.id === deduction.itemId))
      .filter((item): item is PantryItem => item?.place === "freezer");
    if (frozen.length && dates.includes(meal.date))
      list.push({
        mealId: meal.id,
        date: meal.date,
        slot: meal.slot,
        meal: recipe.name,
        items: [...new Set(frozen.map((item) => [item.name, item.packaging].filter(Boolean).join(" · ")))],
      });
    stock = stock.map((item) => {
      const used = plan.deductions.find((d) => d.itemId === item.id);
      return used ? { ...item, quantity: used.remaining.quantity, unit: used.remaining.unit } : item;
    });
  }
  return list;
}
