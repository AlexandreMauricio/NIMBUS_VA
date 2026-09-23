import { test } from "node:test";
import assert from "node:assert/strict";
import { MealService } from "./mealService";
import { dayRange } from "./plan";
import { isoDate } from "./pantry";
import type { MealsState, MealsStore } from "./types";

function service() {
  let state: MealsState | null = null;
  const store: MealsStore = {
    load: () => state,
    save: (next) => {
      state = JSON.parse(JSON.stringify(next)) as MealsState;
    },
  };
  return new MealService(store);
}

/** A kitchen with the demo data, a clean week ahead and room in the budget rules. */
function kitchen() {
  const meals = service();
  meals.loadDemoData();
  // The demo plans a few days; clear them so the planner has the week.
  for (const meal of meals.listPlan()) meals.removePlannedMeal(meal.id);
  meals.updatePreferences({ cookingTime: { weekday: 120, weekend: 120 }, maxRepeats: 2 });
  return meals;
}

const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoDate(d);
})();

test("planner: the same kitchen and the same days give the same plan, with a reason for each meal", () => {
  const meals = kitchen();
  const request = { from: TOMORROW, days: 3, slots: ["lunch", "dinner"], eating: 2, budgetPerDay: null };
  const first = meals.generatePlan(request);
  const again = meals.generatePlan(request);
  assert.deepEqual(
    first.meals.map((m) => [m.date, m.slot, m.kind, m.recipeId ?? m.leftoverId]),
    again.meals.map((m) => [m.date, m.slot, m.kind, m.recipeId ?? m.leftoverId])
  );
  assert.equal(new Set(first.meals.map((m) => `${m.date}|${m.slot}`)).size, 6, "every empty slot filled");
  for (const meal of first.meals) {
    assert.equal(meal.origin, "generator");
    assert.ok(meal.reasons.length > 0, "every choice explains itself");
  }
  assert.equal(meals.listPlan().length, 0, "nothing is in the plan until it's accepted");
});

test("planner: leftovers go in first, before they expire, saying how far they go", () => {
  const meals = kitchen();
  const proposal = meals.generatePlan({ from: TOMORROW, days: 3, slots: ["lunch", "dinner"], eating: 3 });
  const leftover = proposal.meals.find((m) => m.kind === "leftover");
  assert.ok(leftover, "the demo chilli leftovers are used");
  assert.ok(leftover!.reasons[0].startsWith("Uses 2 cooked portions"));
  assert.ok(leftover!.reasons[1].includes("Only covers 2 of 3"));
  // The demo keeps two: the chilli (2 portions) and the bolognese in the freezer (4).
  const existing = new Set(proposal.meals.filter((m) => m.leftoverId).map((m) => m.leftoverId));
  assert.equal(existing.size, 2);
});

test("planner: restrictions never appear, and max repeats holds", () => {
  const meals = kitchen();
  meals.updatePreferences({ restrictions: ["No beef"], maxRepeats: 1 });
  const state = meals.getState();
  const mince = state.ingredients.find((i) => i.name.toLowerCase().includes("mince"))!;
  meals.updateIngredient(mince.id, { name: "Beef mince" });
  const proposal = meals.generatePlan({
    from: TOMORROW,
    days: 7,
    slots: ["lunch", "dinner"],
    eating: 2,
    objectives: ["pantry"],
  });
  const chilli = meals.getState().recipes.find((r) => r.name === "Chilli con carne")!;
  assert.ok(!proposal.meals.some((m) => m.recipeId === chilli.id), "chilli has beef");
  const counts = new Map<string, number>();
  for (const meal of proposal.meals)
    if (meal.recipeId) counts.set(meal.recipeId, (counts.get(meal.recipeId) ?? 0) + 1);
  for (const [, count] of counts) assert.ok(count <= 1, "no recipe more than once");
  assert.ok(proposal.meals.length < 14, "slots stay empty rather than break a rule");
});

test("planner: your picks and locked meals are kept, and accepting replaces only the planner's own", () => {
  const meals = kitchen();
  const [first, second] = dayRange(new Date(`${TOMORROW}T12:00:00`), 2);
  const recipes = meals.listRecipes();
  const mine = meals.planMeal({
    date: first,
    slot: "dinner",
    kind: "recipe",
    recipeId: recipes[0].id,
    servings: 2,
    planLeftovers: false,
  });
  const proposal = meals.generatePlan({ from: first, days: 2, slots: ["dinner"], eating: 2 });
  assert.equal(proposal.meals.length, 1, "only the free dinner is filled");
  assert.equal(proposal.meals[0].date, second);
  meals.acceptProposal();
  assert.equal(meals.listPlan().length, 2);
  assert.equal(meals.getProposal(), null);
  // Regenerating keeps your pick; the planner's own dinner may be replaced, unless locked.
  const planned = meals.listPlan().find((m) => m.origin === "generator")!;
  meals.lockMeal(planned.id, true);
  const again = meals.generatePlan({ from: first, days: 2, slots: ["dinner"], eating: 2 });
  assert.equal(again.meals.length, 0, "both dinners are kept");
  assert.ok(meals.listPlan().some((m) => m.id === mine.id));
});

