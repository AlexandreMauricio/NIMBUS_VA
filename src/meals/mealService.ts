/**
 * The Meals service: ingredients, recipes, the pantry, leftovers and the
 * plan, over an injected store (`meals.json` in the main process).
 *
 * It owns three things the pure modules deliberately don't:
 *
 *  - **validation of anything persisted or typed.** Every list is checked
 *    item by item on load, and a malformed entry is dropped rather than
 *    poisoning the rest — the same rule the shelf and the collection follow.
 *  - **identity.** Recipe lines and pantry items point at an ingredient id,
 *    so `ensureIngredient` is the one place a new food comes into being,
 *    matching on name and aliases before creating anything.
 *  - **cooking**, the only operation that changes several things at once:
 *    it deducts stock (marking what it touched as an estimate), turns extra
 *    portions into leftovers, and marks the planned meal cooked.
 */

import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { buildDemoData } from "./demoData";
import {
  familyChoices,
  familyOf,
  isoDate,
  mergeInto,
  planDeductions,
  suggestEatBy,
  wholeBagServings,
} from "./pantry";
import type { Family } from "./pantry";
import { pricePerBaseUnit, recipeCost, scaleFor } from "./recipes";
import { effectOfReplacing, generatePlan, proposalFigures, replaceOptions } from "./generator";
import type { PlannerInput, ReplaceOption } from "./generator";
import { currentPrice, guessPlace, linePricePerBase, matchLine } from "./purchases";
import { buildShoppingList } from "./shopping";
import type { ShoppingList } from "./shopping";
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
  MealsStore,
  NutritionPer100,
  PantryItem,
  PlannedMeal,
  PlannedMealKind,
  Recipe,
  MAX_COMPONENTS,
  PLAN_OBJECTIVES,
  MEAL_KIND_LABELS,
  PLANNED_MEAL_KINDS,
  PlanObjective,
  PlanProposal,
  PlanRequest,
  RECIPE_DIFFICULTIES,
  RecipeDifficulty,
  RecipeComponent,
  RecipeIngredient,
  RecipeStep,
  isRecipePhotoUrl,
  STORAGE_PLACES,
  StoragePlace,
} from "./types";
import { ingredientKey, matchIngredient } from "./names";
import { cookServingsOf, dayRange, freeMealsAfter, servingsNeeded, spreadLeftovers } from "./plan";
import { parseAmountText } from "./recipeImport";
import { formatAmount, normaliseUnit, subtract, toBase } from "./units";

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

function positive(value: unknown, fallback: number | null = null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000) / 1000
    : fallback;
}

