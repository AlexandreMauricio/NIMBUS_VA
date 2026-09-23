/**
 * The planner: fills a stretch of days with meals from your own recipes —
 * deterministically, with a reason for every choice.
 *
 * There is no AI here and no randomness. For each empty slot, day by day,
 * every recipe that suits the slot is first filtered (restrictions, the
 * cooking time you allow on that day, the difficulty you want, how often
 * it's already come up) and then scored against the objectives:
 *
 *  - **pantry**: the share of its ingredients already at home, and food
 *    that has to be used in the next days;
 *  - **leftovers**: cooked portions go into a meal before they expire,
 *    before any recipe is considered;
 *  - **money**: the cost per serving, against what's left of the budget;
 *  - **quick**, **easy**, **protein**: minutes, difficulty, grams per serving;
 *
 * plus a favourite's boost, a push down for anything cooked in the last
 * few days (variety), and a bigger one for dislikes. The highest score
 * wins; ties go to the name, so the same kitchen and the same day always
 * give the same plan. Each choice uses up what it takes from a copy of the
 * pantry, so the next choice sees what's really left.
 *
 * When the plan comes out over budget and you've asked it to, the most
 * expensive meals it chose are swapped for the cheapest that still fit,
 * each swap recorded ("budget swap −3,10 €"). What can't be fixed that way
 * becomes the banner's options: raise the budget, allow repeats, or swap
 * one more by hand.
 *
 * Pure: the service gives it the state, it gives back a proposal.
 */

import { ingredientKey } from "./names";
import {
  coverRecipe,
  coverageCount,
  expiryState,
  isoDate,
  planDeductions,
  usableLeftovers,
  wholeBagServings,
} from "./pantry";
import type { Family } from "./pantry";
import { LEFTOVER_SLOTS, cookServingsOf, dayRange, spreadLeftovers } from "./plan";
import { perServing, recipeCost, recipeNutrition, scaleFor, totalMinutes } from "./recipes";
import type { IngredientLookup } from "./recipes";
import { formatAmount } from "./units";
import { MEAL_SLOTS } from "./types";
import type {
  BudgetFix,
  Ingredient,
  Leftover,
  MealPreferences,
  MealSlot,
  PantryItem,
  PlanProposal,
  PlanRequest,
  PlannedMeal,
  Recipe,
} from "./types";

export interface PlannerInput {
  recipes: Recipe[];
  ingredients: Ingredient[];
  /** Ingredients with their current price (the cheapest recent one). */
  lookup: IngredientLookup;
  pantry: PantryItem[];
  /** Foods that count as others (Soy milk → Milk), for what's at home. */
  family: Family;
  leftovers: Leftover[];
  /** The plan as it is — kept where you placed, locked or cooked something. */
  plan: PlannedMeal[];
  preferences: MealPreferences;
  /** Today, for expiry and "cooked recently". */
  today: string;
  /** New ids for proposed meals. */
  id: () => string;
  now: string;
}

/** What a restriction rules out, by words in an ingredient's name, category or the recipe's tags. */
const RESTRICTION_WORDS: Record<string, string[]> = {
  vegetarian: [
    "meat",
    "chicken",
    "beef",
    "pork",
    "mince",
    "bacon",
    "ham",
    "fish",
    "tuna",
    "salmon",
    "cod",
    "chorizo",
    "prawn",
    "shrimp",
    "carne",
    "frango",
    "porco",
    "peixe",
    "atum",
    "bacalhau",
  ],
  vegan: [
    "meat",
    "chicken",
    "beef",
    "pork",
    "mince",
    "bacon",
    "ham",
    "fish",
    "tuna",
    "salmon",
    "cod",
    "egg",
    "milk",
    "cheese",
    "yoghurt",
    "butter",
    "cream",
    "honey",
    "dairy",
  ],
  "no pork": ["pork", "bacon", "ham", "chorizo", "porco", "presunto", "chourico", "toucinho"],
  "gluten free": [
    "flour",
    "bread",
    "pasta",
    "spaghetti",
    "noodle",
    "couscous",
    "barley",
    "wheat",
    "rye",
    "farinha",
    "pao",
    "massa",
  ],
  "lactose free": ["milk", "cheese", "yoghurt", "butter", "cream", "leite", "queijo", "iogurte", "natas"],
  "no fish": ["fish", "tuna", "salmon", "cod", "prawn", "shrimp", "peixe", "atum", "bacalhau"],
};

