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

import { MEAL_SLOTS, MEAL_SLOT_LABELS, STORAGE_LABELS, STORAGE_PLACES } from "../meals/types";
import type { MealSlot, PlannedMeal, StoragePlace } from "../meals/types";
import { KNOWN_UNITS, formatAmount, unitLabel } from "../meals/units";

type Confidence = "confirmed" | "estimated";

interface NutritionUI {
  kcal: number | null;
  protein: number | null;
  carbs?: number | null;
  fat?: number | null;
  from: number;
  total: number;
  missing: string[];
}

interface RecipeUI {
  id: string;
  name: string;
  description: string | null;
  slots: MealSlot[];
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: Array<{
    ingredientId: string;
    text: string;
    quantity: number;
    unit: string;
    optional: boolean;
  }>;
  steps: Array<{ text: string; minutes: number | null }>;
  tags: string[];
  source: string | null;
  notes: string | null;
  favourite: boolean;
  timesCooked: number;
  lastCookedAt: string | null;
}

/** What `nimbus:get-meals` returns — the shapes lifecycle.ts builds. */
interface MealsSnapshot {
  today: string;
  servingsNeeded: number;
  preferences: {
    eaters: Array<{ id: string; name: string; portionFactor: number; notes: string | null }>;
    restrictions: string[];
    dislikes: string[];
    slots: MealSlot[];
    dailyBudget: number | null;
    dailyKcal: number | null;
    dailyProtein: number | null;
  };
  ingredients: Array<{ id: string; name: string; unit: string; lastPrice: number | null }>;
  recipes: Array<{
    recipe: RecipeUI;
    minutes: number | null;
    cost: { value: number | null; from: number; total: number; missing: string[] };
    nutrition: NutritionUI;
    coverage: { have: number; total: number };
    lines: Array<{
      text: string;
      ingredientId: string;
      optional: boolean;
      needed: { quantity: number; unit: string };
      status: "have" | "partial" | "missing" | "unknown";
      short: { quantity: number; unit: string } | null;
    }>;
  }>;
  stock: Array<{
    ingredientId: string;
    name: string;
    category: string | null;
    totals: Array<{ unit: string; quantity: number }>;
    items: Array<{
      id: string;
      quantity: number;
      unit: string;
      startQuantity: number;
      place: StoragePlace;
      confidence: Confidence;
      packaging: string | null;
      expiresAt: string | null;
      openedAt: string | null;
    }>;
    confidence: Confidence;
    expiresAt: string | null;
    expiry: "expired" | "urgent" | "soon" | "later" | "none";
  }>;
  leftovers: Array<{ id: string; name: string; portions: number; place: StoragePlace; eatBy: string | null }>;
  plan: Array<{ meal: PlannedMeal; name: string; cost: number | null; nutrition: NutritionUI | null }>;
  spend: Array<{ date: string; total: number | null; confirmed: number; estimated: number; over: boolean }>;
  days: string[];
  shopping: {
    lines: Array<{
      ingredientId: string | null;
      name: string;
      needed: { quantity: number; unit: string } | null;
      have: number | null;
      buy: { quantity: number; unit: string } | null;
      forMeals: string[];
      cost: number | null;
      manual: boolean;
      itemId: string | null;
    }>;
    toBuy: number;
    covered: Array<{ name: string; value: number | null }>;
    cost: number | null;
    unpriced: number;
    unknown: number;
  };
  hasDemoData: boolean;
  weekCost: {
    value: number | null;
    known: number;
    estimated: number;
    unknown: number;
    budget: number | null;
    overBudget: boolean;
  };
}

/** What the importer hands back: a draft to check, never a saved recipe. */
interface ImportedRecipeUI {
  name: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: Array<{
    text: string;
    name: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
    warning: string | null;
  }>;
  steps: string[];
  slots: MealSlot[];
  source: string;
  needsChecking: number;
}

interface MealsBridge {
  getMeals(): Promise<MealsSnapshot>;
  saveRecipe(input: Record<string, unknown>, id?: string): Promise<unknown>;
  removeRecipe(id: string): Promise<void>;
  addStock(input: Record<string, unknown>): Promise<unknown>;
  updateStock(id: string, changes: Record<string, unknown>): Promise<unknown>;
  correctStock(id: string, quantity: number, unit?: string): Promise<unknown>;
  removeStock(id: string): Promise<void>;
  addLeftover(input: Record<string, unknown>): Promise<unknown>;
  updateLeftover(id: string, changes: Record<string, unknown>): Promise<unknown>;
  removeLeftover(id: string): Promise<void>;
  planMeal(input: Record<string, unknown>, id?: string): Promise<unknown>;
  removePlannedMeal(id: string): Promise<void>;
  cookMeal(input: Record<string, unknown>): Promise<{
    deducted: Array<{ name: string; used: string }>;
    short: Array<{ name: string; reason: string }>;
    leftover: { portions: number } | null;
  }>;
  eatLeftover(mealId: string, leftoverId: string, portions: number): Promise<unknown>;
  updateMealPreferences(changes: Record<string, unknown>): Promise<unknown>;
  addShoppingItem(input: Record<string, unknown>): Promise<unknown>;
  removeShoppingItem(id: string): Promise<void>;
  buyItem(input: Record<string, unknown>): Promise<unknown>;
  importRecipeUrl(url: string): Promise<ImportedRecipeUI>;
  loadDemoMeals(): Promise<void>;
  removeDemoMeals(): Promise<void>;
  onMealsChanged(callback: () => void): () => void;
}

const bridge = (): MealsBridge => (window as unknown as { nimbus: MealsBridge }).nimbus;

type MealsView = "today" | "plan" | "recipes" | "shopping" | "pantry" | "settings";
type RecipeFilter = "all" | "home" | "quick" | "cheap" | "favourites" | "imported";

interface MealsUiState {
  view: MealsView;
  recipeId: string | null;
  editing: string | null;
  imported: ImportedRecipeUI | null;
  recipeSearch: string;
  recipeSlot: MealSlot | "all";
  recipeFilter: RecipeFilter;
  recipeSort: "home" | "quick" | "cheap" | "name";
  /** The servings the open recipe page is scaled to. */
  recipeServings: number | null;
  pantryFilter: "all" | StoragePlace | "expiring" | "unconfirmed";
  shoppingGroup: "category" | "meal";
  planning: { date: string; slot: MealSlot; mealId: string | null } | null;
  message: string;
  error: string;
}

const state: MealsUiState = {
  view: "today",
  recipeId: null,
  editing: null,
  imported: null,
  recipeSearch: "",
  recipeSlot: "all",
  recipeFilter: "all",
  recipeSort: "home",
  recipeServings: null,
  pantryFilter: "all",
  shoppingGroup: "category",
  planning: null,
  message: "",
  error: "",
};

let snapshot: MealsSnapshot | null = null;
let root: HTMLElement | null = null;

// ---------- Small builders ----------

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function input(type: string, className = "input"): HTMLInputElement {
  const element = make("input", className);
  element.type = type;
  return element;
}

function select(options: Array<[string, string]>, value?: string): HTMLSelectElement {
  const element = make("select", "select");
  for (const [id, label] of options) element.appendChild(new Option(label, id));
  if (value !== undefined) element.value = value;
  return element;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = make("label", "meals-field");
  wrap.appendChild(make("span", "meals-field-label", label));
  wrap.appendChild(control);
  return wrap;
}

/** A rounded tag: the tab's whole vocabulary of state in one element. */
function pill(
  text: string,
  kind: "calm" | "urgent" | "soon" | "accent" | "est" | "ok" = "calm"
): HTMLElement {
  return make("span", `meals-pill meals-pill-${kind}`, text);
}

/** A titled box, with something optional on the right of its header. */
function panel(title: string, right?: HTMLElement | string): { box: HTMLElement; body: HTMLElement } {
  const box = make("section", "meals-panel");
  const head = make("div", "meals-panel-head");
  head.appendChild(make("h5", undefined, title));
  if (typeof right === "string") head.appendChild(make("span", "meals-panel-note", right));
  else if (right) head.appendChild(right);
  box.appendChild(head);
  const body = make("div", "meals-panel-body");
  box.appendChild(body);
  return { box, body };
}

/** The boxes above a list: a number, a label, and how alarming it is. */
function counter(value: string, label: string, kind: "" | "urgent" | "soon" | "est" = ""): HTMLElement {
  const box = make("div", `meals-counter${kind ? ` meals-counter-${kind}` : ""}`);
  box.append(make("strong", "meals-counter-value", value), make("span", "meals-counter-label", label));
  return box;
}

/** How much of a package is left. Estimated stock is drawn hatched, never solid. */
function stockBar(share: number, estimated: boolean): HTMLElement {
  const bar = make("div", "meals-bar");
  const fill = make("span", estimated ? "meals-bar-est" : undefined);
  fill.style.width = `${Math.max(2, Math.min(100, Math.round(share * 100)))}%`;
  bar.appendChild(fill);
  return bar;
}

/** A dial for one macro: how much of a day's target today's meals come to. */
function ring(percent: number | null, value: string, label: string): HTMLElement {
  const box = make("div", "meals-ring-box");
  const dial = make("div", "meals-ring");
  if (percent === null) dial.classList.add("meals-ring-empty");
  else
    dial.style.background = `conic-gradient(var(--color-accent-400) ${Math.min(100, percent)}%, var(--color-neutral-800) 0)`;
  dial.appendChild(make("span", undefined, percent === null ? "—" : `${Math.round(percent)}%`));
  box.append(dial, make("span", "meals-ring-value", value), make("span", "meals-ring-label", label));
  return box;
}

/** − value + , for servings and portions. */
function stepper(value: number, step: number, min: number, onChange: (next: number) => void): HTMLElement {
  const box = make("div", "meals-stepper");
  let current = value;
  const show = make("span", undefined, String(Math.round(current * 100) / 100));
  const set = (next: number) => {
    current = Math.max(min, Math.round(next * 100) / 100);
    show.textContent = String(current);
    onChange(current);
  };
  box.append(
    button("−", "", () => set(current - step)),
    show,
    button("+", "", () => set(current + step))
  );
  return box;
}

