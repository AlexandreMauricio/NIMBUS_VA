/**
 * Reading Meals' state: every list in meals.json checked entry by entry,
 * and the small value checks (text, positive numbers, dates) the service
 * applies to what is typed. A malformed entry is dropped rather than
 * poisoning the rest. Pure.
 */

import { linePriceUnit } from "./purchases";
import {
  CORRECTION_REASONS,
  CorrectionReason,
  DEFAULT_MEAL_PREFERENCES,
  Eater,
  Ingredient,
  Leftover,
  MAX_EATERS,
  MAX_INGREDIENTS,
  MAX_LEFTOVERS,
  MAX_PANTRY_ITEMS,
  MAX_PLANNED_MEALS,
  MAX_RECIPES,
  MAX_RECIPE_INGREDIENTS,
  MAX_RECIPE_STEPS,
  MAX_SHOPPING_ITEMS,
  MAX_SHOPPING_MARKS,
  MAX_STORES,
  MAX_PURCHASES,
  MAX_PURCHASE_LINES,
  MAX_PRICES,
  PriceRecord,
  Purchase,
  PurchaseLine,
  PurchaseSource,
  PurchaseStatus,
  ShoppingMark,
  ShoppingMarkKind,
  Store,
  MEAL_SLOTS,
  ManualShoppingItem,
  MealPreferences,
  MealSlot,
  MealsState,
  NutritionPer100,
  PantryItem,
  PlannedMeal,
  PlannedMealKind,
  Recipe,
  MAX_COMPONENTS,
  PLAN_OBJECTIVES,
  PLANNED_MEAL_KINDS,
  PlanObjective,
  PlanProposal,
  RECIPE_DIFFICULTIES,
  RecipeDifficulty,
  RecipeComponent,
  RecipeIngredient,
  RecipeStep,
  isRecipePhotoUrl,
  STORAGE_PLACES,
  StoragePlace,
} from "./types";
import { baseUnit, normaliseUnit, toBase } from "./units";

export function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

export function positive(value: unknown, fallback: number | null = null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000) / 1000
    : fallback;
}

export function isoTime(value: unknown): string | null {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

export function isoDay(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function stamp(value: unknown): string {
  return typeof value === "string" && value ? value : new Date(0).toISOString();
}

export function list(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = text(entry, length);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

/** `amount` (in a base unit) expressed in `unit`, when they measure the same thing. */
export function inUnitOf(
  amount: { quantity: number; unit: string },
  unit: string
): { quantity: number; unit: string } {
  const one = toBase({ quantity: 1, unit });
  const base = toBase(amount);
  if (!one || !base || one.unit !== base.unit || one.quantity <= 0) return amount;
  return { quantity: Math.round((base.quantity / one.quantity) * 1000) / 1000, unit };
}

export function parseNutrition(raw: unknown): NutritionPer100 | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const value = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const nutrition = {
    kcal: value(r.kcal),
    protein: value(r.protein),
    carbs: value(r.carbs),
    fat: value(r.fat),
    fibre: value(r.fibre),
  };
  return Object.values(nutrition).some((v) => v !== null) ? nutrition : null;
}

export function parseIngredient(raw: unknown): Ingredient | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 120);
  if (typeof r.id !== "string" || !r.id || !name) return null;
  return {
    id: r.id,
    name,
    aliases: list(r.aliases, 20, 120),
    unit: normaliseUnit(r.unit) ?? "g",
    category: text(r.category, 60),
    nutrition: parseNutrition(r.nutrition),
    nutritionSource: text(r.nutritionSource, 80),
    lastPrice:
      typeof r.lastPrice === "number" && Number.isFinite(r.lastPrice) && r.lastPrice >= 0
        ? r.lastPrice
        : null,
    fridgeDays: positive(r.fridgeDays),
    lastPackaging: text(r.lastPackaging, 120),
    priceUnit: r.priceUnit === "g" || r.priceUnit === "ml" || r.priceUnit === "piece" ? r.priceUnit : null,
    pieceSize: parsePieceSize(r.pieceSize),
    countsAs: typeof r.countsAs === "string" && r.countsAs && r.countsAs !== r.id ? r.countsAs : null,
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

export function parseRecipeIngredient(raw: unknown): RecipeIngredient | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const quantity = positive(r.quantity);
  const unit = normaliseUnit(r.unit);
  if (typeof r.ingredientId !== "string" || !r.ingredientId || quantity === null || !unit) return null;
  return {
    ingredientId: r.ingredientId,
    text: text(r.text, 200) ?? "",
    quantity,
    unit,
    optional: r.optional === true,
    componentId: typeof r.componentId === "string" && r.componentId ? r.componentId : null,
  };
}

export function parseStep(raw: unknown): RecipeStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const body = text(r.text, 2000);
  if (!body) return null;
  return {
    text: body,
    minutes: positive(r.minutes),
    componentId: typeof r.componentId === "string" && r.componentId ? r.componentId : null,
  };
}

