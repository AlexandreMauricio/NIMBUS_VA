import { logger } from "../../logging/logger";
import {
  coverRecipe,
  coverageCount,
  expiryState,
  familyOf,
  isoDate,
  suggestBags,
  summariseStock,
  usableLeftovers,
} from "../../meals/pantry";
import { perServing, recipeCost, recipeNutrition, scaleFor, totalMinutes } from "../../meals/recipes";
import { cookServingsOf, dayRange, mealBadge, mealName, planCost, servingsNeeded } from "../../meals/plan";
import { parseRecipePage } from "../../meals/recipeImport";
import { PublicFetchError, fetchPublicPage } from "../publicFetch";
import type { PublicPage } from "../publicFetch";
import { BrowserWindow } from "electron";
import { recipePhotoUrl } from "../../meals/types";
import { choosePictureFile, removePictureFile } from "../coverStore";
import { chooseAndReadReceipt } from "../receiptImport";
import { currentPrice, pricesByStore, splitShopSaving } from "../../meals/purchases";
import type { StorePrice } from "../../meals/purchases";
import { reconcile } from "../../meals/receiptText";
import { bagNeeds, defrostList } from "../../meals/freezer";
import type { ShoppingList } from "../../meals/shopping";
import type { MealsState, PlannedMeal, Purchase } from "../../meals/types";
import { toBase } from "../../meals/units";
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
    // Soy milk at home counts for a recipe's milk.
    const family = familyOf(state.ingredients);
    // What a food costs now: the cheapest recent price at any shop, else the last one typed.
    const priced = new Map(
      state.ingredients.map((ingredient) => [
        ingredient.id,
        { ...ingredient, lastPrice: currentPrice(state.prices, ingredient, state.stores, today) },
      ])
    );
    const lookup = (id: string) => priced.get(id);
    const needed = servingsNeeded(state.preferences.eaters);
    const leftoverMap = new Map(state.leftovers.map((leftover) => [leftover.id, leftover]));
    // "Your pick" means something only beside the planner's own choices.
    const planPicks = Boolean(state.proposal) || state.plan.some((meal) => meal.origin === "generator");
    /** One meal as the tab draws it: its name, badge, cost and nutrition. */
    const planEntry = (meal: PlannedMeal, picks: boolean) => {
      const recipe = meal.kind === "recipe" && meal.recipeId ? recipes.get(meal.recipeId) : undefined;
      const servings = recipe ? cookServingsOf(meal, recipe) : meal.servings;
      return {
        meal,
        name: mealName(meal, recipes, leftoverMap),
        cooks: recipe ? cookServingsOf(meal, recipe) : null,
        // "Nothing to buy" is judged at the servings this meal is cooked for.
        badge: mealBadge(
          meal,
          leftoverMap,
          recipe
            ? coverageCount(coverRecipe(recipe.ingredients, state.pantry, scaleFor(recipe, servings), family))
            : null,
          picks
        ),
        cost:
          meal.cost ??
          (meal.kind === "leftover" ? 0 : recipe ? recipeCost(recipe, servings, lookup).value : null),
        nutrition: recipe ? perServing(recipeNutrition(recipe, servings, lookup), servings) : null,
      };
    };
    // The package of a food that would be used first — what "Home · exp. tomorrow" describes.
    const firstPackage = (ingredientId: string) =>
      state.pantry
        .filter((item) => item.ingredientId === ingredientId)
        .sort((a, b) => (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"))[0];
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
        const coverage = coverRecipe(
          recipe.ingredients,
          state.pantry,
          scaleFor(recipe, recipe.servings),
          family
        );
        return {
          recipe,
          minutes: totalMinutes(recipe),
          cost: recipeCost(recipe, recipe.servings, lookup),
          nutrition: perServing(recipeNutrition(recipe, recipe.servings, lookup), recipe.servings),
          coverage: coverageCount(coverage),
          lines: coverage.map((line) => {
            const stock = firstPackage(line.ingredient.ingredientId);
            return {
              text: line.ingredient.text,
              ingredientId: line.ingredient.ingredientId,
              optional: line.ingredient.optional,
              componentId: line.ingredient.componentId,
              needed: line.needed,
              status: line.status,
              short: line.short,
              packaging: ingredients.get(line.ingredient.ingredientId)?.lastPackaging ?? null,
              stock: stock
                ? {
                    expiry: expiryState(stock.expiresAt, now),
                    expiresAt: stock.expiresAt,
                    opened: stock.openedAt !== null,
                    confidence: stock.confidence,
                  }
                : null,
            };
          }),
        };
      }),
      stock: summariseStock(state.pantry, now).map((entry) => ({
        ...entry,
        category: ingredients.get(entry.ingredientId)?.category ?? null,
      })),
      leftovers: usableLeftovers(state.leftovers, now),
      plan: state.plan.map((meal) => planEntry(meal, planPicks)),
      // A plan the planner proposed, drawn over the plan until accepted or discarded.
      proposal: state.proposal
        ? {
            ...state.proposal,
            meals: state.proposal.meals.map((meal) => planEntry(meal, true)),
          }
        : null,
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
      shopping: shoppingWithShops(ctx.mealService.shoppingList(days), state, today),
      stores: state.stores,
      purchases: ctx.mealService.listPurchases().map((purchase) => ({
        ...purchase,
        // Ways to freeze each line in bags, sized by the planned meals that use it — only while reviewing.
        lines: purchase.lines.map((line) => ({
          ...line,
          bagOptions:
            purchase.status === "review" &&
            line.ingredientId &&
            line.quantity !== null &&
            line.unit &&
            !line.notFood
              ? suggestBags(
                  { quantity: line.quantity, unit: line.unit },
                  bagNeeds(line.ingredientId, state.plan, recipes, today, family)
                )
              : [],
        })),
        storeName: state.stores.find((store) => store.id === purchase.storeId)?.name ?? null,
        check: reconcile(purchase.lines, purchase.total),
        spent: purchaseTotal(purchase),
      })),
      spent: spentSummary(state, days, today),
      priceWatch: state.ingredients
        .map((ingredient) => ({
          ingredientId: ingredient.id,
          name: ingredient.name,
          prices: pricesByStore(state.prices, ingredient.id, state.stores, today, manualPurchaseIds(state)),
        }))
        .filter((entry) => entry.prices.length > 0)
        .sort((a, b) => b.prices.length - a.prices.length || a.name.localeCompare(b.name)),
      // What to take out of the freezer: tonight for tomorrow, and anything still frozen for today.
      defrost: defrostList(state.plan, recipes, state.pantry, today, [today, days[1] ?? today], family),
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
  handle("nimbus:remove-recipe", (_event, id: unknown) => {
    ctx.mealService.removeRecipe(String(id ?? ""));
    removePictureFile("recipe", String(id ?? ""));
  });
  // A recipe's photo: the main process opens the picker and keeps the
  // picture in its own folder — the renderer only names the recipe.
  handle("nimbus:choose-recipe-photo", async (_event, id: unknown) => {
    const recipe = ctx.mealService.getRecipe(String(id ?? ""));
    if (!recipe) throw new Error("That recipe is gone.");
    const saved = await choosePictureFile("recipe", BrowserWindow.getFocusedWindow(), recipe.id);
    if (!saved) return false;
    ctx.mealService.setRecipePhoto(recipe.id, recipePhotoUrl(recipe.id, Date.now()));
    return true;
  });
  handle("nimbus:clear-recipe-photo", (_event, id: unknown) => {
    const recipe = ctx.mealService.getRecipe(String(id ?? ""));
    if (!recipe) throw new Error("That recipe is gone.");
    removePictureFile("recipe", recipe.id);
    ctx.mealService.setRecipePhoto(recipe.id, null);
    return true;
  });
  handle("nimbus:add-stock", (_event, input: unknown) => ctx.mealService.addStock(input));
  handle("nimbus:update-stock", (_event, id: unknown, changes: unknown) =>
    ctx.mealService.updateStock(String(id ?? ""), changes)
  );
  handle("nimbus:correct-stock", (_event, id: unknown, quantity: unknown, unit: unknown, reason: unknown) =>
    ctx.mealService.correctStock(String(id ?? ""), quantity, unit ?? undefined, reason)
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
  handle("nimbus:preview-cook", (_event, recipeId: unknown, servings: unknown, choose: unknown) =>
    ctx.mealService.previewCook(String(recipeId ?? ""), servings, choose)
  );
  handle("nimbus:add-missing-to-shopping", (_event, recipeId: unknown, servings: unknown) =>
    ctx.mealService.addMissingToShopping(String(recipeId ?? ""), servings)
  );
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
  // Purchases: created for review, checked line by line, then confirmed into
  // prices, the pantry and the list — nothing moves before the confirm.
  handle("nimbus:create-purchase", (_event, input: unknown) => ctx.mealService.createPurchase(input));
  // A receipt or invoice: main opens the dialog, reads the file on the PC,
  // and holds what it read for review. The renderer names nothing.
  handle("nimbus:import-receipt", async () => {
    const read = await chooseAndReadReceipt(BrowserWindow.getFocusedWindow());
    if (!read) return null;
    if (!read.lines.length) throw new Error("No purchase lines could be read from that file.");
    return ctx.mealService.createPurchase({
      source: read.source,
      store: read.store,
      date: read.date,
      total: read.total,
      lines: read.lines,
      fileName: read.fileName,
    });
  });
  handle("nimbus:update-purchase", (_event, id: unknown, changes: unknown) =>
    ctx.mealService.updatePurchase(String(id ?? ""), changes)
  );
  handle("nimbus:update-purchase-line", (_event, id: unknown, lineId: unknown, changes: unknown) =>
    ctx.mealService.updatePurchaseLine(String(id ?? ""), String(lineId ?? ""), changes)
  );
  handle("nimbus:confirm-purchase", (_event, id: unknown, apply: unknown) =>
    ctx.mealService.confirmPurchase(String(id ?? ""), apply)
  );
  handle("nimbus:remove-purchase", (_event, id: unknown, options: unknown) =>
    ctx.mealService.removePurchase(String(id ?? ""), options)
  );
  handle("nimbus:mark-shopping", (_event, ingredientId: unknown, kind: unknown, extra: unknown) =>
    ctx.mealService.markShopping(ingredientId, kind ?? null, extra)
  );
  handle("nimbus:import-recipe-url", (_event, url: unknown) => fetchRecipePage(url));
  handle("nimbus:load-demo-meals", () => ctx.mealService.loadDemoData());
  // The planner: a proposal held until accepted, and the replace drawer's options and effects.
  handle("nimbus:generate-plan", (_event, options: unknown) => ctx.mealService.generatePlan(options));
  handle("nimbus:accept-plan", () => ctx.mealService.acceptProposal());
  handle("nimbus:discard-plan", () => ctx.mealService.discardProposal());
  handle("nimbus:replace-options", (_event, mealId: unknown) => ctx.mealService.replaceOptionsFor(mealId));
  handle("nimbus:replace-effect", (_event, mealId: unknown, recipeId: unknown, cost: unknown) =>
    ctx.mealService.effectOfReplacing(mealId, recipeId, cost)
  );
  handle("nimbus:replace-meal", (_event, mealId: unknown, choice: unknown) =>
    ctx.mealService.replaceMeal(mealId, choice)
  );
  handle("nimbus:lock-meal", (_event, mealId: unknown, locked: unknown) =>
    ctx.mealService.lockMeal(mealId, locked)
  );
  handle("nimbus:regenerate-slot", (_event, mealId: unknown) => ctx.mealService.regenerateSlot(mealId));
  handle("nimbus:keep-planned-version", (_event, recipeId: unknown) =>
    ctx.mealService.keepPlannedVersion(recipeId)
  );
  handle("nimbus:remove-demo-meals", () => ctx.mealService.removeDemoData());
}