function chip(label: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const element = button(label, `meals-chip${on ? " is-on" : ""}`, onClick);
  element.setAttribute("aria-pressed", String(on));
  return element;
}

const euro = (value: number | null): string =>
  value === null
    ? "—"
    : `${value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

/** "Tue 22 Sep", from an ISO date, without turning it into UTC first. */
function dayLabel(iso: string, weekday: "short" | "long" | undefined = "short"): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", {
    weekday,
    day: "numeric",
    month: "short",
  });
}

/** How an expiry date reads next to a food: "today", "tomorrow", "in 4 days". */
function expiryLabel(iso: string | null, today: string): string {
  if (!iso) return "";
  const days = Math.round(
    (new Date(`${iso}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

const EXPIRY_PILL: Record<string, "urgent" | "soon" | "calm"> = {
  expired: "urgent",
  urgent: "urgent",
  soon: "soon",
  later: "calm",
  none: "calm",
};

/** "19:30" minus the cooking time, as a clock. */
function startTime(time: string, minutes: number | null): string | null {
  if (!minutes) return null;
  const [hours, mins] = time.split(":").map(Number);
  const start = new Date(2000, 0, 1, hours, mins - minutes);
  return `${`${start.getHours()}`.padStart(2, "0")}:${`${start.getMinutes()}`.padStart(2, "0")}`;
}

// ---------- Loading and rendering ----------

async function refresh(): Promise<void> {
  try {
    snapshot = await bridge().getMeals();
    state.error = "";
  } catch (err) {
    state.error = errorText(err);
  }
  render();
}

/** Runs a change, then redraws from a fresh snapshot — every write goes through here. */
async function act(work: () => Promise<unknown>, message = ""): Promise<void> {
  try {
    await work();
    state.message = message;
    state.error = "";
  } catch (err) {
    state.error = errorText(err);
  }
  await refresh();
}

export function initMealsTab(): void {
  root = document.getElementById("mealsRoot");
  if (!root) return;
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

// ---------- Today ----------

function todayView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  const todays = data.plan
    .filter((entry) => entry.meal.date === data.today)
    .sort((a, b) => MEAL_SLOTS.indexOf(a.meal.slot) - MEAL_SLOTS.indexOf(b.meal.slot));
  const next = todays.find((entry) => !entry.meal.cookedAt);

  wrap.appendChild(next ? heroCard(data, next) : emptyHero());

  if (todays.length) {
    const { box, body } = panel(
      "Today's meals",
      button("Open planner →", "meals-link", () => {
        state.view = "plan";
        render();
      })
    );
    const grid = make("div", "meals-meal-grid");
    for (const entry of todays) grid.appendChild(mealCard(entry));
    body.appendChild(grid);
    wrap.appendChild(box);
  }

  const panels = make("div", "meals-panel-grid");
  panels.append(nutritionPanel(data, todays), spendPanel(data), attentionPanel(data), leftoverPanel(data));
  wrap.appendChild(panels);

  const lower = make("div", "meals-panel-grid");
  lower.append(shoppingPanel(data), weekStripPanel(data));
  wrap.appendChild(lower);
  return wrap;
}

function emptyHero(): HTMLElement {
  const hero = make("section", "meals-hero");
  const body = make("div", "meals-hero-body");
  body.append(
    make("p", "card-kicker", "Nothing planned"),
    make("h1", "meals-hero-title", "No meal for today yet"),
    make("p", "meals-hero-text", "Put something in a slot on the Plan, or cook straight from a recipe.")
  );
  const actions = make("div", "meals-row");
  actions.append(
    button("Open the plan", "btn btn-primary", () => {
      state.view = "plan";
      render();
    }),
    button("Browse recipes", "btn btn-secondary", () => {
      state.view = "recipes";
      render();
    })
  );
  body.appendChild(actions);
  hero.appendChild(body);
  return hero;
}