export function parseComponents(raw: unknown): RecipeComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeComponent[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const name = text(r.name, 60);
    if (typeof r.id !== "string" || !r.id || !name || out.some((c) => c.id === r.id)) continue;
    out.push({ id: r.id, name });
    if (out.length >= MAX_COMPONENTS) break;
  }
  return out;
}

/** A line or step pointing at a dish the recipe doesn't have is just part of the whole. */
export function keepComponent<T extends { componentId: string | null }>(
  entry: T,
  components: RecipeComponent[]
): T {
  return entry.componentId && !components.some((c) => c.id === entry.componentId)
    ? { ...entry, componentId: null }
    : entry;
}

export function parseRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 200);
  if (typeof r.id !== "string" || !r.id || !name) return null;
  const slots = Array.isArray(r.slots)
    ? (r.slots.filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot)) as MealSlot[])
    : [];
  const components = parseComponents(r.components);
  return {
    id: r.id,
    name,
    components,
    batch: r.batch === true,
    photo: isRecipePhotoUrl(r.photo) ? r.photo : null,
    description: text(r.description, 2000),
    slots: slots.length ? [...new Set(slots)] : ["dinner"],
    servings: positive(r.servings, 2)!,
    prepMinutes: positive(r.prepMinutes),
    cookMinutes: positive(r.cookMinutes),
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients
          .map(parseRecipeIngredient)
          .filter((i): i is RecipeIngredient => i !== null)
          .slice(0, MAX_RECIPE_INGREDIENTS)
          .map((i) => keepComponent(i, components))
      : [],
    steps: Array.isArray(r.steps)
      ? r.steps
          .map(parseStep)
          .filter((s): s is RecipeStep => s !== null)
          .slice(0, MAX_RECIPE_STEPS)
          .map((s) => keepComponent(s, components))
      : [],
    tags: list(r.tags, 20, 40),
    source: text(r.source, 500),
    notes: text(r.notes, 2000),
    favourite: r.favourite === true,
    lastCookedAt: typeof r.lastCookedAt === "string" ? r.lastCookedAt : null,
    timesCooked: typeof r.timesCooked === "number" && r.timesCooked >= 0 ? Math.floor(r.timesCooked) : 0,
    difficulty: RECIPE_DIFFICULTIES.includes(r.difficulty as RecipeDifficulty)
      ? (r.difficulty as RecipeDifficulty)
      : null,
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

export function parseCorrection(raw: unknown): PantryItem["lastCorrection"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!CORRECTION_REASONS.includes(r.reason as CorrectionReason) || typeof r.at !== "string") return null;
  return { reason: r.reason as CorrectionReason, at: r.at };
}

