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
import { isoDate, mergeInto, planDeductions, suggestEatBy } from "./pantry";
import { pricePerBaseUnit, scaleFor } from "./recipes";
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
  RecipeComponent,
  RecipeIngredient,
  RecipeStep,
  isRecipePhotoUrl,
  STORAGE_PLACES,
  StoragePlace,
} from "./types";
import { matchIngredient } from "./names";
import { servingsNeeded } from "./plan";
import { normaliseUnit, toBase } from "./units";

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

const MEAL_KINDS: PlannedMealKind[] = ["recipe", "leftover", "custom", "out"];

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
}

/** What cooking would take out of the pantry, package by package — shown before anything moves. */
export interface CookPreview {
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
    ingredient.updatedAt = this.now();
    this.save();
    return ingredient;
  }

  /** Only an ingredient nothing points at can go — otherwise recipes would lose their lines. */
  removeIngredient(id: unknown): void {
    const used =
      this.state.recipes.some((recipe) => recipe.ingredients.some((line) => line.ingredientId === id)) ||
      this.state.pantry.some((item) => item.ingredientId === id);
    if (used) throw new Error("That ingredient is used by a recipe or is in the pantry.");
    this.state.ingredients = this.state.ingredients.filter((i) => i.id !== id);
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
    if (kind === "leftover" && !this.state.leftovers.some((l) => l.id === leftoverId))
      throw new Error("Choose which leftovers.");
    const existing = id ? this.state.plan.find((meal) => meal.id === id) : undefined;
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
      addedAt: existing?.addedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.state.plan = existing
      ? this.state.plan.map((entry) => (entry.id === meal.id ? meal : entry))
      : [...this.state.plan, meal];
    this.save();
    return meal;
  }

  removePlannedMeal(id: unknown): void {
    this.state.plan = this.state.plan.filter((meal) => meal.id !== id);
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
  previewCook(recipeId: unknown, servings: unknown): CookPreview {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const plan = planDeductions(
      recipe.ingredients,
      this.state.pantry,
      scaleFor(recipe, positive(servings, recipe.servings)!)
    );
    return {
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
      const plan = planDeductions(recipe.ingredients, this.state.pantry, scaleFor(recipe, cookServings));
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
      const target = r.scheduleLeftoverFor;
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
      scaleFor(recipe, positive(servings, recipe.servings)!)
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
      if (price !== null) this.updateIngredient(item.ingredientId, { lastPrice: price });
    }
    if (typeof r.itemId === "string" && r.itemId) this.removeShoppingItem(r.itemId);
    else this.save();
    return item;
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
    this.state.demoIds = [
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
    this.save();
    return this.getPreferences();
  }

  /** Today, as the rest of the app writes it. */
  today(): string {
    return isoDate(new Date());
  }
}