function heroCard(data: MealsSnapshot, entry: MealsSnapshot["plan"][number]): HTMLElement {
  const recipe = data.recipes.find((r) => r.recipe.id === entry.meal.recipeId);
  const hero = make("section", "meals-hero");
  const body = make("div", "meals-hero-body");
  const head = make("div");
  head.appendChild(
    make(
      "p",
      "card-kicker",
      `${dayLabel(data.today, "long")} · ${MEAL_SLOT_LABELS[entry.meal.slot].toLowerCase()}${entry.meal.time ? ` at ${entry.meal.time}` : ""}`
    )
  );
  head.appendChild(make("h1", "meals-hero-title", entry.name));

  // The sentence under the title says what is actually about to happen.
  const cookServings = entry.meal.cookServings ?? entry.meal.servings;
  const extra = cookServings - entry.meal.servings;
  const start = entry.meal.time && recipe ? startTime(entry.meal.time, recipe.minutes) : null;
  const sentence = [
    recipe
      ? `Cooking ${cookServings} portion${cookServings === 1 ? "" : "s"} for ${entry.meal.servings} ${entry.meal.servings === 1 ? "person" : "people"}.`
      : entry.meal.kind === "out"
        ? "Eating out — nothing to cook."
        : "",
    extra > 0 ? `The ${extra} extra become${extra === 1 ? "s" : ""} leftovers.` : "",
    start ? `Start cooking by ${start}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (sentence) head.appendChild(make("p", "meals-hero-text", sentence));
  body.appendChild(head);

  const facts = make("div", "meals-facts");
  const fact = (label: string, value: string) => {
    const box = make("div", "meals-fact");
    box.append(make("span", "card-kicker", label), make("span", "meals-fact-value", value));
    facts.appendChild(box);
  };
  if (recipe?.minutes) fact("Time", `${recipe.minutes} min`);
  if (entry.nutrition?.kcal) fact("Per serving", `≈ ${entry.nutrition.kcal} kcal`);
  fact("Cost", entry.cost === null ? "—" : `≈ ${euro(entry.cost)}`);
  if (recipe) fact("At home", `${recipe.coverage.have} of ${recipe.coverage.total}`);
  body.appendChild(facts);

  const actions = make("div", "meals-row");
  if (recipe) {
    actions.append(
      button("Start cooking", "btn btn-primary", () => openCook(recipe.recipe.id, entry.meal)),
      button("View recipe", "btn btn-secondary", () => openRecipe(recipe.recipe.id))
    );
  }
  if (entry.meal.kind === "leftover" && entry.meal.leftoverId) {
    actions.appendChild(
      button(
        "Eat leftovers",
        "btn btn-primary",
        () =>
          void act(
            () => bridge().eatLeftover(entry.meal.id, entry.meal.leftoverId!, entry.meal.servings),
            "Leftovers eaten."
          )
      )
    );
  }
  actions.appendChild(
    button("Swap", "btn btn-ghost", () => {
      state.view = "plan";
      state.planning = { date: entry.meal.date, slot: entry.meal.slot, mealId: entry.meal.id };
      render();
    })
  );
  body.appendChild(actions);
  hero.appendChild(body);

  // The right-hand column: what the recipe is short of, or that nothing is.
  const side = make("div", "meals-hero-side");
  if (recipe) {
    const missing = recipe.lines.filter((line) => !line.optional && line.status !== "have");
    side.appendChild(make("p", "card-kicker", missing.length ? "Not at home" : "Everything is in"));
    const list = make("div", "meals-hero-list");
    for (const line of missing.slice(0, 6)) {
      const row = make("div", "meals-hero-line");
      row.append(
        make("span", undefined, line.text),
        pill(line.short ? formatAmount(line.short) : "missing", "urgent")
      );
      list.appendChild(row);
    }
    if (!missing.length)
      list.appendChild(make("p", "meals-hero-text", "The pantry covers every ingredient this recipe needs."));
    side.appendChild(list);
    if (missing.length)
      side.appendChild(
        button("See the shopping list", "meals-link", () => {
          state.view = "shopping";
          render();
        })
      );
  }
  hero.appendChild(side);
  return hero;
}

function mealCard(entry: MealsSnapshot["plan"][number]): HTMLElement {
  const card = make("article", `meals-meal-card${entry.meal.cookedAt ? " is-done" : ""}`);
  const top = make("div", "meals-meal-top");
  top.append(
    make(
      "span",
      "card-kicker",
      `${MEAL_SLOT_LABELS[entry.meal.slot]}${entry.meal.time ? ` · ${entry.meal.time}` : ""}`
    ),
    make(
      "span",
      "meals-meal-state",
      entry.meal.cookedAt
        ? "cooked"
        : entry.meal.kind === "out"
          ? "out"
          : entry.meal.kind === "leftover"
            ? "leftovers"
            : "planned"
    )
  );
  card.append(top, make("div", "meals-meal-name", entry.name));
  const pills = make("div", "meals-row meals-row-tight");
  if (entry.nutrition?.kcal) pills.appendChild(pill(`≈ ${entry.nutrition.kcal} kcal`));
  pills.appendChild(entry.cost === null ? pill("no price", "est") : pill(`≈ ${euro(entry.cost)}`));
  card.appendChild(pills);
  const actions = make("div", "meals-row meals-row-tight");
  if (!entry.meal.cookedAt && entry.meal.kind === "recipe" && entry.meal.recipeId)
    actions.appendChild(button("Cook", "meals-link", () => openCook(entry.meal.recipeId!, entry.meal)));
  actions.appendChild(
    button("Edit", "meals-link", () => {
      state.view = "plan";
      state.planning = { date: entry.meal.date, slot: entry.meal.slot, mealId: entry.meal.id };
      render();
    })
  );
  card.appendChild(actions);
  return card;
}

function nutritionPanel(data: MealsSnapshot, todays: MealsSnapshot["plan"]): HTMLElement {
  const { box, body } = panel("Nutrition today", pill("≈ per person · estimate", "est"));
  const eaten = todays.filter((entry) => entry.nutrition);
  const totals = eaten.reduce(
    (sum, entry) => ({
      kcal: sum.kcal + (entry.nutrition?.kcal ?? 0),
      protein: sum.protein + (entry.nutrition?.protein ?? 0),
    }),
    { kcal: 0, protein: 0 }
  );
  const targets = data.preferences;
  const rings = make("div", "meals-rings");
  rings.append(
    ring(
      targets.dailyKcal ? (totals.kcal / targets.dailyKcal) * 100 : null,
      `${Math.round(totals.kcal)} kcal`,
      "Calories"
    ),
    ring(
      targets.dailyProtein ? (totals.protein / targets.dailyProtein) * 100 : null,
      `${Math.round(totals.protein)} g`,
      "Protein"
    )
  );
  body.appendChild(rings);
  const withoutData = todays.length - eaten.length;
  body.appendChild(
    make(
      "p",
      "meals-note",
      [
        targets.dailyKcal || targets.dailyProtein
          ? "% of the daily target set in Settings"
          : "Set a daily target in Settings to see how far through the day this is",
        withoutData ? `${withoutData} of today's meals have no nutrition data` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  return box;
}

function spendPanel(data: MealsSnapshot): HTMLElement {
  const budget = data.preferences.dailyBudget;
  const { box, body } = panel(
    "Food spend · this week",
    budget === null ? "no budget set" : `${euro(budget)}/day budget`
  );
  const peak = Math.max(1, ...data.spend.map((entry) => entry.total ?? 0), budget ?? 0);
  const chart = make("div", "meals-spend");
  for (const entry of data.spend) {
    const column = make("div", "meals-spend-col");
    column.title = `${dayLabel(entry.date)}: ${entry.total === null ? "nothing costed" : euro(entry.total)}`;
    const area = make("div", "meals-spend-area");
    if (budget !== null) {
      const line = make("div", "meals-spend-budget");
      line.style.bottom = `${(budget / peak) * 100}%`;
      area.appendChild(line);
    }
    // Two stacked parts: what is known, and above it what is only estimated.
    const stack = make("div", "meals-spend-stack");
    const known = make("div", `meals-spend-fill${entry.over ? " is-over" : ""}`);
    known.style.height = `${((entry.confirmed || 0) / peak) * 100}%`;
    const estimated = make("div", `meals-spend-fill meals-spend-est${entry.over ? " is-over" : ""}`);
    estimated.style.height = `${(Math.max(0, entry.estimated) / peak) * 100}%`;
    stack.append(estimated, known);
    area.appendChild(stack);
    column.append(area, make("span", "meals-spend-label", dayLabel(entry.date).split(" ")[0]));
    chart.appendChild(column);
  }
  body.appendChild(chart);
  const week = data.weekCost;
  body.appendChild(
    make(
      "p",
      "meals-note",
      `Hatched = estimated from ingredient prices · ${week.value === null ? "nothing costed" : `week ≈ ${euro(week.value)}`}${week.budget === null ? "" : ` of ${euro(week.budget)}`}`
    )
  );
  if (week.overBudget)
    body.appendChild(
      pill(
        `Over budget by ${euro(Math.round(((week.value ?? 0) - (week.budget ?? 0)) * 100) / 100)}`,
        "urgent"
      )
    );
  return box;
}

function attentionPanel(data: MealsSnapshot): HTMLElement {
  const urgent = data.stock.filter(
    (item) => item.expiry === "urgent" || item.expiry === "expired" || item.expiry === "soon"
  );
  const unconfirmed = data.stock.filter((item) => item.confidence === "estimated");
  const { box, body } = panel(
    "Needs attention",
    button("Pantry →", "meals-link", () => {
      state.view = "pantry";
      render();
    })
  );
  const list = make("div", "meals-lines");
  for (const item of urgent.slice(0, 5)) {
    const row = make("div", "meals-line");
    row.append(
      make("strong", undefined, item.name),
      make(
        "span",
        "meals-line-meta",
        item.totals.map((total) => formatAmount({ quantity: total.quantity, unit: total.unit })).join(" · ")
      ),
      pill(
        item.expiry === "expired"
          ? `expired ${expiryLabel(item.expiresAt, data.today)}`
          : `use ${expiryLabel(item.expiresAt, data.today)}`,
        EXPIRY_PILL[item.expiry]
      )
    );
    list.appendChild(row);
  }
  for (const item of unconfirmed.slice(0, 3)) {
    const row = make("div", "meals-line");
    row.append(
      make("strong", undefined, item.name),
      make("span", "meals-line-meta", "NIMBUS worked this out — check it when you can"),
      pill("estimated", "est")
    );
    list.appendChild(row);
  }
  if (!list.childNodes.length)
    list.appendChild(make("p", "meals-note", "Nothing going off, and no guesses to check."));
  body.appendChild(list);
  return box;
}

function leftoverPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "Leftovers",
    `${data.leftovers.reduce((sum, l) => sum + l.portions, 0)} portions`
  );
  const list = make("div", "meals-lines");
  for (const leftover of data.leftovers.slice(0, 6)) {
    const row = make("div", "meals-line");
    row.append(
      make("strong", undefined, leftover.name),
      make(
        "span",
        "meals-line-meta",
        `${leftover.portions} portion${leftover.portions === 1 ? "" : "s"} · ${STORAGE_LABELS[leftover.place].toLowerCase()}`
      ),
      leftover.eatBy ? pill(`eat by ${expiryLabel(leftover.eatBy, data.today)}`, "soon") : pill("no date")
    );
    row.appendChild(
      button(
        "Ate one",
        "meals-link",
        () =>
          void act(() =>
            bridge().updateLeftover(leftover.id, { portions: Math.max(0, leftover.portions - 1) })
          )
      )
    );
    list.appendChild(row);
  }
  if (!data.leftovers.length)
    list.appendChild(
      make("p", "meals-note", "Nothing cooked and kept. Cooking more than you eat records it here.")
    );
  body.appendChild(list);
  return box;
}

function shoppingPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "Shopping",
    button("Open list →", "meals-link", () => {
      state.view = "shopping";
      render();
    })
  );
  body.appendChild(
    make(
      "p",
      "meals-big",
      data.shopping.cost === null ? `${data.shopping.toBuy} items` : `≈ ${euro(data.shopping.cost)}`
    )
  );
  body.appendChild(
    make(
      "p",
      "meals-note",
      [
        `${data.shopping.toBuy} item${data.shopping.toBuy === 1 ? "" : "s"} to buy`,
        data.shopping.covered.length ? `${data.shopping.covered.length} covered by the pantry` : null,
        data.shopping.unpriced ? `${data.shopping.unpriced} with no price yet` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  return box;
}

function weekStripPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "This week's dinners",
    button("Planner →", "meals-link", () => {
      state.view = "plan";
      render();
    })
  );
  const strip = make("div", "meals-daypills");
  for (const date of data.days) {
    const dinner = data.plan.find((entry) => entry.meal.date === date && entry.meal.slot === "dinner");
    const cell = make("div", `meals-daypill${date === data.today ? " is-today" : ""}`);
    cell.append(
      make("span", "meals-daypill-day", dayLabel(date).split(" ")[0]),
      make("span", "meals-daypill-name", dinner ? dinner.name : "—")
    );
    if (dinner && dinner.cost !== null)
      cell.appendChild(make("span", "meals-daypill-cost", `≈ ${euro(dinner.cost)}`));
    strip.appendChild(cell);
  }
  body.appendChild(strip);
  return box;
}

// ---------- Plan ----------

function planView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    make(
      "p",
      "meals-note",
      `Cooking for ${data.servingsNeeded} serving${data.servingsNeeded === 1 ? "" : "s"}, from the people in Settings. Click a slot to fill it.`
    )
  );
  if (state.planning) wrap.appendChild(planEditor(data, state.planning));

  const grid = make("div", "meals-week");
  for (const date of data.days) {
    const column = make("div", `meals-day${date === data.today ? " is-today" : ""}`);
    const spend = data.spend.find((entry) => entry.date === date);
    const head = make("div", "meals-day-head");
    head.append(
      make("span", "meals-day-name", dayLabel(date)),
      make("span", "meals-day-cost", !spend || spend.total === null ? "" : `≈ ${euro(spend.total)}`)
    );
    column.appendChild(head);
    for (const slot of data.preferences.slots) {
      const entry = data.plan.find((p) => p.meal.date === date && p.meal.slot === slot);
      const cell = make(
        "div",
        `meals-cell${entry ? "" : " is-empty"}${entry?.meal.cookedAt ? " is-done" : ""}${entry?.meal.kind === "leftover" ? " is-leftover" : ""}`
      );
      cell.appendChild(make("span", "card-kicker", MEAL_SLOT_LABELS[slot]));
      if (entry) {
        cell.appendChild(
          button(entry.name, "meals-cell-name", () => {
            state.planning = { date, slot, mealId: entry.meal.id };
            render();
          })
        );
        cell.appendChild(
          make(
            "span",
            "meals-cell-meta",
            [
              `${entry.meal.servings}p`,
              entry.cost === null ? null : `≈ ${euro(entry.cost)}`,
              entry.meal.cookedAt ? "cooked" : null,
            ]
              .filter(Boolean)
              .join(" · ")
          )
        );
      } else {
        cell.appendChild(
          button("+ Add", "meals-cell-add", () => {
            state.planning = { date, slot, mealId: null };
            render();
          })
        );
      }
      column.appendChild(cell);
    }
    grid.appendChild(column);
  }
  wrap.appendChild(grid);
  return wrap;
}