export function parsePantryItem(raw: unknown): PantryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 120);
  const quantity =
    typeof r.quantity === "number" && Number.isFinite(r.quantity) && r.quantity >= 0 ? r.quantity : null;
  const unit = normaliseUnit(r.unit);
  if (
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.ingredientId !== "string" ||
    !name ||
    quantity === null ||
    !unit
  )
    return null;
  return {
    id: r.id,
    ingredientId: r.ingredientId,
    name,
    quantity,
    unit,
    startQuantity: positive(r.startQuantity, quantity)!,
    place: STORAGE_PLACES.includes(r.place as StoragePlace) ? (r.place as StoragePlace) : "cupboard",
    confidence: r.confidence === "estimated" ? "estimated" : "confirmed",
    packaging: text(r.packaging, 120),
    openedAt: typeof r.openedAt === "string" ? r.openedAt : null,
    expiresAt: isoDay(r.expiresAt),
    lastCorrection: parseCorrection(r.lastCorrection),
    wholeBag: r.wholeBag === true,
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

export function parseLeftover(raw: unknown): Leftover | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 200);
  const portions = positive(r.portions);
  if (typeof r.id !== "string" || !r.id || !name || portions === null) return null;
  return {
    id: r.id,
    name,
    recipeId: typeof r.recipeId === "string" && r.recipeId ? r.recipeId : null,
    portions,
    place: STORAGE_PLACES.includes(r.place as StoragePlace) ? (r.place as StoragePlace) : "fridge",
    cookedAt: stamp(r.cookedAt),
    eatBy: isoDay(r.eatBy),
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

export const MEAL_KINDS: PlannedMealKind[] = PLANNED_MEAL_KINDS;

export function parsePlannedMeal(raw: unknown): PlannedMeal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = isoDay(r.date);
  if (typeof r.id !== "string" || !r.id || !date) return null;
  if (!MEAL_SLOTS.includes(r.slot as MealSlot)) return null;
  if (!MEAL_KINDS.includes(r.kind as PlannedMealKind)) return null;
  return {
    id: r.id,
    date,
    slot: r.slot as MealSlot,
    kind: r.kind as PlannedMealKind,
    recipeId: typeof r.recipeId === "string" && r.recipeId ? r.recipeId : null,
    leftoverId: typeof r.leftoverId === "string" && r.leftoverId ? r.leftoverId : null,
    name: text(r.name, 200),
    servings: positive(r.servings, 1)!,
    cookServings: positive(r.cookServings),
    time: isoTime(r.time),
    cost: typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost >= 0 ? r.cost : null,
    notes: text(r.notes, 1000),
    cookedAt: typeof r.cookedAt === "string" ? r.cookedAt : null,
    locked: r.locked === true,
    origin: r.origin === "generator" ? "generator" : "user",
    reasons: list(r.reasons, 6, 200),
    swapSaving: money(r.swapSaving),
    portions: r.kind === "leftover" ? positive(r.portions) : null,
    fromMealId: typeof r.fromMealId === "string" && r.fromMealId ? r.fromMealId : null,
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

export function parseEater(raw: unknown): Eater | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 60);
  if (typeof r.id !== "string" || !r.id || !name) return null;
  return {
    id: r.id,
    name,
    portionFactor: Math.min(5, positive(r.portionFactor, 1)!),
    notes: text(r.notes, 200),
  };
}

export function parseCookingTime(raw: unknown): MealPreferences["cookingTime"] {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEAL_PREFERENCES.cookingTime };
  const r = raw as Record<string, unknown>;
  return { weekday: positive(r.weekday), weekend: positive(r.weekend) };
}