/** The words a restriction or dislike stands for: a known diet's list, or "No X" → X. */
function wordsFor(rule: string): string[] {
  const key = ingredientKey(rule.replace(/-/g, " "));
  const known = Object.entries(RESTRICTION_WORDS).find(([name]) => ingredientKey(name) === key);
  if (known) return known[1].map(ingredientKey);
  return [ingredientKey(rule.replace(/^\s*no\s+/i, ""))].filter(Boolean);
}

/** Everything a recipe could be judged by: its name, tags, and its ingredients' names and kinds. */
function recipeWords(recipe: Recipe, ingredients: Map<string, Ingredient>): string {
  const parts = [recipe.name, ...recipe.tags];
  for (const line of recipe.ingredients) {
    const food = ingredients.get(line.ingredientId);
    parts.push(line.text, food?.name ?? "", food?.category ?? "");
  }
  return ` ${parts.map(ingredientKey).join(" ")} `;
}

function mentions(words: string, rule: string[]): string | null {
  for (const word of rule) if (word && words.includes(` ${word} `)) return word;
  for (const word of rule) if (word && word.length > 3 && words.includes(word)) return word;
  return null;
}

const DIFFICULTY_RANK = { easy: 1, medium: 2, hard: 3 } as const;

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00`).getDay();
  return day === 0 || day === 6;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
}

const euro = (value: number) =>
  `${value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

interface Candidate {
  recipe: Recipe;
  score: number;
  reasons: string[];
  cost: number | null;
  coverage: { have: number; total: number };
}

/** A recipe that can go in a slot at all: the hard rules, each a reason it can't. */
export function allowed(
  recipe: Recipe,
  slot: MealSlot,
  date: string,
  input: PlannerInput,
  counts: Map<string, number>,
  allowRepeats: boolean
): string | null {
  const prefs = input.preferences;
  if (!recipe.slots.includes(slot)) return "not for this meal";
  const ingredients = new Map(input.ingredients.map((i) => [i.id, i]));
  const words = recipeWords(recipe, ingredients);
  for (const rule of prefs.restrictions) {
    const hit = mentions(words, wordsFor(rule));
    if (hit) return `${rule}: has ${hit}`;
  }
  const limit = isWeekend(date) ? prefs.cookingTime.weekend : prefs.cookingTime.weekday;
  const minutes = totalMinutes(recipe);
  if (limit !== null && minutes !== null && minutes > limit) return `over the ${limit} min limit`;
  if (
    prefs.difficulty !== "any" &&
    recipe.difficulty &&
    DIFFICULTY_RANK[recipe.difficulty] > DIFFICULTY_RANK[prefs.difficulty]
  )
    return `${recipe.difficulty} to make`;
  if (!allowRepeats && (counts.get(recipe.id) ?? 0) >= prefs.maxRepeats)
    return "already in the plan enough times";
  return null;
}

/** How well a recipe fits a slot, and why — the scoring described at the top. */
export function scoreRecipe(
  recipe: Recipe,
  date: string,
  servings: number,
  input: PlannerInput,
  pantry: PantryItem[],
  objectives: Set<string>,
  lastPlanned: Map<string, string>,
  budgetLeft: number | null
): Candidate {
  const reasons: string[] = [];
  let score = 0;
  // A recipe cooks as written (at least for everyone eating); the extra is leftovers.
  const cooked = Math.max(recipe.servings, servings);
  const scale = scaleFor(recipe, cooked);
  const coverage = coverageCount(coverRecipe(recipe.ingredients, pantry, scale, input.family));
  const share = coverage.total ? coverage.have / coverage.total : 0;
  if (objectives.has("pantry")) {
    score += share * 3;
    if (coverage.total && coverage.have >= Math.ceil(coverage.total / 2))
      reasons.push(`${coverage.have} of ${coverage.total} ingredients already at home`);
    // Food that has to be used soon, which this recipe would use.
    const soon = recipe.ingredients
      .map((line) => pantry.find((item) => item.ingredientId === line.ingredientId && item.quantity > 0))
      .filter((item): item is PantryItem => Boolean(item))
      .filter((item) =>
        ["urgent", "soon", "expired"].includes(
          expiryState(item.expiresAt, new Date(`${input.today}T12:00:00`))
        )
      );
    if (soon.length) {
      score += 1.5 * soon.length;
      reasons.push(`Uses ${soon.map((item) => item.name.toLowerCase()).join(", ")} before it goes off`);
    }
  }
  const cost = recipeCost(recipe, cooked, input.lookup).value;
  if (objectives.has("money") && cost !== null) {
    const perServing = cost / Math.max(1, cooked);
    score += Math.max(-2, 2 - perServing);
    if (perServing <= 2) reasons.push(`≈ ${euro(perServing)} a serving`);
  }
  // Against the day's budget, only the servings eaten that day count.
  if (budgetLeft !== null && cost !== null && (cost * servings) / cooked > budgetLeft) score -= 2;
  const minutes = totalMinutes(recipe);
  if (objectives.has("quick") && minutes !== null && minutes <= 30) {
    score += 1;
    reasons.push(`Quick: ${minutes} min`);
  }
  if (objectives.has("easy") && recipe.difficulty === "easy") {
    score += 1;
    reasons.push("Easy to make");
  }
  if (objectives.has("protein")) {
    const protein = perServing(recipeNutrition(recipe, servings, input.lookup), servings).protein;
    if (protein !== null && protein >= 25) {
      score += 1;
      reasons.push(`${protein} g protein a serving`);
    }
  }
  if (recipe.favourite) {
    score += 0.8;
    reasons.push("One of your favourites");
  }
  // Variety: pushed down when cooked or planned in the last few days.
  const last = [recipe.lastCookedAt?.slice(0, 10), lastPlanned.get(recipe.id)]
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();
  if (last) {
    const gap = Math.abs(daysBetween(last, date));
    if (gap < 3) score -= 2 - gap * 0.5;
    else reasons.push(`Not had in ${gap} days`);
  } else reasons.push("Not had recently");
  const ingredients = new Map(input.ingredients.map((i) => [i.id, i]));
  const words = recipeWords(recipe, ingredients);
  for (const dislike of input.preferences.dislikes) {
    if (mentions(words, wordsFor(dislike))) {
      score -= 2;
      reasons.push(`Has ${dislike.toLowerCase()} — disliked`);
    }
  }
  return { recipe, score, reasons: reasons.slice(0, 4), cost, coverage };
}

/** Takes what a recipe uses out of a copy of the pantry, so the next choice sees what's left. */
function useUp(pantry: PantryItem[], recipe: Recipe, servings: number, family: Family): PantryItem[] {
  const plan = planDeductions(recipe.ingredients, pantry, scaleFor(recipe, servings), { family });
  return pantry.map((item) => {
    const deduction = plan.deductions.find((d) => d.itemId === item.id);
    return deduction
      ? { ...item, quantity: deduction.remaining.quantity, unit: deduction.remaining.unit }
      : item;
  });
}

function blankMeal(input: PlannerInput, date: string, slot: MealSlot, servings: number): PlannedMeal {
  return {
    id: input.id(),
    date,
    slot,
    kind: "recipe",
    recipeId: null,
    leftoverId: null,
    name: null,
    servings,
    cookServings: null,
    time: null,
    cost: null,
    notes: null,
    cookedAt: null,
    locked: false,
    origin: "generator",
    reasons: [],
    swapSaving: null,
    portions: null,
    fromMealId: null,
    addedAt: input.now,
    updatedAt: input.now,
  };
}

/** What a proposed meal costs (a leftover is already paid for). */
function mealCost(meal: PlannedMeal, input: PlannerInput): number | null {
  if (meal.cost !== null) return meal.cost;
  if (meal.kind === "leftover") return 0;
  const recipe = input.recipes.find((r) => r.id === meal.recipeId);
  return recipe ? recipeCost(recipe, cookServingsOf(meal, recipe), input.lookup).value : null;
}

/** "Thu", for saying which meal leftovers come from. */
function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" });
}

