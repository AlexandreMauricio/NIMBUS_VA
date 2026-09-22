/**
 * The Meals tab: what's being eaten today, the week's plan, the recipes,
 * and what's in the kitchen.
 *
 * Five views behind one row of buttons — Today, Plan, Recipes, Pantry and
 * Settings — all drawn from one snapshot (`nimbus:get-meals`), which the
 * main process works out in full: costs, nutrition, what's at home for each
 * recipe, and how urgent each expiry date is. This file is DOM wiring.
 *
 * Two habits it keeps from the rest of NIMBUS: an estimate is always
 * labelled as one (stock NIMBUS worked out, a cost from the last price
 * paid), and nothing is ever deducted or scheduled without the user
 * pressing something.
 */

import { MEAL_SLOTS, MEAL_SLOT_LABELS, STORAGE_LABELS, STORAGE_PLACES } from "../meals/types";
import type { MealSlot, PlannedMeal, StoragePlace } from "../meals/types";
import { KNOWN_UNITS, formatAmount, unitLabel } from "../meals/units";

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
  };
  ingredients: Array<{ id: string; name: string; unit: string; lastPrice: number | null }>;
  recipes: Array<{
    recipe: {
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
    };
    minutes: number | null;
    cost: { value: number | null; from: number; total: number; missing: string[] };
    nutrition: {
      kcal: number | null;
      protein: number | null;
      from: number;
      total: number;
      missing: string[];
    };
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
    totals: Array<{ unit: string; quantity: number }>;
    items: Array<{
      id: string;
      quantity: number;
      unit: string;
      place: StoragePlace;
      confidence: "confirmed" | "estimated";
      packaging: string | null;
      expiresAt: string | null;
      openedAt: string | null;
    }>;
    confidence: "confirmed" | "estimated";
    expiresAt: string | null;
    expiry: "expired" | "urgent" | "soon" | "later" | "none";
  }>;
  leftovers: Array<{
    id: string;
    name: string;
    portions: number;
    place: StoragePlace;
    eatBy: string | null;
  }>;
  plan: Array<{ meal: PlannedMeal; name: string; cost: number | null }>;
  days: string[];
  weekCost: {
    value: number | null;
    known: number;
    estimated: number;
    unknown: number;
    budget: number | null;
    overBudget: boolean;
  };
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
  onMealsChanged(callback: () => void): () => void;
}

const bridge = (): MealsBridge => (window as unknown as { nimbus: MealsBridge }).nimbus;

type MealsView = "today" | "plan" | "recipes" | "pantry" | "settings";

interface MealsUiState {
  view: MealsView;
  /** The recipe whose page is open, or null for the list. */
  recipeId: string | null;
  /** The recipe being edited ("new" for a fresh one), or null. */
  editing: string | null;
  recipeSearch: string;
  recipeSort: "home" | "quick" | "cheap" | "name";
  pantryFilter: "all" | StoragePlace | "expiring" | "unconfirmed";
  /** The plan slot whose editor is open. */
  planning: { date: string; slot: MealSlot; mealId: string | null } | null;
  message: string;
  error: string;
}

const state: MealsUiState = {
  view: "today",
  recipeId: null,
  editing: null,
  recipeSearch: "",
  recipeSort: "home",
  pantryFilter: "all",
  planning: null,
  message: "",
  error: "",
};

let snapshot: MealsSnapshot | null = null;
let root: HTMLElement | null = null;

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