function planEditor(
  data: MealsSnapshot,
  target: { date: string; slot: MealSlot; mealId: string | null }
): HTMLElement {
  const existing = target.mealId ? data.plan.find((p) => p.meal.id === target.mealId)?.meal : undefined;
  const { box, body } = panel(
    `${existing ? "Edit" : "Add"} · ${dayLabel(target.date)} · ${MEAL_SLOT_LABELS[target.slot]}`
  );
  box.classList.add("meals-dialog");
  const kind = select(
    [
      ["recipe", "A recipe"],
      ["leftover", "Leftovers"],
      ["custom", "Something I'll make"],
      ["out", "Eating out"],
    ],
    existing?.kind ?? "recipe"
  );
  const recipePicker = select(
    data.recipes.map(
      (r) =>
        [r.recipe.id, `${r.recipe.name} (${r.coverage.have}/${r.coverage.total} at home)`] as [string, string]
    ),
    existing?.recipeId ?? undefined
  );
  const leftoverPicker = select(
    data.leftovers.map((l) => [l.id, `${l.name} — ${l.portions} portion(s)`] as [string, string]),
    existing?.leftoverId ?? undefined
  );
  const name = input("text");
  name.maxLength = 200;
  name.placeholder = "Name";
  name.value = existing?.name ?? "";
  const servings = input("number");
  servings.min = "1";
  servings.value = String(existing?.servings ?? data.servingsNeeded);
  const cookServings = input("number");
  cookServings.min = "1";
  cookServings.placeholder = "same";
  cookServings.value = existing?.cookServings ? String(existing.cookServings) : "";
  const time = input("time");
  time.value = existing?.time ?? "";
  const cost = input("number");
  cost.step = "0.01";
  cost.min = "0";
  cost.placeholder = "optional";
  cost.value = existing?.cost !== null && existing?.cost !== undefined ? String(existing.cost) : "";

  const rows = make("div", "meals-form");
  const recipeField = field("Recipe", recipePicker);
  const leftoverField = field("Leftovers", leftoverPicker);
  const nameField = field("Name", name);
  rows.append(
    field("What", kind),
    recipeField,
    leftoverField,
    nameField,
    field("Servings", servings),
    field("Cook servings", cookServings),
    field("Time", time),
    field("Cost €", cost)
  );
  const applyKind = () => {
    recipeField.hidden = kind.value !== "recipe";
    leftoverField.hidden = kind.value !== "leftover";
    nameField.hidden = kind.value === "recipe" || kind.value === "leftover";
  };
  kind.addEventListener("change", applyKind);
  applyKind();
  body.appendChild(rows);
  if (!data.recipes.length) body.appendChild(make("p", "meals-note", "No recipes yet — add one in Recipes."));

  const actions = make("div", "meals-row");
  actions.appendChild(
    button(
      existing ? "Save" : "Add to plan",
      "btn btn-primary",
      () =>
        void act(async () => {
          await bridge().planMeal(
            {
              date: target.date,
              slot: target.slot,
              kind: kind.value,
              recipeId: kind.value === "recipe" ? recipePicker.value : null,
              leftoverId: kind.value === "leftover" ? leftoverPicker.value : null,
              name: name.value || null,
              servings: Number(servings.value) || 1,
              cookServings: cookServings.value ? Number(cookServings.value) : null,
              time: time.value || null,
              cost: cost.value ? Number(cost.value) : null,
            },
            existing?.id
          );
          state.planning = null;
        })
    )
  );
  if (existing)
    actions.appendChild(
      button(
        "Remove",
        "btn btn-ghost",
        () =>
          void act(async () => {
            await bridge().removePlannedMeal(existing.id);
            state.planning = null;
          })
      )
    );
  actions.appendChild(
    button("Cancel", "btn btn-ghost", () => {
      state.planning = null;
      render();
    })
  );
  body.appendChild(actions);
  return box;
}

// ---------- Cooking ----------

/**
 * The cook panel: how many servings are being cooked, how many are eaten
 * now, and where the rest go. It lists what will come out of the pantry
 * before it comes out — the deduction is never a surprise — and nothing
 * happens until "Mark cooked".
 */
function openCook(recipeId: string, meal?: PlannedMeal): void {
  if (!snapshot) return;
  const entry = snapshot.recipes.find((r) => r.recipe.id === recipeId);
  if (!entry) return;
  const wanted = meal?.cookServings ?? meal?.servings ?? snapshot.servingsNeeded;
  let cooking = wanted;
  let eating = meal?.servings ?? wanted;
  const { box, body } = panel(`Cook · ${entry.recipe.name}`);
  box.classList.add("meals-dialog");

  const form = make("div", "meals-form");
  const place = select(
    STORAGE_PLACES.filter((p) => p !== "cupboard").map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "fridge"
  );
  const skip = input("checkbox", "");
  form.append(
    field(
      "Cooking",
      stepper(cooking, 1, 1, (next) => (cooking = next))
    ),
    field(
      "Eaten now",
      stepper(eating, 1, 1, (next) => (eating = next))
    ),
    field("Extra goes to", place),
    field("Don't touch the pantry", skip)
  );
  body.appendChild(form);

  const lines = make("div", "meals-lines");
  for (const line of entry.lines.filter((l) => !l.optional)) {
    const row = make("div", "meals-line");
    row.append(
      make("span", "meals-amount", formatAmount(line.needed)),
      make("strong", undefined, line.text),
      line.status === "have"
        ? pill("at home", "ok")
        : pill(
            line.status === "partial"
              ? `short ${line.short ? formatAmount(line.short) : ""}`
              : line.status === "unknown"
                ? "can't measure"
                : "missing",
            "urgent"
          )
    );
    lines.appendChild(row);
  }
  body.append(
    make("p", "meals-note", `For ${entry.recipe.servings} servings — scaled to what you cook.`),
    lines
  );

  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Mark cooked",
      "btn btn-primary",
      () =>
        void act(async () => {
          const result = await bridge().cookMeal({
            mealId: meal?.id,
            recipeId,
            cookServings: cooking,
            eatServings: eating,
            leftoverPlace: place.value,
            skipPantry: skip.checked,
          });
          const parts = [
            result.deducted.length ? `${result.deducted.length} item(s) taken out of the pantry` : null,
            result.leftover ? `${result.leftover.portions} portion(s) kept as leftovers` : null,
            result.short.length ? `short of: ${result.short.map((s) => s.name).join(", ")}` : null,
          ].filter(Boolean);
          state.message = parts.length ? `Cooked. ${parts.join(" · ")}.` : "Cooked.";
        })
    ),
    button("Cancel", "btn btn-ghost", () => render())
  );
  body.appendChild(actions);
  root?.appendChild(box);
  box.scrollIntoView({ block: "nearest" });
}

// ---------- Recipes ----------

function openRecipe(id: string): void {
  state.view = "recipes";
  state.recipeId = id;
  state.recipeServings = null;
  render();
}

function recipesView(data: MealsSnapshot): HTMLElement {
  if (state.editing) return recipeEditor(data, state.editing);
  if (state.recipeId) {
    const entry = data.recipes.find((r) => r.recipe.id === state.recipeId);
    if (entry) return recipePage(data, entry);
    state.recipeId = null;
  }
  const wrap = make("div", "meals-view");

  // Category chips with counts, as the mock-up has them.
  const slots: Array<[MealSlot | "all", string]> = [
    ["all", "All recipes"],
    ["breakfast", "Breakfast"],
    ["lunch", "Lunch"],
    ["dinner", "Dinner"],
    ["snack", "Snacks"],
    ["dessert", "Dessert"],
  ];
  const slotRow = make("div", "meals-chips");
  for (const [slot, label] of slots) {
    const count =
      slot === "all" ? data.recipes.length : data.recipes.filter((r) => r.recipe.slots.includes(slot)).length;
    if (!count && slot !== "all") continue;
    slotRow.appendChild(
      chip(`${label} ${count}`, state.recipeSlot === slot, () => {
        state.recipeSlot = slot;
        render();
      })
    );
  }
  wrap.appendChild(slotRow);

  const filters: Array<[RecipeFilter, string, (r: MealsSnapshot["recipes"][number]) => boolean]> = [
    ["all", "No filter", () => true],
    ["home", "All at home", (r) => r.coverage.total > 0 && r.coverage.have === r.coverage.total],
    ["quick", "≤ 30 min", (r) => (r.minutes ?? 999) <= 30],
    ["cheap", "≤ 2 €/serving", (r) => (r.cost.value ?? 99) / Math.max(1, r.recipe.servings) <= 2],
    ["favourites", "Favourites", (r) => r.recipe.favourite],
    ["imported", "Imported", (r) => Boolean(r.recipe.source && r.recipe.source.startsWith("http"))],
  ];
  const filterRow = make("div", "meals-chips");
  for (const [id, label, test] of filters) {
    const count = id === "all" ? data.recipes.length : data.recipes.filter(test).length;
    if (!count && id !== "all") continue;
    filterRow.appendChild(
      chip(id === "all" ? label : `${label} ${count}`, state.recipeFilter === id, () => {
        state.recipeFilter = id;
        render();
      })
    );
  }
  wrap.appendChild(filterRow);

  const controls = make("div", "meals-toolbar");
  const search = input("search");
  search.placeholder = "Search recipes";
  search.value = state.recipeSearch;
  search.addEventListener("input", () => {
    state.recipeSearch = search.value;
    render();
    const again = root?.querySelector("input[type=search]") as HTMLInputElement | null;
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  });
  const sort = select(
    [
      ["home", "Sort: most at home"],
      ["quick", "Sort: quickest"],
      ["cheap", "Sort: cheapest"],
      ["name", "Sort: name"],
    ],
    state.recipeSort
  );
  sort.addEventListener("change", () => {
    state.recipeSort = sort.value as MealsUiState["recipeSort"];
    render();
  });
  controls.append(
    search,
    sort,
    button("+ New recipe", "btn btn-primary", () => {
      state.editing = "new";
      render();
    }),
    button("Import from a URL", "btn btn-secondary", () => openImport())
  );
  wrap.appendChild(controls);

  const term = state.recipeSearch.trim().toLowerCase();
  const filterTest = filters.find(([id]) => id === state.recipeFilter)![2];
  const recipes = data.recipes
    .filter((entry) => state.recipeSlot === "all" || entry.recipe.slots.includes(state.recipeSlot))
    .filter(filterTest)
    .filter(
      (entry) =>
        !term ||
        entry.recipe.name.toLowerCase().includes(term) ||
        entry.recipe.tags.some((tag) => tag.toLowerCase().includes(term)) ||
        entry.recipe.ingredients.some((line) => line.text.toLowerCase().includes(term))
    )
    .sort((a, b) => {
      if (state.recipeSort === "quick") return (a.minutes ?? 9999) - (b.minutes ?? 9999);
      if (state.recipeSort === "cheap")
        return (
          (a.cost.value ?? 9999) / Math.max(1, a.recipe.servings) -
          (b.cost.value ?? 9999) / Math.max(1, b.recipe.servings)
        );
      if (state.recipeSort === "home")
        return (
          b.coverage.have / Math.max(1, b.coverage.total) - a.coverage.have / Math.max(1, a.coverage.total) ||
          a.recipe.name.localeCompare(b.recipe.name)
        );
      return a.recipe.name.localeCompare(b.recipe.name);
    });

  wrap.appendChild(
    make(
      "p",
      "meals-note",
      `${recipes.length} recipe${recipes.length === 1 ? "" : "s"} · sorted by ${
        state.recipeSort === "home"
          ? "how much is at home"
          : state.recipeSort === "quick"
            ? "time"
            : state.recipeSort === "cheap"
              ? "cost per serving"
              : "name"
      }`
    )
  );
  if (!recipes.length)
    wrap.appendChild(
      make("p", "feed-empty", "Nothing matches. Add a recipe, or load the demo data in Settings.")
    );

  const grid = make("div", "meals-recipe-grid");
  for (const entry of recipes) grid.appendChild(recipeCard(entry));
  wrap.appendChild(grid);
  return wrap;
}

