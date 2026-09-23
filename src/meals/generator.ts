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
import { coverRecipe, coverageCount, expiryState, planDeductions, usableLeftovers } from "./pantry";
import type { Family } from "./pantry";
import { dayRange } from "./plan";
import { perServing, recipeCost, recipeNutrition, scaleFor, totalMinutes } from "./recipes";
import type { IngredientLookup } from "./recipes";
import { formatAmount } from "./units";
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
  const scale = scaleFor(recipe, servings);
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
  const cost = recipeCost(recipe, servings, input.lookup).value;
  if (objectives.has("money") && cost !== null) {
    const perServing = cost / Math.max(1, servings);
    score += Math.max(-2, 2 - perServing);
    if (perServing <= 2) reasons.push(`≈ ${euro(perServing)} a serving`);
  }
  if (budgetLeft !== null && cost !== null && cost > budgetLeft) score -= 2;
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
    addedAt: input.now,
    updatedAt: input.now,
  };
}

/** What a proposed meal costs (a leftover is already paid for). */
function mealCost(meal: PlannedMeal, input: PlannerInput): number | null {
  if (meal.cost !== null) return meal.cost;
  if (meal.kind === "leftover") return 0;
  const recipe = input.recipes.find((r) => r.id === meal.recipeId);
  return recipe ? recipeCost(recipe, meal.cookServings ?? meal.servings, input.lookup).value : null;
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

  let pantry = input.pantry.map((item) => ({ ...item }));
  const proposed: PlannedMeal[] = [];
  // Leftovers first: each into the earliest free lunch or dinner before it has to be eaten.
  if (objectives.has("leftovers")) {
    const promised = new Set(
      input.plan.filter((m) => m.kind === "leftover" && !m.cookedAt).map((m) => m.leftoverId)
    );
    for (const leftover of usableLeftovers(input.leftovers, new Date(`${input.today}T12:00:00`))) {
      if (promised.has(leftover.id)) continue;
      const slot = days
        .flatMap((date) =>
          (["lunch", "dinner"] as MealSlot[])
            .filter((s) => request.slots.includes(s))
            .map((s) => ({ date, slot: s }))
        )
        .find(
          (option) =>
            !taken.has(`${option.date}|${option.slot}`) && (!leftover.eatBy || option.date <= leftover.eatBy)
        );
      if (!slot) continue;
      const meal = blankMeal(input, slot.date, slot.slot, request.eating);
      meal.kind = "leftover";
      meal.leftoverId = leftover.id;
      const covers = Math.min(leftover.portions, request.eating);
      meal.reasons = [
        `Uses ${leftover.portions} cooked portion${leftover.portions === 1 ? "" : "s"} before they expire`,
        covers < request.eating
          ? `Only covers ${covers} of ${request.eating} — ${request.eating - covers} more portion${request.eating - covers === 1 ? "" : "s"} needed`
          : `Covers all ${request.eating}`,
      ];
      proposed.push(meal);
      taken.add(`${slot.date}|${slot.slot}`);
    }
  }

  const perDayBudget =
    request.budgetPerDay ?? (request.budgetTotal !== null ? request.budgetTotal / days.length : null);
  const allowRepeats = request.allowRepeats;
  for (const date of days) {
    let spent = [...kept, ...proposed]
      .filter((meal) => meal.date === date)
      .reduce((sum, meal) => sum + (mealCost(meal, input) ?? 0), 0);
    for (const slot of request.slots) {
      if (taken.has(`${date}|${slot}`)) continue;
      const budgetLeft = perDayBudget === null ? null : perDayBudget - spent;
      const candidates = input.recipes
        .filter((recipe) => !allowed(recipe, slot, date, input, counts, allowRepeats))
        .map((recipe) =>
          scoreRecipe(recipe, date, request.eating, input, pantry, objectives, lastPlanned, budgetLeft)
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.recipe.name.localeCompare(b.recipe.name) ||
            a.recipe.id.localeCompare(b.recipe.id)
        );
      const best = candidates[0];
      if (!best) continue;
      const meal = blankMeal(input, date, slot, request.eating);
      meal.recipeId = best.recipe.id;
      meal.reasons = best.reasons.length ? best.reasons : ["The best fit left for this meal"];
      proposed.push(meal);
      taken.add(`${date}|${slot}`);
      counts.set(best.recipe.id, (counts.get(best.recipe.id) ?? 0) + 1);
      lastPlanned.set(best.recipe.id, date);
      pantry = useUp(pantry, best.recipe, request.eating, input.family);
      spent += best.cost ?? 0;
    }
  }

  const budget =
    request.budgetTotal ??
    (request.budgetPerDay !== null ? Math.round(request.budgetPerDay * days.length * 100) / 100 : null);
  const total = () =>
    Math.round([...kept, ...proposed].reduce((sum, meal) => sum + (mealCost(meal, input) ?? 0), 0) * 100) /
    100;

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
          .map((recipe) => ({ recipe, cost: recipeCost(recipe, meal.servings, input.lookup).value }))
          .filter(
            (option): option is { recipe: Recipe; cost: number } => option.cost !== null && option.cost < cost
          )
          .sort((a, b) => a.cost - b.cost || a.recipe.name.localeCompare(b.recipe.name))[0];
        if (!cheaper) continue;
        const before = input.recipes.find((r) => r.id === meal.recipeId)!;
        const saving = Math.round((cost - cheaper.cost) * 100) / 100;
        counts.set(before.id, (counts.get(before.id) ?? 1) - 1);
        counts.set(cheaper.recipe.id, (counts.get(cheaper.recipe.id) ?? 0) + 1);
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
        swapped = true;
        break;
      }
      if (!swapped) break;
    }
  }

  return {
    request,
    meals: proposed,
    ...proposalFigures(input, request, proposed),
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
): Omit<PlanProposal, "request" | "meals" | "createdAt"> {
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
    const plan = planDeductions(recipe.ingredients, stock, scaleFor(recipe, meal.servings), {
      family: input.family,
    });
    fromPantry += new Set(plan.deductions.map((d) => d.itemId)).size;
    toBuy += plan.short.length;
    stock = useUp(stock, recipe, meal.servings, input.family);
  }

  let leftoverPortions = 0;
  let leftoverMeals = 0;
  for (const meal of proposed.filter((m) => m.kind === "leftover")) {
    const leftover = input.leftovers.find((l) => l.id === meal.leftoverId);
    if (!leftover) continue;
    leftoverPortions += Math.min(leftover.portions, meal.servings);
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