function isoTime(value: unknown): string | null {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

function isoDay(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function stamp(value: unknown): string {
  return typeof value === "string" && value ? value : new Date(0).toISOString();
}

function list(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = text(entry, length);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

export { ingredientKey } from "./names";

/** `amount` (in a base unit) expressed in `unit`, when they measure the same thing. */
function inUnitOf(
  amount: { quantity: number; unit: string },
  unit: string
): { quantity: number; unit: string } {
  const one = toBase({ quantity: 1, unit });
  const base = toBase(amount);
  if (!one || !base || one.unit !== base.unit || one.quantity <= 0) return amount;
  return { quantity: Math.round((base.quantity / one.quantity) * 1000) / 1000, unit };
}

function parseNutrition(raw: unknown): NutritionPer100 | null {
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
    countsAs: typeof r.countsAs === "string" && r.countsAs && r.countsAs !== r.id ? r.countsAs : null,
    addedAt: stamp(r.addedAt),
    updatedAt: stamp(r.updatedAt),
  };
}

function parseRecipeIngredient(raw: unknown): RecipeIngredient | null {
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

function parseStep(raw: unknown): RecipeStep | null {
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

function parseComponents(raw: unknown): RecipeComponent[] {
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
function keepComponent<T extends { componentId: string | null }>(entry: T, components: RecipeComponent[]): T {
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

function parseCorrection(raw: unknown): PantryItem["lastCorrection"] {
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

const MEAL_KINDS: PlannedMealKind[] = PLANNED_MEAL_KINDS;

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

function parseEater(raw: unknown): Eater | null {
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

function parseCookingTime(raw: unknown): MealPreferences["cookingTime"] {
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
  return {
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
}

/** A held proposal, checked like the plan it would become. */
function parseProposal(raw: unknown): PlanProposal | null {
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

function parseStore(raw: unknown): Store | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60);
  return typeof r.id === "string" && r.id && name ? { id: r.id, name } : null;
}

const PURCHASE_SOURCES: PurchaseSource[] = ["manual", "pdf", "photo"];
const PURCHASE_STATUSES: PurchaseStatus[] = ["review", "imported", "history"];

function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function parsePurchaseLine(raw: unknown): PurchaseLine | null {
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
function parseBags(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const sizes = raw.map((size) => positive(size)).filter((size): size is number => size !== null);
  return sizes.length ? sizes.slice(0, 12) : null;
}

/** What a confirmed line put in the pantry — one entry, or one per frozen bag (older files kept one). */
function parseStocked(raw: unknown): PurchaseLine["stocked"] {
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

function parsePurchase(raw: unknown): Purchase | null {
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

function parsePriceRecord(raw: unknown): PriceRecord | null {
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
    date,
    purchaseId: typeof r.purchaseId === "string" && r.purchaseId ? r.purchaseId : null,
  };
}

const MARK_KINDS: ShoppingMarkKind[] = ["unavailable", "skip", "substitute"];

function parseShoppingMark(raw: unknown): ShoppingMark | null {
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

export interface CookInput {
  /** The planned meal being cooked, when it came from the plan. */
  mealId?: string;
  recipeId: string;
  /** How many servings are actually being cooked — may be more than are eaten. */
  cookServings: number;
  /** How many are eaten now; the rest become leftovers. */
  eatServings: number;
  leftoverPlace?: StoragePlace;
  /** Skip the pantry deduction (you cooked from something you hadn't recorded). */
  skipPantry?: boolean;
  /** Put the leftovers straight into this slot of the plan. */
  scheduleLeftoverFor?: { date: string; slot: MealSlot } | null;
  /** Or spread them: this many portions into each of these meals. */
  scheduleLeftovers?: Array<{ date: string; slot: MealSlot; portions: number }> | null;
}

/** What cooking would take out of the pantry, package by package — shown before anything moves. */
export interface CookPreview {
  choices: Array<{
    /** The food the recipe line names. */
    ingredientId: string;
    text: string;
    /** The foods at home that will do, the named one first. */
    foods: Array<{ ingredientId: string; name: string }>;
  }>;
  deductions: Array<{
    itemId: string;
    name: string;
    packaging: string | null;
    place: StoragePlace;
    confidence: PantryItem["confidence"];
    use: { quantity: number; unit: string };
    remaining: { quantity: number; unit: string };
    empties: boolean;
  }>;
  short: Array<{
    name: string;
    missing: { quantity: number; unit: string } | null;
    reason: "short" | "unknown";
  }>;
  /** Frozen bags this takes whole, and how much of each goes past what the recipe needs. */
  bags: Array<{ name: string; extra: { quantity: number; unit: string } }>;
  /** Servings that would use those bags up exactly, when more than asked. */
  bagServings: number | null;
}

export interface CookResult {
  deducted: Array<{ name: string; used: string }>;
  short: Array<{ name: string; reason: "short" | "unknown" }>;
  leftover: Leftover | null;
  /** The planned meal the leftovers were put into, when asked to. */
  scheduled: PlannedMeal | null;
}

/**
 * Meals, over a store. Every mutating method saves; readers return copies
 * so a caller can't edit the state by accident.
 */
export class MealService {
  private state: MealsState;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly store: MealsStore) {
    this.state = parseState(store.load());
  }

  getState(): MealsState {
    return JSON.parse(JSON.stringify(this.state)) as MealsState;
  }

  /** Told after every change, so the windows can redraw — as decks and books do. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private save(): void {
    this.store.save(this.state);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A meals listener threw", { error: String(err) });
      }
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ---------- Ingredients ----------

  listIngredients(): Ingredient[] {
    return [...this.state.ingredients].sort((a, b) => a.name.localeCompare(b.name));
  }

  findIngredient(name: string): Ingredient | undefined {
    return matchIngredient(name, this.state.ingredients);
  }

  /** The one way a food comes into being: found by name or alias, or created. */
  ensureIngredient(name: unknown, unit: unknown = "g"): Ingredient {
    const cleaned = text(name, 120);
    if (!cleaned) throw new Error("An ingredient needs a name.");
    const existing = this.findIngredient(cleaned);
    if (existing) return existing;
    if (this.state.ingredients.length >= MAX_INGREDIENTS) throw new Error("Too many ingredients.");
    const ingredient: Ingredient = {
      id: randomUUID(),
      name: cleaned,
      aliases: [],
      unit: normaliseUnit(unit) ?? "g",
      category: null,
      nutrition: null,
      nutritionSource: null,
      lastPrice: null,
      fridgeDays: null,
      lastPackaging: null,
      countsAs: null,
      addedAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.ingredients.push(ingredient);
    this.save();
    return ingredient;
  }

  updateIngredient(id: unknown, changes: unknown): Ingredient {
    const ingredient = this.state.ingredients.find((i) => i.id === id);
    if (!ingredient) throw new Error("That ingredient is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.name !== undefined) ingredient.name = text(c.name, 120) ?? ingredient.name;
    if (c.aliases !== undefined) ingredient.aliases = list(c.aliases, 20, 120);
    if (c.unit !== undefined) ingredient.unit = normaliseUnit(c.unit) ?? ingredient.unit;
    if (c.category !== undefined) ingredient.category = text(c.category, 60);
    if (c.nutrition !== undefined) ingredient.nutrition = parseNutrition(c.nutrition);
    if (c.nutritionSource !== undefined) ingredient.nutritionSource = text(c.nutritionSource, 80);
    if (c.lastPrice !== undefined)
      ingredient.lastPrice =
        typeof c.lastPrice === "number" && Number.isFinite(c.lastPrice) && c.lastPrice >= 0
          ? c.lastPrice
          : null;
    if (c.fridgeDays !== undefined) ingredient.fridgeDays = positive(c.fridgeDays);
    if (c.countsAs !== undefined) this.setCountsAs(ingredient, c.countsAs);
    ingredient.updatedAt = this.now();
    this.save();
    return ingredient;
  }

  /**
   * "Soy milk counts as Milk". One level only: pointing at a food that
   * itself counts as another points at that one, and foods that counted as
   * this one follow it to its new general food.
   */
  private setCountsAs(ingredient: Ingredient, value: unknown): void {
    if (value === null || value === "") {
      ingredient.countsAs = null;
      return;
    }
    let target = this.state.ingredients.find((i) => i.id === value);
    if (!target) throw new Error("That food isn't known.");
    if (target.countsAs) target = this.state.ingredients.find((i) => i.id === target!.countsAs) ?? target;
    if (target.id === ingredient.id) throw new Error("A food can't count as itself.");
    ingredient.countsAs = target.id;
    for (const other of this.state.ingredients)
      if (other.countsAs === ingredient.id) other.countsAs = target.id;
  }

  /** The cook dialog's picks — { line's food: food to use } — keeping only known foods. */
  private choices(raw: unknown): Map<string, string> {
    const picks = new Map<string, string>();
    if (!raw || typeof raw !== "object") return picks;
    const known = new Set(this.state.ingredients.map((i) => i.id));
    for (const [line, food] of Object.entries(raw as Record<string, unknown>))
      if (known.has(line) && typeof food === "string" && known.has(food)) picks.set(line, food);
    return picks;
  }

  /** Food families as the pantry functions take them. */
  private family(): Family {
    return familyOf(this.state.ingredients);
  }

  /** Only an ingredient nothing points at can go — otherwise recipes would lose their lines. */
  removeIngredient(id: unknown): void {
    const used =
      this.state.recipes.some((recipe) => recipe.ingredients.some((line) => line.ingredientId === id)) ||
      this.state.pantry.some((item) => item.ingredientId === id);
    if (used) throw new Error("That ingredient is used by a recipe or is in the pantry.");
    this.state.ingredients = this.state.ingredients.filter((i) => i.id !== id);
    for (const other of this.state.ingredients) if (other.countsAs === id) other.countsAs = null;
    this.save();
  }

  // ---------- Recipes ----------

  listRecipes(): Recipe[] {
    return [...this.state.recipes].sort((a, b) => a.name.localeCompare(b.name));
  }

  getRecipe(id: unknown): Recipe | null {
    return this.state.recipes.find((recipe) => recipe.id === id) ?? null;
  }

  /**
   * Saves a recipe from the editor or an import. Ingredient lines arrive as
   * names — each is matched to an ingredient or creates one, so a recipe is
   * never saved pointing at a food that doesn't exist.
   */
  saveRecipe(input: unknown, id?: unknown): Recipe {
    const r = (input ?? {}) as Record<string, unknown>;
    const name = text(r.name, 200);
    if (!name) throw new Error("A recipe needs a name.");
    const existing = id ? this.state.recipes.find((recipe) => recipe.id === id) : undefined;
    if (id && !existing) throw new Error("That recipe is gone.");
    // Dishes arrive as {key, name}: a key that is one of this recipe's
    // component ids keeps it, anything else is a new dish. Lines and steps
    // name their dish by the same key.
    const componentIds = new Map<string, string>();
    const components: RecipeComponent[] = [];
    for (const raw of Array.isArray(r.components) ? r.components.slice(0, MAX_COMPONENTS) : []) {
      const c = (raw ?? {}) as Record<string, unknown>;
      const componentName = text(c.name, 60);
      const key = typeof c.key === "string" ? c.key : typeof c.id === "string" ? c.id : "";
      if (!componentName || !key || componentIds.has(key)) continue;
      const keep = existing?.components.find((entry) => entry.id === key);
      const componentId = keep?.id ?? randomUUID();
      componentIds.set(key, componentId);
      components.push({ id: componentId, name: componentName });
    }
    const componentOf = (value: unknown) =>
      typeof value === "string" ? (componentIds.get(value) ?? null) : null;
    const lines = Array.isArray(r.ingredients) ? r.ingredients.slice(0, MAX_RECIPE_INGREDIENTS) : [];
    const ingredients: RecipeIngredient[] = [];
    for (const raw of lines) {
      const line = (raw ?? {}) as Record<string, unknown>;
      const lineName = text(line.name, 200) ?? text(line.text, 200);
      const quantity = positive(line.quantity);
      const unit = normaliseUnit(line.unit);
      if (!lineName || quantity === null || !unit) continue;
      const ingredient =
        typeof line.ingredientId === "string" && line.ingredientId
          ? (this.state.ingredients.find((i) => i.id === line.ingredientId) ??
            this.ensureIngredient(lineName, unit))
          : this.ensureIngredient(lineName, unit);
      ingredients.push({
        ingredientId: ingredient.id,
        text: text(line.text, 200) ?? lineName,
        quantity,
        unit,
        optional: line.optional === true,
        componentId: componentOf(line.component ?? line.componentId),
      });
    }
    const steps = Array.isArray(r.steps)
      ? r.steps
          .map((raw) => {
            const step = typeof raw === "string" ? { text: raw } : ((raw ?? {}) as Record<string, unknown>);
            const parsed = parseStep(step);
            return parsed
              ? { ...parsed, componentId: componentOf(step.component ?? step.componentId) }
              : null;
          })
          .filter((s): s is RecipeStep => s !== null)
          .slice(0, MAX_RECIPE_STEPS)
      : [];
    if (!existing && this.state.recipes.length >= MAX_RECIPES) throw new Error("Too many recipes.");
    const slots = Array.isArray(r.slots)
      ? (r.slots.filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot)) as MealSlot[])
      : [];
    const recipe: Recipe = {
      id: existing?.id ?? randomUUID(),
      name,
      description: text(r.description, 2000),
      slots: slots.length ? [...new Set(slots)] : (existing?.slots ?? ["dinner"]),
      servings: positive(r.servings, existing?.servings ?? 2)!,
      prepMinutes: positive(r.prepMinutes),
      cookMinutes: positive(r.cookMinutes),
      components,
      ingredients,
      steps,
      batch: r.batch === undefined ? (existing?.batch ?? false) : r.batch === true,
      // The photo is set only by the main process's picker (setRecipePhoto).
      photo: existing?.photo ?? null,
      tags: list(r.tags, 20, 40),
      source: text(r.source, 500) ?? existing?.source ?? null,
      notes: r.notes === undefined ? (existing?.notes ?? null) : text(r.notes, 2000),
      favourite: r.favourite === undefined ? (existing?.favourite ?? false) : r.favourite === true,
      lastCookedAt: existing?.lastCookedAt ?? null,
      timesCooked: existing?.timesCooked ?? 0,
      difficulty:
        r.difficulty === undefined
          ? (existing?.difficulty ?? null)
          : RECIPE_DIFFICULTIES.includes(r.difficulty as RecipeDifficulty)
            ? (r.difficulty as RecipeDifficulty)
            : null,
      addedAt: existing?.addedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.state.recipes = existing
      ? this.state.recipes.map((entry) => (entry.id === recipe.id ? recipe : entry))
      : [...this.state.recipes, recipe];
    this.save();
    return recipe;
  }

  /** Sets or clears the recipe's photo address — the picture itself is saved by the main process. */
  setRecipePhoto(id: unknown, photo: string | null): Recipe {
    const recipe = this.state.recipes.find((entry) => entry.id === id);
    if (!recipe) throw new Error("That recipe is gone.");
    if (photo !== null && !isRecipePhotoUrl(photo)) throw new Error("That isn't a recipe photo.");
    recipe.photo = photo;
    recipe.updatedAt = this.now();
    this.save();
    return recipe;
  }

  removeRecipe(id: unknown): void {
    if (typeof id !== "string") return;
    this.unlinkRecipes(new Set([id]));
    this.save();
  }

  /**
   * Takes recipes out. Planned meals keep a name so the plan still reads —
   * the recipe's own, when the meal had none — but lose the link, and
   * leftovers forget which recipe they came from.
   */
  private unlinkRecipes(ids: Set<string>): void {
    const names = new Map(this.state.recipes.map((recipe) => [recipe.id, recipe.name]));
    this.state.recipes = this.state.recipes.filter((recipe) => !ids.has(recipe.id));
    this.state.plan = this.state.plan.map((meal) =>
      meal.recipeId && ids.has(meal.recipeId)
        ? {
            ...meal,
            kind: "custom" as const,
            recipeId: null,
            name: meal.name ?? names.get(meal.recipeId) ?? "Deleted recipe",
          }
        : meal
    );
    this.state.leftovers = this.state.leftovers.map((leftover) =>
      leftover.recipeId && ids.has(leftover.recipeId) ? { ...leftover, recipeId: null } : leftover
    );
  }

  // ---------- Pantry ----------

  listPantry(): PantryItem[] {
    return [...this.state.pantry];
  }

  /** Adds stock, merging into a matching line rather than making a second row. */
  addStock(input: unknown): PantryItem {
    const r = (input ?? {}) as Record<string, unknown>;
    const quantity = positive(r.quantity);
    const unit = normaliseUnit(r.unit);
    if (quantity === null || !unit) throw new Error("How much, and in what unit?");
    if (this.state.pantry.length >= MAX_PANTRY_ITEMS) throw new Error("The pantry is full.");
    const ingredient =
      typeof r.ingredientId === "string" && r.ingredientId
        ? this.state.ingredients.find((i) => i.id === r.ingredientId)
        : this.ensureIngredient(r.name, unit);
    if (!ingredient) throw new Error("That ingredient is gone.");
    const item: PantryItem = {
      id: randomUUID(),
      ingredientId: ingredient.id,
      name: ingredient.name,
      quantity,
      unit,
      startQuantity: quantity,
      place: STORAGE_PLACES.includes(r.place as StoragePlace) ? (r.place as StoragePlace) : "cupboard",
      confidence: r.confidence === "estimated" ? "estimated" : "confirmed",
      packaging: text(r.packaging, 120),
      openedAt: null,
      expiresAt: isoDay(r.expiresAt),
      lastCorrection: null,
      wholeBag: false,
      addedAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.pantry = mergeInto(this.state.pantry, item);
    if (item.packaging) {
      ingredient.lastPackaging = item.packaging;
      ingredient.updatedAt = this.now();
    }
    this.save();
    return this.state.pantry.find((entry) => entry.id === item.id) ?? item;
  }

  updateStock(id: unknown, changes: unknown): PantryItem | null {
    const item = this.state.pantry.find((entry) => entry.id === id);
    if (!item) throw new Error("That pantry item is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.quantity !== undefined) {
      const quantity =
        typeof c.quantity === "number" && c.quantity >= 0 ? Math.round(c.quantity * 1000) / 1000 : null;
      if (quantity === null) throw new Error("That amount doesn't make sense.");
      item.quantity = quantity;
    }
    if (c.unit !== undefined) item.unit = normaliseUnit(c.unit) ?? item.unit;
    if (c.place !== undefined && STORAGE_PLACES.includes(c.place as StoragePlace))
      item.place = c.place as StoragePlace;
    if (c.packaging !== undefined) item.packaging = text(c.packaging, 120);
    if (c.expiresAt !== undefined) item.expiresAt = isoDay(c.expiresAt);
    if (c.opened !== undefined) item.openedAt = c.opened === true ? (item.openedAt ?? this.now()) : null;
    if (c.confidence !== undefined)
      item.confidence = c.confidence === "estimated" ? "estimated" : "confirmed";
    item.updatedAt = this.now();
    if (item.quantity === 0) {
      this.state.pantry = this.state.pantry.filter((entry) => entry.id !== item.id);
      this.save();
      return null;
    }
    this.save();
    return item;
  }

  /**
   * "Correct stock": the user says what's actually there. Whatever the
   * number, the item becomes **confirmed** — that's the whole point of the
   * screen, and the only way an estimate stops being one.
   */
  correctStock(id: unknown, quantity: unknown, unit?: unknown, reason?: unknown): PantryItem | null {
    const item = this.state.pantry.find((entry) => entry.id === id);
    if (!item) throw new Error("That pantry item is gone.");
    const amount =
      typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0 ? quantity : null;
    if (amount === null) throw new Error("That amount doesn't make sense.");
    item.quantity = Math.round(amount * 1000) / 1000;
    if (unit !== undefined) item.unit = normaliseUnit(unit) ?? item.unit;
    // Confirming resets the "how far through the package" reference: this
    // amount is now the full one, so the bar starts from what's really there.
    item.startQuantity = item.quantity;
    item.confidence = "confirmed";
    if (CORRECTION_REASONS.includes(reason as CorrectionReason))
      item.lastCorrection = { reason: reason as CorrectionReason, at: this.now() };
    item.updatedAt = this.now();
    if (item.quantity === 0) {
      this.state.pantry = this.state.pantry.filter((entry) => entry.id !== item.id);
      this.save();
      return null;
    }
    this.save();
    return item;
  }

  removeStock(id: unknown): void {
    this.state.pantry = this.state.pantry.filter((item) => item.id !== id);
    this.save();
  }

  // ---------- Leftovers ----------

  listLeftovers(): Leftover[] {
    return [...this.state.leftovers];
  }

  addLeftover(input: unknown): Leftover {
    const r = (input ?? {}) as Record<string, unknown>;
    const name = text(r.name, 200);
    const portions = positive(r.portions);
    if (!name || portions === null) throw new Error("Leftovers need a name and how many portions.");
    if (this.state.leftovers.length >= MAX_LEFTOVERS) throw new Error("Too many leftovers recorded.");
    const place = STORAGE_PLACES.includes(r.place as StoragePlace) ? (r.place as StoragePlace) : "fridge";
    const cookedAt = new Date();
    const leftover: Leftover = {
      id: randomUUID(),
      name,
      recipeId: typeof r.recipeId === "string" && r.recipeId ? r.recipeId : null,
      portions,
      place,
      cookedAt: cookedAt.toISOString(),
      eatBy: isoDay(r.eatBy) ?? (place === "cupboard" ? null : suggestEatBy(cookedAt, place)),
      addedAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.leftovers.push(leftover);
    this.save();
    return leftover;
  }

  /** Eating some of it: portions go down, and the entry goes when it's finished. */
  updateLeftover(id: unknown, changes: unknown): Leftover | null {
    const leftover = this.state.leftovers.find((entry) => entry.id === id);
    if (!leftover) throw new Error("Those leftovers are gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.portions !== undefined) {
      const portions =
        typeof c.portions === "number" && c.portions >= 0 ? Math.round(c.portions * 100) / 100 : null;
      if (portions === null) throw new Error("That number of portions doesn't make sense.");
      leftover.portions = portions;
    }
    if (c.place !== undefined && STORAGE_PLACES.includes(c.place as StoragePlace))
      leftover.place = c.place as StoragePlace;
    if (c.eatBy !== undefined) leftover.eatBy = isoDay(c.eatBy);
    if (c.name !== undefined) leftover.name = text(c.name, 200) ?? leftover.name;
    leftover.updatedAt = this.now();
    if (leftover.portions === 0) {
      this.state.leftovers = this.state.leftovers.filter((entry) => entry.id !== leftover.id);
      this.save();
      return null;
    }
    this.save();
    return leftover;
  }

  removeLeftover(id: unknown): void {
    this.state.leftovers = this.state.leftovers.filter((entry) => entry.id !== id);
    this.save();
  }

  // ---------- The plan ----------

  listPlan(): PlannedMeal[] {
    return [...this.state.plan];
  }

  planMeal(input: unknown, id?: unknown): PlannedMeal {
    const r = (input ?? {}) as Record<string, unknown>;
    const date = isoDay(r.date);
    if (!date) throw new Error("A planned meal needs a day.");
    if (!MEAL_SLOTS.includes(r.slot as MealSlot)) throw new Error("A planned meal needs a slot.");
    const kind = MEAL_KINDS.includes(r.kind as PlannedMealKind) ? (r.kind as PlannedMealKind) : "recipe";
    const recipeId = typeof r.recipeId === "string" && r.recipeId ? r.recipeId : null;
    const leftoverId = typeof r.leftoverId === "string" && r.leftoverId ? r.leftoverId : null;
    if (kind === "recipe" && !this.getRecipe(recipeId)) throw new Error("Choose a recipe.");
    const existing = id ? this.state.plan.find((meal) => meal.id === id) : undefined;
    // Leftovers of a batch not cooked yet point at that planned meal until it's cooked.
    const source =
      kind === "leftover" && typeof r.fromMealId === "string"
        ? this.state.plan.find((m) => m.id === r.fromMealId && m.kind === "recipe" && !m.cookedAt)
        : undefined;
    if (kind === "leftover" && typeof r.fromMealId === "string" && !source)
      throw new Error("That meal is already cooked or gone.");
    const fromMealId = source?.id ?? existing?.fromMealId ?? null;
    if (kind === "leftover" && !fromMealId && !this.state.leftovers.some((l) => l.id === leftoverId))
      throw new Error("Choose which leftovers.");
    if (id && !existing) throw new Error("That planned meal is gone.");
    if (!existing && this.state.plan.length >= MAX_PLANNED_MEALS) throw new Error("The plan is full.");
    const meal: PlannedMeal = {
      id: existing?.id ?? randomUUID(),
      date,
      slot: r.slot as MealSlot,
      kind,
      recipeId: kind === "recipe" ? recipeId : null,
      leftoverId: kind === "leftover" ? leftoverId : null,
      name: text(r.name, 200),
      servings: positive(r.servings, existing?.servings ?? 1)!,
      cookServings: positive(r.cookServings),
      time: isoTime(r.time),
      cost: typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost >= 0 ? r.cost : null,
      notes: text(r.notes, 1000),
      cookedAt: existing?.cookedAt ?? null,
      locked: existing?.locked ?? false,
      // Anything you place or change yourself is "Your pick".
      origin: "user",
      reasons: [],
      swapSaving: null,
      portions: kind === "leftover" ? positive(r.portions) : null,
      fromMealId,
      addedAt: existing?.addedAt ?? this.now(),
      updatedAt: this.now(),
    };
    if (source && !meal.name) meal.name = `${this.getRecipe(source.recipeId)?.name ?? "Meal"} (leftovers)`;
    this.state.plan = existing
      ? this.state.plan.map((entry) => (entry.id === meal.id ? meal : entry))
      : [...this.state.plan, meal];
    // A frozen bag is defrosted whole: a meal it feeds cooks enough to use it all.
    if (kind === "recipe" && meal.cookServings === null && !meal.cookedAt) {
      const recipe = this.getRecipe(meal.recipeId)!;
      const bag = wholeBagServings(
        recipe,
        cookServingsOf(meal, recipe),
        this.pantryBefore(meal),
        this.family()
      );
      if (bag !== null) {
        meal.cookServings = bag;
        meal.reasons = [`Cooks ${bag} to use the whole frozen bag`];
      }
    }
    // A batch: its extra portions go into the next free meals, unless asked not to.
    this.dropLeftoversOf(meal.id);
    if (r.planLeftovers !== false && this.state.preferences.autoLeftovers) this.planLeftoversOf(meal);
    this.save();
    return meal;
  }

  /**
   * The pantry as it will be when a meal comes round: what the planned
   * meals before it (not cooked yet) will have taken — so two meals don't
   * both count on the same frozen bag.
   */
  private pantryBefore(meal: PlannedMeal): PantryItem[] {
    const family = this.family();
    let pantry = this.state.pantry.map((item) => ({ ...item }));
    const order = (m: PlannedMeal) => `${m.date}|${MEAL_SLOTS.indexOf(m.slot)}`;
    const earlier = this.state.plan
      .filter((m) => m.id !== meal.id && m.kind === "recipe" && !m.cookedAt && order(m) < order(meal))
      .sort((a, b) => order(a).localeCompare(order(b)));
    for (const other of earlier) {
      const recipe = this.getRecipe(other.recipeId);
      if (!recipe) continue;
      const plan = planDeductions(
        recipe.ingredients,
        pantry,
        scaleFor(recipe, cookServingsOf(other, recipe)),
        {
          family,
        }
      );
      pantry = pantry.map((item) => {
        const used = plan.deductions.find((d) => d.itemId === item.id);
        return used ? { ...item, quantity: used.remaining.quantity, unit: used.remaining.unit } : item;
      });
    }
    return pantry;
  }

  /** "Plan its leftovers": a batch planned before leftovers were planned for it, or with some left free. */
  planLeftoversFor(mealId: unknown): PlannedMeal[] {
    const meal = this.state.plan.find((m) => m.id === mealId);
    if (!meal) throw new Error("That meal is gone.");
    const planned = this.planLeftoversOf(meal);
    if (!planned.length) throw new Error("No free lunch or dinner in the next three days for them.");
    this.save();
    return planned;
  }

  /**
   * How many leftovers a planned batch will leave, as the pantry edits it:
   * it cooks that many more than are eating. Leftover meals planned from it
   * that no longer have portions are taken out, the last first.
   */
  setExpectedLeftovers(mealId: unknown, portions: unknown): PlannedMeal {
    const meal = this.state.plan.find((m) => m.id === mealId && m.kind === "recipe");
    if (!meal) throw new Error("That meal is gone.");
    if (meal.cookedAt) throw new Error("That meal is already cooked — change its leftovers in the pantry.");
    const extra =
      typeof portions === "number" && Number.isFinite(portions) ? Math.max(0, Math.round(portions)) : 0;
    meal.cookServings = meal.servings + extra;
    meal.updatedAt = this.now();
    const chain = this.state.plan
      .filter((m) => m.kind === "leftover" && m.fromMealId === meal.id && !m.leftoverId && !m.cookedAt)
      .sort(
        (a, b) => a.date.localeCompare(b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot)
      );
    let left = extra;
    for (const entry of chain) {
      const share = Math.min(entry.portions ?? entry.servings, left);
      left -= share;
      if (share <= 0) {
        this.state.plan = this.state.plan.filter((m) => m !== entry);
        this.dropLeftoversOf(entry.id);
      } else entry.portions = share;
    }
    this.save();
    return meal;
  }

  /** The planned leftovers of a meal not cooked yet — taken out when it changes or goes. */
  private dropLeftoversOf(mealId: string): void {
    // Its leftovers not cooked yet, and what was planned alongside them — and so on down.
    const gone = [...this.state.plan, ...(this.state.proposal?.meals ?? [])].filter(
      (entry) =>
        entry.fromMealId === mealId && !entry.cookedAt && !(entry.kind === "leftover" && entry.leftoverId)
    );
    if (!gone.length) return;
    const ids = new Set(gone.map((entry) => entry.id));
    this.state.plan = this.state.plan.filter((entry) => !ids.has(entry.id));
    if (this.state.proposal)
      this.state.proposal.meals = this.state.proposal.meals.filter((entry) => !ids.has(entry.id));
    for (const id of ids) this.dropLeftoversOf(id);
  }

  /**
   * A recipe cooked as a batch — 5 servings for 2 people — leaves 3
   * portions: 2 go into the next free lunch or dinner, 1 into the one after
   * (which then needs something alongside). Within three days.
   */
  private planLeftoversOf(meal: PlannedMeal): PlannedMeal[] {
    if (meal.kind !== "recipe" || meal.cookedAt) return [];
    const recipe = this.getRecipe(meal.recipeId);
    if (!recipe) return [];
    const already = this.state.plan
      .filter((other) => other.kind === "leftover" && other.fromMealId === meal.id && !other.leftoverId)
      .reduce((sum, other) => sum + (other.portions ?? other.servings), 0);
    const extra = Math.round((cookServingsOf(meal, recipe) - meal.servings - already) * 100) / 100;
    if (extra <= 0) return [];
    const eatBy = isoDate(new Date(Date.parse(`${meal.date}T12:00:00`) + 3 * 86_400_000));
    const free = freeMealsAfter(this.state.plan, meal, 4, this.state.preferences.slots);
    const eating = servingsNeeded(this.state.preferences.eaters);
    const planned: PlannedMeal[] = [];
    for (const share of spreadLeftovers(extra, eating, free, eatBy)) {
      if (this.state.plan.length >= MAX_PLANNED_MEALS) break;
      const leftover: PlannedMeal = {
        ...meal,
        id: randomUUID(),
        date: share.date,
        slot: share.slot,
        kind: "leftover",
        recipeId: null,
        leftoverId: null,
        fromMealId: meal.id,
        portions: share.portions,
        name: `${recipe.name} (leftovers)`,
        servings: eating,
        cookServings: null,
        time: null,
        cost: null,
        notes: null,
        cookedAt: null,
        locked: false,
        reasons: [
          `Leftovers of the ${recipe.name.toLowerCase()} — ${share.portions} of ${extra} extra portion${extra === 1 ? "" : "s"}`,
        ],
        swapSaving: null,
        addedAt: this.now(),
        updatedAt: this.now(),
      };
      this.state.plan.push(leftover);
      planned.push(leftover);
    }
    return planned;
  }

  removePlannedMeal(id: unknown): void {
    this.state.plan = this.state.plan.filter((meal) => meal.id !== id);
    if (typeof id === "string") this.dropLeftoversOf(id);
    this.save();
  }

  // ---------- Cooking ----------

  /**
   * Cooking a recipe, in one step: take the ingredients out of the pantry
   * (soonest expiry first), turn extra portions into leftovers, and mark
   * the planned meal cooked.
   *
   * Everything it touches in the pantry becomes **estimated**, because
   * "the recipe said 300 g" is not the same as knowing what came out of
   * the bag. What the pantry couldn't cover is reported, not invented.
   */
  /** What cooking `servings` of a recipe would take, package by package. Changes nothing. */
  previewCook(recipeId: unknown, servings: unknown, choose: unknown = {}): CookPreview {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const family = this.family();
    const plan = planDeductions(
      recipe.ingredients,
      this.state.pantry,
      scaleFor(recipe, positive(servings, recipe.servings)!),
      { family, choose: this.choices(choose) }
    );
    const name = (id: string) => this.state.ingredients.find((i) => i.id === id)?.name ?? "?";
    return {
      // Lines more than one food at home can fill — the dialog asks which.
      choices: familyChoices(recipe.ingredients, this.state.pantry, family).map((choice) => ({
        ingredientId: choice.ingredient.ingredientId,
        text: choice.ingredient.text || name(choice.ingredient.ingredientId),
        foods: choice.foods.map((id) => ({ ingredientId: id, name: name(id) })),
      })),
      deductions: plan.deductions.map((deduction) => {
        const item = this.state.pantry.find((entry) => entry.id === deduction.itemId)!;
        return {
          itemId: item.id,
          name: item.name,
          packaging: item.packaging,
          place: item.place,
          confidence: item.confidence,
          // In the package's own unit: "use 1 tin", not "use 1" of a base unit.
          use: inUnitOf(deduction.use, item.unit),
          remaining: deduction.remaining,
          empties: deduction.empties,
        };
      }),
      short: plan.short.map((entry) => ({
        name: entry.ingredient.text || "ingredient",
        missing: entry.missing,
        reason: entry.reason,
      })),
      // Frozen bags used whole: what's cooked past the recipe, and the servings that would use it.
      bags: plan.surplus.map((entry) => ({ name: entry.bag, extra: entry.extra })),
      bagServings: wholeBagServings(recipe, positive(servings, recipe.servings)!, this.state.pantry, family),
    };
  }

  cook(input: unknown): CookResult {
    const r = (input ?? {}) as CookInput & Record<string, unknown>;
    const recipe = this.getRecipe(r.recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const cookServings = positive(r.cookServings, recipe.servings)!;
    const eatServings = Math.min(cookServings, positive(r.eatServings, cookServings)!);
    const result: CookResult = { deducted: [], short: [], leftover: null, scheduled: null };
    // Checked before anything moves: cooking a planned meal twice would
    // take its ingredients out of the pantry twice.
    const planned =
      typeof r.mealId === "string" ? this.state.plan.find((entry) => entry.id === r.mealId) : undefined;
    if (planned?.cookedAt) throw new Error("That meal is already cooked.");

    if (r.skipPantry !== true) {
      const plan = planDeductions(recipe.ingredients, this.state.pantry, scaleFor(recipe, cookServings), {
        family: this.family(),
        choose: this.choices(r.choose),
      });
      for (const deduction of plan.deductions) {
        const item = this.state.pantry.find((entry) => entry.id === deduction.itemId);
        if (!item) continue;
        item.quantity = deduction.remaining.quantity;
        item.unit = deduction.remaining.unit;
        item.confidence = "estimated";
        item.updatedAt = this.now();
        result.deducted.push({
          name: item.name,
          used: `${deduction.use.quantity} ${deduction.use.unit}`,
        });
      }
      this.state.pantry = this.state.pantry.filter((item) => {
        const base = toBase({ quantity: item.quantity, unit: item.unit });
        return !base || base.quantity > 0;
      });
      result.short = plan.short.map((entry) => ({
        name: entry.ingredient.text || "ingredient",
        reason: entry.reason,
      }));
    }

    const extra = Math.round((cookServings - eatServings) * 100) / 100;
    if (extra > 0) {
      const place = STORAGE_PLACES.includes(r.leftoverPlace as StoragePlace)
        ? (r.leftoverPlace as StoragePlace)
        : "fridge";
      result.leftover = this.addLeftover({
        name: recipe.name,
        recipeId: recipe.id,
        portions: extra,
        place,
      });
      // Leftovers already planned from this meal now point at the real ones — as far as they go.
      const promised = planned
        ? this.state.plan
            .filter(
              (entry) => entry.kind === "leftover" && entry.fromMealId === planned.id && !entry.cookedAt
            )
            .sort(
              (a, b) =>
                a.date.localeCompare(b.date) || MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot)
            )
        : [];
      let left = extra;
      for (const entry of promised) {
        entry.leftoverId = result.leftover.id;
        entry.portions = Math.max(0, Math.min(entry.portions ?? entry.servings, left));
        left = Math.round((left - entry.portions) * 100) / 100;
        entry.updatedAt = this.now();
      }
      if (promised.length) result.scheduled = promised[0];
      const spread = Array.isArray(r.scheduleLeftovers) ? r.scheduleLeftovers : [];
      for (const share of promised.length ? [] : spread.slice(0, 8)) {
        if (!isoDay(share?.date) || !MEAL_SLOTS.includes(share?.slot) || left <= 0) continue;
        const portions = Math.min(left, positive(share.portions, 1)!);
        const scheduled = this.planMeal({
          date: share.date,
          slot: share.slot,
          kind: "leftover",
          leftoverId: result.leftover.id,
          portions,
          servings: servingsNeeded(this.state.preferences.eaters),
        });
        left = Math.round((left - portions) * 100) / 100;
        result.scheduled ??= scheduled;
      }
      const target = promised.length || spread.length ? null : r.scheduleLeftoverFor;
      if (target && isoDay(target.date) && MEAL_SLOTS.includes(target.slot)) {
        result.scheduled = this.planMeal({
          date: target.date,
          slot: target.slot,
          kind: "leftover",
          leftoverId: result.leftover.id,
          servings: servingsNeeded(this.state.preferences.eaters),
        });
      }
    }

    recipe.timesCooked += 1;
    recipe.lastCookedAt = this.now();
    recipe.updatedAt = this.now();

    if (planned) {
      planned.cookedAt = this.now();
      planned.cookServings = cookServings;
      planned.updatedAt = this.now();
    }
    this.save();
    logger.info("Cooked a meal", {
      recipe: recipe.name,
      cookServings,
      deducted: result.deducted.length,
      short: result.short.length,
    });
    return result;
  }

  /** Eating leftovers: portions go down by what was eaten, and the meal is marked done. */
  eatLeftover(mealId: unknown, leftoverId: unknown, portions: unknown): Leftover | null {
    const leftover = this.state.leftovers.find((entry) => entry.id === leftoverId);
    if (!leftover) throw new Error("Those leftovers are gone.");
    const eaten = Math.min(leftover.portions, positive(portions, 1)!);
    const meal = this.state.plan.find((entry) => entry.id === mealId);
    if (meal) {
      meal.cookedAt = this.now();
      meal.updatedAt = this.now();
    }
    return this.updateLeftover(leftover.id, {
      portions: Math.round((leftover.portions - eaten) * 100) / 100,
    });
  }

  // ---------- The shopping list ----------

  /**
   * What the days in `dates` need that the kitchen doesn't have, plus
   * whatever was added by hand. Worked out fresh every time — see
   * shopping.ts for why nothing about it is stored.
   */
  shoppingList(dates: string[]): ShoppingList {
    const days = new Set(dates);
    return buildShoppingList(
      this.state.plan.filter((meal) => days.has(meal.date)),
      new Map(this.state.recipes.map((recipe) => [recipe.id, recipe])),
      this.state.pantry,
      new Map(this.state.ingredients.map((ingredient) => [ingredient.id, ingredient])),
      this.state.shopping
    );
  }

  addShoppingItem(input: unknown): ManualShoppingItem {
    const r = (input ?? {}) as Record<string, unknown>;
    const name = text(r.name, 120);
    if (!name) throw new Error("What should go on the list?");
    if (this.state.shopping.length >= MAX_SHOPPING_ITEMS) throw new Error("The shopping list is full.");
    const known = this.findIngredient(name);
    const item: ManualShoppingItem = {
      id: randomUUID(),
      name,
      ingredientId: known?.id ?? null,
      quantity: positive(r.quantity),
      unit: normaliseUnit(r.unit),
      note: text(r.note, 200),
      addedAt: this.now(),
    };
    this.state.shopping.push(item);
    this.save();
    return item;
  }

  /**
   * Puts what a recipe is short of on the shopping list, as lines of their
   * own — for cooking something that isn't in the plan. A food already on
   * the list by hand isn't added twice. Returns how many were added.
   */
  addMissingToShopping(recipeId: unknown, servings: unknown): number {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const plan = planDeductions(
      recipe.ingredients,
      this.state.pantry,
      scaleFor(recipe, positive(servings, recipe.servings)!),
      { family: this.family() }
    );
    let added = 0;
    for (const entry of plan.short) {
      const ingredientId = entry.ingredient.ingredientId;
      if (this.state.shopping.some((item) => item.ingredientId === ingredientId)) continue;
      if (this.state.shopping.length >= MAX_SHOPPING_ITEMS) break;
      const food = this.state.ingredients.find((i) => i.id === ingredientId);
      this.state.shopping.push({
        id: randomUUID(),
        name: food?.name ?? entry.ingredient.text,
        ingredientId,
        quantity: entry.missing ? Math.round(entry.missing.quantity * 1000) / 1000 : null,
        unit: entry.missing?.unit ?? null,
        note: `for ${recipe.name}`,
        addedAt: this.now(),
      });
      added += 1;
    }
    if (added) this.save();
    return added;
  }

  removeShoppingItem(id: unknown): void {
    this.state.shopping = this.state.shopping.filter((item) => item.id !== id);
    this.save();
  }

  /**
   * Buying something: it goes into the pantry as **confirmed** stock, and
   * what it cost becomes that ingredient's price per unit, so every recipe
   * using it is costed from a real receipt rather than a guess. A manual
   * line is removed once bought; a line the plan asked for disappears by
   * itself, because the pantry now covers it.
   */
  buy(input: unknown): PantryItem {
    const r = (input ?? {}) as Record<string, unknown>;
    const quantity = positive(r.quantity);
    const unit = normaliseUnit(r.unit);
    if (quantity === null || !unit) throw new Error("How much did you buy?");
    const item = this.addStock({
      ingredientId: r.ingredientId,
      name: r.name,
      quantity,
      unit,
      place: r.place,
      expiresAt: r.expiresAt,
      packaging: r.packaging,
      confidence: "confirmed",
    });
    const paid = typeof r.paid === "number" && Number.isFinite(r.paid) && r.paid >= 0 ? r.paid : null;
    if (paid !== null) {
      const price = pricePerBaseUnit(paid, { quantity, unit });
      if (price !== null) {
        this.updateIngredient(item.ingredientId, { lastPrice: price });
        const store = text(r.store, 60) ? this.ensureStore(r.store) : null;
        this.recordPrice({
          ingredientId: item.ingredientId,
          storeId: store?.id ?? null,
          pricePerBase: price,
          date: this.today(),
          purchaseId: null,
        });
      }
    }
    this.state.shoppingMarks = this.state.shoppingMarks.filter(
      (mark) => mark.ingredientId !== item.ingredientId
    );
    if (typeof r.itemId === "string" && r.itemId) this.removeShoppingItem(r.itemId);
    else this.save();
    return item;
  }

  // ---------- Shops, purchases and prices ----------

  listStores(): Store[] {
    return [...this.state.stores];
  }

  /** A shop by name, created the first time it's named. */
  ensureStore(name: unknown): Store {
    const cleaned = text(name, 60);
    if (!cleaned) throw new Error("A shop needs a name.");
    const key = ingredientKey(cleaned);
    const existing = this.state.stores.find((store) => ingredientKey(store.name) === key);
    if (existing) return existing;
    if (this.state.stores.length >= MAX_STORES) throw new Error("Too many shops.");
    const store = { id: randomUUID(), name: cleaned };
    this.state.stores.push(store);
    this.save();
    return store;
  }

  private recordPrice(record: PriceRecord): void {
    this.state.prices.push(record);
    if (this.state.prices.length > MAX_PRICES)
      this.state.prices.splice(0, this.state.prices.length - MAX_PRICES);
  }

  listPurchases(): Purchase[] {
    return [...this.state.purchases].sort(
      (a, b) => b.date.localeCompare(a.date) || b.addedAt.localeCompare(a.addedAt)
    );
  }

  /**
   * A purchase to check: its lines as read or typed, each matched to a
   * known food where one fits (with how sure), waiting in "review" until
   * you confirm it. Nothing in the kitchen changes yet.
   */
  createPurchase(input: unknown): Purchase {
    const r = (input ?? {}) as Record<string, unknown>;
    if (this.state.purchases.length >= MAX_PURCHASES) throw new Error("Too many purchases kept.");
    const source = PURCHASE_SOURCES.includes(r.source as PurchaseSource)
      ? (r.source as PurchaseSource)
      : "manual";
    const rawLines = Array.isArray(r.lines) ? r.lines.slice(0, MAX_PURCHASE_LINES) : [];
    const lines: PurchaseLine[] = [];
    for (const raw of rawLines) {
      const l = (raw ?? {}) as Record<string, unknown>;
      const lineText = text(l.raw ?? l.name, 200);
      if (!lineText) continue;
      const typed =
        typeof l.ingredientId === "string" && this.state.ingredients.some((i) => i.id === l.ingredientId);
      const match = typed
        ? { ingredientId: l.ingredientId as string, confidence: 1 }
        : matchLine(lineText, this.state.ingredients);
      lines.push({
        id: randomUUID(),
        raw: lineText,
        ingredientId: match.ingredientId,
        notFood: l.notFood === true,
        quantity: positive(l.quantity),
        unit: normaliseUnit(l.unit),
        price: money(l.price),
        // What you typed yourself is known; what was read off paper is a guess until checked.
        confidence:
          source === "manual" && match.ingredientId ? Math.max(match.confidence, 0.9) : match.confidence,
        confirmed: source === "manual" && Boolean(match.ingredientId) && match.confidence >= 0.8,
        place: STORAGE_PLACES.includes(l.place as StoragePlace)
          ? (l.place as StoragePlace)
          : guessPlace(
              lineText,
              this.state.ingredients.find((i) => i.id === match.ingredientId) ?? null,
              this.state.pantry
            ),
        bags: null,
        stocked: [],
      });
    }
    if (!lines.length) throw new Error("A purchase needs at least one line.");
    const store = text(r.store, 60) ? this.ensureStore(r.store) : null;
    const purchase: Purchase = {
      id: randomUUID(),
      storeId: store?.id ?? null,
      date: isoDay(r.date) ?? this.today(),
      source,
      status: "review",
      lines,
      total: money(r.total),
      fileName: text(r.fileName, 200),
      addedAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.purchases.push(purchase);
    this.save();
    return purchase;
  }

  /** Checking one line: which food (or not food), how much, what it cost. The line is then confirmed. */
  updatePurchaseLine(purchaseId: unknown, lineId: unknown, changes: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    const line = purchase.lines.find((entry) => entry.id === lineId);
    if (!line) throw new Error("That line is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.ingredientId !== undefined) {
      if (c.ingredientId === null) line.ingredientId = null;
      else if (
        typeof c.ingredientId === "string" &&
        this.state.ingredients.some((i) => i.id === c.ingredientId)
      )
        line.ingredientId = c.ingredientId;
      else throw new Error("That food isn't known.");
    }
    const before = line.ingredientId;
    if (typeof c.newFood === "string" && text(c.newFood, 120)) {
      const food = this.ensureIngredient(c.newFood, normaliseUnit(c.unit) ?? line.unit ?? "g");
      line.ingredientId = food.id;
      if (typeof c.countsAs === "string" && c.countsAs && food.id !== c.countsAs)
        this.setCountsAs(food, c.countsAs);
    }
    // Freezing in bags: to the freezer, each bag its own item; sizes adding up to more than bought are refused.
    if (c.bags !== undefined) {
      const bags = parseBags(c.bags);
      const total = bags?.reduce((sum, size) => sum + size, 0) ?? 0;
      if (bags && line.quantity !== null && total > line.quantity + 1e-6)
        throw new Error("Those bags hold more than was bought.");
      line.bags = bags && bags.length > 1 ? bags : bags && line.quantity !== null ? bags : null;
      if (line.bags) line.place = "freezer";
    }
    // A place you chose stays; a different food brings its own guess.
    if (STORAGE_PLACES.includes(c.place as StoragePlace)) line.place = c.place as StoragePlace;
    else if (line.ingredientId !== before)
      line.place = guessPlace(
        line.raw,
        this.state.ingredients.find((i) => i.id === line.ingredientId) ?? null,
        this.state.pantry
      );
    if (c.notFood !== undefined) line.notFood = c.notFood === true;
    if (c.quantity !== undefined) line.quantity = positive(c.quantity);
    if (c.unit !== undefined) line.unit = normaliseUnit(c.unit);
    if (c.price !== undefined) line.price = money(c.price);
    line.confirmed = true;
    line.confidence = line.ingredientId || line.notFood ? 1 : line.confidence;
    purchase.updatedAt = this.now();
    this.save();
    return purchase;
  }

  updatePurchase(purchaseId: unknown, changes: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.store !== undefined) purchase.storeId = text(c.store, 60) ? this.ensureStore(c.store).id : null;
    if (c.date !== undefined) purchase.date = isoDay(c.date) ?? purchase.date;
    if (c.total !== undefined) purchase.total = money(c.total);
    purchase.updatedAt = this.now();
    this.save();
    return purchase;
  }

  /**
   * Confirming a purchase: every line you've checked that is a food,
   * with an amount, applied to what you ask —
   *
   *  - `prices`: its price per unit, at that shop, on that day;
   *  - `pantry`: the food into the kitchen, as confirmed stock;
   *  - `shopping`: lines added by hand for that food ticked off (the ones
   *    worked out from the plan go by themselves, now the pantry has it).
   *
   * Each confirmed line's text becomes an alias of its food, so the same
   * receipt line matches for certain next time. Lines never checked are
   * left out rather than guessed into the kitchen.
   */
  confirmPurchase(purchaseId: unknown, apply: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    if (purchase.status !== "review") throw new Error("That purchase is already confirmed.");
    const a = (apply ?? {}) as Record<string, unknown>;
    const toPrices = a.prices !== false;
    const toPantry = a.pantry !== false;
    const toShopping = a.shopping !== false;
    for (const line of purchase.lines) {
      if (!line.confirmed || line.notFood || !line.ingredientId) continue;
      const ingredient = this.state.ingredients.find((i) => i.id === line.ingredientId);
      if (!ingredient) continue;
      // The line's own words, remembered as a name for this food.
      const lineKey = ingredientKey(line.raw);
      const known = [ingredient.name, ...ingredient.aliases].some((name) => ingredientKey(name) === lineKey);
      if (lineKey && !known && ingredient.aliases.length < 20) ingredient.aliases.push(line.raw);
      const perBase = linePricePerBase(line);
      if (toPrices && perBase !== null) {
        this.recordPrice({
          ingredientId: ingredient.id,
          storeId: purchase.storeId,
          pricePerBase: perBase,
          date: purchase.date,
          purchaseId: purchase.id,
        });
        ingredient.lastPrice = perBase;
      }
      if (toPantry && line.quantity !== null && line.unit) {
        const place = line.bags ? "freezer" : line.place;
        const unit = line.unit;
        // Frozen in bags: one pantry item per bag, each used whole. Else one item.
        const portions = line.bags ?? [line.quantity];
        line.stocked = [];
        for (const quantity of portions) {
          if (this.state.pantry.length >= MAX_PANTRY_ITEMS) break;
          const item: PantryItem = {
            id: randomUUID(),
            ingredientId: ingredient.id,
            name: ingredient.name,
            quantity,
            unit,
            startQuantity: quantity,
            place,
            confidence: "confirmed",
            packaging: line.bags ? `frozen bag of ${formatAmount({ quantity, unit })}` : null,
            openedAt: null,
            // In the fridge, a food with a known keeping time gets an eat-by date.
            expiresAt:
              place === "fridge" && ingredient.fridgeDays
                ? isoDate(new Date(Date.parse(this.now()) + ingredient.fridgeDays * 86_400_000))
                : null,
            lastCorrection: null,
            wholeBag: Boolean(line.bags),
            addedAt: this.now(),
            updatedAt: this.now(),
          };
          this.state.pantry = mergeInto(this.state.pantry, item);
          // Remember where it went — a new item, or topped up into one already there.
          const into =
            this.state.pantry.find((entry) => entry.id === item.id) ??
            this.state.pantry.find(
              (entry) =>
                entry.ingredientId === ingredient.id &&
                entry.place === place &&
                entry.updatedAt === item.updatedAt
            );
          if (into) line.stocked.push({ itemId: into.id, quantity, unit });
        }
      }
      if (toShopping) {
        this.state.shopping = this.state.shopping.filter((item) => item.ingredientId !== ingredient.id);
        this.state.shoppingMarks = this.state.shoppingMarks.filter(
          (mark) => mark.ingredientId !== ingredient.id
        );
      }
      ingredient.updatedAt = this.now();
    }
    purchase.status = toPantry ? "imported" : "history";
    purchase.updatedAt = this.now();
    this.save();
    logger.info("Purchase confirmed", { lines: purchase.lines.length, status: purchase.status });
    return purchase;
  }

  /** Forgets a purchase and the prices it recorded. What it put in the pantry stays — that's food now. */
  /**
   * Deleting a purchase forgets its prices. With `takeBack`, what it put in
   * the pantry comes out again — as much as it added, from the item it
   * went into, if that's still there — for a purchase entered by mistake
   * or to try things. Returns how many pantry items changed.
   */
  removePurchase(purchaseId: unknown, options: unknown = {}): number {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) return 0;
    let changed = 0;
    if (((options ?? {}) as Record<string, unknown>).takeBack === true)
      for (const stocked of purchase.lines.flatMap((line) => line.stocked)) {
        const item = this.state.pantry.find((entry) => entry.id === stocked.itemId);
        if (!item) continue;
        const left = subtract(item, stocked);
        if (!left) continue;
        changed += 1;
        if (left.quantity <= 1e-9) this.state.pantry = this.state.pantry.filter((entry) => entry !== item);
        else {
          if (item.unit === stocked.unit)
            item.startQuantity = Math.max(left.quantity, item.startQuantity - stocked.quantity);
          item.quantity = left.quantity;
          item.unit = left.unit;
          item.updatedAt = this.now();
        }
      }
    this.state.purchases = this.state.purchases.filter((entry) => entry !== purchase);
    this.state.prices = this.state.prices.filter((record) => record.purchaseId !== purchaseId);
    this.save();
    return changed;
  }

  /**
   * A note on a food of this week's list: not in the shop ("unavailable",
   * optionally which shop), skipped this week, or replaced by another food.
   * Clearing (kind null) removes the note. Notes are forgotten after a week.
   */
  markShopping(ingredientId: unknown, kind: unknown, extra: unknown = {}): void {
    if (typeof ingredientId !== "string" || !ingredientId) throw new Error("Which food?");
    this.state.shoppingMarks = this.state.shoppingMarks.filter((mark) => mark.ingredientId !== ingredientId);
    if (kind !== null && MARK_KINDS.includes(kind as ShoppingMarkKind)) {
      const e = (extra ?? {}) as Record<string, unknown>;
      const substitute =
        typeof e.substituteId === "string" && this.state.ingredients.some((i) => i.id === e.substituteId)
          ? e.substituteId
          : null;
      if (kind === "substitute" && !substitute) throw new Error("Substitute with what?");
      this.state.shoppingMarks.push({
        ingredientId,
        kind: kind as ShoppingMarkKind,
        substituteId: substitute,
        storeId: typeof e.storeId === "string" && e.storeId ? e.storeId : null,
        at: this.now(),
      });
    }
    this.save();
  }

  /** The week's notes on the shopping list, older ones dropped. */
  shoppingMarks(): ShoppingMark[] {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return this.state.shoppingMarks.filter((mark) => mark.at >= weekAgo);
  }

  // ---------- The planner ----------

  /** What the planner reads: the state, with every food at its current price. */
  private plannerInput(): PlannerInput {
    const today = this.today();
    const priced = new Map(
      this.state.ingredients.map((i) => [
        i.id,
        { ...i, lastPrice: currentPrice(this.state.prices, i, this.state.stores, today) },
      ])
    );
    return {
      family: this.family(),
      recipes: this.state.recipes,
      ingredients: this.state.ingredients,
      lookup: (id: string) => priced.get(id),
      pantry: this.state.pantry,
      leftovers: this.state.leftovers,
      plan: this.state.plan,
      preferences: this.state.preferences,
      today,
      id: () => randomUUID(),
      now: this.now(),
    };
  }

  getProposal(): PlanProposal | null {
    return this.state.proposal ? (JSON.parse(JSON.stringify(this.state.proposal)) as PlanProposal) : null;
  }

  /**
   * Proposes a plan for the days asked, from the Household defaults for
   * anything not given. Nothing in the plan changes until it's accepted.
   */
  generatePlan(options: unknown): PlanProposal {
    const o = (options ?? {}) as Record<string, unknown>;
    const prefs = this.state.preferences;
    const request: PlanRequest = {
      from: isoDay(o.from) ?? this.today(),
      days: Math.min(14, Math.max(1, Math.round(positive(o.days, 7)!))),
      slots: Array.isArray(o.slots)
        ? MEAL_SLOTS.filter((slot) => (o.slots as unknown[]).includes(slot))
        : [...prefs.slots],
      eating: positive(o.eating, servingsNeeded(prefs.eaters))!,
      budgetPerDay: o.budgetPerDay === undefined ? prefs.dailyBudget : positive(o.budgetPerDay),
      budgetTotal: positive(o.budgetTotal),
      objectives: Array.isArray(o.objectives)
        ? PLAN_OBJECTIVES.filter((objective) => (o.objectives as unknown[]).includes(objective))
        : [...prefs.objectives],
      allowRepeats: o.allowRepeats === true,
    };
    if (!request.slots.length) throw new Error("Choose at least one meal to plan.");
    if (!this.state.recipes.length) throw new Error("There are no recipes to plan from yet.");
    this.state.proposal = generatePlan(this.plannerInput(), request);
    this.save();
    logger.info("Plan proposed", { meals: this.state.proposal.meals.length, over: this.state.proposal.over });
    return this.getProposal()!;
  }

  /** Accepting: the proposed meals go into the plan, replacing the planner's own earlier ones in those days. */
  acceptProposal(): PlannedMeal[] {
    const proposal = this.state.proposal;
    if (!proposal) throw new Error("There's no proposed plan.");
    const days = dayRange(new Date(`${proposal.request.from}T12:00:00`), proposal.request.days);
    this.state.plan = this.state.plan.filter(
      (meal) => !(days.includes(meal.date) && meal.origin === "generator" && !meal.locked && !meal.cookedAt)
    );
    if (this.state.plan.length + proposal.meals.length > MAX_PLANNED_MEALS)
      throw new Error("The plan is full.");
    this.state.plan.push(...proposal.meals);
    this.state.proposal = null;
    this.save();
    return proposal.meals;
  }

  discardProposal(): void {
    this.state.proposal = null;
    this.save();
  }

  /** After a proposed meal changes, the proposal's figures follow it. */
  private refreshProposal(): void {
    const proposal = this.state.proposal;
    if (!proposal) return;
    Object.assign(proposal, proposalFigures(this.plannerInput(), proposal.request, proposal.meals));
  }

  /** A planned or proposed meal, and the list it lives in. */
  private findMeal(mealId: unknown): { meal: PlannedMeal; proposed: boolean } {
    const proposed = this.state.proposal?.meals.find((meal) => meal.id === mealId);
    if (proposed) return { meal: proposed, proposed: true };
    const planned = this.state.plan.find((meal) => meal.id === mealId);
    if (planned) return { meal: planned, proposed: false };
    throw new Error("That meal is gone.");
  }

  /** What a meal could become: the recipes for its slot, best first, with how the cost changes. */
  replaceOptionsFor(mealId: unknown): ReplaceOption[] {
    const { meal } = this.findMeal(mealId);
    return replaceOptions(
      this.plannerInput(),
      meal,
      this.state.proposal?.request.objectives ?? this.state.preferences.objectives
    );
  }

  /** What replacing a meal with a recipe (or a custom meal at a cost) would change. */
  effectOfReplacing(mealId: unknown, recipeId: unknown, cost: unknown = null) {
    const { meal, proposed } = this.findMeal(mealId);
    const days = new Set(
      proposed && this.state.proposal
        ? dayRange(new Date(`${this.state.proposal.request.from}T12:00:00`), this.state.proposal.request.days)
        : dayRange(new Date(`${this.today()}T12:00:00`), 7)
    );
    const meals = [
      ...this.state.plan.filter((m) => days.has(m.date)),
      ...(proposed ? (this.state.proposal?.meals ?? []) : []),
    ];
    return effectOfReplacing(
      this.plannerInput(),
      meals,
      meal,
      typeof recipeId === "string" && this.getRecipe(recipeId) ? recipeId : null,
      money(cost)
    );
  }

  /**
   * Replacing a meal: with a recipe, or with something that isn't one —
   * something you'll make, eating out, takeaway, at friends', or skipping
   * it. The result is "your pick", kept when the planner regenerates. A
   * meal you'll make can bring its ingredients to the shopping list and
   * be saved as a recipe.
   */
  replaceMeal(mealId: unknown, choice: unknown): PlannedMeal {
    const { meal } = this.findMeal(mealId);
    if (meal.cookedAt) throw new Error("That meal is already cooked.");
    this.dropLeftoversOf(meal.id);
    const c = (choice ?? {}) as Record<string, unknown>;
    const kind = PLANNED_MEAL_KINDS.includes(c.kind as PlannedMealKind)
      ? (c.kind as PlannedMealKind)
      : "recipe";
    if (kind === "recipe") {
      const recipe = this.getRecipe(c.recipeId);
      if (!recipe) throw new Error("Choose a recipe.");
      Object.assign(meal, { kind, recipeId: recipe.id, leftoverId: null, name: null, cost: null });
    } else if (kind === "leftover") {
      throw new Error("Leftovers are placed from the pantry or the cook dialog.");
    } else {
      const labels = MEAL_KIND_LABELS;
      Object.assign(meal, {
        kind,
        recipeId: null,
        leftoverId: null,
        name: text(c.name, 200) ?? labels[kind] ?? "Something I'll make",
        cost: kind === "skip" ? 0 : money(c.cost),
      });
      if (kind === "custom" && typeof c.ingredients === "string" && c.ingredients.trim()) {
        const lines = c.ingredients
          .split(/[,;\n]/)
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, MAX_RECIPE_INGREDIENTS);
        if (c.addMissing === true)
          for (const line of lines) {
            if (this.state.shopping.length >= MAX_SHOPPING_ITEMS) break;
            const parsed = parseAmountText(line);
            const name = parsed ? line.replace(/^[\d.,½¼¾\s]+[a-zA-Z]*\s+/, "").trim() || line : line;
            const food = this.findIngredient(name);
            if (food && this.state.pantry.some((item) => item.ingredientId === food.id)) continue;
            this.state.shopping.push({
              id: randomUUID(),
              name: food?.name ?? name,
              ingredientId: food?.id ?? null,
              quantity: parsed?.quantity ?? null,
              unit: parsed?.unit ?? null,
              note: `for ${meal.name}`,
              addedAt: this.now(),
            });
          }
        if (c.saveAsRecipe === true) {
          const recipe = this.saveRecipe({
            name: meal.name,
            servings: meal.servings,
            slots: [meal.slot],
            ingredients: lines.map((line) => {
              const parsed = parseAmountText(line);
              const name = parsed ? line.replace(/^[\d.,½¼¾\s]+[a-zA-Z]*\s+/, "").trim() || line : line;
              return { name, quantity: parsed?.quantity ?? 1, unit: parsed?.unit ?? "piece" };
            }),
          });
          Object.assign(meal, { kind: "recipe", recipeId: recipe.id, name: null, cost: meal.cost });
        }
      }
    }
    Object.assign(meal, { origin: "user", reasons: [], swapSaving: null, updatedAt: this.now() });
    this.refreshProposal();
    this.save();
    return meal;
  }

  /** "Lock": the planner leaves this meal as it is. */
  lockMeal(mealId: unknown, locked: unknown): PlannedMeal {
    const { meal } = this.findMeal(mealId);
    meal.locked = locked === true;
    meal.updatedAt = this.now();
    this.refreshProposal();
    this.save();
    return meal;
  }

  /** "Regenerate this slot": the next-best recipe for it, with its reasons. */
  regenerateSlot(mealId: unknown): PlannedMeal {
    const { meal } = this.findMeal(mealId);
    if (meal.cookedAt) throw new Error("That meal is already cooked.");
    const options = this.replaceOptionsFor(meal.id).filter((option) => !option.note);
    const next = options[0];
    if (!next) throw new Error("No other recipe fits this meal.");
    Object.assign(meal, {
      kind: "recipe",
      recipeId: next.recipeId,
      leftoverId: null,
      name: null,
      cost: null,
      origin: "generator",
      swapSaving: null,
      reasons: [
        next.delta === null
          ? "The next best fit"
          : `The next best fit (${next.delta >= 0 ? "+" : "−"}${Math.abs(next.delta).toFixed(2).replace(".", ",")} €)`,
        next.coverage.total
          ? `${next.coverage.have} of ${next.coverage.total} ingredients already at home`
          : null,
      ].filter((reason): reason is string => Boolean(reason)),
      updatedAt: this.now(),
    });
    this.refreshProposal();
    this.save();
    return meal;
  }

  /**
   * Before a recipe changes: its planned meals still to come can keep the
   * version they were planned with — snapshotted as a meal of their own,
   * with the name and cost it had — instead of following the edit.
   */
  keepPlannedVersion(recipeId: unknown): number {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const today = this.today();
    const input = this.plannerInput();
    let kept = 0;
    for (const meal of this.state.plan) {
      if (meal.recipeId !== recipe.id || meal.cookedAt || meal.date < today) continue;
      const cost = recipeCost(recipe, cookServingsOf(meal, recipe), input.lookup).value;
      Object.assign(meal, {
        kind: "custom",
        recipeId: null,
        name: `${recipe.name} (as planned)`,
        cost,
        updatedAt: this.now(),
      });
      kept += 1;
    }
    if (kept) this.save();
    return kept;
  }

  // ---------- Demo data ----------

  /** True when the demo kitchen is loaded — the button says "Remove" instead. */
  hasDemoData(): boolean {
    return this.state.demoIds.length > 0;
  }

  /**
   * Plants a kitchen to try the tab with. Everything it adds is recorded
   * by id, so removing it later takes out exactly these entries.
   */
  loadDemoData(): void {
    if (this.hasDemoData()) throw new Error("The demo data is already loaded.");
    const demo = buildDemoData(new Date(), () => randomUUID());
    this.state.ingredients.push(...demo.ingredients);
    this.state.recipes.push(...demo.recipes);
    this.state.pantry.push(...demo.pantry);
    this.state.leftovers.push(...demo.leftovers);
    this.state.plan.push(...demo.plan);
    // A shop you already have by that name is used instead of a second one.
    const storeIds = new Map<string, string>();
    for (const store of demo.stores) {
      const existing = this.state.stores.find((s) => ingredientKey(s.name) === ingredientKey(store.name));
      if (existing) storeIds.set(store.id, existing.id);
      else this.state.stores.push(store);
    }
    const shopOf = (id: string | null) => (id ? (storeIds.get(id) ?? id) : null);
    this.state.purchases.push(...demo.purchases.map((p) => ({ ...p, storeId: shopOf(p.storeId) })));
    this.state.prices.push(...demo.prices.map((p) => ({ ...p, storeId: shopOf(p.storeId) })));
    this.state.demoIds = [
      ...demo.stores.filter((store) => !storeIds.has(store.id)).map((store) => store.id),
      ...demo.purchases.map((entry) => entry.id),
      ...demo.ingredients.map((entry) => entry.id),
      ...demo.recipes.map((entry) => entry.id),
      ...demo.pantry.map((entry) => entry.id),
      ...demo.leftovers.map((entry) => entry.id),
      ...demo.plan.map((entry) => entry.id),
    ];
    this.save();
    logger.info("Meals demo data loaded", { entries: this.state.demoIds.length });
  }

  /**
   * Takes the demo kitchen back out. Only ids it planted are removed —
   * anything you added yourself stays, including stock of a demo
   * ingredient, which keeps its own ingredient so the entry still reads.
   */
  removeDemoData(): void {
    const ids = new Set(this.state.demoIds);
    if (!ids.size) return;
    this.state.plan = this.state.plan.filter((meal) => !ids.has(meal.id));
    this.state.leftovers = this.state.leftovers.filter((entry) => !ids.has(entry.id));
    this.state.pantry = this.state.pantry.filter((item) => !ids.has(item.id));
    this.state.purchases = this.state.purchases.filter((purchase) => !ids.has(purchase.id));
    // Demo prices: those of demo purchases, and the typed demo price (a demo food at a demo shop).
    this.state.prices = this.state.prices.filter(
      (record) =>
        !(record.purchaseId && ids.has(record.purchaseId)) &&
        !(
          record.purchaseId === null &&
          ids.has(record.ingredientId) &&
          record.storeId &&
          ids.has(record.storeId)
        )
    );
    const shopsInUse = new Set([
      ...this.state.purchases.map((p) => p.storeId),
      ...this.state.prices.map((p) => p.storeId),
    ]);
    this.state.stores = this.state.stores.filter((store) => !ids.has(store.id) || shopsInUse.has(store.id));
    // Meals you planned yourself from a demo recipe stay, named, unlinked.
    this.unlinkRecipes(ids);
    // An ingredient the demo created is only removed once nothing points
    // at it — a recipe you wrote using demo chicken keeps its chicken.
    const used = new Set<string>();
    for (const recipe of this.state.recipes)
      for (const line of recipe.ingredients) used.add(line.ingredientId);
    for (const item of this.state.pantry) used.add(item.ingredientId);
    for (const item of this.state.shopping) if (item.ingredientId) used.add(item.ingredientId);
    this.state.ingredients = this.state.ingredients.filter(
      (ingredient) => !ids.has(ingredient.id) || used.has(ingredient.id)
    );
    this.state.demoIds = [];
    this.save();
    logger.info("Meals demo data removed", { remaining: this.state.ingredients.length });
  }

  // ---------- Preferences ----------

  getPreferences(): MealPreferences {
    return JSON.parse(JSON.stringify(this.state.preferences)) as MealPreferences;
  }

  updatePreferences(changes: unknown): MealPreferences {
    const c = (changes ?? {}) as Record<string, unknown>;
    const current = this.state.preferences;
    if (c.eaters !== undefined && Array.isArray(c.eaters)) {
      current.eaters = c.eaters
        .map((raw) => {
          const e = (raw ?? {}) as Record<string, unknown>;
          const name = text(e.name, 60);
          if (!name) return null;
          return {
            id: typeof e.id === "string" && e.id ? e.id : randomUUID(),
            name,
            portionFactor: Math.min(5, positive(e.portionFactor, 1)!),
            notes: text(e.notes, 200),
          };
        })
        .filter((e): e is Eater => e !== null)
        .slice(0, MAX_EATERS);
    }
    if (c.restrictions !== undefined) current.restrictions = list(c.restrictions, 40, 60);
    if (c.dislikes !== undefined) current.dislikes = list(c.dislikes, 60, 60);
    if (c.slots !== undefined && Array.isArray(c.slots)) {
      const slots = c.slots.filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot));
      if (slots.length) current.slots = [...new Set(slots)];
    }
    if (c.dailyBudget !== undefined) current.dailyBudget = positive(c.dailyBudget);
    if (c.dailyKcal !== undefined) current.dailyKcal = positive(c.dailyKcal);
    if (c.dailyProtein !== undefined) current.dailyProtein = positive(c.dailyProtein);
    if (c.dailyCarbs !== undefined) current.dailyCarbs = positive(c.dailyCarbs);
    if (c.dailyFibre !== undefined) current.dailyFibre = positive(c.dailyFibre);
    if (c.monthlyBudget !== undefined) current.monthlyBudget = positive(c.monthlyBudget);
    // The Household panel's planning defaults — each checked like the file is on load.
    const parsed = parsePreferences({ ...current, ...c });
    if (c.overBudget !== undefined) current.overBudget = parsed.overBudget;
    if (c.cookingTime !== undefined) current.cookingTime = parsed.cookingTime;
    if (c.difficulty !== undefined) current.difficulty = parsed.difficulty;
    if (c.objectives !== undefined) current.objectives = parsed.objectives;
    if (c.autoLeftovers !== undefined) current.autoLeftovers = parsed.autoLeftovers;
    if (c.maxRepeats !== undefined) current.maxRepeats = parsed.maxRepeats;
    this.save();
    return this.getPreferences();
  }

  /** Today, as the rest of the app writes it. */
  today(): string {
    return isoDate(new Date());
  }
}