function recipeCard(entry: MealsSnapshot["recipes"][number]): HTMLElement {
  const card = make("button", "meals-recipe-card");
  (card as HTMLButtonElement).type = "button";
  card.addEventListener("click", () => openRecipe(entry.recipe.id));
  const head = make("div", "meals-recipe-head");
  head.append(
    make("span", "card-kicker", entry.recipe.slots.map((slot) => MEAL_SLOT_LABELS[slot]).join(" · ")),
    make("span", "meals-recipe-home", `${entry.coverage.have}/${entry.coverage.total} at home`)
  );
  card.append(head, make("span", "meals-recipe-name", entry.recipe.name));
  if (entry.recipe.description) card.appendChild(make("span", "meals-recipe-desc", entry.recipe.description));
  const pills = make("div", "meals-row meals-row-tight");
  if (entry.minutes) pills.appendChild(pill(`⏱ ${entry.minutes} min`));
  if (entry.nutrition.kcal) pills.appendChild(pill(`≈ ${entry.nutrition.kcal} kcal`));
  if (entry.nutrition.protein) pills.appendChild(pill(`${entry.nutrition.protein} g protein`));
  pills.appendChild(
    entry.cost.value === null
      ? pill("no price", "est")
      : pill(`≈ ${euro(entry.cost.value / Math.max(1, entry.recipe.servings))}/serving`, "accent")
  );
  if (entry.recipe.favourite) pills.appendChild(pill("favourite", "accent"));
  card.appendChild(pills);
  return card;
}