/** How long cooked food keeps in the fridge, for planning a batch's leftovers. */
const FRIDGE_DAYS = 3;

/** What a meal costs the day it's eaten: a batch counts for the servings eaten then, the rest is leftovers. */
function mealShare(meal: PlannedMeal, input: PlannerInput): number | null {
  const cost = mealCost(meal, input);
  if (cost === null || meal.kind !== "recipe") return cost;
  const recipe = input.recipes.find((r) => r.id === meal.recipeId);
  return recipe ? (cost * meal.servings) / cookServingsOf(meal, recipe) : cost;
}

/** Fills the request's empty slots with the best meals, day by day. */
export function generatePlan(input: PlannerInput, request: PlanRequest): PlanProposal {
  const days = dayRange(new Date(`${request.from}T12:00:00`), request.days);
  const objectives = new Set<string>(request.objectives);
  // What stays: anything in these days you placed, locked or already cooked.
  const kept = input.plan.filter(
    (meal) => days.includes(meal.date) && (meal.origin === "user" || meal.locked || meal.cookedAt)
  );
  const taken = new Set(kept.map((meal) => `${meal.date}|${meal.slot}`));
  const counts = new Map<string, number>();
  const lastPlanned = new Map<string, string>();
  for (const meal of input.plan)
    if (meal.recipeId && meal.date < request.from && daysBetween(meal.date, request.from) <= 7)
      lastPlanned.set(meal.recipeId, meal.date);
  for (const meal of kept)
    if (meal.recipeId) {
      counts.set(meal.recipeId, (counts.get(meal.recipeId) ?? 0) + 1);
      lastPlanned.set(meal.recipeId, meal.date);
    }

  const allowRepeats = request.allowRepeats;
  let pantry = input.pantry.map((item) => ({ ...item }));
  const proposed: PlannedMeal[] = [];
  const key = (option: { date: string; slot: MealSlot }) => `${option.date}|${option.slot}`;
  const slotOrder = (slot: MealSlot) => MEAL_SLOTS.indexOf(slot);
  /** The free lunches and dinners after a meal, up to an eat-by date. */
  const freeAfter = (after: { date: string; slot: MealSlot }, until: string | null) =>
    days
      .flatMap((date) =>
        LEFTOVER_SLOTS.filter((slot) => request.slots.includes(slot)).map((slot) => ({ date, slot }))
      )
      .filter(
        (option) =>
          (option.date > after.date ||
            (option.date === after.date && slotOrder(option.slot) > slotOrder(after.slot))) &&
          !taken.has(key(option)) &&
          (!until || option.date <= until)
      );
  /** What a batch cooks, and what it costs a serving — leftovers make the rest of the batch worth it. */
  const batchOf = (recipe: Recipe, servings: number) => {
    const cooked = Math.max(recipe.servings, servings);
    return { cooked, extra: Math.round((cooked - servings) * 100) / 100 };
  };

  /**
   * Leftovers into the next free meals: as many portions as eat each time,
   * and where they don't feed everyone, something alongside for the rest.
   */
  const spreadInto = (
    source: {
      name: string;
      portions: number;
      eatBy: string | null;
      leftoverId?: string;
      fromMealId?: string;
    },
    after: { date: string; slot: MealSlot },
    depth: number
  ) => {
    for (const share of spreadLeftovers(source.portions, request.eating, freeAfter(after, source.eatBy))) {
      const meal = blankMeal(input, share.date, share.slot, request.eating);
      meal.kind = "leftover";
      meal.leftoverId = source.leftoverId ?? null;
      meal.fromMealId = source.fromMealId ?? null;
      meal.portions = share.portions;
      meal.name = `${source.name} (leftovers)`;
      meal.reasons = [
        source.fromMealId
          ? `Leftovers of the ${source.name.toLowerCase()} cooked ${weekdayOf(after.date)} ${after.slot} — ${share.portions} of ${source.portions} extra portion${source.portions === 1 ? "" : "s"}`
          : `Uses ${share.portions === source.portions ? "" : `${share.portions} of `}${source.portions} cooked portion${source.portions === 1 ? "" : "s"} before they expire`,
        share.short > 0
          ? `Only covers ${share.portions} of ${request.eating} — ${share.short} more portion${share.short === 1 ? "" : "s"} needed`
          : `Covers all ${request.eating}`,
      ];
      proposed.push(meal);
      taken.add(key(share));
      if (share.short > 0 && depth < 3) topUp(share, share.short, meal, depth);
    }
  };

  /** A recipe placed in a slot — and, cooked as a batch, its extra portions planned after it. */
  const place = (
    date: string,
    slot: MealSlot,
    candidate: Candidate,
    servings: number,
    depth: number,
    reasons?: string[]
  ): PlannedMeal => {
    const meal = blankMeal(input, date, slot, servings);
    meal.recipeId = candidate.recipe.id;
    meal.reasons =
      reasons ?? (candidate.reasons.length ? candidate.reasons : ["The best fit left for this meal"]);
    proposed.push(meal);
    taken.add(key({ date, slot }));
    counts.set(candidate.recipe.id, (counts.get(candidate.recipe.id) ?? 0) + 1);
    lastPlanned.set(candidate.recipe.id, date);
    const batch = batchOf(candidate.recipe, servings);
    // A frozen bag is defrosted whole: cook enough to use it all, and plan what's over.
    const bag = wholeBagServings(candidate.recipe, batch.cooked, pantry, input.family);
    if (bag !== null) {
      meal.cookServings = bag;
      meal.reasons = [`Cooks ${bag} to use the whole frozen bag`, ...meal.reasons].slice(0, 4);
      batch.cooked = bag;
      batch.extra = Math.round((bag - servings) * 100) / 100;
    }
    pantry = useUp(pantry, candidate.recipe, batch.cooked, input.family);
    if (batch.extra > 0 && input.preferences.autoLeftovers)
      spreadInto(
        {
          name: candidate.recipe.name,
          portions: batch.extra,
          eatBy: isoDate(new Date(Date.parse(`${date}T12:00:00`) + FRIDGE_DAYS * 86_400_000)),
          fromMealId: meal.id,
        },
        { date, slot },
        depth + 1
      );
    return meal;
  };

  /** Leftovers that don't feed everyone: the best recipe for the rest, in the same meal. */
  const topUp = (
    at: { date: string; slot: MealSlot },
    short: number,
    leftovers: PlannedMeal,
    depth: number
  ) => {
    const best = input.recipes
      .filter((recipe) => !allowed(recipe, at.slot, at.date, input, counts, allowRepeats))
      .map((recipe) => scoreRecipe(recipe, at.date, short, input, pantry, objectives, lastPlanned, null))
      // Something small alongside, rather than another big batch and more leftovers after it.
      .map((candidate) => ({
        ...candidate,
        fit: candidate.score - 0.3 * batchOf(candidate.recipe, short).extra,
      }))
      .sort((a, b) => b.fit - a.fit || a.recipe.name.localeCompare(b.recipe.name))[0];
    if (!best) return;
    const beside = place(at.date, at.slot, best, short, depth, [
      `Alongside ${leftovers.name?.toLowerCase() ?? "the leftovers"}: ${short} more serving${short === 1 ? "" : "s"} needed`,
      ...best.reasons.slice(0, 2),
    ]);
    // Planned because of those leftovers: it goes when they do.
    beside.fromMealId = leftovers.id;
  };

  // Leftovers first: spread over the earliest free lunches and dinners before they have to be eaten.
  if (objectives.has("leftovers")) {
    const promised = new Set(
      input.plan.filter((m) => m.kind === "leftover" && !m.cookedAt).map((m) => m.leftoverId)
    );
    for (const leftover of usableLeftovers(input.leftovers, new Date(`${input.today}T12:00:00`))) {
      if (promised.has(leftover.id)) continue;
      spreadInto(
        { name: leftover.name, portions: leftover.portions, eatBy: leftover.eatBy, leftoverId: leftover.id },
        { date: days[0], slot: "breakfast" },
        0
      );
    }
  }

  const perDayBudget =
    request.budgetPerDay ?? (request.budgetTotal !== null ? request.budgetTotal / days.length : null);
  // You still have to eat: when nothing passes every rule, the soft ones give way in turn —
  // repeats first, then the cooking time and difficulty — never a restriction. Each says so.
  const relaxedTime: PlannerInput = {
    ...input,
    preferences: { ...input.preferences, cookingTime: { weekday: null, weekend: null }, difficulty: "any" },
  };
  const levels: Array<{
    check: (recipe: Recipe, slot: MealSlot, date: string) => string | null;
    why: string | null;
  }> = [
    { check: (recipe, slot, date) => allowed(recipe, slot, date, input, counts, allowRepeats), why: null },
    {
      check: (recipe, slot, date) => allowed(recipe, slot, date, input, counts, true),
      why: "A repeat — nothing else fits this meal this week",
    },
    {
      check: (recipe, slot, date) => allowed(recipe, slot, date, relaxedTime, counts, true),
      why: "Over your cooking-time or difficulty limit — nothing else fits this meal",
    },
  ];
  const gaps: Array<{ date: string; slot: MealSlot; why: string }> = [];
  const fillEmpty = () => {
    for (const date of days) {
      for (const slot of request.slots) {
        if (taken.has(key({ date, slot }))) continue;
        // Today's share of what's planned: a batch counts for the servings eaten now.
        const spent = [...kept, ...proposed]
          .filter((meal) => meal.date === date)
          .reduce((sum, meal) => sum + (mealShare(meal, input) ?? 0), 0);
        const budgetLeft = perDayBudget === null ? null : perDayBudget - spent;
        let placed = false;
        for (const level of levels) {
          const best = input.recipes
            .filter((recipe) => !level.check(recipe, slot, date))
            .map((recipe) =>
              scoreRecipe(recipe, date, request.eating, input, pantry, objectives, lastPlanned, budgetLeft)
            )
            .sort(
              (a, b) =>
                b.score - a.score ||
                a.recipe.name.localeCompare(b.recipe.name) ||
                a.recipe.id.localeCompare(b.recipe.id)
            )[0];
          if (!best) continue;
          place(
            date,
            slot,
            best,
            request.eating,
            0,
            level.why ? [level.why, ...best.reasons].slice(0, 4) : undefined
          );
          placed = true;
          break;
        }
        if (!placed && !gaps.some((gap) => gap.date === date && gap.slot === slot))
          gaps.push({
            date,
            slot,
            why: input.recipes.some((recipe) => recipe.slots.includes(slot))
              ? "every recipe for it has something you never eat"
              : `no recipe is marked for ${slot}`,
          });
      }
    }
  };
  fillEmpty();

  const budget =
    request.budgetTotal ??
    (request.budgetPerDay !== null ? Math.round(request.budgetPerDay * days.length * 100) / 100 : null);
  const total = () =>
    Math.round([...kept, ...proposed].reduce((sum, meal) => sum + (mealCost(meal, input) ?? 0), 0) * 100) /
    100;

  /** A swapped batch's planned leftovers, and whatever was planned alongside them, go with it. */
  const dropChain = (mealId: string) => {
    for (const leftover of proposed.filter((meal) => meal.fromMealId === mealId)) {
      const beside = proposed.filter(
        (meal) => meal !== leftover && meal.date === leftover.date && meal.slot === leftover.slot
      );
      for (const meal of [leftover, ...beside]) {
        proposed.splice(proposed.indexOf(meal), 1);
        if (meal.recipeId) counts.set(meal.recipeId, (counts.get(meal.recipeId) ?? 1) - 1);
        dropChain(meal.id);
      }
      taken.delete(key(leftover));
    }
  };

  // Over budget: swap the planner's most expensive choices for the cheapest that still fit.
  if (budget !== null && input.preferences.overBudget === "swap") {
    for (let round = 0; round < proposed.length && total() > budget; round += 1) {
      const swappable = proposed
        .filter((meal) => meal.kind === "recipe" && meal.swapSaving === null)
        .map((meal) => ({ meal, cost: mealCost(meal, input) ?? 0 }))
        .sort((a, b) => b.cost - a.cost);
      let swapped = false;
      for (const { meal, cost } of swappable) {
        const others = new Map(counts);
        others.set(meal.recipeId!, (others.get(meal.recipeId!) ?? 1) - 1);
        const cheaper = input.recipes
          .filter(
            (recipe) =>
              recipe.id !== meal.recipeId &&
              !allowed(recipe, meal.slot, meal.date, input, others, allowRepeats)
          )
          .map((recipe) => ({
            recipe,
            cost: recipeCost(recipe, batchOf(recipe, meal.servings).cooked, input.lookup).value,
          }))
          .filter(
            (option): option is { recipe: Recipe; cost: number } => option.cost !== null && option.cost < cost
          )
          .sort((a, b) => a.cost - b.cost || a.recipe.name.localeCompare(b.recipe.name))[0];
        if (!cheaper) continue;
        const before = input.recipes.find((r) => r.id === meal.recipeId)!;
        const saving = Math.round((cost - cheaper.cost) * 100) / 100;
        counts.set(before.id, (counts.get(before.id) ?? 1) - 1);
        counts.set(cheaper.recipe.id, (counts.get(cheaper.recipe.id) ?? 0) + 1);
        dropChain(meal.id);
        meal.recipeId = cheaper.recipe.id;
        meal.swapSaving = saving;
        meal.reasons = [
          `Budget swap: ${before.name} would have cost ${euro(cost)} (−${euro(saving)})`,
          ...scoreRecipe(
            cheaper.recipe,
            meal.date,
            meal.servings,
            input,
            input.pantry,
            objectives,
            new Map(),
            null
          ).reasons.slice(0, 2),
        ];
        const batch = batchOf(cheaper.recipe, meal.servings);
        if (batch.extra > 0 && input.preferences.autoLeftovers)
          spreadInto(
            {
              name: cheaper.recipe.name,
              portions: batch.extra,
              eatBy: isoDate(new Date(Date.parse(`${meal.date}T12:00:00`) + FRIDGE_DAYS * 86_400_000)),
              fromMealId: meal.id,
            },
            meal,
            1
          );
        swapped = true;
        break;
      }
      if (!swapped) break;
    }
    // Slots a swapped batch's leftovers had taken are filled again.
    fillEmpty();
  }

  return {
    request,
    meals: proposed,
    ...proposalFigures(input, request, proposed),
    // What couldn't be filled at all, and why — said in the proposal, not left as a silent gap.
    gaps: gaps.filter((gap) => !taken.has(key(gap))),
    createdAt: input.now,
  };
}

