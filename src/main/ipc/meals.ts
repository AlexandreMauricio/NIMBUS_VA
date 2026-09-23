import { logger } from "../../logging/logger";
import { coverRecipe, coverageCount, isoDate, summariseStock, usableLeftovers } from "../../meals/pantry";
import { perServing, recipeCost, recipeNutrition, scaleFor, totalMinutes } from "../../meals/recipes";
import { dayRange, mealName, planCost, servingsNeeded } from "../../meals/plan";
import { parseRecipePage } from "../../meals/recipeImport";
import { PublicFetchError, fetchPublicPage } from "../publicFetch";
import type { PublicPage } from "../publicFetch";
import { handle } from "./handle";
import type { IpcContext } from "./context";

/** Meals. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerMealsIpc(ctx: IpcContext): void {
  /**
   * Everything the Meals tab draws, worked out here rather than in the
   * page: the pantry grouped by food with its expiry state, usable
   * leftovers, each recipe with what it costs and how much of it is at
   * home, and the plan for the days around today with its cost against
   * the budget. The renderer gets numbers, not the arithmetic.
   */
  const mealsSnapshot = () => {
    const now = new Date();
    const today = isoDate(now);
    const state = ctx.mealService.getState();
    const ingredients = new Map(state.ingredients.map((ingredient) => [ingredient.id, ingredient]));
    const recipes = new Map(state.recipes.map((recipe) => [recipe.id, recipe]));
    const lookup = (id: string) => ingredients.get(id);
    const needed = servingsNeeded(state.preferences.eaters);
    const days = dayRange(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 7);
    const cost = planCost(
      state.plan.filter((meal) => days.includes(meal.date)),
      recipes,
      lookup,
      state.preferences
    );
    return {
      today,
      servingsNeeded: needed,
      preferences: state.preferences,
      ingredients: state.ingredients,
      recipes: state.recipes.map((recipe) => {
        const coverage = coverRecipe(recipe.ingredients, state.pantry, scaleFor(recipe, recipe.servings));
        return {
          recipe,
          minutes: totalMinutes(recipe),
          cost: recipeCost(recipe, recipe.servings, lookup),
          nutrition: perServing(recipeNutrition(recipe, recipe.servings, lookup), recipe.servings),
          coverage: coverageCount(coverage),
          lines: coverage.map((line) => ({
            text: line.ingredient.text,
            ingredientId: line.ingredient.ingredientId,
            optional: line.ingredient.optional,
            needed: line.needed,
            status: line.status,
            short: line.short,
          })),
        };
      }),
      stock: summariseStock(state.pantry, now).map((entry) => ({
        ...entry,
        category: ingredients.get(entry.ingredientId)?.category ?? null,
      })),
      leftovers: usableLeftovers(state.leftovers, now),
      plan: state.plan.map((meal) => ({
        meal,
        name: mealName(meal, recipes, new Map(state.leftovers.map((l) => [l.id, l]))),
        cost:
          meal.cost ??
          (meal.kind === "recipe" && meal.recipeId && recipes.has(meal.recipeId)
            ? recipeCost(recipes.get(meal.recipeId)!, meal.cookServings ?? meal.servings, lookup).value
            : null),
        nutrition:
          meal.kind === "recipe" && meal.recipeId && recipes.has(meal.recipeId)
            ? perServing(
                recipeNutrition(recipes.get(meal.recipeId)!, meal.cookServings ?? meal.servings, lookup),
                meal.cookServings ?? meal.servings
              )
            : null,
      })),
      // Per day, for the week's spend bars: what's typed is a fact, what
      // comes from ingredient prices is drawn as an estimate.
      spend: days.map((date) => {
        const meals = state.plan.filter((meal) => meal.date === date);
        const dayCost = planCost(meals, recipes, lookup, state.preferences);
        const confirmed = meals.reduce((sum, meal) => sum + (meal.cost ?? 0), 0);
        return {
          date,
          total: dayCost.value,
          confirmed: Math.round(confirmed * 100) / 100,
          estimated: Math.round(((dayCost.value ?? 0) - confirmed) * 100) / 100,
          over:
            state.preferences.dailyBudget !== null && (dayCost.value ?? 0) > state.preferences.dailyBudget,
        };
      }),
      days,
      weekCost: cost,
      shopping: ctx.mealService.shoppingList(days),
      hasDemoData: ctx.mealService.hasDemoData(),
    };
  };

  /**
   * Fetches a recipe page for the importer. The renderer names the
   * address, so this is the one place in Meals where it can: publicFetch
   * allows only http(s) on the public Internet — never this machine or
   * the local network, checked at connection time and on every redirect —
   * with one deadline and only the first megabyte downloaded. The page
   * itself is never rendered, only parsed.
   */
  const fetchRecipePage = async (raw: unknown) => {
    let page: PublicPage;
    try {
      page = await fetchPublicPage(String(raw ?? "").trim(), {
        maxBytes: 1_000_000,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
    } catch (err) {
      if (!(err instanceof PublicFetchError)) throw err;
      if (err.kind === "address")
        throw new Error("That address is on this machine or network, not a recipe site.");
      if (err.kind === "protocol")
        throw new Error(
          err.message.startsWith("That doesn't")
            ? err.message
            : "Only http and https addresses can be imported."
        );
      throw new Error(err.message);
    }
    const recipe = parseRecipePage(page.body, page.url);
    if (!recipe)
      throw new Error("No recipe data on that page — some sites don't publish it. Add it by hand instead.");
    logger.info("Imported a recipe page", {
      host: new URL(page.url).hostname,
      ingredients: recipe.ingredients.length,
    });
    return recipe;
  };

  // Meals (src/meals/): recipes, the pantry, leftovers and the plan. All of
  // it is local — no service is called — so the handlers are thin wrappers
  // over the service, which validates every field it is given.
  handle("nimbus:get-meals", () => mealsSnapshot());
  handle("nimbus:save-recipe", (_event, input: unknown, id: unknown) =>
    ctx.mealService.saveRecipe(input, typeof id === "string" && id ? id : undefined)
  );
  handle("nimbus:remove-recipe", (_event, id: unknown) => ctx.mealService.removeRecipe(String(id ?? "")));
  handle("nimbus:add-stock", (_event, input: unknown) => ctx.mealService.addStock(input));
  handle("nimbus:update-stock", (_event, id: unknown, changes: unknown) =>
    ctx.mealService.updateStock(String(id ?? ""), changes)
  );
  handle("nimbus:correct-stock", (_event, id: unknown, quantity: unknown, unit: unknown) =>
    ctx.mealService.correctStock(String(id ?? ""), quantity, unit)
  );
  handle("nimbus:remove-stock", (_event, id: unknown) => ctx.mealService.removeStock(String(id ?? "")));
  handle("nimbus:add-leftover", (_event, input: unknown) => ctx.mealService.addLeftover(input));
  handle("nimbus:update-leftover", (_event, id: unknown, changes: unknown) =>
    ctx.mealService.updateLeftover(String(id ?? ""), changes)
  );
  handle("nimbus:remove-leftover", (_event, id: unknown) => ctx.mealService.removeLeftover(String(id ?? "")));
  handle("nimbus:plan-meal", (_event, input: unknown, id: unknown) =>
    ctx.mealService.planMeal(input, typeof id === "string" && id ? id : undefined)
  );
  handle("nimbus:remove-planned-meal", (_event, id: unknown) =>
    ctx.mealService.removePlannedMeal(String(id ?? ""))
  );
  handle("nimbus:cook-meal", (_event, input: unknown) => ctx.mealService.cook(input));
  handle("nimbus:eat-leftover", (_event, mealId: unknown, leftoverId: unknown, portions: unknown) =>
    ctx.mealService.eatLeftover(String(mealId ?? ""), String(leftoverId ?? ""), portions)
  );
  handle("nimbus:update-ingredient", (_event, id: unknown, changes: unknown) =>
    ctx.mealService.updateIngredient(String(id ?? ""), changes)
  );
  handle("nimbus:update-meal-preferences", (_event, changes: unknown) =>
    ctx.mealService.updatePreferences(changes)
  );
  handle("nimbus:add-shopping-item", (_event, input: unknown) => ctx.mealService.addShoppingItem(input));
  handle("nimbus:remove-shopping-item", (_event, id: unknown) =>
    ctx.mealService.removeShoppingItem(String(id ?? ""))
  );
  handle("nimbus:buy-item", (_event, input: unknown) => ctx.mealService.buy(input));
  handle("nimbus:import-recipe-url", (_event, url: unknown) => fetchRecipePage(url));
  handle("nimbus:load-demo-meals", () => ctx.mealService.loadDemoData());
  handle("nimbus:remove-demo-meals", () => ctx.mealService.removeDemoData());
}