export function parsePreferences(raw: unknown): MealPreferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEAL_PREFERENCES };
  const r = raw as Record<string, unknown>;
  const slots = Array.isArray(r.slots)
    ? (r.slots.filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot)) as MealSlot[])
    : [];
  return {
    eaters: Array.isArray(r.eaters)
      ? r.eaters
          .map(parseEater)
          .filter((e): e is Eater => e !== null)
          .slice(0, MAX_EATERS)
      : [],
    restrictions: list(r.restrictions, 40, 60),
    dislikes: list(r.dislikes, 60, 60),
    slots: slots.length ? [...new Set(slots)] : [...DEFAULT_MEAL_PREFERENCES.slots],
    dailyBudget: positive(r.dailyBudget),
    dailyKcal: positive(r.dailyKcal),
    dailyProtein: positive(r.dailyProtein),
    dailyCarbs: positive(r.dailyCarbs),
    dailyFibre: positive(r.dailyFibre),
    monthlyBudget: positive(r.monthlyBudget),
    overBudget: r.overBudget === "warn" ? "warn" : "swap",
    cookingTime: parseCookingTime(r.cookingTime),
    difficulty: r.difficulty === "easy" || r.difficulty === "any" ? r.difficulty : "medium",
    objectives: Array.isArray(r.objectives)
      ? [
          ...new Set(
            r.objectives.filter((o): o is PlanObjective => PLAN_OBJECTIVES.includes(o as PlanObjective))
          ),
        ]
      : [...DEFAULT_MEAL_PREFERENCES.objectives],
    autoLeftovers: r.autoLeftovers !== false,
    maxRepeats: Math.min(7, Math.max(1, Math.round(positive(r.maxRepeats, 2)!))),
  };
}

export function parseManualShoppingItem(raw: unknown): ManualShoppingItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 120);
  if (typeof r.id !== "string" || !r.id || !name) return null;
  return {
    id: r.id,
    name,
    ingredientId: typeof r.ingredientId === "string" && r.ingredientId ? r.ingredientId : null,
    quantity: positive(r.quantity),
    unit: normaliseUnit(r.unit),
    note: text(r.note, 200),
    addedAt: stamp(r.addedAt),
  };
}

/** The whole file, checked entry by entry. Anything malformed is dropped with a warning. */
export function parseState(raw: unknown): MealsState {
  const empty: MealsState = {
    version: 1,
    ingredients: [],
    recipes: [],
    pantry: [],
    leftovers: [],
    plan: [],
    shopping: [],
    preferences: { ...DEFAULT_MEAL_PREFERENCES },
    demoIds: [],
    stores: [],
    purchases: [],
    prices: [],
    shoppingMarks: [],
    proposal: null,
  };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as Record<string, unknown>;
  const take = <T>(value: unknown, parse: (entry: unknown) => T | null, max: number): T[] =>
    Array.isArray(value)
      ? value
          .map(parse)
          .filter((entry): entry is T => entry !== null)
          .slice(0, max)
      : [];
  const state: MealsState = {
    version: 1,
    ingredients: take(r.ingredients, parseIngredient, MAX_INGREDIENTS),
    recipes: take(r.recipes, parseRecipe, MAX_RECIPES),
    pantry: take(r.pantry, parsePantryItem, MAX_PANTRY_ITEMS),
    leftovers: take(r.leftovers, parseLeftover, MAX_LEFTOVERS),
    plan: take(r.plan, parsePlannedMeal, MAX_PLANNED_MEALS),
    shopping: take(r.shopping, parseManualShoppingItem, MAX_SHOPPING_ITEMS),
    demoIds: Array.isArray(r.demoIds)
      ? r.demoIds.filter((entry): entry is string => typeof entry === "string").slice(0, 10_000)
      : [],
    preferences: parsePreferences(r.preferences),
    stores: take(r.stores, parseStore, MAX_STORES),
    purchases: take(r.purchases, parsePurchase, MAX_PURCHASES),
    prices: take(r.prices, parsePriceRecord, MAX_PRICES),
    shoppingMarks: take(r.shoppingMarks, parseShoppingMark, MAX_SHOPPING_MARKS),
    proposal: parseProposal(r.proposal),
  };
  inferPriceUnits(state);
  return state;
}