function recipePage(data: MealsSnapshot, entry: MealsSnapshot["recipes"][number]): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    button("← All recipes", "meals-link", () => {
      state.recipeId = null;
      render();
    })
  );
  const servings = state.recipeServings ?? entry.recipe.servings;
  const factor = servings / Math.max(1, entry.recipe.servings);

  const hero = make("section", "meals-hero meals-hero-recipe");
  const body = make("div", "meals-hero-body");
  body.appendChild(
    make(
      "p",
      "card-kicker",
      [
        entry.recipe.slots.map((slot) => MEAL_SLOT_LABELS[slot]).join(" · "),
        entry.recipe.tags.join(" · "),
        entry.recipe.source?.startsWith("http") ? "Imported" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  body.appendChild(make("h1", "meals-hero-title", entry.recipe.name));
  if (entry.recipe.description) body.appendChild(make("p", "meals-hero-text", entry.recipe.description));

  const facts = make("div", "meals-facts");
  const fact = (label: string, value: string | HTMLElement) => {
    const box = make("div", "meals-fact");
    box.appendChild(make("span", "card-kicker", label));
    if (typeof value === "string") box.appendChild(make("span", "meals-fact-value", value));
    else box.appendChild(value);
    facts.appendChild(box);
  };
  fact(
    "Servings",
    stepper(servings, 1, 1, (next) => {
      state.recipeServings = next;
      render();
    })
  );
  if (entry.minutes)
    fact("Prep · cook", `${entry.recipe.prepMinutes ?? 0} · ${entry.recipe.cookMinutes ?? 0} min`);
  fact(
    "Per serving",
    entry.nutrition.kcal === null
      ? "—"
      : `≈ ${entry.nutrition.kcal} kcal${entry.nutrition.protein ? ` · ${entry.nutrition.protein} g protein` : ""}`
  );
  fact(
    "Cost",
    entry.cost.value === null
      ? "—"
      : `≈ ${euro(entry.cost.value * factor)} · ${euro(entry.cost.value / Math.max(1, entry.recipe.servings))}/serving`
  );
  body.appendChild(facts);

  const actions = make("div", "meals-row");
  actions.append(
    button("Cook now", "btn btn-primary", () => openCook(entry.recipe.id)),
    button("Add to plan", "btn btn-secondary", () => {
      state.view = "plan";
      state.planning = { date: data.today, slot: entry.recipe.slots[0] ?? "dinner", mealId: null };
      render();
    }),
    button("Edit", "btn btn-ghost", () => {
      state.editing = entry.recipe.id;
      render();
    }),
    button(
      "Delete",
      "btn btn-ghost",
      () =>
        void act(async () => {
          await bridge().removeRecipe(entry.recipe.id);
          state.recipeId = null;
        })
    )
  );
  body.appendChild(actions);
  hero.appendChild(body);
  wrap.appendChild(hero);

  const columns = make("div", "meals-recipe-columns");

  const ingredients = panel("Ingredients", `${entry.coverage.have} of ${entry.coverage.total} at home`);
  const lines = make("div", "meals-lines");
  for (const line of entry.lines) {
    const row = make("div", "meals-line");
    row.append(
      make(
        "span",
        "meals-amount",
        formatAmount({ quantity: line.needed.quantity * factor, unit: line.needed.unit })
      ),
      make("strong", undefined, line.text)
    );
    row.appendChild(
      line.status === "have"
        ? pill("at home", "ok")
        : line.optional
          ? pill("optional")
          : pill(
              line.status === "partial"
                ? `short ${line.short ? formatAmount(line.short) : ""}`
                : line.status === "unknown"
                  ? "can't measure"
                  : "not at home",
              "urgent"
            )
    );
    lines.appendChild(row);
  }
  ingredients.body.appendChild(lines);
  const missing = entry.lines.filter((line) => !line.optional && line.status !== "have").length;
  if (missing)
    ingredients.body.appendChild(
      button(`See the ${missing} missing on the shopping list`, "meals-link", () => {
        state.view = "shopping";
        render();
      })
    );
  columns.appendChild(ingredients.box);

  const side = make("div", "meals-recipe-side");
  const nutrition = panel("Nutrition", pill("≈ estimate", "est"));
  const table = make("div", "meals-kv-list");
  const kv = (label: string, value: string) => {
    const row = make("div", "meals-kv");
    row.append(make("span", undefined, label), make("strong", undefined, value));
    table.appendChild(row);
  };
  kv("Calories", entry.nutrition.kcal === null ? "—" : `${entry.nutrition.kcal} kcal`);
  kv("Protein", entry.nutrition.protein === null ? "—" : `${entry.nutrition.protein} g`);
  if (entry.nutrition.carbs !== undefined)
    kv("Carbs", entry.nutrition.carbs === null ? "—" : `${entry.nutrition.carbs} g`);
  if (entry.nutrition.fat !== undefined)
    kv("Fat", entry.nutrition.fat === null ? "—" : `${entry.nutrition.fat} g`);
  nutrition.body.appendChild(table);
  nutrition.body.appendChild(
    make(
      "p",
      "meals-note",
      entry.nutrition.from
        ? `From ${entry.nutrition.from} of ${entry.nutrition.total} ingredients${entry.nutrition.missing.length ? ` · no data for ${entry.nutrition.missing.join(", ")}` : ""}`
        : "No nutrition data for these ingredients yet"
    )
  );
  side.appendChild(nutrition.box);

  const inPlan = data.plan.filter((p) => p.meal.recipeId === entry.recipe.id);
  const planPanel = panel("In your plan", `${inPlan.length}`);
  if (inPlan.length) {
    const list = make("div", "meals-lines");
    for (const planned of inPlan.slice(0, 8)) {
      const row = make("div", "meals-line");
      row.append(
        make(
          "span",
          undefined,
          `${dayLabel(planned.meal.date)} · ${MEAL_SLOT_LABELS[planned.meal.slot].toLowerCase()}`
        ),
        make("span", "meals-line-meta", `×${planned.meal.cookServings ?? planned.meal.servings}`),
        planned.meal.cookedAt ? pill("cooked", "ok") : pill("planned")
      );
      list.appendChild(row);
    }
    planPanel.body.appendChild(list);
  } else planPanel.body.appendChild(make("p", "meals-note", "Not planned yet."));
  side.appendChild(planPanel.box);

  const history = panel("History");
  const historyList = make("div", "meals-kv-list");
  const hkv = (label: string, value: string) => {
    const row = make("div", "meals-kv");
    row.append(make("span", undefined, label), make("strong", undefined, value));
    historyList.appendChild(row);
  };
  hkv("Cooked", entry.recipe.timesCooked ? `${entry.recipe.timesCooked} times` : "never");
  hkv(
    "Last",
    entry.recipe.lastCookedAt
      ? new Date(entry.recipe.lastCookedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      : "—"
  );
  history.body.appendChild(historyList);
  if (entry.recipe.source)
    history.body.appendChild(make("p", "meals-note", `Source: ${entry.recipe.source}`));
  side.appendChild(history.box);
  columns.appendChild(side);
  wrap.appendChild(columns);

  if (entry.recipe.steps.length) {
    wrap.appendChild(make("h5", "kicker collection-heading", "Method"));
    const steps = make("div", "meals-steps");
    entry.recipe.steps.forEach((step, index) => {
      const row = make("div", "meals-step");
      row.append(make("span", "meals-step-n", String(index + 1)), make("p", undefined, step.text));
      steps.appendChild(row);
    });
    wrap.appendChild(steps);
  }
  return wrap;
}

/**
 * Import from a URL: the main process fetches the page and reads the
 * recipe data most cooking sites publish for search engines. What comes
 * back opens in the editor as a draft, with the doubtful lines flagged.
 * Nothing is saved until you press Save.
 */
function openImport(): void {
  const { box, body } = panel("Import a recipe");
  box.classList.add("meals-dialog");
  const url = input("url");
  url.placeholder = "https://...";
  const form = make("div", "meals-form");
  form.appendChild(field("Recipe page", url));
  body.appendChild(form);
  body.appendChild(
    make(
      "p",
      "meals-note",
      "No page is shown and nothing is saved until you check it. A site that publishes no recipe data can't be imported."
    )
  );
  const actions = make("div", "meals-row");
  const go = button("Read the page", "btn btn-primary", async () => {
    go.disabled = true;
    go.textContent = "Reading...";
    try {
      state.imported = await bridge().importRecipeUrl(url.value);
      state.editing = "new";
      state.error = "";
      state.message = state.imported.needsChecking
        ? `Imported. ${state.imported.needsChecking} line(s) need a look before saving.`
        : "Imported — check it and save.";
    } catch (err) {
      state.error = errorText(err);
    }
    render();
  });
  actions.append(
    go,
    button("Cancel", "btn btn-ghost", () => render())
  );
  body.appendChild(actions);
  root?.appendChild(box);
  url.focus();
}

function recipeEditor(data: MealsSnapshot, id: string): HTMLElement {
  const existing = id === "new" ? undefined : data.recipes.find((r) => r.recipe.id === id)?.recipe;
  // A draft read off a web page fills the editor instead of an empty form.
  const draft = existing ? null : state.imported;
  const wrap = make("div", "meals-view");
  const { box, body } = panel(existing ? "Edit recipe" : draft ? "Imported recipe" : "New recipe");
  if (draft)
    body.appendChild(
      make(
        "p",
        "meals-note",
        `From ${draft.source}${draft.needsChecking ? ` · ${draft.needsChecking} line(s) below need an amount or a unit` : ""}`
      )
    );

  const name = input("text");
  name.maxLength = 200;
  name.value = existing?.name ?? draft?.name ?? "";
  const servings = input("number");
  servings.min = "1";
  servings.value = String(existing?.servings ?? draft?.servings ?? 2);
  const prep = input("number");
  prep.min = "0";
  prep.value = minutesValue(existing?.prepMinutes, draft?.prepMinutes);
  const cook = input("number");
  cook.min = "0";
  cook.value = minutesValue(existing?.cookMinutes, draft?.cookMinutes);
  const description = make("textarea", "input meals-textarea");
  description.value = existing?.description ?? draft?.description ?? "";
  const tags = input("text");
  tags.value = existing?.tags.join(", ") ?? "";
  tags.placeholder = "comma separated";

  const form = make("div", "meals-form");
  form.append(
    field("Name", name),
    field("Servings", servings),
    field("Prep (min)", prep),
    field("Cook (min)", cook),
    field("Tags", tags)
  );
  body.appendChild(form);

  const slotBoxes = new Map<MealSlot, HTMLInputElement>();
  const slotRow = make("div", "meals-chips");
  for (const slot of MEAL_SLOTS) {
    const label = make("label", "meals-check");
    const boxInput = input("checkbox", "");
    boxInput.checked = existing
      ? existing.slots.includes(slot)
      : draft?.slots.length
        ? draft.slots.includes(slot)
        : slot === "dinner";
    slotBoxes.set(slot, boxInput);
    label.append(boxInput, document.createTextNode(` ${MEAL_SLOT_LABELS[slot]}`));
    slotRow.appendChild(label);
  }
  body.append(make("p", "meals-field-label", "Suits"), slotRow, field("Description", description));

  body.appendChild(make("h6", "kicker", "Ingredients"));
  const linesBox = make("div", "meals-lines");
  const lineRows: Array<{
    name: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLSelectElement;
    optional: HTMLInputElement;
  }> = [];
  const addLine = (line?: {
    text: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
    warning?: string | null;
  }) => {
    const row = make("div", `meals-line meals-line-edit${line?.warning ? " has-warning" : ""}`);
    const lineName = input("text");
    lineName.placeholder = "Ingredient";
    lineName.maxLength = 200;
    lineName.value = line?.text ?? "";
    const quantity = input("number");
    quantity.step = "0.01";
    quantity.min = "0";
    quantity.value = line?.quantity === null || line?.quantity === undefined ? "" : String(line.quantity);
    const unit = select(
      KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
      line?.unit ?? "g"
    );
    const optional = input("checkbox", "");
    optional.checked = line?.optional ?? false;
    const optionalLabel = make("label", "meals-check");
    optionalLabel.append(optional, document.createTextNode(" optional"));
    const entry = { name: lineName, quantity, unit, optional };
    lineRows.push(entry);
    row.append(quantity, unit, lineName, optionalLabel);
    if (line?.warning) row.appendChild(pill(line.warning, "urgent"));
    row.appendChild(
      button("✕", "meals-link", () => {
        const index = lineRows.indexOf(entry);
        if (index >= 0) lineRows.splice(index, 1);
        row.remove();
      })
    );
    linesBox.appendChild(row);
  };
  for (const line of existing?.ingredients ?? []) addLine(line);
  for (const line of draft?.ingredients ?? [])
    addLine({
      text: line.name,
      quantity: line.quantity,
      unit: line.unit,
      optional: line.optional,
      warning: line.warning,
    });
  if (!existing && !draft) addLine();
  body.append(
    linesBox,
    button("+ Add ingredient", "meals-link", () => addLine())
  );

  body.appendChild(make("h6", "kicker", "Method"));
  const steps = make("textarea", "input meals-textarea meals-steps-input");
  steps.value = existing
    ? existing.steps.map((step) => step.text).join("\n")
    : (draft?.steps ?? []).join("\n");
  steps.placeholder = "One step per line";
  body.appendChild(steps);

  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Save recipe",
      "btn btn-primary",
      () =>
        void act(async () => {
          await bridge().saveRecipe(
            {
              name: name.value,
              description: description.value || null,
              servings: Number(servings.value) || 2,
              prepMinutes: prep.value ? Number(prep.value) : null,
              cookMinutes: cook.value ? Number(cook.value) : null,
              slots: [...slotBoxes.entries()]
                .filter(([, boxInput]) => boxInput.checked)
                .map(([slot]) => slot),
              tags: tags.value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
              ingredients: lineRows
                .filter((row) => row.name.value.trim() && row.quantity.value)
                .map((row) => ({
                  name: row.name.value,
                  text: row.name.value,
                  quantity: Number(row.quantity.value),
                  unit: row.unit.value,
                  optional: row.optional.checked,
                })),
              steps: steps.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((text) => ({ text })),
              source: draft?.source ?? null,
            },
            existing?.id
          );
          state.editing = null;
          state.imported = null;
        }, "Recipe saved.")
    ),
    button("Cancel", "btn btn-ghost", () => {
      state.editing = null;
      state.imported = null;
      render();
    })
  );
  body.appendChild(actions);
  wrap.appendChild(box);
  return wrap;
}

/** A minutes field: the saved recipe's value, else an imported one, else empty. */
function minutesValue(saved: number | null | undefined, imported: number | null | undefined): string {
  const value = saved ?? imported ?? null;
  return value === null ? "" : String(value);
}

// ---------- Shopping ----------

/**
 * The list is worked out from the plan every time, so there is nothing to
 * tick: **Bought** puts the food in the pantry, and the line disappears
 * because the kitchen now covers it.
 */
function shoppingView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  const list = data.shopping;

  const counters = make("div", "meals-counters");
  counters.append(
    counter(String(list.toBuy), "to buy"),
    counter(list.cost === null ? "—" : `≈ ${euro(list.cost)}`, "estimated", "est"),
    counter(String(list.covered.length), "covered by the pantry"),
    counter(String(list.unpriced), "with no price yet", list.unpriced ? "soon" : "")
  );
  wrap.appendChild(counters);

  const toolbar = make("div", "meals-toolbar");
  const manualName = input("text");
  manualName.placeholder = "Bin bags, something for Sunday…";
  const manualQuantity = input("number");
  manualQuantity.step = "0.01";
  manualQuantity.min = "0";
  manualQuantity.placeholder = "amount";
  const manualUnit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    "piece"
  );
  toolbar.append(
    manualName,
    manualQuantity,
    manualUnit,
    button(
      "Add",
      "btn btn-secondary",
      () =>
        void act(
          () =>
            bridge().addShoppingItem({
              name: manualName.value,
              quantity: manualQuantity.value ? Number(manualQuantity.value) : null,
              unit: manualUnit.value,
            }),
          "Added to the list."
        )
    )
  );
  const grouping = make("div", "meals-chips");
  grouping.append(
    chip("By category", state.shoppingGroup === "category", () => {
      state.shoppingGroup = "category";
      render();
    }),
    chip("By meal", state.shoppingGroup === "meal", () => {
      state.shoppingGroup = "meal";
      render();
    })
  );
  wrap.append(toolbar, grouping);

  if (!list.lines.length) {
    wrap.appendChild(
      make(
        "p",
        "feed-empty",
        "Nothing to buy — the pantry covers what's planned. Plan more meals, or add something by hand."
      )
    );
    return wrap;
  }

  // Grouped either by the food's category, or by the meal that wants it.
  const categories = new Map<string, string>();
  for (const stock of data.stock) if (stock.category) categories.set(stock.ingredientId, stock.category);
  const groups = new Map<string, typeof list.lines>();
  for (const line of list.lines) {
    const keys =
      state.shoppingGroup === "meal"
        ? line.manual
          ? ["Added by hand"]
          : line.forMeals.length
            ? line.forMeals
            : ["Other"]
        : [
            line.manual
              ? "Added by hand"
              : (line.ingredientId && categories.get(line.ingredientId)) || "Other",
          ];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  for (const [title, lines] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = make("section", "meals-group");
    const head = make("div", "meals-group-head");
    const groupCost = lines.reduce<number | null>(
      (sum, line) => (line.cost === null ? sum : (sum ?? 0) + line.cost),
      null
    );
    head.append(
      make("h6", undefined, title),
      make("span", "meals-group-meta", `${lines.length} item${lines.length === 1 ? "" : "s"}`),
      make("span", "meals-group-cost", groupCost === null ? "" : `≈ ${euro(groupCost)}`)
    );
    group.appendChild(head);
    for (const line of lines) {
      const row = make("div", "meals-srow");
      const what = make("div", "meals-srow-what");
      what.append(
        make("strong", undefined, line.name),
        make(
          "span",
          "meals-line-meta",
          line.manual ? "added by hand" : line.forMeals.length ? `for ${line.forMeals.join(", ")}` : ""
        )
      );
      row.appendChild(what);
      row.appendChild(
        make(
          "span",
          "meals-srow-need",
          line.needed
            ? `${formatAmount(line.needed)} needed${line.have ? ` · ${formatAmount({ quantity: line.have, unit: line.needed.unit })} at home` : ""}`
            : "amount unclear"
        )
      );
      row.appendChild(make("span", "meals-srow-buy", line.buy ? formatAmount(line.buy) : "—"));
      row.appendChild(make("span", "meals-srow-price", line.cost === null ? "" : `≈ ${euro(line.cost)}`));
      const actions = make("span", "meals-srow-actions");
      if (line.buy)
        actions.appendChild(
          button("Bought", "btn btn-secondary", () =>
            openBuy({
              name: line.name,
              ingredientId: line.ingredientId,
              quantity: line.buy!.quantity,
              unit: line.buy!.unit,
              itemId: line.itemId,
            })
          )
        );
      if (line.manual && line.itemId)
        actions.appendChild(
          button("Remove", "meals-link", () => void act(() => bridge().removeShoppingItem(line.itemId!)))
        );
      row.appendChild(actions);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }

  if (list.covered.length) {
    const { box, body } = panel("Already in the kitchen", `${list.covered.length}`);
    body.appendChild(
      make(
        "p",
        "meals-note",
        list.covered
          .map((entry) => `${entry.name}${entry.value === null ? "" : ` (≈ ${euro(entry.value)})`}`)
          .join(" · ")
      )
    );
    wrap.appendChild(box);
  }
  wrap.appendChild(
    make(
      "p",
      "meals-note",
      "The list is the week's meals added up, minus the pantry — worked out each time you open it. Marking something bought puts it in the pantry, which is what makes the line go away."
    )
  );
  return wrap;
}

/** Buying: how much came home, what it cost, and where it goes. */
function openBuy(line: {
  name: string;
  ingredientId: string | null;
  quantity: number;
  unit: string;
  itemId: string | null;
}): void {
  const { box, body } = panel(`Bought · ${line.name}`);
  box.classList.add("meals-dialog");
  const quantity = input("number");
  quantity.step = "0.01";
  quantity.min = "0";
  quantity.value = String(line.quantity);
  const unit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    line.unit
  );
  const paid = input("number");
  paid.step = "0.01";
  paid.min = "0";
  paid.placeholder = "optional";
  const place = select(
    STORAGE_PLACES.map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "cupboard"
  );
  const expires = input("date");
  const form = make("div", "meals-form");
  form.append(
    field("Amount", quantity),
    field("Unit", unit),
    field("Paid €", paid),
    field("Where", place),
    field("Use by", expires)
  );
  body.appendChild(form);
  body.appendChild(
    make(
      "p",
      "meals-note",
      "What you paid becomes this food's price per unit, so recipe costs stop being guesses."
    )
  );
  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Put in the pantry",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().buyItem({
              itemId: line.itemId,
              ingredientId: line.ingredientId,
              name: line.name,
              quantity: Number(quantity.value),
              unit: unit.value,
              paid: paid.value ? Number(paid.value) : null,
              place: place.value,
              expiresAt: expires.value || null,
            }),
          `${line.name} is in the pantry.`
        )
    ),
    button("Cancel", "btn btn-ghost", () => render())
  );
  body.appendChild(actions);
  root?.appendChild(box);
  box.scrollIntoView({ block: "nearest" });
}

