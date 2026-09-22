import { test } from "node:test";
import assert from "node:assert/strict";
import { add, formatAmount, normaliseUnit, scaleAmount, subtract, toBase } from "./units";
import {
  coverRecipe,
  coverageCount,
  expiryState,
  planDeductions,
  suggestEatBy,
  summariseStock,
} from "./pantry";
import { pricePerBaseUnit, recipeCost, recipeNutrition, perServing, startCookingAt } from "./recipes";
import { dayRange, mealsOn, nextMeal, planCost, servingsNeeded } from "./plan";
import { MealService, ingredientKey, parseState } from "./mealService";
import type { Ingredient, MealsState, MealsStore, PantryItem, Recipe } from "./types";

test("units: aliases, base amounts, and weight is never turned into volume", () => {
  assert.equal(normaliseUnit(" Kilos "), "kg");
  assert.equal(normaliseUnit("colher"), null);
  assert.deepEqual(toBase({ quantity: 1.5, unit: "kg" }), { quantity: 1500, unit: "g" });
  assert.deepEqual(toBase({ quantity: 2, unit: "tbsp" }), { quantity: 30, unit: "ml" });
  // 100 ml of oil is not 100 g of oil: the two never mix.
  assert.equal(subtract({ quantity: 1, unit: "kg" }, { quantity: 100, unit: "ml" }), null);
  assert.deepEqual(subtract({ quantity: 1, unit: "kg" }, { quantity: 400, unit: "g" }), {
    quantity: 0.6,
    unit: "kg",
  });
  assert.deepEqual(add({ quantity: 250, unit: "g" }, { quantity: 1, unit: "kg" }), {
    quantity: 1250,
    unit: "g",
  });
  // Taking more than there is leaves nothing, never a negative pantry.
  assert.deepEqual(subtract({ quantity: 100, unit: "g" }, { quantity: 1, unit: "kg" }), {
    quantity: 0,
    unit: "g",
  });
});

test("units: amounts read the way a person writes them, and pieces scale to whole things", () => {
  assert.equal(formatAmount({ quantity: 1500, unit: "g" }), "1.5 kg");
  assert.equal(formatAmount({ quantity: 0.5, unit: "kg" }), "500 g");
  assert.equal(formatAmount({ quantity: 2, unit: "piece" }), "2");
  assert.equal(formatAmount({ quantity: 1, unit: "pack" }), "1 pack");
  // 3 eggs for 2 people, cooked for 3, is 5 eggs — not 4.5.
  assert.deepEqual(scaleAmount({ quantity: 3, unit: "piece" }, 2, 3), { quantity: 5, unit: "piece" });
  assert.deepEqual(scaleAmount({ quantity: 300, unit: "g" }, 2, 3), { quantity: 450, unit: "g" });
});

const day = (iso: string) => new Date(`${iso}T12:00:00`);

