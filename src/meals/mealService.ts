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
 *
 * The class is built in layers, each in its own file under service/ and
 * each only using the ones below it:
 *
 *  - `MealsCore` (service/core.ts): the state and saving; ingredients,
 *    recipes, the pantry, leftovers and preferences;
 *  - `MealsPlanning` (service/planning.ts): the plan and cooking;
 *  - `MealsShopping` (service/shopping.ts): the shopping list, purchases
 *    and prices;
 *  - `MealService` (here): the planner and the demo data.
 *
 * Reading meals.json is in parse.ts.
 */

import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { buildDemoData } from "./demoData";
import { recipeCost } from "./recipes";
import { effectOfReplacing, generatePlan, proposalFigures, replaceOptions } from "./generator";
import type { PlannerInput, ReplaceOption } from "./generator";
import { currentPrice } from "./purchases";
import {
  MAX_PLANNED_MEALS,
  MAX_RECIPE_INGREDIENTS,
  MAX_SHOPPING_ITEMS,
  MEAL_SLOTS,
  PlannedMeal,
  PlannedMealKind,
  PLAN_OBJECTIVES,
  MEAL_KIND_LABELS,
  PLANNED_MEAL_KINDS,
  PlanProposal,
  PlanRequest,
} from "./types";
import { ingredientKey } from "./names";
import { cookServingsOf, dayRange, servingsNeeded } from "./plan";
import { parseAmountText } from "./recipeImport";
import { text, positive, isoDay, money } from "./parse";
import { MealsShopping } from "./service/shopping";

export { ingredientKey } from "./names";
export {
  parseIngredient,
  parseLeftover,
  parseManualShoppingItem,
  parsePantryItem,
  parsePlannedMeal,
  parsePreferences,
  parseRecipe,
  parseState,
} from "./parse";
export type { CookInput, CookPreview, CookResult } from "./service/planning";

/**
 * Meals, over a store. Every mutating method saves; readers return copies
 * so a caller can't edit the state by accident.
 */
export class MealService extends MealsShopping {
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
}
