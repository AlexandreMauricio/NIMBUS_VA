import { test } from "node:test";
import assert from "node:assert/strict";
import { add, formatAmount, normaliseUnit, practicalAmount, scaleAmount, subtract, toBase } from "./units";
import {
  coverRecipe,
  coverageCount,
  expiryState,
  familyChoices,
  familyOf,
  planDeductions,
  suggestEatBy,
  summariseStock,
} from "./pantry";
import { pricePerBaseUnit, recipeCost, recipeNutrition, perServing, startCookingAt } from "./recipes";
import {
  cookServingsOf,
  dayRange,
  freeMealsAfter,
  leftoverCoverage,
  mealBadge,
  mealName,
  mealsOn,
  nextMeal,
  planCost,
  servingsNeeded,
  spreadLeftovers,
} from "./plan";
import { MealService, ingredientKey, parseState } from "./mealService";
import { durationMinutes, parseAmountText, parseIngredientLine, parseRecipePage } from "./recipeImport";
import type { Ingredient, MealsState, MealsStore, PantryItem, PlannedMeal, Recipe } from "./types";
import { isRecipePhotoUrl, recipePhotoUrl } from "./types";

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
    startQuantity: over.quantity ?? 1,
    place: over.place ?? "fridge",
    confidence: over.confidence ?? "confirmed",
    packaging: null,
    openedAt: null,
    expiresAt: over.expiresAt ?? null,
    lastCorrection: null,
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
    {
      ingredientId: "chicken",
      text: "chicken thighs",
      quantity: 600,
      unit: "g",
      optional: false,
      componentId: null,
    },
    { ingredientId: "lemon", text: "lemons", quantity: 2, unit: "piece", optional: false, componentId: null },
    {
      ingredientId: "parsley",
      text: "parsley",
      quantity: 1,
      unit: "bunch",
      optional: true,
      componentId: null,
    },
  ],
  steps: [],
  components: [],
  batch: false,
  photo: null,
  tags: [],
  source: null,
  notes: null,
  favourite: false,
  lastCookedAt: null,
  timesCooked: 0,
  difficulty: null,
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
  startQuantity: quantity,
  place: "fridge",
  confidence: "confirmed",
  packaging: null,
  openedAt: null,
  expiresAt,
  lastCorrection: null,
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
  lastPackaging: null,
  countsAs: null,
  addedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

