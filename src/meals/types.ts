/**
 * Meals — recipes, what's in the kitchen, and what's planned to eat.
 *
 * Three things that only make sense together:
 *
 *  - an **ingredient** is a thing you buy and keep ("Chicken thighs"), the
 *    name a recipe line and a pantry item both point at, so "chicken
 *    thighs" in a recipe and the 1 kg pack in the freezer are known to be
 *    the same food;
 *  - the **pantry** is what you have of it right now, with where it is and
 *    how long it keeps — plus prepared food and leftovers, which are
 *    counted in portions rather than grams;
 *  - the **plan** is which meal is eaten when: a recipe, leftovers, or a
 *    night out — nothing about it is automatic in this version.
 *
 * Stock is either **confirmed** (you said so, or a purchase did) or
 * **estimated** (NIMBUS subtracted what a recipe used when you cooked it).
 * The difference is never hidden: an estimate is shown as an estimate
 * until you check it, because a pantry that quietly lies is worse than one
 * that admits it's guessing.
 */

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack" | "dessert";

export const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack", "dessert"];

export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  dessert: "Dessert",
};

/** Where something is kept — it decides how long it lasts, not just where to look. */
export type StoragePlace = "cupboard" | "fridge" | "freezer";

export const STORAGE_PLACES: StoragePlace[] = ["cupboard", "fridge", "freezer"];

export const STORAGE_LABELS: Record<StoragePlace, string> = {
  cupboard: "Cupboard",
  fridge: "Fridge",
  freezer: "Freezer",
};