// ---------- Pantry ----------

function pantryView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");

  const counts = {
    urgent: data.stock.filter((s) => s.expiry === "urgent" || s.expiry === "expired").length,
    soon: data.stock.filter((s) => s.expiry === "soon").length,
    estimated: data.stock.filter((s) => s.confidence === "estimated").length,
    confirmed: data.stock.filter((s) => s.confidence === "confirmed").length,
  };
  const counters = make("div", "meals-counters");
  counters.append(
    counter(String(counts.urgent), "expire within 48 h", counts.urgent ? "urgent" : ""),
    counter(String(counts.soon), "expire this week", counts.soon ? "soon" : ""),
    counter(String(counts.estimated), "need a quick check", counts.estimated ? "est" : ""),
    counter(String(counts.confirmed), `of ${data.stock.length} confirmed`)
  );
  wrap.appendChild(counters);

  const filters: Array<[MealsUiState["pantryFilter"], string]> = [
    ["all", "All"],
    ["cupboard", "Cupboard"],
    ["fridge", "Fridge"],
    ["freezer", "Freezer"],
    ["expiring", "Expiring"],
    ["unconfirmed", "Estimated"],
  ];
  const chips = make("div", "meals-chips");
  for (const [filter, label] of filters)
    chips.appendChild(
      chip(label, state.pantryFilter === filter, () => {
        state.pantryFilter = filter;
        render();
      })
    );
  wrap.appendChild(chips);
  wrap.appendChild(addStockForm(data));

  const stock = data.stock.filter((item) => {
    if (state.pantryFilter === "all") return true;
    if (state.pantryFilter === "expiring")
      return item.expiry === "urgent" || item.expiry === "soon" || item.expiry === "expired";
    if (state.pantryFilter === "unconfirmed") return item.confidence === "estimated";
    return item.items.some((entry) => entry.place === state.pantryFilter);
  });
  if (!stock.length)
    wrap.appendChild(make("p", "feed-empty", "Nothing here yet — add what's in the kitchen above."));

  // Grouped by where it's kept, which is how you actually look for food.
  const places: StoragePlace[] = ["fridge", "freezer", "cupboard"];
  for (const place of places) {
    const placeFilter =
      state.pantryFilter === "cupboard" || state.pantryFilter === "fridge" || state.pantryFilter === "freezer"
        ? state.pantryFilter
        : null;
    if (placeFilter && placeFilter !== place) continue;
    const rows = stock.flatMap((summary) =>
      summary.items.filter((item) => item.place === place).map((item) => ({ summary, item }))
    );
    if (!rows.length) continue;
    const group = make("section", "meals-group");
    const head = make("div", "meals-group-head");
    head.append(
      make("h6", undefined, STORAGE_LABELS[place]),
      make("span", "meals-group-meta", `${rows.length} item${rows.length === 1 ? "" : "s"}`)
    );
    group.appendChild(head);
    for (const { summary, item } of rows) {
      const row = make("div", "meals-prow");
      const what = make("div", "meals-prow-what");
      what.append(make("strong", undefined, summary.name));
      const meta = [summary.category, item.packaging, item.openedAt ? "opened" : null]
        .filter(Boolean)
        .join(" · ");
      if (meta) what.appendChild(make("span", "meals-line-meta", meta));
      row.appendChild(what);

      const amount = make("div", "meals-prow-amount");
      amount.appendChild(
        make("span", "meals-amount", formatAmount({ quantity: item.quantity, unit: item.unit }))
      );
      amount.appendChild(
        stockBar(
          item.startQuantity > 0 ? item.quantity / item.startQuantity : 1,
          item.confidence === "estimated"
        )
      );
      row.appendChild(amount);

      const tags = make("div", "meals-prow-tags");
      tags.appendChild(item.confidence === "estimated" ? pill("estimated", "est") : pill("confirmed", "ok"));
      if (item.expiresAt) {
        const level = summary.items.length === 1 ? summary.expiry : "later";
        tags.appendChild(pill(`use ${expiryLabel(item.expiresAt, data.today)}`, EXPIRY_PILL[level]));
      }
      row.appendChild(tags);

      const actions = make("div", "meals-prow-actions");
      actions.append(
        button("Correct", "btn btn-secondary", () =>
          openCorrect(item.id, summary.name, item.quantity, item.unit)
        ),
        button("Remove", "meals-link", () => void act(() => bridge().removeStock(item.id)))
      );
      row.appendChild(actions);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }

  const leftovers = make("section", "meals-group");
  const head = make("div", "meals-group-head");
  head.append(
    make("h6", undefined, "Prepared food & leftovers"),
    make("span", "meals-group-meta", `${data.leftovers.reduce((sum, l) => sum + l.portions, 0)} portions`)
  );
  leftovers.appendChild(head);
  for (const leftover of data.leftovers) {
    const row = make("div", "meals-prow");
    const what = make("div", "meals-prow-what");
    what.append(
      make("strong", undefined, leftover.name),
      make("span", "meals-line-meta", STORAGE_LABELS[leftover.place])
    );
    row.append(
      what,
      make("div", "meals-prow-amount", `${leftover.portions} portion${leftover.portions === 1 ? "" : "s"}`)
    );
    const tags = make("div", "meals-prow-tags");
    tags.appendChild(pill("cooked", "accent"));
    if (leftover.eatBy) tags.appendChild(pill(`eat by ${expiryLabel(leftover.eatBy, data.today)}`, "soon"));
    row.appendChild(tags);
    const actions = make("div", "meals-prow-actions");
    actions.append(
      button(
        "Ate one",
        "btn btn-secondary",
        () =>
          void act(() =>
            bridge().updateLeftover(leftover.id, { portions: Math.max(0, leftover.portions - 1) })
          )
      ),
      button("Remove", "meals-link", () => void act(() => bridge().removeLeftover(leftover.id)))
    );
    row.appendChild(actions);
    leftovers.appendChild(row);
  }
  if (!data.leftovers.length)
    leftovers.appendChild(
      make("p", "meals-note", "Nothing cooked and kept. Cooking more than you eat records it here.")
    );
  wrap.appendChild(leftovers);

  wrap.appendChild(
    make(
      "p",
      "meals-note",
      "Estimated stock is what NIMBUS worked out from the recipes you cooked — the hatched bars. Correcting an amount makes it confirmed again."
    )
  );
  return wrap;
}