/** A held proposal, checked like the plan it would become. */
export function parseProposal(raw: unknown): PlanProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const q = (r.request ?? {}) as Record<string, unknown>;
  const from = isoDay(q.from);
  if (!from || !Array.isArray(r.meals)) return null;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    request: {
      from,
      days: Math.min(14, Math.max(1, Math.round(positive(q.days, 7)!))),
      slots: Array.isArray(q.slots)
        ? q.slots.filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot))
        : [],
      eating: positive(q.eating, 1)!,
      budgetPerDay: positive(q.budgetPerDay),
      budgetTotal: positive(q.budgetTotal),
      objectives: Array.isArray(q.objectives)
        ? q.objectives.filter((o): o is PlanObjective => PLAN_OBJECTIVES.includes(o as PlanObjective))
        : [],
      allowRepeats: q.allowRepeats === true,
    },
    meals: r.meals
      .map(parsePlannedMeal)
      .filter((meal): meal is PlannedMeal => meal !== null)
      .slice(0, 200),
    cost: money(r.cost),
    budget: money(r.budget),
    over: money(r.over),
    fixes: [],
    fromPantry: count(r.fromPantry),
    leftoverPortions: count(r.leftoverPortions),
    leftoverMeals: count(r.leftoverMeals),
    toBuy: count(r.toBuy),
    gaps: Array.isArray(r.gaps)
      ? r.gaps
          .map((raw) => {
            const g = (raw ?? {}) as Record<string, unknown>;
            const date = isoDay(g.date);
            return date && MEAL_SLOTS.includes(g.slot as MealSlot)
              ? { date, slot: g.slot as MealSlot, why: text(g.why, 200) ?? "" }
              : null;
          })
          .filter((gap): gap is { date: string; slot: MealSlot; why: string } => gap !== null)
          .slice(0, 50)
      : [],
    createdAt: stamp(r.createdAt),
  };
}

export function parseStore(raw: unknown): Store | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60);
  return typeof r.id === "string" && r.id && name ? { id: r.id, name } : null;
}

export const PURCHASE_SOURCES: PurchaseSource[] = ["manual", "pdf", "photo"];
export const PURCHASE_STATUSES: PurchaseStatus[] = ["review", "imported", "history"];

export function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export function parsePurchaseLine(raw: unknown): PurchaseLine | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lineText = text(r.raw, 200);
  if (typeof r.id !== "string" || !r.id || !lineText) return null;
  return {
    id: r.id,
    raw: lineText,
    ingredientId: typeof r.ingredientId === "string" && r.ingredientId ? r.ingredientId : null,
    notFood: r.notFood === true,
    quantity: positive(r.quantity),
    unit: normaliseUnit(r.unit),
    price: money(r.price),
    confidence: typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : 0,
    confirmed: r.confirmed === true,
    place: STORAGE_PLACES.includes(r.place as StoragePlace) ? (r.place as StoragePlace) : "cupboard",
    bags: parseBags(r.bags),
    stocked: parseStocked(r.stocked),
  };
}

/** Bag sizes, each positive, at most 12 bags. */
export function parseBags(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const sizes = raw.map((size) => positive(size)).filter((size): size is number => size !== null);
  return sizes.length ? sizes.slice(0, 12) : null;
}

/** What a confirmed line put in the pantry — one entry, or one per frozen bag (older files kept one). */
export function parseStocked(raw: unknown): PurchaseLine["stocked"] {
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const quantity = positive(r.quantity);
      const unit = normaliseUnit(r.unit);
      return typeof r.itemId === "string" && r.itemId && quantity !== null && unit
        ? { itemId: r.itemId, quantity, unit }
        : null;
    })
    .filter((entry): entry is { itemId: string; quantity: number; unit: string } => entry !== null)
    .slice(0, 12);
}