test("pantry: expiry states, and the summary puts what expires first at the top", () => {
  const today = day("2026-09-22");
  assert.equal(expiryState("2026-09-21", today), "expired");
  assert.equal(expiryState("2026-09-23", today), "urgent");
  assert.equal(expiryState("2026-09-27", today), "soon");
  assert.equal(expiryState("2026-12-01", today), "later");
  assert.equal(expiryState(null, today), "none");

  const item = (over: Partial<PantryItem>): PantryItem => ({
    id: over.id ?? "i1",
    ingredientId: over.ingredientId ?? "chicken",
    name: over.name ?? "Chicken thighs",
    quantity: over.quantity ?? 1,
    unit: over.unit ?? "kg",
    place: over.place ?? "fridge",
    confidence: over.confidence ?? "confirmed",
    packaging: null,
    openedAt: null,
    expiresAt: over.expiresAt ?? null,
    addedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const summary = summariseStock(
    [
      item({ id: "a", expiresAt: "2026-12-01" }),
      item({
        id: "b",
        ingredientId: "spinach",
        name: "Baby spinach",
        quantity: 200,
        unit: "g",
        expiresAt: "2026-09-23",
        confidence: "estimated",
      }),
      item({ id: "c", quantity: 500, unit: "g", expiresAt: "2026-09-26" }),
    ],
    today
  );
  assert.deepEqual(
    summary.map((s) => [s.name, s.expiry, s.confidence]),
    [
      ["Baby spinach", "urgent", "estimated"],
      ["Chicken thighs", "soon", "confirmed"],
    ]
  );
  // 1 kg and 500 g of the same food is one total of 1500 g.
  assert.deepEqual(summary[1].totals, [{ unit: "g", quantity: 1500 }]);
});

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: "r1",
  name: "Lemon chicken traybake",
  description: null,
  slots: ["dinner"],
  servings: 3,
  prepMinutes: 15,
  cookMinutes: 40,
  ingredients: over.ingredients ?? [
    { ingredientId: "chicken", text: "chicken thighs", quantity: 600, unit: "g", optional: false },
    { ingredientId: "lemon", text: "lemons", quantity: 2, unit: "piece", optional: false },
    { ingredientId: "parsley", text: "parsley", quantity: 1, unit: "bunch", optional: true },
  ],
  steps: [],
  tags: [],
  source: null,
  notes: null,
  favourite: false,
  lastCookedAt: null,
  timesCooked: 0,
  addedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const pantryItem = (
  id: string,
  ingredientId: string,
  quantity: number,
  unit: string,
  expiresAt: string | null = null
): PantryItem => ({
  id,
  ingredientId,
  name: ingredientId,
  quantity,
  unit,
  place: "fridge",
  confidence: "confirmed",
  packaging: null,
  openedAt: null,
  expiresAt,
  addedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

test("pantry: a recipe against the pantry says what's there, what's short and what can't be compared", () => {
  const r = recipe();
  const pantry = [pantryItem("p1", "chicken", 1, "kg"), pantryItem("p2", "lemon", 1, "piece")];
  const coverage = coverRecipe(r.ingredients, pantry, (line) => scaleAmount(line, r.servings, r.servings));
  assert.deepEqual(
    coverage.map((c) => [c.ingredient.text, c.status]),
    [
      ["chicken thighs", "have"],
      ["lemons", "partial"],
      // A bunch of parsley against nothing in the pantry: no stock to compare.
      ["parsley", "missing"],
    ]
  );
  assert.deepEqual(coverage[1].short, { quantity: 1, unit: "piece" });
  // The optional parsley never counts against the "at home" figure.
  assert.deepEqual(coverageCount(coverage), { have: 1, total: 2 });
});

test("pantry: cooking uses the package that expires first, and reports what it couldn't cover", () => {
  const r = recipe();
  const pantry = [
    pantryItem("keeps", "chicken", 1, "kg", "2026-12-01"),
    pantryItem("urgent", "chicken", 400, "g", "2026-09-23"),
  ];
  const plan = planDeductions(r.ingredients, pantry, (line) => scaleAmount(line, r.servings, r.servings));
  assert.deepEqual(
    plan.deductions.map((d) => [d.itemId, d.use.quantity, d.empties]),
    [
      // The 400 g going off tomorrow goes first, then the rest of the 1 kg pack.
      ["urgent", 400, true],
      ["keeps", 200, false],
    ]
  );
  assert.deepEqual(
    plan.short.map((s) => [s.ingredient.text, s.reason]),
    [["lemons", "short"]]
  );
});

test("pantry: cooked food keeps three days in the fridge and three months in the freezer", () => {
  assert.equal(suggestEatBy(day("2026-09-22"), "fridge"), "2026-09-25");
  assert.equal(suggestEatBy(day("2026-09-22"), "freezer"), "2026-12-21");
});

const ingredient = (id: string, over: Partial<Ingredient> = {}): Ingredient => ({
  id,
  name: id,
  aliases: [],
  unit: "g",
  category: null,
  nutrition: null,
  nutritionSource: null,
  lastPrice: null,
  fridgeDays: null,
  addedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

test("recipes: cost and nutrition are estimates that say how many lines they used", () => {
  const r = recipe();
  const ingredients = new Map([
    [
      "chicken",
      ingredient("chicken", { lastPrice: 0.0055, nutrition: { kcal: 209, protein: 26, carbs: 0, fat: 11 } }),
    ],
    ["lemon", ingredient("lemon", { unit: "piece", lastPrice: 0.4 })],
  ]);
  const lookup = (id: string) => ingredients.get(id);
  const cost = recipeCost(r, 3, lookup);
  // 600 g at 0.55 €/100 g plus two lemons at 0.40 €.
  assert.deepEqual([cost.value, cost.from, cost.total], [4.1, 2, 2]);

  const nutrition = recipeNutrition(r, 3, lookup);
  assert.deepEqual([nutrition.kcal, nutrition.protein, nutrition.from, nutrition.total], [1254, 156, 1, 2]);
  // Lemons are counted in pieces, so they can't be turned into calories.
  assert.deepEqual(nutrition.missing, ["lemons"]);
  assert.equal(perServing(nutrition, 3).kcal, 418);

  assert.equal(pricePerBaseUnit(4.99, { quantity: 1, unit: "kg" }), 0.00499);
  assert.equal(pricePerBaseUnit(4.99, { quantity: 0, unit: "kg" }), null);
});

test("recipes: when to start cooking, and nothing when the recipe doesn't say how long it takes", () => {
  const start = startCookingAt(recipe(), new Date("2026-09-22T19:30:00"));
  assert.equal(start?.toTimeString().slice(0, 5), "18:35");
  assert.equal(startCookingAt(recipe({ prepMinutes: null, cookMinutes: null }), new Date()), null);
});

test("plan: servings for the household round up, and days read in slot order", () => {
  assert.equal(servingsNeeded([]), 1);
  assert.equal(
    servingsNeeded([
      { id: "a", name: "Adult 1", portionFactor: 1, notes: null },
      { id: "b", name: "Adult 2", portionFactor: 1.2, notes: null },
      { id: "c", name: "Child", portionFactor: 0.6, notes: null },
    ]),
    3
  );
  assert.deepEqual(dayRange(day("2026-09-22"), 3), ["2026-09-22", "2026-09-23", "2026-09-24"]);
});

function service(): { service: MealService; saved: () => MealsState } {
  let state: MealsState | null = null;
  const store: MealsStore = {
    load: () => state,
    save: (next) => {
      state = JSON.parse(JSON.stringify(next)) as MealsState;
    },
  };
  return { service: new MealService(store), saved: () => state! };
}

test("the service: one ingredient per food, however the name is written", () => {
  const { service: meals } = service();
  const first = meals.ensureIngredient("Chicken thighs", "g");
  assert.equal(meals.ensureIngredient("chicken thigh").id, first.id);
  assert.equal(meals.ensureIngredient("CHICKEN THIGHS ").id, first.id);
  assert.notEqual(meals.ensureIngredient("Chicken breast").id, first.id);
  assert.equal(ingredientKey("Tomates"), "tomate");
});

test("the service: cooking deducts stock as an estimate, makes leftovers and marks the meal cooked", () => {
  const { service: meals } = service();
  const chicken = meals.ensureIngredient("Chicken thighs", "g");
  meals.addStock({ ingredientId: chicken.id, quantity: 1, unit: "kg", place: "fridge" });
  const saved = meals.saveRecipe({
    name: "Lemon chicken",
    servings: 2,
    slots: ["dinner"],
    ingredients: [{ name: "Chicken thighs", quantity: 400, unit: "g" }],
    steps: ["Roast it."],
  });
  const meal = meals.planMeal({
    date: "2026-09-22",
    slot: "dinner",
    kind: "recipe",
    recipeId: saved.id,
    servings: 3,
  });

  const result = meals.cook({ mealId: meal.id, recipeId: saved.id, cookServings: 5, eatServings: 3 });
  assert.deepEqual(result.short, []);
  // 5 servings of a 2-serving recipe is 1 kg of chicken: the pack is emptied.
  assert.equal(meals.listPantry().length, 0);
  assert.equal(result.leftover?.portions, 2);
  assert.equal(meals.listPlan()[0].cookedAt !== null, true);
  assert.equal(meals.getRecipe(saved.id)?.timesCooked, 1);
});

test("the service: what cooking couldn't cover is reported, and what it used is only an estimate", () => {
  const { service: meals } = service();
  const rice = meals.ensureIngredient("Rice", "g");
  meals.addStock({ ingredientId: rice.id, quantity: 200, unit: "g" });
  const saved = meals.saveRecipe({
    name: "Rice and beans",
    servings: 2,
    ingredients: [
      { name: "Rice", quantity: 300, unit: "g" },
      { name: "Beans", quantity: 1, unit: "tin" },
    ],
  });
  const result = meals.cook({ recipeId: saved.id, cookServings: 2, eatServings: 2 });
  assert.deepEqual(
    result.short.map((s) => [s.name, s.reason]),
    [
      ["Rice", "short"],
      ["Beans", "short"],
    ]
  );
  assert.equal(meals.listPantry().length, 0);

  // Stock NIMBUS worked out is an estimate until the user says otherwise.
  meals.addStock({ name: "Rice", quantity: 1, unit: "kg" });
  meals.cook({ recipeId: saved.id, cookServings: 2, eatServings: 2 });
  assert.equal(meals.listPantry()[0].confidence, "estimated");
  const corrected = meals.correctStock(meals.listPantry()[0].id, 650);
  assert.deepEqual([corrected?.quantity, corrected?.confidence], [650, "confirmed"]);
  assert.equal(meals.correctStock(corrected!.id, 0), null);
  assert.equal(meals.listPantry().length, 0);
});

test("the service: adding the same thing twice merges it, and an estimate keeps the total honest", () => {
  const { service: meals } = service();
  meals.addStock({ name: "Rice", quantity: 500, unit: "g", place: "cupboard" });
  meals.addStock({ name: "Rice", quantity: 1, unit: "kg", place: "cupboard" });
  assert.equal(meals.listPantry().length, 1);
  assert.deepEqual([meals.listPantry()[0].quantity, meals.listPantry()[0].unit], [1500, "g"]);
  meals.addStock({ name: "Rice", quantity: 200, unit: "g", place: "cupboard", confidence: "estimated" });
  assert.equal(meals.listPantry()[0].confidence, "estimated");
  // A different place is a different line — it's somewhere else in the kitchen.
  meals.addStock({ name: "Rice", quantity: 500, unit: "g", place: "freezer" });
  assert.equal(meals.listPantry().length, 2);
});

test("the service: leftovers are eaten by the portion and disappear when finished", () => {
  const { service: meals } = service();
  const leftover = meals.addLeftover({ name: "Chilli con carne", portions: 6, place: "fridge" });
  assert.equal(leftover.eatBy !== null, true);
  const meal = meals.planMeal({
    date: "2026-09-22",
    slot: "lunch",
    kind: "leftover",
    leftoverId: leftover.id,
    servings: 2,
  });
  assert.equal(meals.eatLeftover(meal.id, leftover.id, 4)?.portions, 2);
  assert.equal(meals.eatLeftover(meal.id, leftover.id, 5), null);
  assert.equal(meals.listLeftovers().length, 0);
});

test("the plan: today's meals, the next one due, and what a stretch costs against the budget", () => {
  const { service: meals } = service();
  meals.ensureIngredient("Chicken thighs", "g");
  meals.updateIngredient(meals.findIngredient("Chicken thighs")!.id, { lastPrice: 0.006 });
  const saved = meals.saveRecipe({
    name: "Traybake",
    servings: 2,
    ingredients: [{ name: "Chicken thighs", quantity: 500, unit: "g" }],
  });
  meals.planMeal({
    date: "2026-09-22",
    slot: "dinner",
    kind: "recipe",
    recipeId: saved.id,
    servings: 2,
    time: "19:30",
  });
  meals.planMeal({
    date: "2026-09-22",
    slot: "lunch",
    kind: "out",
    name: "Canteen",
    servings: 1,
    cost: 6.5,
    time: "13:00",
  });

  const plan = meals.listPlan();
  assert.deepEqual(
    mealsOn(plan, "2026-09-22").map((m) => m.slot),
    ["lunch", "dinner"]
  );
  assert.equal(nextMeal(plan, new Date("2026-09-22T14:00:00"))?.slot, "dinner");

  const recipes = new Map(meals.listRecipes().map((r) => [r.id, r]));
  const ingredients = new Map(meals.listIngredients().map((i) => [i.id, i]));
  const cost = planCost(plan, recipes, (id) => ingredients.get(id), {
    ...meals.getPreferences(),
    dailyBudget: 8,
  });
  // 6.50 € typed for the canteen, 3.00 € estimated for the traybake.
  assert.deepEqual(
    [cost.value, cost.known, cost.estimated, cost.budget, cost.overBudget],
    [9.5, 1, 1, 8, true]
  );
});

test("the service: a broken file loses only the broken entries", () => {
  const state = parseState({
    version: 1,
    ingredients: [{ id: "i1", name: "Rice", unit: "g" }, { name: "no id" }],
    recipes: [
      {
        id: "r1",
        name: "Rice",
        servings: 2,
        ingredients: [{ ingredientId: "i1", quantity: 100, unit: "g" }],
      },
      7,
    ],
    pantry: [{ id: "p1", ingredientId: "i1", name: "Rice", quantity: 500, unit: "g" }, { id: "p2" }],
    plan: [{ id: "m1", date: "not a date", slot: "dinner", kind: "recipe" }],
    preferences: { dailyBudget: 9, slots: ["dinner", "nonsense"] },
  });
  assert.deepEqual(
    [state.ingredients.length, state.recipes.length, state.pantry.length, state.plan.length],
    [1, 1, 1, 0]
  );
  assert.deepEqual([state.preferences.dailyBudget, state.preferences.slots], [9, ["dinner"]]);
});