/**
 * The proposal's header figures — cost against the budget, the fixes when
 * it's over, pantry lines used, lines to buy, leftovers placed — worked
 * out again whenever a proposed meal changes. The meals are sorted in place.
 */
export function proposalFigures(
  input: PlannerInput,
  request: PlanRequest,
  proposed: PlannedMeal[]
): Omit<PlanProposal, "request" | "meals" | "createdAt" | "gaps"> {
  const days = dayRange(new Date(`${request.from}T12:00:00`), request.days);
  const kept = input.plan.filter(
    (meal) => days.includes(meal.date) && (meal.origin === "user" || meal.locked || meal.cookedAt)
  );
  proposed.sort(
    (a, b) => a.date.localeCompare(b.date) || request.slots.indexOf(a.slot) - request.slots.indexOf(b.slot)
  );
  const budget =
    request.budgetTotal ??
    (request.budgetPerDay !== null ? Math.round(request.budgetPerDay * days.length * 100) / 100 : null);
  const cost =
    Math.round([...kept, ...proposed].reduce((sum, meal) => sum + (mealCost(meal, input) ?? 0), 0) * 100) /
    100;
  const over = budget !== null && cost > budget ? Math.round((cost - budget) * 100) / 100 : null;
  const fixes: BudgetFix[] = [];
  if (over !== null) {
    fixes.push({ kind: "raise", to: Math.ceil(cost) });
    if (!request.allowRepeats) fixes.push({ kind: "repeats" });
    const priciest = proposed
      .filter((meal) => meal.kind === "recipe" && !meal.locked && meal.origin === "generator")
      .map((meal) => ({ meal, cost: mealCost(meal, input) ?? 0 }))
      .sort((a, b) => b.cost - a.cost)[0];
    if (priciest) {
      const name = input.recipes.find((r) => r.id === priciest.meal.recipeId)?.name ?? "the dearest meal";
      fixes.push({ kind: "swap", mealId: priciest.meal.id, name, saving: priciest.cost });
    }
  }

  // Pantry lines used, lines to buy.
  let stock = input.pantry.map((item) => ({ ...item }));
  let fromPantry = 0;
  let toBuy = 0;
  for (const meal of proposed.filter((m) => m.kind === "recipe")) {
    const recipe = input.recipes.find((r) => r.id === meal.recipeId);
    if (!recipe) continue;
    const cooked = cookServingsOf(meal, recipe);
    const plan = planDeductions(recipe.ingredients, stock, scaleFor(recipe, cooked), {
      family: input.family,
    });
    fromPantry += new Set(plan.deductions.map((d) => d.itemId)).size;
    toBuy += plan.short.length;
    stock = useUp(stock, recipe, cooked, input.family);
  }

  let leftoverPortions = 0;
  let leftoverMeals = 0;
  for (const meal of proposed.filter((m) => m.kind === "leftover")) {
    const leftover = input.leftovers.find((l) => l.id === meal.leftoverId);
    if (!leftover && !meal.fromMealId) continue;
    leftoverPortions += meal.portions ?? Math.min(leftover?.portions ?? 0, meal.servings);
    leftoverMeals += 1;
  }

  return { cost, budget, over, fixes, fromPantry, leftoverPortions, leftoverMeals, toBuy };
}

