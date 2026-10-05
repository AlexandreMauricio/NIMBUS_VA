/**
 * The base of the Meals service: its state and saving, and the parts
 * everything else stands on — ingredients, recipes, the pantry, leftovers
 * and the household's preferences. See mealService.ts for the whole.
 */

import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { familyOf, isoDate, mergeInto, suggestEatBy } from "../pantry";
import type { Family } from "../pantry";
import {
  CORRECTION_REASONS,
  CorrectionReason,
  Eater,
  Ingredient,
  Leftover,
  MAX_EATERS,
  MAX_INGREDIENTS,
  MAX_LEFTOVERS,
  MAX_PANTRY_ITEMS,
  MAX_RECIPES,
  MAX_RECIPE_INGREDIENTS,
  MAX_RECIPE_STEPS,
  MEAL_SLOTS,
  MealPreferences,
  MealSlot,
  MealsState,
  MealsStore,
  PantryItem,
  Recipe,
  MAX_COMPONENTS,
  RECIPE_DIFFICULTIES,
  RecipeDifficulty,
  RecipeComponent,
  RecipeIngredient,
  RecipeStep,
  isRecipePhotoUrl,
  STORAGE_PLACES,
  StoragePlace,
} from "../types";
import { matchIngredient } from "../names";
import { baseUnit, normaliseUnit } from "../units";
import {
  text,
  positive,
  isoDay,
  list,
  parseNutrition,
  parseStep,
  parsePreferences,
  parseState,
  parsePieceSize,
} from "../parse";

export class MealsCore {
  protected state: MealsState;
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

  protected save(): void {
    this.store.save(this.state);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A meals listener threw", { error: String(err) });
      }
    }
  }

  protected now(): string {
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
      priceUnit: null,
      pieceSize: null,
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
    if (c.priceUnit !== undefined)
      ingredient.priceUnit =
        c.priceUnit === "g" || c.priceUnit === "ml" || c.priceUnit === "piece" ? c.priceUnit : null;
    // A typed price is in the food's own unit unless said otherwise.
    else if (c.lastPrice !== undefined) ingredient.priceUnit = baseUnit(ingredient.unit);
    if (c.pieceSize !== undefined) ingredient.pieceSize = parsePieceSize(c.pieceSize);
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
  protected setCountsAs(ingredient: Ingredient, value: unknown): void {
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
  protected choices(raw: unknown): Map<string, string> {
    const picks = new Map<string, string>();
    if (!raw || typeof raw !== "object") return picks;
    const known = new Set(this.state.ingredients.map((i) => i.id));
    for (const [line, food] of Object.entries(raw as Record<string, unknown>))
      if (known.has(line) && typeof food === "string" && known.has(food)) picks.set(line, food);
    return picks;
  }

  /** Food families as the pantry functions take them. */
  protected family(): Family {
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
  protected unlinkRecipes(ids: Set<string>): void {
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