function addStockForm(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel("Add stock");
  const name = input("text");
  name.placeholder = "Food";
  name.setAttribute("list", "mealsIngredientNames");
  const datalist = make("datalist");
  datalist.id = "mealsIngredientNames";
  for (const ingredient of data.ingredients) datalist.appendChild(new Option(ingredient.name));
  const quantity = input("number");
  quantity.step = "0.01";
  quantity.min = "0";
  const unit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    "g"
  );
  const place = select(
    STORAGE_PLACES.map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "cupboard"
  );
  const expires = input("date");
  const form = make("div", "meals-form");
  form.append(
    field("Food", name),
    field("Amount", quantity),
    field("Unit", unit),
    field("Where", place),
    field("Use by", expires)
  );
  body.append(form, datalist);
  body.appendChild(
    button(
      "Add to pantry",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().addStock({
              name: name.value,
              quantity: Number(quantity.value),
              unit: unit.value,
              place: place.value,
              expiresAt: expires.value || null,
            }),
          "Added."
        )
    )
  );
  return box;
}

/** "Correct stock": what's actually there. Whatever the number, it becomes confirmed. */
function openCorrect(itemId: string, name: string, quantity: number, unit: string): void {
  const { box, body } = panel(`Correct stock · ${name}`);
  box.classList.add("meals-dialog");
  body.appendChild(
    make(
      "p",
      "meals-note",
      `NIMBUS thinks there is ${formatAmount({ quantity, unit })}. What's actually there?`
    )
  );
  const amount = input("number");
  amount.step = "0.01";
  amount.min = "0";
  amount.value = String(quantity);
  const form = make("div", "meals-form");
  form.appendChild(field(`Amount (${unitLabel(unit)})`, amount));
  body.appendChild(form);
  const actions = make("div", "meals-row");
  actions.append(
    button(
      "None left",
      "btn btn-ghost",
      () => void act(() => bridge().correctStock(itemId, 0), "Confirmed: none left.")
    ),
    button(
      "Half",
      "btn btn-ghost",
      () =>
        void act(
          () => bridge().correctStock(itemId, Math.round((quantity / 2) * 100) / 100),
          "Stock confirmed."
        )
    ),
    button(
      "Confirm amount",
      "btn btn-primary",
      () => void act(() => bridge().correctStock(itemId, Number(amount.value)), "Stock confirmed.")
    ),
    button("Cancel", "btn btn-ghost", () => render())
  );
  body.appendChild(actions);
  root?.appendChild(box);
  box.scrollIntoView({ block: "nearest" });
}

// ---------- Settings ----------

function settingsView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");

  const people = panel(
    "People eating",
    `${data.servingsNeeded} serving${data.servingsNeeded === 1 ? "" : "s"} a meal`
  );
  const eaters = data.preferences.eaters.map((eater) => ({ ...eater }));
  const list = make("div", "meals-lines");
  const drawEaters = () => {
    list.replaceChildren();
    eaters.forEach((eater, index) => {
      const row = make("div", "meals-line meals-line-edit");
      const name = input("text");
      name.value = eater.name;
      name.addEventListener("input", () => (eaters[index].name = name.value));
      const notes = input("text");
      notes.placeholder = "No mushrooms";
      notes.value = eater.notes ?? "";
      notes.addEventListener("input", () => (eaters[index].notes = notes.value || null));
      row.append(
        name,
        notes,
        stepper(eater.portionFactor, 0.2, 0.2, (next) => (eaters[index].portionFactor = next)),
        button("✕", "meals-link", () => {
          eaters.splice(index, 1);
          drawEaters();
        })
      );
      list.appendChild(row);
    });
    if (!eaters.length) list.appendChild(make("p", "meals-note", "Nobody yet — one serving a meal."));
  };
  drawEaters();
  people.body.appendChild(list);
  people.body.appendChild(
    make("p", "meals-note", "A label, a multiplier and a note. No profiles, no accounts.")
  );
  const peopleActions = make("div", "meals-row");
  peopleActions.append(
    button("+ Add person", "btn btn-secondary", () => {
      eaters.push({ id: "", name: "Someone", portionFactor: 1, notes: null });
      drawEaters();
    }),
    button(
      "Save people",
      "btn btn-primary",
      () => void act(() => bridge().updateMealPreferences({ eaters }), "Saved.")
    )
  );
  people.body.appendChild(peopleActions);
  wrap.appendChild(people.box);

  const rules = panel("Budget & targets");
  const budget = input("number");
  budget.step = "0.5";
  budget.min = "0";
  budget.placeholder = "none";
  budget.value = data.preferences.dailyBudget === null ? "" : String(data.preferences.dailyBudget);
  const kcal = input("number");
  kcal.min = "0";
  kcal.placeholder = "none";
  kcal.value = data.preferences.dailyKcal === null ? "" : String(data.preferences.dailyKcal);
  const protein = input("number");
  protein.min = "0";
  protein.placeholder = "none";
  protein.value = data.preferences.dailyProtein === null ? "" : String(data.preferences.dailyProtein);
  const restrictions = input("text");
  restrictions.value = data.preferences.restrictions.join(", ");
  restrictions.placeholder = "No pork, Gluten-free";
  const dislikes = input("text");
  dislikes.value = data.preferences.dislikes.join(", ");
  dislikes.placeholder = "Mushrooms, coriander";
  const form = make("div", "meals-form");
  form.append(
    field("Budget €/day", budget),
    field("Calories/day", kcal),
    field("Protein g/day", protein),
    field("Never suggest", restrictions),
    field("Avoid when possible", dislikes)
  );
  rules.body.appendChild(form);
  if (data.preferences.dailyBudget !== null)
    rules.body.appendChild(
      make(
        "p",
        "meals-note",
        `${euro(data.preferences.dailyBudget)} a day is about ${euro(Math.round(data.preferences.dailyBudget * 30 * 100) / 100)} a month.`
      )
    );
  rules.body.appendChild(
    make(
      "p",
      "meals-note",
      "Restrictions and dislikes are kept for the meal generator, which isn't built yet — nothing filters recipes today."
    )
  );

  const chosenSlots = new Map<MealSlot, boolean>();
  const slotRow = make("div", "meals-chips");
  for (const slot of MEAL_SLOTS) {
    chosenSlots.set(slot, data.preferences.slots.includes(slot));
    const slotChip = chip(MEAL_SLOT_LABELS[slot], chosenSlots.get(slot)!, () => {
      const next = !chosenSlots.get(slot);
      chosenSlots.set(slot, next);
      slotChip.classList.toggle("is-on", next);
      slotChip.setAttribute("aria-pressed", String(next));
    });
    slotRow.appendChild(slotChip);
  }
  rules.body.append(make("p", "meals-field-label", "Meal slots the plan shows"), slotRow);
  rules.body.appendChild(
    button(
      "Save",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().updateMealPreferences({
              restrictions: restrictions.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
              dislikes: dislikes.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
              dailyBudget: budget.value ? Number(budget.value) : null,
              dailyKcal: kcal.value ? Number(kcal.value) : null,
              dailyProtein: protein.value ? Number(protein.value) : null,
              slots: [...chosenSlots.entries()].filter(([, on]) => on).map(([slot]) => slot),
            }),
          "Saved."
        )
    )
  );
  wrap.appendChild(rules.box);

  const demo = panel("Demo data", data.hasDemoData ? pill("loaded", "accent") : undefined);
  demo.body.appendChild(
    make(
      "p",
      "meals-note",
      data.hasDemoData
        ? "A demo kitchen is loaded. Removing it takes out exactly what it added — anything you made yourself stays, including your own stock of a demo ingredient."
        : "Fills the tab with a kitchen to try it on: foods with prices and nutrition, four recipes, a stocked pantry with something going off tomorrow, leftovers in the fridge, and meals planned around today."
    )
  );
  demo.body.appendChild(
    data.hasDemoData
      ? button(
          "Remove demo data",
          "btn btn-secondary",
          () => void act(() => bridge().removeDemoMeals(), "Demo data removed.")
        )
      : button(
          "Load demo data",
          "btn btn-secondary",
          () => void act(() => bridge().loadDemoMeals(), "Demo data loaded.")
        )
  );
  wrap.appendChild(demo.box);
  return wrap;
}