/** Nutrition per 100 g or 100 ml, as food labels give it. Any field can be unknown. */
export interface NutritionPer100 {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

/**
 * A food you buy and cook with. Kept apart from pantry items so the same
 * food can be in the fridge and the freezer, bought at two prices, and
 * still be one thing to a recipe.
 */
export interface Ingredient {
  id: string;
  name: string;
  /** Names that mean the same food, so an imported recipe line can find it. */
  aliases: string[];
  /** The unit it's usually measured in: "g", "ml", "piece". */
  unit: string;
  category: string | null;
  /** Per 100 g/ml; null until looked up or typed. */
  nutrition: NutritionPer100 | null;
  /** Where the nutrition came from: "off:<barcode>" (Open Food Facts) or null if typed. */
  nutritionSource: string | null;
  /** The last price paid, per base unit (€/g, €/ml or €/piece), or null. */
  lastPrice: number | null;
  /** How long it keeps once in the fridge, in days — used to suggest an eat-by date. */
  fridgeDays: number | null;
  /** The package it last came in ("1 kg pack"), so the shopping side can say what to buy. */
  lastPackaging: string | null;
  addedAt: string;
  updatedAt: string;
}

/** One line of a recipe: how much of which ingredient. */
export interface RecipeIngredient {
  ingredientId: string;
  /** The name as the recipe writes it ("chicken thighs, bone in"), for display. */
  text: string;
  quantity: number;
  unit: string;
  /** "to taste", garnishes: left out of cost, nutrition and the shopping list. */
  optional: boolean;
}

export interface RecipeStep {
  text: string;
  /** Minutes this step takes, when the recipe says — used for "start cooking by". */
  minutes: number | null;
}

export interface Recipe {
  id: string;
  name: string;
  description: string | null;
  /** Which meals it suits; a recipe can be both lunch and dinner. */
  slots: MealSlot[];
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  tags: string[];
  /** Where it came from: a URL, "typed", or null. */
  source: string | null;
  notes: string | null;
  favourite: boolean;
  /** When it was last cooked, and how often — filled in by cooking, not by hand. */
  lastCookedAt: string | null;
  timesCooked: number;
  addedAt: string;
  updatedAt: string;
}

/** Where a stock figure came from — an estimate is never presented as a fact. */
export type StockConfidence = "confirmed" | "estimated";

/** Something you have in the kitchen: an amount of one ingredient, in one place. */
export interface PantryItem {
  id: string;
  ingredientId: string;
  /** The name at the time it was added, so the list still reads right if the ingredient is renamed. */
  name: string;
  quantity: number;
  unit: string;
  /**
   * How much there was when this item was last added or confirmed — the
   * reference a "half a pack left" bar is drawn against. Never used in
   * arithmetic, only to show how far through a package you are.
   */
  startQuantity: number;
  place: StoragePlace;
  confidence: StockConfidence;
  /** The package it came in, e.g. "1 kg pack" — free text, for recognising it. */
  packaging: string | null;
  /** Set when you open it: what's left usually keeps for days, not weeks. */
  openedAt: string | null;
  /** Eat-by date, as an ISO date (YYYY-MM-DD), or null if it doesn't really expire. */
  expiresAt: string | null;
  /** The last time you corrected the amount, and why — so "thrown away" isn't lost in the number. */
  lastCorrection: { reason: CorrectionReason; at: string } | null;
  addedAt: string;
  updatedAt: string;
}

/** Why an amount was corrected by hand. */
export type CorrectionReason = "estimate" | "outside" | "thrown" | "found";

export const CORRECTION_REASONS: CorrectionReason[] = ["estimate", "outside", "thrown", "found"];

export const CORRECTION_LABELS: Record<CorrectionReason, string> = {
  estimate: "Estimate was off",
  outside: "Used outside a recipe",
  thrown: "Thrown away",
  found: "Found more",
};

/**
 * Food already cooked: portions, not grams. Its own thing rather than a
 * pantry item, because what matters is how many people it feeds, how long
 * it's safe, and whether it's been promised to a meal.
 */
export interface Leftover {
  id: string;
  name: string;
  /** The recipe it came from, when it came from one. */
  recipeId: string | null;
  portions: number;
  place: StoragePlace;
  cookedAt: string;
  /** The day it stops being a good idea (ISO date). */
  eatBy: string | null;
  addedAt: string;
  updatedAt: string;
}

/** What a planned meal actually is. */
export type PlannedMealKind = "recipe" | "leftover" | "custom" | "out";

/** One meal in one slot on one day. */
export interface PlannedMeal {
  id: string;
  /** ISO date, YYYY-MM-DD, in local time. */
  date: string;
  slot: MealSlot;
  kind: PlannedMealKind;
  /** Set when kind is "recipe". */
  recipeId: string | null;
  /** Set when kind is "leftover". */
  leftoverId: string | null;
  /** For "custom" and "out", and the display name of anything whose source is gone. */
  name: string | null;
  /** How many servings are wanted — how many people eat, not the recipe's own yield. */
  servings: number;
  /** Cooking more than is eaten today: the extra becomes leftovers. */
  cookServings: number | null;
  /** The time it's eaten ("19:30"), or null. */
  time: string | null;
  /** What it cost, when you know — "out" meals carry their own price. */
  cost: number | null;
  notes: string | null;
  /** Set when the meal was cooked or eaten; a cooked meal is never re-deducted. */
  cookedAt: string | null;
  addedAt: string;
  updatedAt: string;
}

/** A person the plan cooks for: a label, how much they eat, and what to avoid. */
export interface Eater {
  id: string;
  name: string;
  /** Portions relative to an adult: a child might be 0.6. */
  portionFactor: number;
  notes: string | null;
}

export interface MealPreferences {
  /** Who eats, for "servings needed" — no accounts, no profiles. */
  eaters: Eater[];
  /** Foods never suggested for anyone ("No pork", "Gluten-free"). */
  restrictions: string[];
  /** Avoided when there's a choice, but not forbidden. */
  dislikes: string[];
  /** Which slots the planner shows. */
  slots: MealSlot[];
  /** A day's food budget in euros, or null for no budget. */
  dailyBudget: number | null;
  /** Daily calories per person, for the "how much of today" rings. Null hides them. */
  dailyKcal: number | null;
  /** Daily protein per person, in grams. */
  dailyProtein: number | null;
}

export const DEFAULT_MEAL_PREFERENCES: MealPreferences = {
  eaters: [],
  restrictions: [],
  dislikes: [],
  slots: ["breakfast", "lunch", "dinner"],
  dailyBudget: null,
  dailyKcal: null,
  dailyProtein: null,
};

/**
 * Something on the shopping list that no recipe asked for — bin bags, or
 * "something for Sunday". The rest of the list is worked out from the
 * plan every time it's read, so only these are stored.
 */
export interface ManualShoppingItem {
  id: string;
  name: string;
  /** Set when it matches a known food, so buying it can go into the pantry. */
  ingredientId: string | null;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  addedAt: string;
}

export interface MealsState {
  version: 1;
  ingredients: Ingredient[];
  recipes: Recipe[];
  pantry: PantryItem[];
  leftovers: Leftover[];
  plan: PlannedMeal[];
  shopping: ManualShoppingItem[];
  preferences: MealPreferences;
  /**
   * The ids of everything the demo data planted, so "Remove demo data"
   * takes out exactly what it put in and never touches your own food.
   */
  demoIds: string[];
}

/** The store the service writes through — the same shape as the shelf's and the collection's. */
export interface MealsStore {
  load(): unknown;
  save(state: MealsState): void;
}

export const MAX_INGREDIENTS = 3000;
export const MAX_RECIPES = 2000;
export const MAX_PANTRY_ITEMS = 2000;
export const MAX_LEFTOVERS = 300;
export const MAX_PLANNED_MEALS = 5000;
export const MAX_RECIPE_INGREDIENTS = 60;
export const MAX_RECIPE_STEPS = 60;
export const MAX_EATERS = 20;
export const MAX_SHOPPING_ITEMS = 300;
