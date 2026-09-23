/**
 * The Meals tab: tonight's dinner, the week's plan, the recipes, the
 * shopping list and what's in the kitchen.
 *
 * Six views behind one row of tabs — Today, Plan, Recipes, Shopping,
 * Pantry and Settings — all drawn from one snapshot (`nimbus:get-meals`),
 * which the main process works out in full: costs, nutrition, what's at
 * home for each recipe, how urgent each expiry date is, and what each day
 * of the week costs. This file is DOM wiring and layout.
 *
 * The layout follows the design mock-up it was drawn from: a hero card
 * for the next meal, panels for nutrition, spend, what needs eating and
 * leftovers, cards for recipes, counters and stock bars in the pantry.
 *
 * Two habits it keeps from the rest of NIMBUS: an estimate always *looks*
 * like an estimate (hatched, dashed, and labelled "≈"), and nothing is
 * deducted, bought or scheduled without the user pressing something.
 */

import {
  MealsView,
  bridge,
  button,
  euro,
  make,
  refresh,
  root,
  setRerender,
  setRoot,
  snapshot,
  state,
} from "./meals/common";
import { pantryView } from "./meals/pantry";
import { planView } from "./meals/plan";
import { recipesView } from "./meals/recipes";
import { settingsView } from "./meals/settings";
import { shoppingView } from "./meals/shopping";
import { todayView } from "./meals/today";

export function initMealsTab(): void {
  setRoot(document.getElementById("mealsRoot"));
  if (!root) return;
  setRerender(render);
  bridge().onMealsChanged(() => void refresh());
  void refresh();
}

function render(): void {
  if (!root) return;
  root.replaceChildren();
  if (!snapshot) {
    root.appendChild(make("p", "feed-empty", "Reading the kitchen…"));
    return;
  }
  const data = snapshot;

  // Header: the tab's name, and what today costs — what's known, and what's a guess.
  const todaySpend = data.spend.find((entry) => entry.date === data.today);
  const header = make("div", "meals-header");
  header.appendChild(make("h6", "kicker", "Meals"));
  const totals = make("div", "meals-header-totals");
  if (todaySpend) {
    if (todaySpend.estimated > 0) {
      totals.append(
        make("span", "meals-estimate", `≈ ${euro(todaySpend.estimated)}`),
        make("span", undefined, " estimated")
      );
    }
    if (todaySpend.confirmed > 0) {
      if (totals.childNodes.length) totals.appendChild(make("span", "meals-dot", "·"));
      totals.appendChild(make("span", undefined, `${euro(todaySpend.confirmed)} confirmed`));
    }
  }
  if (!totals.childNodes.length) totals.appendChild(make("span", undefined, "nothing costed today"));
  header.appendChild(totals);
  root.appendChild(header);

  const views: Array<[MealsView, string]> = [
    ["today", "Today"],
    ["plan", "Plan"],
    ["recipes", "Recipes"],
    ["shopping", "Shopping"],
    ["pantry", "Pantry"],
    ["settings", "Settings"],
  ];
  const nav = make("div", "meals-tabs");
  for (const [view, label] of views) {
    const tab = button(label, `meals-tab${state.view === view ? " is-on" : ""}`, () => {
      state.view = view;
      state.recipeId = null;
      state.editing = null;
      state.planning = null;
      state.recipeServings = null;
      state.message = "";
      render();
    });
    tab.setAttribute("aria-pressed", String(state.view === view));
    nav.appendChild(tab);
  }
  root.appendChild(nav);

  if (state.error) root.appendChild(make("p", "form-error", state.error));
  if (state.message) root.appendChild(make("p", "meals-flash", state.message));

  if (state.view === "today") root.appendChild(todayView(data));
  else if (state.view === "plan") root.appendChild(planView(data));
  else if (state.view === "recipes") root.appendChild(recipesView(data));
  else if (state.view === "shopping") root.appendChild(shoppingView(data));
  else if (state.view === "pantry") root.appendChild(pantryView(data));
  else root.appendChild(settingsView(data));
}
