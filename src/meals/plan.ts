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
import { MEAL_KIND_LABELS, MEAL_SLOTS, MealSlot, PlannedMeal, Recipe } from "./types";
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
    const cost = recipe ? recipeCost(recipe, cookServingsOf(meal, recipe), lookup) : null;
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
  return MEAL_KIND_LABELS[meal.kind] ?? "Meal";
}

/** How far a planned leftover meal goes: portions there against servings wanted. */
export function leftoverCoverage(
  meal: PlannedMeal,
  leftovers: Map<string, { portions: number }>
): { portions: number; needed: number; short: number } | null {
  if (meal.kind !== "leftover" || (!meal.leftoverId && !meal.fromMealId)) return null;
  const there = meal.leftoverId ? (leftovers.get(meal.leftoverId)?.portions ?? 0) : Infinity;
  // A meal given its share of a batch takes that share, if it's still there.
  const portions = meal.portions !== null ? Math.min(meal.portions, there) : there;
  const needed = meal.servings;
  return { portions: Math.min(portions, needed), needed, short: Math.max(0, needed - portions) };
}

export type MealBadgeKind = "leftover" | "pantry" | "pick" | "swap" | "kind";

/** The small tag a plan cell carries: leftovers covering 2 of 3, all from the pantry, your pick. */
export interface MealBadge {
  kind: MealBadgeKind;
  label: string;
}

/**
 * The badge for a planned meal, or null. `atHome` is the recipe's
 * coverage when it's cooked from a recipe — all of it at home means there
 * is nothing to buy for it.
 */
export function mealBadge(
  meal: PlannedMeal,
  leftovers: Map<string, { portions: number }>,
  atHome: { have: number; total: number } | null,
  /** Show "Your pick" for meals you chose — only beside the planner's own. */
  picks = false
): MealBadge | null {
  const coverage = leftoverCoverage(meal, leftovers);
  if (coverage) return { kind: "leftover", label: `↺ ${coverage.portions}/${coverage.needed}` };
  // Not cooked at home: say what it was — "Divinos" reads as a meal out.
  const away: Partial<Record<PlannedMeal["kind"], string>> = {
    out: "Out",
    takeaway: "Takeaway",
    friends: "At friends'",
    work: "At work",
    skip: "Skipped",
  };
  if (away[meal.kind]) return { kind: "kind", label: away[meal.kind]! };
  if (meal.swapSaving !== null && meal.swapSaving > 0)
    return { kind: "swap", label: `€ −${meal.swapSaving.toFixed(2).replace(".", ",")}` };
  if (picks && meal.origin === "user" && !meal.cookedAt) return { kind: "pick", label: "✎ Your pick" };
  if (meal.kind === "recipe" && !meal.cookedAt && atHome && atHome.total > 0 && atHome.have === atHome.total)
    return { kind: "pantry", label: "◦ Pantry" };
  return null;
}

/**
 * How many servings a planned meal cooks: what you set, else the recipe as
 * written — a recipe for 5 cooks 5 — and never fewer than are eating.
 */
export function cookServingsOf(
  meal: Pick<PlannedMeal, "cookServings" | "servings">,
  recipe: { servings: number } | null | undefined
): number {
  if (meal.cookServings !== null) return meal.cookServings;
  return Math.max(recipe?.servings ?? meal.servings, meal.servings);
}

/** Lunch and dinner — the meals leftovers go into. */
export const LEFTOVER_SLOTS: MealSlot[] = ["lunch", "dinner"];

/**
 * Where a batch's extra portions go: into the next free meals, as many
 * as eat each time — 3 extra for 2 people is 2 at the next meal and 1 at
 * the one after, which then needs something alongside (`short`). Only
 * meals up to `eatBy` (inclusive), in order.
 */
export function spreadLeftovers(
  extra: number,
  eating: number,
  free: Array<{ date: string; slot: MealSlot }>,
  eatBy: string | null = null
): Array<{ date: string; slot: MealSlot; portions: number; short: number }> {
  const out: Array<{ date: string; slot: MealSlot; portions: number; short: number }> = [];
  let left = Math.round(extra * 100) / 100;
  for (const option of free) {
    if (left <= 0 || eating <= 0) break;
    if (eatBy && option.date > eatBy) break;
    const portions = Math.min(left, eating);
    out.push({ ...option, portions, short: Math.round((eating - portions) * 100) / 100 });
    left = Math.round((left - portions) * 100) / 100;
  }
  return out;
}

/**
 * The lunches and dinners after a meal, in order, that nothing is planned
 * in yet — for its leftovers. `days` counts from the meal's own day.
 */
export function freeMealsAfter(
  plan: Array<Pick<PlannedMeal, "date" | "slot">>,
  after: { date: string; slot: MealSlot },
  days: number,
  slots: MealSlot[] = LEFTOVER_SLOTS
): Array<{ date: string; slot: MealSlot }> {
  const taken = new Set(plan.map((meal) => `${meal.date}|${meal.slot}`));
  const order = (slot: MealSlot) => MEAL_SLOTS.indexOf(slot);
  const free: Array<{ date: string; slot: MealSlot }> = [];
  for (const date of dayRange(new Date(`${after.date}T12:00:00`), days))
    for (const slot of slots.filter((s) => LEFTOVER_SLOTS.includes(s)).sort((a, b) => order(a) - order(b))) {
      if (date === after.date && order(slot) <= order(after.slot)) continue;
      if (!taken.has(`${date}|${slot}`)) free.push({ date, slot });
    }
  return free;
}

/** Leftovers a planned batch will leave, not cooked yet: how many, and how many are already planned. */
export interface ExpectedLeftover {
  mealId: string;
  recipeId: string;
  name: string;
  date: string;
  slot: MealSlot;
  /** Portions cooked past who's eating. */
  extra: number;
  /** Of those, how many planned meals already take. */
  planned: number;
  /** What's still free to plan. */
  free: number;
}

/**
 * Every planned batch not cooked yet that cooks more than is eaten — Wed's
 * traybake cooking 4 for 2 leaves 2 — and how much of that is spoken for,
 * so another meal can be planned from the rest.
 */
export function expectedLeftovers(plan: PlannedMeal[], recipes: Map<string, Recipe>): ExpectedLeftover[] {
  const out: ExpectedLeftover[] = [];
  for (const meal of plan) {
    if (meal.cookedAt || meal.kind !== "recipe" || !meal.recipeId) continue;
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;
    const extra = Math.round((cookServingsOf(meal, recipe) - meal.servings) * 100) / 100;
    if (extra <= 0) continue;
    const planned = plan
      .filter((other) => other.kind === "leftover" && other.fromMealId === meal.id && !other.leftoverId)
      .reduce((sum, other) => sum + (other.portions ?? other.servings), 0);
    out.push({
      mealId: meal.id,
      recipeId: recipe.id,
      name: recipe.name,
      date: meal.date,
      slot: meal.slot,
      extra,
      planned: Math.round(planned * 100) / 100,
      free: Math.max(0, Math.round((extra - planned) * 100) / 100),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot)
  );
}