export function parsePurchase(raw: unknown): Purchase | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const date = isoDay(r.date);
  if (typeof r.id !== "string" || !r.id || !date) return null;
  return {
    id: r.id,
    storeId: typeof r.storeId === "string" && r.storeId ? r.storeId : null,
    date,
    source: PURCHASE_SOURCES.includes(r.source as PurchaseSource) ? (r.source as PurchaseSource) : "manual",
    status: PURCHASE_STATUSES.includes(r.status as PurchaseStatus) ? (r.status as PurchaseStatus) : "review",
    lines: Array.isArray(r.lines)
      ? r.lines
          .map(parsePurchaseLine)
          .filter((line): line is PurchaseLine => line !== null)
          .slice(0, MAX_PURCHASE_LINES)
      : [],
    total: money(r.total),
    fileName: text(r.fileName, 200),
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

/** "One piece is 1 l": a weight or volume, never pieces of pieces. */
export function parsePieceSize(raw: unknown): Ingredient["pieceSize"] {
  const r = (raw ?? null) as Record<string, unknown> | null;
  if (!r) return null;
  const quantity = positive(r.quantity);
  const unit = normaliseUnit(r.unit);
  const base = quantity !== null && unit ? toBase({ quantity, unit }) : null;
  return base && base.unit !== "piece" ? { quantity: quantity!, unit: unit! } : null;
}

/**
 * Files from before prices kept their unit: each price gets the unit of
 * the purchase line it came from, else the unit the food sits in the pantry
 * in (a price typed at "Bought" is for the amount put in the pantry), else
 * the food's own unit.
 */
export function inferPriceUnits(state: MealsState): void {
  const lineUnit = new Map<string, "g" | "ml" | "piece">();
  for (const purchase of state.purchases)
    for (const line of purchase.lines) {
      const unit = line.ingredientId && line.confirmed ? linePriceUnit(line) : null;
      if (unit) lineUnit.set(`${purchase.id}|${line.ingredientId}`, unit);
    }
  for (const ingredient of state.ingredients) {
    if (ingredient.priceUnit || ingredient.lastPrice === null) continue;
    const latest = [...state.prices]
      .filter((record) => record.ingredientId === ingredient.id && record.purchaseId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((record) => lineUnit.get(`${record.purchaseId}|${ingredient.id}`))
      .find(Boolean);
    const stocked = state.pantry.find((item) => item.ingredientId === ingredient.id);
    ingredient.priceUnit = latest ?? (stocked ? baseUnit(stocked.unit) : null) ?? baseUnit(ingredient.unit);
  }
  for (const record of state.prices) {
    if (record.unit) continue;
    record.unit =
      (record.purchaseId ? lineUnit.get(`${record.purchaseId}|${record.ingredientId}`) : undefined) ??
      state.ingredients.find((i) => i.id === record.ingredientId)?.priceUnit ??
      null;
  }
}

export function parsePriceRecord(raw: unknown): PriceRecord | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const date = isoDay(r.date);
  if (
    typeof r.ingredientId !== "string" ||
    !r.ingredientId ||
    !date ||
    typeof r.pricePerBase !== "number" ||
    !Number.isFinite(r.pricePerBase) ||
    r.pricePerBase <= 0
  )
    return null;
  return {
    ingredientId: r.ingredientId,
    storeId: typeof r.storeId === "string" && r.storeId ? r.storeId : null,
    pricePerBase: r.pricePerBase,
    unit: r.unit === "g" || r.unit === "ml" || r.unit === "piece" ? r.unit : null,
    date,
    purchaseId: typeof r.purchaseId === "string" && r.purchaseId ? r.purchaseId : null,
  };
}

export const MARK_KINDS: ShoppingMarkKind[] = ["unavailable", "skip", "substitute"];

export function parseShoppingMark(raw: unknown): ShoppingMark | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.ingredientId !== "string" || !r.ingredientId || typeof r.at !== "string") return null;
  if (!MARK_KINDS.includes(r.kind as ShoppingMarkKind)) return null;
  return {
    ingredientId: r.ingredientId,
    kind: r.kind as ShoppingMarkKind,
    substituteId: typeof r.substituteId === "string" && r.substituteId ? r.substituteId : null,
    storeId: typeof r.storeId === "string" && r.storeId ? r.storeId : null,
    at: r.at,
  };
}