/** Purchases whose prices were typed in by hand — shown dashed in the price watch. */
function manualPurchaseIds(state: MealsState): Set<string> {
  return new Set(state.purchases.filter((purchase) => purchase.source === "manual").map((p) => p.id));
}

/** What a purchase came to: the printed total, else its lines added up. */
function purchaseTotal(purchase: Purchase): number {
  return (
    purchase.total ?? Math.round(purchase.lines.reduce((sum, line) => sum + (line.price ?? 0), 0) * 100) / 100
  );
}

/**
 * Money actually spent — confirmed purchases only — this week (per day,
 * for the spend bars) and this month, against the monthly budget.
 */
function spentSummary(state: MealsState, days: string[], today: string) {
  const confirmed = state.purchases.filter((purchase) => purchase.status !== "review");
  const month = today.slice(0, 7);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    byDay: days.map((date) => ({
      date,
      amount: round(confirmed.filter((p) => p.date === date).reduce((sum, p) => sum + purchaseTotal(p), 0)),
    })),
    week: round(confirmed.filter((p) => days.includes(p.date)).reduce((sum, p) => sum + purchaseTotal(p), 0)),
    month: round(
      confirmed.filter((p) => p.date.startsWith(month)).reduce((sum, p) => sum + purchaseTotal(p), 0)
    ),
    monthlyBudget: state.preferences.monthlyBudget,
    toReview: state.purchases.filter((purchase) => purchase.status === "review").length,
  };
}

