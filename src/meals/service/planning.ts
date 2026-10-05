/**
 * The plan and cooking, over MealsCore: planned meals and the leftovers
 * they're expected to leave, and the one operation that changes several
 * things at once — cooking. See mealService.ts for the whole.
 */

import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { familyChoices, isoDate, planDeductions, wholeBagServings } from "../pantry";
import { scaleFor } from "../recipes";
import {
  Leftover,
  MAX_PLANNED_MEALS,
  MEAL_SLOTS,
  MealSlot,
  PantryItem,
  PlannedMeal,
  PlannedMealKind,
  STORAGE_PLACES,
  StoragePlace,
} from "../types";
import { cookServingsOf, freeMealsAfter, servingsNeeded, spreadLeftovers } from "../plan";
import { toBase } from "../units";
import { text, positive, isoTime, isoDay, inUnitOf, MEAL_KINDS } from "../parse";
import { MealsCore } from "./core";

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

export class MealsPlanning extends MealsCore {
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
  protected dropLeftoversOf(mealId: string): void {
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
}