test("planner: over budget, the dearest meals are swapped and the swap says why; what's left becomes fixes", () => {
  const meals = kitchen();
  const free = meals.generatePlan({
    from: TOMORROW,
    days: 2,
    slots: ["dinner"],
    eating: 3,
    budgetPerDay: null,
    objectives: ["pantry"],
  });
  const tight = meals.generatePlan({
    from: TOMORROW,
    days: 2,
    slots: ["dinner"],
    eating: 3,
    budgetPerDay: 0.5,
    objectives: ["pantry"],
  });
  assert.ok((tight.cost ?? 0) <= (free.cost ?? 0), "swapping never makes it dearer");
  const swapped = tight.meals.find((m) => m.swapSaving !== null);
  if (swapped) assert.ok(swapped.reasons[0].startsWith("Budget swap:"));
  assert.ok(tight.over !== null, "0,50 € a day can't be met");
  assert.equal(tight.fixes[0].kind, "raise");
  assert.ok(tight.fixes.some((fix) => fix.kind === "repeats"));

  // Only warning, nothing is swapped.
  meals.updatePreferences({ overBudget: "warn" });
  const warned = meals.generatePlan({
    from: TOMORROW,
    days: 2,
    slots: ["dinner"],
    eating: 3,
    budgetPerDay: 0.5,
  });
  assert.ok(!warned.meals.some((m) => m.swapSaving !== null));
});

test("planner: replacing a meal — options with the cost change, the effect, and custom meals", () => {
  const meals = kitchen();
  const proposal = meals.generatePlan({ from: TOMORROW, days: 1, slots: ["dinner"], eating: 2 });
  const meal = proposal.meals[0];
  const options = meals.replaceOptionsFor(meal.id);
  assert.ok(options.length > 0);
  assert.ok(!options.some((o) => o.recipeId === meal.recipeId), "not the meal it already is");
  const pick = options[0];
  const effect = meals.effectOfReplacing(meal.id, pick.recipeId);
  if (pick.delta !== null) assert.equal(Math.round((effect.after - effect.before) * 100) / 100, pick.delta);

  const replaced = meals.replaceMeal(meal.id, { kind: "recipe", recipeId: pick.recipeId });
  assert.equal(replaced.recipeId, pick.recipeId);
  assert.equal(replaced.origin, "user", "your pick now");

  meals.replaceMeal(meal.id, {
    kind: "custom",
    name: "Grandma's bacalhau à brás",
    cost: 8.7,
    ingredients: "400 g salt cod, 6 eggs",
    addMissing: true,
  });
  const custom = meals.getProposal()!.meals[0];
  assert.equal(custom.kind, "custom");
  assert.equal(custom.cost, 8.7);
  assert.ok(meals.getState().shopping.some((item) => item.name.toLowerCase().includes("salt cod")));

  meals.replaceMeal(meal.id, { kind: "skip" });
  assert.equal(meals.getProposal()!.meals[0].cost, 0);
  assert.equal(meals.getProposal()!.meals[0].name, "Skipped");
});

test("planner: editing a planned recipe can keep the planned meals as they were", () => {
  const meals = kitchen();
  const recipe = meals.listRecipes()[0];
  meals.planMeal({ date: TOMORROW, slot: "dinner", kind: "recipe", recipeId: recipe.id, servings: 2 });
  assert.equal(meals.keepPlannedVersion(recipe.id), 1);
  const meal = meals.listPlan()[0];
  assert.equal(meal.kind, "custom");
  assert.equal(meal.name, `${recipe.name} (as planned)`);
});

test("planner: changing a proposed meal brings the proposal's figures up to date", () => {
  const meals = kitchen();
  const proposal = meals.generatePlan({
    from: TOMORROW,
    days: 2,
    slots: ["dinner"],
    eating: 2,
    objectives: ["pantry"],
  });
  const meal = proposal.meals[0];
  meals.replaceMeal(meal.id, { kind: "out", cost: 40 });
  const after = meals.getProposal()!;
  // What was planned from that dinner (its leftovers) goes with it; the rest stays.
  const others = proposal.meals.slice(1).filter((m) => m.fromMealId === null);
  assert.ok(after.cost !== null && after.cost > (proposal.cost ?? 0), "the dinner out costs more");
  assert.ok(others.every((m) => after.meals.some((a) => a.id === m.id)));
  assert.ok(!after.meals.some((m) => m.fromMealId === meal.id));
  meals.replaceMeal(meal.id, { kind: "skip" });
  assert.ok((meals.getProposal()!.cost ?? 0) < (after.cost ?? 0));
});