/**
 * The shopping list with shops: each line's prices by shop (cheapest
 * first) and its cost at the cheapest, your notes on it (not in the shop,
 * skipped, bought as something else), what the pantry could stand in for
 * it, and the "two shops" hint. Skipped and substituted lines move out of
 * the list into `setAside`.
 */
function shoppingWithShops(list: ShoppingList, state: MealsState, today: string) {
  const manual = manualPurchaseIds(state);
  const marks = new Map(
    state.shoppingMarks
      .filter((mark) => mark.at >= new Date(Date.now() - 7 * 86_400_000).toISOString())
      .map((mark) => [mark.ingredientId, mark])
  );
  const onHand = new Set(state.pantry.map((item) => item.ingredientId));
  const categoryOf = (id: string) => state.ingredients.find((i) => i.id === id)?.category ?? null;
  const lines = list.lines.map((line) => {
    const prices: StorePrice[] = line.ingredientId
      ? pricesByStore(state.prices, line.ingredientId, state.stores, today, manual)
      : [];
    const base = line.buy ? toBase(line.buy) : null;
    const cheapest = prices[0] ?? null;
    const mark = line.ingredientId ? (marks.get(line.ingredientId) ?? null) : null;
    const category = line.ingredientId ? categoryOf(line.ingredientId) : null;
    return {
      ...line,
      prices,
      cost: cheapest && base ? Math.round(cheapest.pricePerBase * base.quantity * 100) / 100 : line.cost,
      shop: cheapest ? cheapest.storeName : null,
      priceSource: cheapest ? `${cheapest.manual ? "typed" : "receipt"} ${cheapest.date}` : null,
      mark,
      // Foods in the kitchen of the same kind, for "substitute".
      substitutes:
        category && line.ingredientId
          ? state.ingredients
              .filter((i) => i.id !== line.ingredientId && i.category === category && onHand.has(i.id))
              .slice(0, 3)
              .map((i) => ({ id: i.id, name: i.name }))
          : [],
    };
  });
  const setAside = lines.filter((line) => line.mark && line.mark.kind !== "unavailable");
  const kept = lines.filter((line) => !setAside.includes(line));
  const cost = kept.reduce<number | null>(
    (sum, line) => (line.cost === null ? sum : (sum ?? 0) + line.cost),
    null
  );
  return {
    ...list,
    lines: kept,
    setAside: setAside.map((line) => ({
      name: line.name,
      ingredientId: line.ingredientId,
      kind: line.mark!.kind,
      substitute: state.ingredients.find((i) => i.id === line.mark!.substituteId)?.name ?? null,
    })),
    toBuy: kept.length,
    cost: cost === null ? null : Math.round(cost * 100) / 100,
    saving: splitShopSaving(
      kept
        .filter((line) => line.buy && line.prices.length)
        .map((line) => ({ baseQuantity: toBase(line.buy!)?.quantity ?? 0, prices: line.prices }))
    ),
  };
}
