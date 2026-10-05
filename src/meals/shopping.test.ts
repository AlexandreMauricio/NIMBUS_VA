import { test } from "node:test";
import assert from "node:assert/strict";
import { MealService } from "./mealService";
import { ingredientKey, matchIngredient } from "./names";
import type { MealsState, MealsStore } from "./types";

function meals(): MealService {
  let state: MealsState | null = null;
  const store: MealsStore = {
    load: () => state,
    save: (next) => {
      state = JSON.parse(JSON.stringify(next)) as MealsState;
    },
  };
  return new MealService(store);
}

/** One recipe planned for dinner on each date. */
function plan(service: MealService, recipe: { id: string }, dates: string[], servings = 2): void {
  for (const date of dates)
    service.planMeal({ date, slot: "dinner", kind: "recipe", recipeId: recipe.id, servings });
}

test("shopping: optional lines are never bought", () => {
  const service = meals();
  const pasta = service.saveRecipe({
    name: "Pasta",
    servings: 2,
    ingredients: [
      { name: "Spaghetti", quantity: 200, unit: "g" },
      { name: "Parmesan", quantity: 20, unit: "g", optional: true },
    ],
  });
  plan(service, pasta, ["2026-09-22"]);
  assert.deepEqual(
    service.shoppingList(["2026-09-22"]).lines.map((line) => line.name),
    ["Spaghetti"]
  );
});

test("shopping: one food in two units can't be added up, so the second asks to be checked", () => {
  const service = meals();
  const soup = service.saveRecipe({
    name: "Soup",
    servings: 2,
    ingredients: [{ name: "Carrot", quantity: 300, unit: "g" }],
  });
  const salad = service.saveRecipe({
    name: "Salad",
    servings: 2,
    ingredients: [{ name: "Carrot", quantity: 1, unit: "piece" }],
  });
  plan(service, soup, ["2026-09-22"]);
  plan(service, salad, ["2026-09-23"]);
  const list = service.shoppingList(["2026-09-22", "2026-09-23"]);
  const carrots = list.lines.filter((line) => line.name === "Carrot");
  assert.deepEqual(
    carrots.map((line) => [line.buy, line.forMeals]),
    [
      [{ quantity: 300, unit: "g" }, ["Soup"]],
      [null, ["Salad"]],
    ]
  );
  assert.equal(list.unknown, 1);
});

test("shopping: only the days asked about count", () => {
  const service = meals();
  const rice = service.saveRecipe({
    name: "Rice",
    servings: 2,
    ingredients: [{ name: "Rice", quantity: 150, unit: "g" }],
  });
  plan(service, rice, ["2026-09-22", "2026-09-23", "2026-09-30"]);
  const line = service.shoppingList(["2026-09-22", "2026-09-23"]).lines[0];
  assert.deepEqual(line.buy, { quantity: 300, unit: "g" });
});

test("shopping: a manual line with a known food and amount is priced, one without isn't", () => {
  const service = meals();
  service.ensureIngredient("Coffee", "g");
  service.updateIngredient(service.findIngredient("Coffee")!.id, { lastPrice: 0.02 });
  service.addShoppingItem({ name: "Coffee", quantity: 250, unit: "g" });
  service.addShoppingItem({ name: "Bin bags" });
  const list = service.shoppingList(["2026-09-22"]);
  assert.deepEqual(
    list.lines.map((line) => [line.name, line.cost]),
    [
      ["Bin bags", null],
      ["Coffee", 5],
    ]
  );
  assert.deepEqual([list.cost, list.unpriced], [5, 1]);
});

test("names: case, accents, punctuation and a plural s don't make a new food", () => {
  assert.equal(ingredientKey("  Limões "), ingredientKey("limoe"));
  assert.equal(ingredientKey("Crème fraîche"), "creme fraiche");
  assert.equal(ingredientKey("Self-raising flour"), "selfraising flour");
  assert.equal(ingredientKey("Eggs"), ingredientKey("egg"));
  assert.equal(ingredientKey("!!!"), "");
});

test("names: a typed name finds its food by name or alias, and nothing for an empty one", () => {
  const foods = [
    { id: "1", name: "Chickpeas", aliases: ["Grão-de-bico", "Garbanzo"] },
    { id: "2", name: "Milk", aliases: [] },
  ];
  assert.equal(matchIngredient("chickpea", foods)?.id, "1");
  assert.equal(matchIngredient("grão de bico", foods), undefined, "a hyphen is not a space");
  assert.equal(matchIngredient("Grão-de-bico", foods)?.id, "1");
  assert.equal(matchIngredient("garbanzos", foods)?.id, "1");
  assert.equal(matchIngredient("MILK", foods)?.id, "2");
  assert.equal(matchIngredient("Oat milk", foods), undefined);
  assert.equal(matchIngredient("  ", foods), undefined);
});