test("recipes: cost and nutrition are estimates that say how many lines they used", () => {
  const r = recipe();
  const ingredients = new Map([
    [
      "chicken",
      ingredient("chicken", {
        lastPrice: 0.0055,
        nutrition: { kcal: 209, protein: 26, carbs: 0, fat: 11, fibre: 0 },
      }),
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

test("the shopping list: one subtraction across the week, not one per meal", () => {
  const { service: meals } = service();
  meals.ensureIngredient("Rice", "g");
  meals.updateIngredient(meals.findIngredient("Rice")!.id, { lastPrice: 0.0015 });
  meals.addStock({ name: "Rice", quantity: 500, unit: "g" });
  const saved = meals.saveRecipe({
    name: "Rice and beans",
    servings: 2,
    ingredients: [
      { name: "Rice", quantity: 200, unit: "g" },
      { name: "Black beans", quantity: 1, unit: "tin" },
    ],
  });
  for (const date of ["2026-09-22", "2026-09-23", "2026-09-24"])
    meals.planMeal({ date, slot: "dinner", kind: "recipe", recipeId: saved.id, servings: 2 });

  const list = meals.shoppingList(["2026-09-22", "2026-09-23", "2026-09-24"]);
  const rice = list.lines.find((line) => line.name === "Rice")!;
  // Three dinners want 600 g; 500 g is in the cupboard, so buy 100 g — not 200 g three times.
  assert.deepEqual(
    [rice.needed, rice.have, rice.buy],
    [{ quantity: 600, unit: "g" }, 500, { quantity: 100, unit: "g" }]
  );
  assert.deepEqual(rice.forMeals, ["Rice and beans"]);
  const beans = list.lines.find((line) => line.name === "Black beans")!;
  assert.deepEqual(beans.buy, { quantity: 3, unit: "piece" });
  // The beans have no price yet, so the total says so instead of pretending.
  assert.deepEqual([list.cost, list.unpriced], [0.15, 1]);
});

test("the shopping list: cooked meals are gone, covered food is credited, manual lines stay", () => {
  const { service: meals } = service();
  meals.addStock({ name: "Oats", quantity: 1, unit: "kg" });
  meals.updateIngredient(meals.findIngredient("Oats")!.id, { lastPrice: 0.002 });
  const porridge = meals.saveRecipe({
    name: "Porridge",
    servings: 1,
    ingredients: [{ name: "Oats", quantity: 60, unit: "g" }],
  });
  meals.planMeal({
    date: "2026-09-22",
    slot: "breakfast",
    kind: "recipe",
    recipeId: porridge.id,
    servings: 1,
  });
  const cooked = meals.planMeal({
    date: "2026-09-23",
    slot: "breakfast",
    kind: "recipe",
    recipeId: porridge.id,
    servings: 1,
  });
  meals.cook({ mealId: cooked.id, recipeId: porridge.id, cookServings: 1, eatServings: 1 });

  meals.addShoppingItem({ name: "Bin bags" });
  const list = meals.shoppingList(["2026-09-22", "2026-09-23"]);
  // The kilo of oats covers what's left to cook, so only the manual line remains.
  assert.deepEqual(
    list.lines.map((line) => [line.name, line.manual]),
    [["Bin bags", true]]
  );
  assert.deepEqual(
    list.covered.map((entry) => entry.name),
    ["Oats"]
  );
});

test("buying: stock is confirmed, the price is recorded per unit, and the line goes away", () => {
  const { service: meals } = service();
  const item = meals.addShoppingItem({ name: "Chicken thighs", quantity: 1, unit: "kg" });
  meals.buy({
    itemId: item.id,
    name: "Chicken thighs",
    quantity: 1,
    unit: "kg",
    paid: 5.49,
    place: "fridge",
  });
  const stock = meals.listPantry();
  assert.deepEqual([stock.length, stock[0].confidence], [1, "confirmed"]);
  // €5.49 for a kilo is €0.00549 a gram, so a 600 g recipe costs €3.29.
  assert.equal(meals.findIngredient("Chicken thighs")!.lastPrice, 0.00549);
  assert.equal(meals.shoppingList(["2026-09-22"]).lines.length, 0);
});

test("importing: a page's recipe metadata becomes a draft, with the doubtful lines flagged", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","name":"Not the recipe"},
      {"@type":["Recipe"],"name":"Lemon chicken traybake","description":"<p>One tray.</p>",
       "recipeYield":"3 servings","prepTime":"PT15M","cookTime":"PT40M","recipeCategory":"Dinner",
       "recipeIngredient":["600g chicken thighs, bone in","2 lemons","1 1/2 tbsp olive oil","a pinch of salt","2-3 sprigs parsley (optional)"],
       "recipeInstructions":[{"@type":"HowToStep","text":"Heat the oven."},{"@type":"HowToStep","text":"Roast for 40 minutes."}]}
    ]}</script></head><body></body></html>`;
  const recipe = parseRecipePage(html, "https://example.com/r")!;
  assert.equal(recipe.name, "Lemon chicken traybake");
  assert.deepEqual([recipe.servings, recipe.prepMinutes, recipe.cookMinutes], [3, 15, 40]);
  assert.deepEqual(recipe.slots, ["dinner"]);
  assert.deepEqual(recipe.steps, ["Heat the oven.", "Roast for 40 minutes."]);
  assert.deepEqual(
    recipe.ingredients.map((line) => [line.name, line.quantity, line.unit, line.optional, line.warning]),
    [
      ["chicken thighs", 600, "g", false, null],
      ["lemons", 2, "piece", false, null],
      ["olive oil", 1.5, "tbsp", false, null],
      // No number at all: flagged rather than invented.
      ["pinch of salt", null, null, false, "No amount found"],
      // A range takes the larger, and "(optional)" is honoured.
      ["sprigs parsley", 3, "piece", true, null],
    ]
  );
  assert.equal(recipe.needsChecking, 1);
  assert.equal(parseRecipePage("<html><body>no metadata</body></html>", "https://example.com"), null);
  assert.equal(durationMinutes("PT1H30M"), 90);
  assert.equal(durationMinutes("soon"), null);
});

test("importing: half a lemon, decimals with a comma, and a unit NIMBUS doesn't know", () => {
  assert.deepEqual(
    [
      parseIngredientLine("½ lemon"),
      parseIngredientLine("0,5 l milk"),
      parseIngredientLine("2 sprigs thyme"),
    ].map((line) => [line.name, line.quantity, line.unit]),
    [
      ["lemon", 0.5, "piece"],
      ["milk", 0.5, "l"],
      // "sprigs" isn't a unit NIMBUS measures, so it stays part of the food and counts as pieces.
      ["sprigs thyme", 2, "piece"],
    ]
  );
});

test("demo data: loads a working kitchen, and removing it takes out exactly what it added", () => {
  const { service: meals } = service();
  const mine = meals.saveRecipe({
    name: "My own recipe",
    servings: 2,
    ingredients: [{ name: "Rice", quantity: 100, unit: "g" }],
  });
  const myRice = meals.findIngredient("Rice")!.id;

  meals.loadDemoData();
  assert.equal(meals.hasDemoData(), true);
  assert.equal(meals.listRecipes().length > 1, true);
  assert.equal(meals.listPantry().length > 5, true);
  assert.equal(meals.listPlan().length > 5, true);
  // Today's dinner is planned, so the tab has something to show at once.
  assert.equal(
    meals.listPlan().some((meal) => meal.date === meals.today() && meal.slot === "dinner"),
    true
  );
  assert.throws(() => meals.loadDemoData(), /already loaded/);

  meals.removeDemoData();
  assert.equal(meals.hasDemoData(), false);
  assert.deepEqual(
    meals.listRecipes().map((recipe) => recipe.id),
    [mine.id]
  );
  assert.equal(meals.listPlan().length, 0);
  assert.equal(meals.listLeftovers().length, 0);
  // My own ingredient survives, because my recipe still uses it.
  assert.equal(meals.findIngredient("Rice")!.id, myRice);
});

test("demo data: a meal you planned from a demo recipe outlives it, still named", () => {
  const { service: meals } = service();
  meals.loadDemoData();
  const demoRecipe = meals.listRecipes()[0];
  const mine = meals.planMeal({
    date: "2026-10-01",
    slot: "lunch",
    kind: "recipe",
    recipeId: demoRecipe.id,
    servings: 2,
  });
  meals.removeDemoData();
  const kept = meals.listPlan().find((meal) => meal.id === mine.id)!;
  assert.equal(kept.recipeId, null);
  assert.equal(kept.kind, "custom");
  assert.equal(kept.name, demoRecipe.name);
});

test("the service: a planned meal can't be cooked twice", () => {
  const { service: meals } = service();
  const rice = meals.ensureIngredient("Rice", "g");
  meals.addStock({ ingredientId: rice.id, quantity: 1, unit: "kg", place: "cupboard" });
  const saved = meals.saveRecipe({
    name: "Rice",
    servings: 2,
    ingredients: [{ name: "Rice", quantity: 200, unit: "g" }],
  });
  const meal = meals.planMeal({
    date: "2026-09-22",
    slot: "dinner",
    kind: "recipe",
    recipeId: saved.id,
    servings: 2,
  });
  meals.cook({ mealId: meal.id, recipeId: saved.id });
  const left = meals.listPantry()[0].quantity;
  assert.throws(() => meals.cook({ mealId: meal.id, recipeId: saved.id }), /already cooked/);
  assert.equal(meals.listPantry()[0].quantity, left);
  assert.equal(meals.getRecipe(saved.id)?.timesCooked, 1);
});

test("a planned meal reads as what it is: the recipe, the leftovers, or where you ate", () => {
  const { service: meals } = service();
  const saved = meals.saveRecipe({ name: "Porridge", servings: 1, ingredients: [] });
  const leftover = meals.addLeftover({ name: "Chilli con carne", portions: 2 });
  const recipes = new Map(meals.listRecipes().map((r) => [r.id, r]));
  const leftovers = new Map(meals.listLeftovers().map((l) => [l.id, l]));
  const named = (meal: { id: string }) =>
    mealName(
      meals.listPlan().find((m) => m.id === meal.id)!,
      recipes,
      leftovers
    );

  const breakfast = meals.planMeal({
    date: "2026-09-22",
    slot: "breakfast",
    kind: "recipe",
    recipeId: saved.id,
  });
  const lunch = meals.planMeal({
    date: "2026-09-22",
    slot: "lunch",
    kind: "leftover",
    leftoverId: leftover.id,
  });
  const dinner = meals.planMeal({ date: "2026-09-22", slot: "dinner", kind: "out", name: "Canteen" });
  assert.deepEqual(
    [named(breakfast), named(lunch), named(dinner)],
    ["Porridge", "Chilli con carne (leftovers)", "Canteen"]
  );
});

test("step 1: the cook preview says what comes out of which package, and changes nothing", () => {
  const { service: meals } = service();
  const potato = meals.ensureIngredient("Potatoes", "g");
  meals.addStock({
    ingredientId: potato.id,
    quantity: 2,
    unit: "kg",
    place: "cupboard",
    packaging: "2 kg bag",
  });
  const saved = meals.saveRecipe({
    name: "Roast potatoes",
    servings: 3,
    ingredients: [
      { name: "Potatoes", quantity: 900, unit: "g" },
      { name: "Rosemary", quantity: 2, unit: "piece" },
    ],
  });
  const preview = meals.previewCook(saved.id, 3);
  assert.equal(preview.deductions.length, 1);
  assert.equal(preview.deductions[0].packaging, "2 kg bag");
  assert.deepEqual(preview.deductions[0].remaining, { quantity: 1.1, unit: "kg" });
  assert.equal(preview.deductions[0].empties, false);
  assert.deepEqual(
    preview.short.map((s) => s.name),
    ["Rosemary"]
  );
  // Nothing moved.
  assert.equal(meals.listPantry()[0].quantity, 2);
  // And the ingredient remembers the package it came in.
  assert.equal(meals.findIngredient("potatoes")!.lastPackaging, "2 kg bag");
});

test("step 1: cooking can put the extra portions straight into a slot of the plan", () => {
  const { service: meals } = service();
  meals.updatePreferences({
    eaters: [
      { name: "A", portionFactor: 1 },
      { name: "B", portionFactor: 1 },
    ],
  });
  const saved = meals.saveRecipe({
    name: "Chilli",
    servings: 4,
    ingredients: [{ name: "Beans", quantity: 400, unit: "g" }],
  });
  const result = meals.cook({
    recipeId: saved.id,
    cookServings: 4,
    eatServings: 2,
    skipPantry: true,
    scheduleLeftoverFor: { date: "2026-09-25", slot: "lunch" },
  });
  assert.equal(result.leftover?.portions, 2);
  assert.ok(result.scheduled);
  assert.equal(result.scheduled!.kind, "leftover");
  assert.equal(result.scheduled!.leftoverId, result.leftover!.id);
  assert.equal(result.scheduled!.servings, 2);
  assert.equal(meals.listPlan().length, 1);
});

test("step 1: correcting stock records why, and a bad reason is simply not recorded", () => {
  const { service: meals } = service();
  const item = meals.addStock({ name: "Eggs", quantity: 12, unit: "piece", place: "fridge" });
  meals.correctStock(item.id, 2, undefined, "thrown");
  const after = meals.listPantry()[0];
  assert.equal(after.quantity, 2);
  assert.equal(after.lastCorrection?.reason, "thrown");
  meals.correctStock(item.id, 3, undefined, "because I said so");
  assert.equal(meals.listPantry()[0].lastCorrection?.reason, "thrown");
  // And it survives a reload, checked like everything else.
  const reloaded = parseState(JSON.parse(JSON.stringify(meals.getState())));
  assert.equal(reloaded.pantry[0].lastCorrection?.reason, "thrown");
  assert.equal(
    parseState({ pantry: [{ ...after, lastCorrection: { reason: "nope", at: "x" } }] }).pantry[0]
      .lastCorrection,
    null
  );
});

test("step 1: amounts typed as text", () => {
  assert.deepEqual(parseAmountText("250 g"), { quantity: 250, unit: "g" });
  assert.deepEqual(parseAmountText("1,5 kg"), { quantity: 1.5, unit: "kg" });
  assert.deepEqual(parseAmountText("3"), { quantity: 3, unit: "piece" });
  assert.equal(parseAmountText("some"), null);
});

test("step 1: plan badges — leftovers covering 2 of 3, and a recipe that's all at home", () => {
  const leftovers = new Map([["l1", { portions: 2 }]]);
  const meal = (over: Partial<PlannedMeal>): PlannedMeal => ({
    id: "m",
    date: "2026-09-22",
    slot: "lunch",
    kind: "recipe",
    recipeId: "r1",
    leftoverId: null,
    name: null,
    servings: 3,
    cookServings: null,
    time: null,
    cost: null,
    notes: null,
    cookedAt: null,
    locked: false,
    origin: "user",
    reasons: [],
    swapSaving: null,
    portions: null,
    fromMealId: null,
    addedAt: "",
    updatedAt: "",
    ...over,
  });
  const left = meal({ kind: "leftover", recipeId: null, leftoverId: "l1" });
  assert.deepEqual(leftoverCoverage(left, leftovers), { portions: 2, needed: 3, short: 1 });
  assert.deepEqual(mealBadge(left, leftovers, null), { kind: "leftover", label: "↺ 2/3" });
  assert.deepEqual(mealBadge(meal({}), leftovers, { have: 4, total: 4 }), {
    kind: "pantry",
    label: "◦ Pantry",
  });
  assert.equal(mealBadge(meal({}), leftovers, { have: 3, total: 4 }), null);
});

test("step 1: a recipe's missing lines go on the shopping list once", () => {
  const { service: meals } = service();
  meals.addStock({ name: "Rice", quantity: 100, unit: "g", place: "cupboard" });
  const saved = meals.saveRecipe({
    name: "Rice and beans",
    servings: 2,
    ingredients: [
      { name: "Rice", quantity: 300, unit: "g" },
      { name: "Beans", quantity: 1, unit: "tin" },
    ],
  });
  assert.equal(meals.addMissingToShopping(saved.id, 2), 2);
  assert.equal(meals.addMissingToShopping(saved.id, 2), 0);
  const rice = meals.getState().shopping.find((item) => item.name === "Rice")!;
  assert.equal(rice.quantity, 200);
  assert.equal(rice.note, "for Rice and beans");
});

test("step 1: editing a recipe keeps its notes and the minutes of steps kept word for word", () => {
  const { service: meals } = service();
  const saved = meals.saveRecipe({
    name: "Soup",
    notes: "Freezes well",
    steps: [{ text: "Simmer.", minutes: 20 }],
  });
  const edited = meals.saveRecipe({ name: "Soup", steps: [{ text: "Simmer.", minutes: 20 }] }, saved.id);
  assert.equal(edited.notes, "Freezes well");
  assert.equal(edited.steps[0].minutes, 20);
});

test("step 2: a recipe of several dishes keeps each line and step with its dish", () => {
  const { service: meals } = service();
  const saved = meals.saveRecipe({
    name: "Traybake with salad",
    components: [
      { key: "a", name: "Chicken" },
      { key: "b", name: "Spinach salad" },
    ],
    ingredients: [
      { name: "Chicken thighs", quantity: 600, unit: "g", component: "a" },
      { name: "Spinach", quantity: 150, unit: "g", component: "b" },
      { name: "Salt", quantity: 1, unit: "g", component: "nope" },
    ],
    steps: [
      { text: "Roast the chicken.", minutes: 25, component: "a" },
      { text: "Dress the salad.", component: "b" },
    ],
    batch: true,
  });
  assert.equal(saved.components.length, 2);
  const [chicken, salad] = saved.components;
  assert.deepEqual(
    saved.ingredients.map((line) => line.componentId),
    [chicken.id, salad.id, null]
  );
  assert.deepEqual(
    saved.steps.map((step) => [step.componentId, step.minutes]),
    [
      [chicken.id, 25],
      [salad.id, null],
    ]
  );
  assert.equal(saved.batch, true);

  // Editing by the existing ids keeps them; a dish that's gone drops its lines' link.
  const edited = meals.saveRecipe(
    {
      name: "Traybake with salad",
      components: [{ key: chicken.id, name: "Chicken" }],
      ingredients: [
        { name: "Chicken thighs", quantity: 600, unit: "g", component: chicken.id },
        { name: "Spinach", quantity: 150, unit: "g", component: salad.id },
      ],
    },
    saved.id
  );
  assert.equal(edited.components[0].id, chicken.id);
  assert.deepEqual(
    edited.ingredients.map((line) => line.componentId),
    [chicken.id, null]
  );
  assert.equal(edited.batch, true, "batch is kept when the edit doesn't mention it");

  // Loading drops a line pointing at a dish the recipe doesn't have.
  const loaded = parseState({
    recipes: [{ ...edited, ingredients: [{ ...edited.ingredients[0], componentId: "ghost" }] }],
  });
  assert.equal(loaded.recipes[0].ingredients[0].componentId, null);
});

test("step 2: fibre is counted like the rest, and the demo traybake has three dishes", () => {
  const { service: meals } = service();
  meals.loadDemoData();
  const state = meals.getState();
  const traybake = state.recipes.find((r) => r.name === "Lemon chicken traybake")!;
  assert.deepEqual(
    traybake.components.map((c) => c.name),
    ["Chicken", "Potatoes", "Spinach salad"]
  );
  assert.ok(traybake.steps.some((s) => s.minutes === 25));
  assert.equal(state.recipes.find((r) => r.name === "Chilli con carne")!.batch, true);
  const lookup = (id: string) => state.ingredients.find((i) => i.id === id);
  const nutrition = recipeNutrition(traybake, traybake.servings, lookup);
  assert.ok((nutrition.fibre ?? 0) > 0, "potatoes and spinach bring fibre");
});

test("step 2: only NIMBUS's own recipe photo addresses are kept", () => {
  assert.equal(recipePhotoUrl("abc-123", 5), "nimbus-cover://recipe/abc-123.jpg?v=5");
  assert.equal(recipePhotoUrl("../etc", 5), null);
  assert.equal(isRecipePhotoUrl("nimbus-cover://recipe/abc-123.jpg?v=5"), true);
  for (const bad of ["file:///C:/x.jpg", "https://example.com/a.jpg", "nimbus-cover://cover/a.jpg"])
    assert.equal(isRecipePhotoUrl(bad), false, bad);
  const { service: meals } = service();
  const saved = meals.saveRecipe({ name: "Soup", photo: "file:///C:/Windows/win.ini" });
  assert.equal(saved.photo, null, "the renderer can't set a photo address");
  assert.throws(() => meals.setRecipePhoto(saved.id, "https://example.com/a.jpg"));
  assert.equal(
    meals.setRecipePhoto(saved.id, recipePhotoUrl(saved.id, 1)).photo,
    recipePhotoUrl(saved.id, 1)
  );
});

test("families: soy milk does for a recipe's milk, not the other way round, and the pantry keeps them apart", () => {
  const family = familyOf([
    { id: "milk", countsAs: null },
    { id: "soy", countsAs: "milk" },
  ]);
  const pantry = [
    pantryItem("a", "milk", 200, "ml", "2026-09-30"),
    pantryItem("b", "soy", 500, "ml", "2026-09-25"),
  ];
  const line = (ingredientId: string) => ({
    ingredientId,
    text: ingredientId,
    quantity: 400,
    unit: "ml",
    optional: false,
    componentId: null,
  });
  const scale = (i: { quantity: number; unit: string }) => ({ quantity: i.quantity, unit: i.unit });
  // Milk: either will do — 700 ml at home.
  assert.equal(coverRecipe([line("milk")], pantry, scale, family)[0].status, "have");
  assert.equal(
    coverRecipe([line("milk")], pantry, scale)[0].status,
    "partial",
    "without families, only milk"
  );
  // Soy milk specifically: only soy.
  assert.equal(
    coverRecipe([line("soy")], [pantryItem("a", "milk", 900, "ml")], scale, family)[0].status,
    "missing"
  );
  // Cooking: the named food first, then the family; a choice puts that one first.
  const plain = planDeductions([line("milk")], pantry, scale, { family });
  assert.deepEqual(
    plain.deductions.map((d) => [d.itemId, d.use.quantity]),
    [
      ["a", 200],
      ["b", 200],
    ]
  );
  const soyFirst = planDeductions([line("milk")], pantry, scale, {
    family,
    choose: new Map([["milk", "soy"]]),
  });
  assert.deepEqual(
    soyFirst.deductions.map((d) => [d.itemId, d.use.quantity]),
    [["b", 400]]
  );
  // The cook dialog asks only when more than one food would do.
  assert.equal(familyChoices([line("milk")], pantry, family)[0].foods.join(), "milk,soy");
  assert.equal(familyChoices([line("soy")], pantry, family).length, 0);
});

test("families: counts-as stays one level deep, and removing the general food frees the others", () => {
  const { service: meals } = service();
  const milk = meals.ensureIngredient("Milk", "ml");
  const plantMilk = meals.ensureIngredient("Plant milk", "ml");
  const soy = meals.ensureIngredient("Soy milk", "ml");
  meals.updateIngredient(soy.id, { countsAs: plantMilk.id });
  meals.updateIngredient(plantMilk.id, { countsAs: milk.id });
  const byName = (name: string) => meals.getState().ingredients.find((i) => i.name === name)!;
  assert.equal(byName("Plant milk").countsAs, milk.id);
  assert.equal(byName("Soy milk").countsAs, milk.id, "soy follows plant milk up to milk");
  assert.throws(() => meals.updateIngredient(milk.id, { countsAs: soy.id }), /itself/);
  meals.updateIngredient(soy.id, { countsAs: null });
  assert.equal(byName("Soy milk").countsAs, null);
  meals.updateIngredient(soy.id, { countsAs: milk.id });
  meals.removeIngredient(milk.id);
  assert.equal(byName("Soy milk").countsAs, null);
});

test("families: cooking uses the food you chose, and the shopping list counts the family", () => {
  const { service: meals } = service();
  const recipe = meals.saveRecipe({
    name: "Pancakes",
    servings: 2,
    slots: ["breakfast"],
    ingredients: [{ name: "Milk", quantity: 300, unit: "ml" }],
  });
  const milk = meals.getState().ingredients.find((i) => i.name === "Milk")!;
  const soy = meals.ensureIngredient("Soy milk", "ml");
  meals.updateIngredient(soy.id, { countsAs: milk.id });
  meals.addStock({ ingredientId: milk.id, quantity: 1000, unit: "ml", place: "fridge" });
  meals.addStock({ ingredientId: soy.id, quantity: 1000, unit: "ml", place: "cupboard" });
  const preview = meals.previewCook(recipe.id, 2);
  assert.deepEqual(
    preview.choices[0].foods.map((f) => f.name),
    ["Milk", "Soy milk"]
  );
  meals.cook({ recipeId: recipe.id, cookServings: 2, eatServings: 2, choose: { [milk.id]: soy.id } });
  const left = new Map(meals.listPantry().map((item) => [item.name, item.quantity]));
  assert.equal(left.get("Soy milk"), 700);
  assert.equal(left.get("Milk"), 1000);
});

test("batches: scaled amounts are ones you'd measure — no 0.1 g of meat", () => {
  assert.deepEqual(practicalAmount({ quantity: 0.1, unit: "g" }), { quantity: 1, unit: "g" });
  assert.deepEqual(practicalAmount({ quantity: 123, unit: "g" }), { quantity: 120, unit: "g" });
  assert.deepEqual(practicalAmount({ quantity: 0.737, unit: "kg" }), { quantity: 0.74, unit: "kg" });
  assert.deepEqual(practicalAmount({ quantity: 2.4, unit: "piece" }), { quantity: 3, unit: "piece" });
  assert.deepEqual(practicalAmount({ quantity: 1.3, unit: "tbsp" }), { quantity: 1.5, unit: "tbsp" });
  // The recipe as written is left alone: 7 g of yeast stays 7 g.
  assert.deepEqual(scaleAmount({ quantity: 7, unit: "g" }, 4, 4), { quantity: 7, unit: "g" });
  assert.deepEqual(scaleAmount({ quantity: 500, unit: "g" }, 5, 2), { quantity: 200, unit: "g" });
});

test("batches: a meal cooks the recipe as written, never less than who's eating", () => {
  assert.equal(cookServingsOf({ cookServings: null, servings: 2 }, { servings: 5 }), 5);
  assert.equal(cookServingsOf({ cookServings: null, servings: 12 }, { servings: 5 }), 12);
  assert.equal(cookServingsOf({ cookServings: 3, servings: 2 }, { servings: 5 }), 3);
});

test("batches: 3 extra portions for 2 people — 2 at the next meal, 1 at the one after, short 1", () => {
  const free = freeMealsAfter(
    [{ date: "2026-09-22", slot: "lunch" }],
    { date: "2026-09-21", slot: "dinner" },
    3
  );
  assert.deepEqual(free.slice(0, 3), [
    { date: "2026-09-22", slot: "dinner" },
    { date: "2026-09-23", slot: "lunch" },
    { date: "2026-09-23", slot: "dinner" },
  ]);
  assert.deepEqual(spreadLeftovers(3, 2, free), [
    { date: "2026-09-22", slot: "dinner", portions: 2, short: 0 },
    { date: "2026-09-23", slot: "lunch", portions: 1, short: 1 },
  ]);
  assert.deepEqual(spreadLeftovers(3, 2, free, "2026-09-22").length, 1, "not past the eat-by");
});

test("batches: planning a batch plans its leftovers; cooking makes them real; removing takes them away", () => {
  const { service: meals } = service();
  meals.updatePreferences({
    eaters: [
      { name: "A", portionFactor: 1 },
      { name: "B", portionFactor: 1 },
    ],
  });
  const recipe = meals.saveRecipe({
    name: "Rice and beans",
    servings: 5,
    slots: ["dinner"],
    ingredients: [{ name: "Rice", quantity: 500, unit: "g" }],
  });
  const dinner = meals.planMeal({
    date: "2026-10-05",
    slot: "dinner",
    kind: "recipe",
    recipeId: recipe.id,
    servings: 2,
  });
  const chain = () => meals.listPlan().filter((m) => m.fromMealId === dinner.id);
  assert.deepEqual(
    chain().map((m) => [m.date, m.slot, m.portions, m.servings]),
    [
      ["2026-10-06", "lunch", 2, 2],
      ["2026-10-06", "dinner", 1, 2],
    ]
  );
  // Planned for 12 (family over): no leftovers to plan.
  meals.planMeal(
    { date: "2026-10-05", slot: "dinner", kind: "recipe", recipeId: recipe.id, servings: 12 },
    dinner.id
  );
  assert.equal(chain().length, 0);
  meals.planMeal(
    { date: "2026-10-05", slot: "dinner", kind: "recipe", recipeId: recipe.id, servings: 2 },
    dinner.id
  );
  assert.equal(chain().length, 2);

  // Cooking 4 instead of 5: 2 extra — the first planned meal gets both, the second none.
  const result = meals.cook({
    mealId: dinner.id,
    recipeId: recipe.id,
    cookServings: 4,
    eatServings: 2,
    skipPantry: true,
  });
  const [first, second] = chain();
  assert.equal(first.leftoverId, result.leftover!.id);
  assert.equal(first.portions, 2);
  assert.equal(second.portions, 0);

  const other = meals.planMeal({
    date: "2026-10-08",
    slot: "dinner",
    kind: "recipe",
    recipeId: recipe.id,
    servings: 2,
  });
  assert.ok(meals.listPlan().some((m) => m.fromMealId === other.id));
  meals.removePlannedMeal(other.id);
  assert.ok(!meals.listPlan().some((m) => m.fromMealId === other.id));
});