const euro = (value: number | null): string =>
  value === null
    ? "—"
    : `${value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

/** "Tue 22 Sep", from an ISO date, without turning it into UTC first. */
function dayLabel(iso: string, withWeekday = true): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-GB", {
    weekday: withWeekday ? "short" : undefined,
    day: "numeric",
    month: "short",
  });
}

/** How an expiry date reads next to a food: "today", "tomorrow", "in 4 days", "2 days ago". */
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

const EXPIRY_CLASS: Record<string, string> = {
  expired: "meals-pill meals-pill-urgent",
  urgent: "meals-pill meals-pill-urgent",
  soon: "meals-pill meals-pill-soon",
  later: "meals-pill",
  none: "meals-pill",
};

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
  const views: Array<[MealsView, string]> = [
    ["today", "Today"],
    ["plan", "Plan"],
    ["recipes", "Recipes"],
    ["pantry", "Pantry"],
    ["settings", "Settings"],
  ];
  const nav = make("div", "meals-views");
  for (const [view, label] of views) {
    const tab = button(label, `btn ${state.view === view ? "btn-secondary" : "btn-ghost"}`, () => {
      state.view = view;
      state.recipeId = null;
      state.editing = null;
      state.planning = null;
      state.message = "";
      render();
    });
    tab.setAttribute("aria-pressed", String(state.view === view));
    nav.appendChild(tab);
  }
  root.appendChild(nav);

  if (state.error) root.appendChild(make("p", "form-error", state.error));
  if (state.message) root.appendChild(make("p", "collection-meta", state.message));
  if (!snapshot) {
    root.appendChild(make("p", "feed-empty", "Reading the kitchen…"));
    return;
  }
  if (state.view === "today") root.appendChild(todayView(snapshot));
  else if (state.view === "plan") root.appendChild(planView(snapshot));
  else if (state.view === "recipes") root.appendChild(recipesView(snapshot));
  else if (state.view === "pantry") root.appendChild(pantryView(snapshot));
  else root.appendChild(settingsView(snapshot));
}

// ---------- Today ----------

function todayView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  const todays = data.plan
    .filter((entry) => entry.meal.date === data.today)
    .sort((a, b) => MEAL_SLOTS.indexOf(a.meal.slot) - MEAL_SLOTS.indexOf(b.meal.slot));
  const next = todays.find((entry) => !entry.meal.cookedAt);

  if (next) {
    const recipe = data.recipes.find((r) => r.recipe.id === next.meal.recipeId);
    const card = make("section", "meals-card meals-next");
    card.appendChild(
      make(
        "p",
        "collection-meta",
        `${dayLabel(data.today)} · ${MEAL_SLOT_LABELS[next.meal.slot].toLowerCase()}${next.meal.time ? ` at ${next.meal.time}` : ""}`
      )
    );
    card.appendChild(make("h3", "meals-next-name", next.name));
    const facts = make("div", "meals-facts");
    const fact = (label: string, value: string) => {
      const box = make("div", "meals-fact");
      box.append(make("span", "meals-fact-label", label), make("strong", undefined, value));
      facts.appendChild(box);
    };
    if (recipe?.minutes) fact("Time", `${recipe.minutes} min`);
    if (recipe?.nutrition.kcal) fact("Per serving", `≈ ${recipe.nutrition.kcal} kcal`);
    fact("Cost", next.cost === null ? "—" : `≈ ${euro(next.cost)}`);
    if (recipe) fact("At home", `${recipe.coverage.have} of ${recipe.coverage.total}`);
    fact("Servings", String(next.meal.cookServings ?? next.meal.servings));
    card.appendChild(facts);
    if (recipe && next.meal.time) {
      const start = startTime(next.meal.time, recipe.minutes);
      if (start) card.appendChild(make("p", "collection-meta", `Start cooking by ${start}.`));
    }
    const actions = make("div", "meals-row");
    if (recipe)
      actions.appendChild(
        button("Start cooking", "btn btn-secondary", () => openCook(recipe.recipe.id, next.meal))
      );
    if (recipe)
      actions.appendChild(
        button("View recipe", "btn btn-ghost", () => {
          state.view = "recipes";
          state.recipeId = recipe.recipe.id;
          render();
        })
      );
    if (next.meal.kind === "leftover" && next.meal.leftoverId) {
      const leftover = data.leftovers.find((l) => l.id === next.meal.leftoverId);
      if (leftover)
        actions.appendChild(
          button(
            "Eat leftovers",
            "btn btn-secondary",
            () =>
              void act(
                () => bridge().eatLeftover(next.meal.id, leftover.id, next.meal.servings),
                `${leftover.name}: ${next.meal.servings} portion(s) eaten.`
              )
          )
        );
    }
    card.appendChild(actions);
    wrap.appendChild(card);
  } else {
    wrap.appendChild(make("p", "feed-empty", "Nothing planned for today — put something in the Plan view."));
  }

  if (todays.length) {
    wrap.appendChild(make("h5", "kicker collection-heading", "Today's meals"));
    const list = make("div", "meals-list");
    for (const entry of todays) list.appendChild(plannedRow(entry, data, false));
    wrap.appendChild(list);
  }

  // What needs eating, and what the week costs — the two things worth knowing at a glance.
  const attention = data.stock.filter((s) => s.expiry === "urgent" || s.expiry === "expired");
  if (attention.length || data.leftovers.length) {
    wrap.appendChild(make("h5", "kicker collection-heading", "Needs attention"));
    const list = make("div", "meals-list");
    for (const item of attention.slice(0, 8)) {
      const row = make("div", "meals-row-item");
      row.append(
        make("strong", undefined, item.name),
        make(
          "span",
          "collection-meta",
          item.totals.map((t) => formatAmount({ quantity: t.quantity, unit: t.unit })).join(" · ")
        ),
        make(
          "span",
          EXPIRY_CLASS[item.expiry],
          `${item.expiry === "expired" ? "expired" : "use"} ${expiryLabel(item.expiresAt, data.today)}`
        )
      );
      list.appendChild(row);
    }
    for (const leftover of data.leftovers.slice(0, 8)) {
      const row = make("div", "meals-row-item");
      row.append(
        make("strong", undefined, leftover.name),
        make(
          "span",
          "collection-meta",
          `${leftover.portions} portion(s) · ${STORAGE_LABELS[leftover.place].toLowerCase()}`
        ),
        make(
          "span",
          "meals-pill",
          leftover.eatBy ? `eat by ${expiryLabel(leftover.eatBy, data.today)}` : "leftover"
        )
      );
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }

  wrap.appendChild(weekCostCard(data));
  return wrap;
}

function weekCostCard(data: MealsSnapshot): HTMLElement {
  const card = make("section", "meals-card");
  card.appendChild(make("h5", "kicker", "Next 7 days"));
  const cost = data.weekCost;
  card.appendChild(
    make(
      "p",
      "meals-total",
      cost.value === null ? "Nothing costed yet" : `${cost.overBudget ? "" : "≈ "}${euro(cost.value)}`
    )
  );
  const parts = [
    cost.budget === null ? "no budget set" : `budget ${euro(cost.budget)}`,
    `${cost.estimated} estimated`,
    `${cost.known} priced`,
    cost.unknown ? `${cost.unknown} unknown` : null,
  ].filter(Boolean);
  card.appendChild(make("p", "collection-meta", parts.join(" · ")));
  if (cost.overBudget)
    card.appendChild(
      make(
        "p",
        "meals-pill meals-pill-urgent",
        `Over budget by ${euro(Math.round(((cost.value ?? 0) - (cost.budget ?? 0)) * 100) / 100)}`
      )
    );
  return card;
}

/** "19:30" minus the cooking time, as a clock. */
function startTime(time: string, minutes: number | null): string | null {
  if (!minutes) return null;
  const [hours, mins] = time.split(":").map(Number);
  const start = new Date(2000, 0, 1, hours, mins - minutes);
  return `${`${start.getHours()}`.padStart(2, "0")}:${`${start.getMinutes()}`.padStart(2, "0")}`;
}

function plannedRow(
  entry: { meal: PlannedMeal; name: string; cost: number | null },
  data: MealsSnapshot,
  showDay: boolean
): HTMLElement {
  const row = make("div", `meals-row-item${entry.meal.cookedAt ? " meals-done" : ""}`);
  const label = `${showDay ? `${dayLabel(entry.meal.date)} · ` : ""}${MEAL_SLOT_LABELS[entry.meal.slot]}${entry.meal.time ? ` ${entry.meal.time}` : ""}`;
  row.append(
    make("span", "meals-slot", label),
    make("strong", undefined, entry.name),
    make(
      "span",
      "collection-meta",
      [
        `${entry.meal.servings} serving${entry.meal.servings === 1 ? "" : "s"}`,
        entry.cost === null ? null : `≈ ${euro(entry.cost)}`,
        entry.meal.cookedAt ? "cooked" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  const actions = make("span", "meals-row-actions");
  if (!entry.meal.cookedAt && entry.meal.kind === "recipe" && entry.meal.recipeId) {
    actions.appendChild(button("Cook", "btn btn-ghost", () => openCook(entry.meal.recipeId!, entry.meal)));
  }
  actions.appendChild(
    button("Edit", "btn btn-ghost", () => {
      state.view = "plan";
      state.planning = { date: entry.meal.date, slot: entry.meal.slot, mealId: entry.meal.id };
      render();
    })
  );
  actions.appendChild(
    button("Remove", "btn btn-ghost", () => void act(() => bridge().removePlannedMeal(entry.meal.id)))
  );
  row.appendChild(actions);
  void data;
  return row;
}

// ---------- Plan ----------

function planView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    make(
      "p",
      "collection-meta",
      `Cooking for ${data.servingsNeeded} serving${data.servingsNeeded === 1 ? "" : "s"} — from the people in Settings. Click a slot to put a meal in it.`
    )
  );
  wrap.appendChild(weekCostCard(data));

  const grid = make("div", "meals-week");
  for (const date of data.days) {
    const column = make("div", `meals-day${date === data.today ? " meals-today" : ""}`);
    column.appendChild(make("h6", "meals-day-label", dayLabel(date)));
    for (const slot of data.preferences.slots) {
      const entry = data.plan.find((p) => p.meal.date === date && p.meal.slot === slot);
      if (entry) {
        const cell = make("div", `meals-cell${entry.meal.cookedAt ? " meals-done" : ""}`);
        cell.appendChild(make("span", "meals-slot", MEAL_SLOT_LABELS[slot]));
        cell.appendChild(
          button(entry.name, "btn btn-ghost meals-cell-name", () => {
            state.planning = { date, slot, mealId: entry.meal.id };
            render();
          })
        );
        cell.appendChild(
          make(
            "span",
            "collection-meta",
            [entry.cost === null ? null : `≈ ${euro(entry.cost)}`, entry.meal.cookedAt ? "cooked" : null]
              .filter(Boolean)
              .join(" · ")
          )
        );
        column.appendChild(cell);
      } else {
        const cell = make("div", "meals-cell meals-empty");
        cell.appendChild(make("span", "meals-slot", MEAL_SLOT_LABELS[slot]));
        cell.appendChild(
          button("+ Add", "btn btn-ghost", () => {
            state.planning = { date, slot, mealId: null };
            render();
          })
        );
        column.appendChild(cell);
      }
    }
    grid.appendChild(column);
  }
  wrap.appendChild(grid);
  if (state.planning) wrap.appendChild(planEditor(data, state.planning));
  return wrap;
}

function planEditor(
  data: MealsSnapshot,
  target: { date: string; slot: MealSlot; mealId: string | null }
): HTMLElement {
  const existing = target.mealId ? data.plan.find((p) => p.meal.id === target.mealId)?.meal : undefined;
  const box = make("section", "meals-card");
  box.appendChild(
    make(
      "h5",
      "kicker",
      `${existing ? "Edit" : "Add"} · ${dayLabel(target.date)} · ${MEAL_SLOT_LABELS[target.slot]}`
    )
  );
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
  cookServings.value =
    existing?.cookServings === null || existing === undefined ? "" : String(existing.cookServings);
  const time = input("time");
  time.value = existing?.time ?? "";
  const cost = input("number");
  cost.step = "0.01";
  cost.min = "0";
  cost.placeholder = "optional";
  cost.value = existing?.cost === null || existing === undefined ? "" : String(existing.cost);

  const rows = make("div", "meals-form");
  rows.append(field("What", kind));
  const recipeField = field("Recipe", recipePicker);
  const leftoverField = field("Leftovers", leftoverPicker);
  const nameField = field("Name", name);
  rows.append(recipeField, leftoverField, nameField);
  rows.append(
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
  box.appendChild(rows);

  if (!data.recipes.length)
    box.appendChild(make("p", "collection-meta", "No recipes yet — add one in Recipes."));

  const actions = make("div", "meals-row");
  actions.appendChild(
    button(
      existing ? "Save" : "Add to plan",
      "btn btn-secondary",
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
  box.appendChild(actions);
  return box;
}

// ---------- Cooking ----------

/**
 * The cook dialog, as a card under the view: how many servings are being
 * cooked, how many are eaten now, and where the rest go. Nothing is
 * deducted until "Mark cooked" — and what it did deduct is reported back.
 */
function openCook(recipeId: string, meal?: PlannedMeal): void {
  if (!snapshot) return;
  const entry = snapshot.recipes.find((r) => r.recipe.id === recipeId);
  if (!entry) return;
  const wanted = meal?.cookServings ?? meal?.servings ?? snapshot.servingsNeeded;
  const dialog = make("section", "meals-card meals-cook");
  dialog.appendChild(make("h5", "kicker", `Cook · ${entry.recipe.name}`));
  const cookServings = input("number");
  cookServings.min = "1";
  cookServings.value = String(wanted);
  const eatServings = input("number");
  eatServings.min = "1";
  eatServings.value = String(meal?.servings ?? wanted);
  const place = select(
    STORAGE_PLACES.filter((p) => p !== "cupboard").map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "fridge"
  );
  const skip = input("checkbox", "");
  const form = make("div", "meals-form");
  form.append(
    field("Cooking", cookServings),
    field("Eaten now", eatServings),
    field("Extra goes to", place),
    field("Don't touch the pantry", skip)
  );
  dialog.appendChild(form);
  const missing = entry.lines.filter((line) => !line.optional && line.status !== "have");
  if (missing.length)
    dialog.appendChild(
      make(
        "p",
        "collection-meta",
        `Not all at home: ${missing.map((line) => line.text).join(", ")} — cooking will say what it couldn't take out.`
      )
    );
  const actions = make("div", "meals-row");
  actions.appendChild(
    button(
      "Mark cooked",
      "btn btn-secondary",
      () =>
        void act(async () => {
          const result = await bridge().cookMeal({
            mealId: meal?.id,
            recipeId,
            cookServings: Number(cookServings.value) || entry.recipe.servings,
            eatServings: Number(eatServings.value) || Number(cookServings.value) || entry.recipe.servings,
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
    )
  );
  actions.appendChild(button("Cancel", "btn btn-ghost", () => render()));
  dialog.appendChild(actions);
  root?.appendChild(dialog);
  dialog.scrollIntoView({ block: "nearest" });
}

// ---------- Recipes ----------

function recipesView(data: MealsSnapshot): HTMLElement {
  if (state.editing) return recipeEditor(data, state.editing);
  if (state.recipeId) {
    const entry = data.recipes.find((r) => r.recipe.id === state.recipeId);
    if (entry) return recipePage(data, entry);
    state.recipeId = null;
  }
  const wrap = make("div", "meals-view");
  const controls = make("div", "books-sort-row");
  const search = input("search");
  search.placeholder = "Search recipes";
  search.value = state.recipeSearch;
  search.addEventListener("input", () => {
    state.recipeSearch = search.value;
    render();
    (
      document.getElementById("mealsRoot")?.querySelector("input[type=search]") as HTMLInputElement | null
    )?.focus();
  });
  controls.appendChild(search);
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
  controls.appendChild(sort);
  controls.appendChild(
    button("+ New recipe", "btn btn-secondary", () => {
      state.editing = "new";
      render();
    })
  );
  wrap.appendChild(controls);

  const term = state.recipeSearch.trim().toLowerCase();
  const recipes = data.recipes
    .filter(
      (entry) =>
        !term ||
        entry.recipe.name.toLowerCase().includes(term) ||
        entry.recipe.tags.some((tag) => tag.toLowerCase().includes(term)) ||
        entry.recipe.ingredients.some((line) => line.text.toLowerCase().includes(term))
    )
    .sort((a, b) => {
      if (state.recipeSort === "quick") return (a.minutes ?? 9999) - (b.minutes ?? 9999);
      if (state.recipeSort === "cheap") return (a.cost.value ?? 9999) - (b.cost.value ?? 9999);
      if (state.recipeSort === "home")
        return (
          b.coverage.have / Math.max(1, b.coverage.total) - a.coverage.have / Math.max(1, a.coverage.total) ||
          a.recipe.name.localeCompare(b.recipe.name)
        );
      return a.recipe.name.localeCompare(b.recipe.name);
    });
  wrap.appendChild(
    make("p", "collection-meta", `${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`)
  );
  if (!recipes.length)
    wrap.appendChild(
      make("p", "feed-empty", "No recipes yet. Add one, and the pantry will start matching it.")
    );
  const list = make("div", "meals-grid");
  for (const entry of recipes) {
    const card = make("button", "meals-recipe-card");
    (card as HTMLButtonElement).type = "button";
    card.addEventListener("click", () => {
      state.recipeId = entry.recipe.id;
      render();
    });
    card.append(
      make("strong", undefined, entry.recipe.name),
      make(
        "span",
        "collection-meta",
        [
          entry.minutes ? `${entry.minutes} min` : null,
          `${entry.coverage.have}/${entry.coverage.total} at home`,
          entry.cost.value === null
            ? null
            : `≈ ${euro(entry.cost.value / Math.max(1, entry.recipe.servings))}/serving`,
          entry.nutrition.kcal ? `≈ ${entry.nutrition.kcal} kcal` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      )
    );
    if (entry.recipe.slots.length)
      card.appendChild(
        make("span", "meals-pill", entry.recipe.slots.map((slot) => MEAL_SLOT_LABELS[slot]).join(" · "))
      );
    list.appendChild(card);
  }
  wrap.appendChild(list);
  return wrap;
}

function recipePage(data: MealsSnapshot, entry: MealsSnapshot["recipes"][number]): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    button("← All recipes", "btn btn-ghost", () => {
      state.recipeId = null;
      render();
    })
  );
  wrap.appendChild(make("h3", "meals-next-name", entry.recipe.name));
  if (entry.recipe.description) wrap.appendChild(make("p", "collection-meta", entry.recipe.description));

  const facts = make("div", "meals-facts");
  const fact = (label: string, value: string) => {
    const box = make("div", "meals-fact");
    box.append(make("span", "meals-fact-label", label), make("strong", undefined, value));
    facts.appendChild(box);
  };
  fact("Servings", String(entry.recipe.servings));
  if (entry.minutes)
    fact("Prep · cook", `${entry.recipe.prepMinutes ?? 0} · ${entry.recipe.cookMinutes ?? 0} min`);
  fact(
    "Cost",
    entry.cost.value === null
      ? "—"
      : `≈ ${euro(entry.cost.value)} (${euro(entry.cost.value / Math.max(1, entry.recipe.servings))}/serving)`
  );
  if (entry.nutrition.kcal !== null)
    fact("Per serving", `≈ ${entry.nutrition.kcal} kcal · ${entry.nutrition.protein ?? "?"} g protein`);
  fact("Cooked", entry.recipe.timesCooked ? `${entry.recipe.timesCooked}×` : "never");
  wrap.appendChild(facts);

  const actions = make("div", "meals-row");
  actions.appendChild(button("Cook now", "btn btn-secondary", () => openCook(entry.recipe.id)));
  actions.appendChild(
    button("Add to plan", "btn btn-ghost", () => {
      state.view = "plan";
      state.planning = { date: data.today, slot: entry.recipe.slots[0] ?? "dinner", mealId: null };
      render();
    })
  );
  actions.appendChild(
    button("Edit", "btn btn-ghost", () => {
      state.editing = entry.recipe.id;
      render();
    })
  );
  actions.appendChild(
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
  wrap.appendChild(actions);

  wrap.appendChild(
    make(
      "h5",
      "kicker collection-heading",
      `Ingredients · ${entry.coverage.have} of ${entry.coverage.total} at home`
    )
  );
  const lines = make("div", "meals-list");
  for (const line of entry.lines) {
    const row = make("div", "meals-row-item");
    row.append(
      make("span", "meals-amount", formatAmount(line.needed)),
      make("strong", undefined, line.text),
      make(
        "span",
        line.status === "have" ? "meals-pill meals-pill-ok" : "meals-pill",
        line.status === "have"
          ? "at home"
          : line.status === "partial"
            ? `short ${line.short ? formatAmount(line.short) : ""}`
            : line.status === "unknown"
              ? "can't measure"
              : "missing"
      )
    );
    if (line.optional) row.appendChild(make("span", "collection-meta", "optional"));
    lines.appendChild(row);
  }
  wrap.appendChild(lines);

  if (entry.recipe.steps.length) {
    wrap.appendChild(make("h5", "kicker collection-heading", "Method"));
    const steps = make("ol", "meals-steps");
    for (const step of entry.recipe.steps) {
      const item = make("li");
      item.appendChild(document.createTextNode(step.text));
      if (step.minutes) item.appendChild(make("span", "collection-meta", ` ${step.minutes} min`));
      steps.appendChild(item);
    }
    wrap.appendChild(steps);
  }

  if (entry.nutrition.kcal !== null || entry.cost.missing.length) {
    wrap.appendChild(
      make(
        "p",
        "builder-footnote",
        [
          entry.nutrition.from
            ? `Nutrition from ${entry.nutrition.from} of ${entry.nutrition.total} ingredients${entry.nutrition.missing.length ? ` · no data for ${entry.nutrition.missing.join(", ")}` : ""}.`
            : "No nutrition data for these ingredients yet.",
          entry.cost.missing.length
            ? `Cost from ${entry.cost.from} of ${entry.cost.total} ingredients — the rest have no price yet.`
            : "Cost is the last price paid per ingredient.",
        ].join(" ")
      )
    );
  }

  const inPlan = data.plan.filter((p) => p.meal.recipeId === entry.recipe.id);
  if (inPlan.length) {
    wrap.appendChild(make("h5", "kicker collection-heading", "In your plan"));
    const list = make("div", "meals-list");
    for (const planned of inPlan) list.appendChild(plannedRow(planned, data, true));
    wrap.appendChild(list);
  }
  if (entry.recipe.source) wrap.appendChild(make("p", "collection-meta", `Source: ${entry.recipe.source}`));
  return wrap;
}

function recipeEditor(data: MealsSnapshot, id: string): HTMLElement {
  const existing = id === "new" ? undefined : data.recipes.find((r) => r.recipe.id === id)?.recipe;
  const wrap = make("div", "meals-view");
  wrap.appendChild(make("h5", "kicker", existing ? "Edit recipe" : "New recipe"));

  const name = input("text");
  name.maxLength = 200;
  name.value = existing?.name ?? "";
  const servings = input("number");
  servings.min = "1";
  servings.value = String(existing?.servings ?? 2);
  const prep = input("number");
  prep.min = "0";
  prep.value = existing?.prepMinutes === null || !existing ? "" : String(existing.prepMinutes);
  const cook = input("number");
  cook.min = "0";
  cook.value = existing?.cookMinutes === null || !existing ? "" : String(existing.cookMinutes);
  const description = make("textarea", "input meals-textarea");
  description.value = existing?.description ?? "";
  const tags = input("text");
  tags.value = existing?.tags.join(", ") ?? "";
  tags.placeholder = "comma separated";

  const slotBoxes = new Map<MealSlot, HTMLInputElement>();
  const slotRow = make("div", "meals-row");
  for (const slot of MEAL_SLOTS) {
    const label = make("label", "meals-check");
    const box = input("checkbox", "");
    box.checked = existing ? existing.slots.includes(slot) : slot === "dinner";
    slotBoxes.set(slot, box);
    label.append(box, document.createTextNode(` ${MEAL_SLOT_LABELS[slot]}`));
    slotRow.appendChild(label);
  }

  const form = make("div", "meals-form");
  form.append(
    field("Name", name),
    field("Servings", servings),
    field("Prep (min)", prep),
    field("Cook (min)", cook),
    field("Tags", tags)
  );
  wrap.append(form, make("p", "meals-field-label", "Suits"), slotRow, field("Description", description));

  // Ingredient lines: a name, an amount and a unit. Names become
  // ingredients in the main process, so "chicken thighs" typed twice is
  // still one food.
  wrap.appendChild(make("h5", "kicker collection-heading", "Ingredients"));
  const linesBox = make("div", "meals-list");
  const lineRows: Array<{
    name: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLSelectElement;
    optional: HTMLInputElement;
  }> = [];
  const addLine = (line?: { text: string; quantity: number; unit: string; optional: boolean }) => {
    const row = make("div", "meals-line");
    const lineName = input("text");
    lineName.placeholder = "Ingredient";
    lineName.maxLength = 200;
    lineName.value = line?.text ?? "";
    const quantity = input("number");
    quantity.step = "0.01";
    quantity.min = "0";
    quantity.value = line ? String(line.quantity) : "";
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
    row.appendChild(
      button("✕", "btn btn-ghost", () => {
        const index = lineRows.indexOf(entry);
        if (index >= 0) lineRows.splice(index, 1);
        row.remove();
      })
    );
    linesBox.appendChild(row);
  };
  for (const line of existing?.ingredients ?? []) addLine(line);
  if (!existing) addLine();
  wrap.appendChild(linesBox);
  wrap.appendChild(button("+ Add ingredient", "btn btn-ghost", () => addLine()));

  wrap.appendChild(make("h5", "kicker collection-heading", "Method"));
  const steps = make("textarea", "input meals-textarea meals-steps-input");
  steps.value = (existing?.steps ?? []).map((step) => step.text).join("\n");
  steps.placeholder = "One step per line";
  wrap.appendChild(steps);

  const actions = make("div", "meals-row");
  actions.appendChild(
    button(
      "Save recipe",
      "btn btn-secondary",
      () =>
        void act(async () => {
          await bridge().saveRecipe(
            {
              name: name.value,
              description: description.value || null,
              servings: Number(servings.value) || 2,
              prepMinutes: prep.value ? Number(prep.value) : null,
              cookMinutes: cook.value ? Number(cook.value) : null,
              slots: [...slotBoxes.entries()].filter(([, box]) => box.checked).map(([slot]) => slot),
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
            },
            existing?.id
          );
          state.editing = null;
        }, "Recipe saved.")
    )
  );
  actions.appendChild(
    button("Cancel", "btn btn-ghost", () => {
      state.editing = null;
      render();
    })
  );
  wrap.appendChild(actions);
  return wrap;
}

// ---------- Pantry ----------

function pantryView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(addStockForm(data));

  const filters: Array<[MealsUiState["pantryFilter"], string]> = [
    ["all", "All"],
    ["cupboard", "Cupboard"],
    ["fridge", "Fridge"],
    ["freezer", "Freezer"],
    ["expiring", "Expiring"],
    ["unconfirmed", "Estimated"],
  ];
  const row = make("div", "meals-row");
  for (const [filter, label] of filters) {
    const tab = button(label, `btn ${state.pantryFilter === filter ? "btn-secondary" : "btn-ghost"}`, () => {
      state.pantryFilter = filter;
      render();
    });
    row.appendChild(tab);
  }
  wrap.appendChild(row);

  const stock = data.stock.filter((item) => {
    if (state.pantryFilter === "all") return true;
    if (state.pantryFilter === "expiring")
      return item.expiry === "urgent" || item.expiry === "soon" || item.expiry === "expired";
    if (state.pantryFilter === "unconfirmed") return item.confidence === "estimated";
    return item.items.some((entry) => entry.place === state.pantryFilter);
  });

  const counts = {
    urgent: data.stock.filter((s) => s.expiry === "urgent" || s.expiry === "expired").length,
    soon: data.stock.filter((s) => s.expiry === "soon").length,
    estimated: data.stock.filter((s) => s.confidence === "estimated").length,
  };
  wrap.appendChild(
    make(
      "p",
      "collection-meta",
      `${data.stock.length} food(s) · ${counts.urgent} needing eating · ${counts.soon} this week · ${counts.estimated} estimated`
    )
  );

  if (!stock.length)
    wrap.appendChild(make("p", "feed-empty", "Nothing here yet — add what's in the kitchen above."));
  const list = make("div", "meals-list");
  for (const summary of stock) {
    for (const item of summary.items) {
      if (
        state.pantryFilter === "cupboard" ||
        state.pantryFilter === "fridge" ||
        state.pantryFilter === "freezer"
      ) {
        if (item.place !== state.pantryFilter) continue;
      }
      const entry = make("div", "meals-row-item");
      entry.append(
        make("strong", undefined, summary.name),
        make("span", "meals-amount", formatAmount({ quantity: item.quantity, unit: item.unit })),
        make("span", "collection-meta", STORAGE_LABELS[item.place])
      );
      if (item.confidence === "estimated")
        entry.appendChild(make("span", "meals-pill meals-pill-est", "estimated"));
      if (item.expiresAt) {
        const days = expiryLabel(item.expiresAt, data.today);
        const level = summary.items.length === 1 ? summary.expiry : "later";
        entry.appendChild(make("span", EXPIRY_CLASS[level] ?? "meals-pill", `use ${days}`));
      }
      const actions = make("span", "meals-row-actions");
      actions.appendChild(
        button("Correct", "btn btn-ghost", () => openCorrect(item.id, summary.name, item.quantity, item.unit))
      );
      actions.appendChild(
        button("Remove", "btn btn-ghost", () => void act(() => bridge().removeStock(item.id)))
      );
      entry.appendChild(actions);
      list.appendChild(entry);
    }
  }
  wrap.appendChild(list);

  wrap.appendChild(make("h5", "kicker collection-heading", "Cooked food & leftovers"));
  const leftovers = make("div", "meals-list");
  for (const leftover of data.leftovers) {
    const entry = make("div", "meals-row-item");
    entry.append(
      make("strong", undefined, leftover.name),
      make(
        "span",
        "collection-meta",
        `${leftover.portions} portion(s) · ${STORAGE_LABELS[leftover.place].toLowerCase()}`
      )
    );
    if (leftover.eatBy)
      entry.appendChild(make("span", "meals-pill", `eat by ${expiryLabel(leftover.eatBy, data.today)}`));
    const actions = make("span", "meals-row-actions");
    actions.appendChild(
      button(
        "Ate one",
        "btn btn-ghost",
        () =>
          void act(() =>
            bridge().updateLeftover(leftover.id, { portions: Math.max(0, leftover.portions - 1) })
          )
      )
    );
    actions.appendChild(
      button("Remove", "btn btn-ghost", () => void act(() => bridge().removeLeftover(leftover.id)))
    );
    entry.appendChild(actions);
    leftovers.appendChild(entry);
  }
  if (!data.leftovers.length)
    leftovers.appendChild(
      make("p", "collection-meta", "Nothing cooked and kept. Cooking more than you eat records it here.")
    );
  wrap.appendChild(leftovers);
  wrap.appendChild(
    make(
      "p",
      "builder-footnote",
      "Estimated stock is what NIMBUS worked out from the recipes you cooked. Correcting an amount makes it confirmed again."
    )
  );
  return wrap;
}

function addStockForm(data: MealsSnapshot): HTMLElement {
  const card = make("section", "meals-card");
  card.appendChild(make("h5", "kicker", "Add stock"));
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
  card.append(form, datalist);
  card.appendChild(
    button(
      "Add to pantry",
      "btn btn-secondary",
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
  return card;
}

/** "Correct stock": what's actually there. Whatever the number, it becomes confirmed. */
function openCorrect(itemId: string, name: string, quantity: number, unit: string): void {
  const dialog = make("section", "meals-card");
  dialog.appendChild(make("h5", "kicker", `Correct stock · ${name}`));
  dialog.appendChild(
    make(
      "p",
      "collection-meta",
      `NIMBUS thinks there is ${formatAmount({ quantity, unit })}. What's actually there?`
    )
  );
  const amount = input("number");
  amount.step = "0.01";
  amount.min = "0";
  amount.value = String(quantity);
  const form = make("div", "meals-form");
  form.appendChild(field(`Amount (${unitLabel(unit)})`, amount));
  dialog.appendChild(form);
  const actions = make("div", "meals-row");
  actions.appendChild(
    button(
      "None left",
      "btn btn-ghost",
      () => void act(() => bridge().correctStock(itemId, 0), "Confirmed: none left.")
    )
  );
  actions.appendChild(
    button(
      "Confirm amount",
      "btn btn-secondary",
      () => void act(() => bridge().correctStock(itemId, Number(amount.value)), "Stock confirmed.")
    )
  );
  actions.appendChild(button("Cancel", "btn btn-ghost", () => render()));
  dialog.appendChild(actions);
  root?.appendChild(dialog);
  dialog.scrollIntoView({ block: "nearest" });
}

// ---------- Settings ----------

function settingsView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");

  wrap.appendChild(make("h5", "kicker collection-heading", "People eating"));
  wrap.appendChild(
    make(
      "p",
      "collection-meta",
      `A label, how much they eat and a note — no profiles. Together: ${data.servingsNeeded} serving(s) a meal.`
    )
  );
  const eaters = data.preferences.eaters.map((eater) => ({ ...eater }));
  const list = make("div", "meals-list");
  const drawEaters = () => {
    list.replaceChildren();
    eaters.forEach((eater, index) => {
      const row = make("div", "meals-row-item");
      const name = input("text");
      name.value = eater.name;
      name.addEventListener("input", () => (eaters[index].name = name.value));
      const factor = input("number");
      factor.step = "0.1";
      factor.min = "0.1";
      factor.max = "5";
      factor.value = String(eater.portionFactor);
      factor.addEventListener("input", () => (eaters[index].portionFactor = Number(factor.value) || 1));
      const notes = input("text");
      notes.placeholder = "No mushrooms";
      notes.value = eater.notes ?? "";
      notes.addEventListener("input", () => (eaters[index].notes = notes.value || null));
      row.append(name, factor, notes);
      row.appendChild(
        button("✕", "btn btn-ghost", () => {
          eaters.splice(index, 1);
          drawEaters();
        })
      );
      list.appendChild(row);
    });
  };
  drawEaters();
  wrap.appendChild(list);
  const eaterActions = make("div", "meals-row");
  eaterActions.appendChild(
    button("+ Add person", "btn btn-ghost", () => {
      eaters.push({ id: "", name: "Someone", portionFactor: 1, notes: null });
      drawEaters();
    })
  );
  eaterActions.appendChild(
    button(
      "Save people",
      "btn btn-secondary",
      () => void act(() => bridge().updateMealPreferences({ eaters }), "Saved.")
    )
  );
  wrap.appendChild(eaterActions);

  wrap.appendChild(make("h5", "kicker collection-heading", "Food rules"));
  const restrictions = input("text");
  restrictions.value = data.preferences.restrictions.join(", ");
  restrictions.placeholder = "No pork, Gluten-free";
  const dislikes = input("text");
  dislikes.value = data.preferences.dislikes.join(", ");
  dislikes.placeholder = "Mushrooms, coriander";
  const budget = input("number");
  budget.step = "0.5";
  budget.min = "0";
  budget.placeholder = "none";
  budget.value = data.preferences.dailyBudget === null ? "" : String(data.preferences.dailyBudget);
  const rules = make("div", "meals-form");
  rules.append(
    field("Never suggest", restrictions),
    field("Avoid when possible", dislikes),
    field("Budget €/day", budget)
  );
  wrap.appendChild(rules);
  wrap.appendChild(
    make(
      "p",
      "builder-footnote",
      "Restrictions and dislikes are kept for the meal generator, which isn't built yet — nothing filters recipes today."
    )
  );

  wrap.appendChild(make("h5", "kicker collection-heading", "Meal slots"));
  const slotRow = make("div", "meals-row");
  const slotBoxes = new Map<MealSlot, HTMLInputElement>();
  for (const slot of MEAL_SLOTS) {
    const label = make("label", "meals-check");
    const box = input("checkbox", "");
    box.checked = data.preferences.slots.includes(slot);
    slotBoxes.set(slot, box);
    label.append(box, document.createTextNode(` ${MEAL_SLOT_LABELS[slot]}`));
    slotRow.appendChild(label);
  }
  wrap.appendChild(slotRow);
  wrap.appendChild(
    button(
      "Save",
      "btn btn-secondary",
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
              slots: [...slotBoxes.entries()].filter(([, box]) => box.checked).map(([slot]) => slot),
            }),
          "Saved."
        )
    )
  );
  return wrap;
}