/** A replacement on offer: the recipe, what changes, and a line to show. */
export interface ReplaceOption {
  recipeId: string;
  name: string;
  /** Cost change against the meal it would replace, in euros. */
  delta: number | null;
  minutes: number | null;
  coverage: { have: number; total: number };
  favourite: boolean;
  /** Why it couldn't normally go here — a dislike, say — or null. */
  note: string | null;
  score: number;
}

/**
 * What a meal could be replaced with: every recipe for that slot, best
 * first — the top three are the drawer's Suggestions, the rest its "My
 * recipes" list, each with how the cost changes.
 */
export function replaceOptions(
  input: PlannerInput,
  meal: PlannedMeal,
  objectives: string[]
): ReplaceOption[] {
  const current = mealCost(meal, input);
  const counts = new Map<string, number>();
  return input.recipes
    .filter((recipe) => recipe.id !== meal.recipeId && recipe.slots.includes(meal.slot))
    .map((recipe) => {
      const scored = scoreRecipe(
        recipe,
        meal.date,
        meal.servings,
        input,
        input.pantry,
        new Set(objectives),
        new Map(),
        null
      );
      const blocked = allowed(recipe, meal.slot, meal.date, input, counts, true);
      const disliked = scored.reasons.find((reason) => reason.includes("disliked"));
      return {
        recipeId: recipe.id,
        name: recipe.name,
        delta:
          scored.cost !== null && current !== null ? Math.round((scored.cost - current) * 100) / 100 : null,
        minutes: totalMinutes(recipe),
        coverage: scored.coverage,
        favourite: recipe.favourite,
        note: blocked ?? disliked ?? null,
        score: blocked ? scored.score - 10 : scored.score,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * What replacing a meal would change: the plan's cost, and the shopping
 * list — what the old recipe needed that the new one doesn't, and the other
 * way round.
 */
export function effectOfReplacing(
  input: PlannerInput,
  planMeals: PlannedMeal[],
  meal: PlannedMeal,
  recipeId: string | null,
  customCost: number | null = null
): { before: number; after: number; less: string[]; more: string[] } {
  const before = Math.round(planMeals.reduce((sum, m) => sum + (mealCost(m, input) ?? 0), 0) * 100) / 100;
  const replaced = {
    ...meal,
    kind: recipeId ? ("recipe" as const) : ("custom" as const),
    recipeId,
    cost: recipeId ? null : customCost,
  };
  const after =
    Math.round(
      planMeals.reduce((sum, m) => sum + (mealCost(m.id === meal.id ? replaced : m, input) ?? 0), 0) * 100
    ) / 100;
  const shortOf = (id: string | null) => {
    const recipe = input.recipes.find((r) => r.id === id);
    if (!recipe) return new Map<string, string>();
    const plan = planDeductions(recipe.ingredients, input.pantry, scaleFor(recipe, meal.servings), {
      family: input.family,
    });
    const names = new Map<string, string>();
    for (const short of plan.short) {
      const food =
        input.ingredients.find((i) => i.id === short.ingredient.ingredientId)?.name ?? short.ingredient.text;
      names.set(
        short.ingredient.ingredientId,
        short.missing ? `${food.toLowerCase()} ${formatAmount(short.missing)}` : food.toLowerCase()
      );
    }
    return names;
  };
  const was = shortOf(meal.kind === "recipe" ? meal.recipeId : null);
  const will = shortOf(recipeId);
  return {
    before,
    after,
    less: [...was.entries()].filter(([id]) => !will.has(id)).map(([, text]) => text),
    more: [...will.entries()].filter(([id]) => !was.has(id)).map(([, text]) => text),
  };
}
