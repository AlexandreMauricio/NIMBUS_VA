/** Shared by the Meals views: the snapshot's shapes, the bridge, the UI state, small DOM builders, and loading. */
import type { MealSlot, PlannedMeal, StoragePlace } from "../../meals/types";

export type Confidence = "confirmed" | "estimated";

export interface NutritionUI {
  kcal: number | null;
  protein: number | null;
  carbs?: number | null;
  fat?: number | null;
  fibre?: number | null;
  from: number;
  total: number;
  missing: string[];
}

export interface RecipeUI {
  id: string;
  name: string;
  description: string | null;
  slots: MealSlot[];
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  components: Array<{ id: string; name: string }>;
  ingredients: Array<{
    ingredientId: string;
    text: string;
    quantity: number;
    unit: string;
    optional: boolean;
    componentId: string | null;
  }>;
  steps: Array<{ text: string; minutes: number | null; componentId: string | null }>;
  batch: boolean;
  photo: string | null;
  tags: string[];
  source: string | null;
  notes: string | null;
  favourite: boolean;
  timesCooked: number;
  lastCookedAt: string | null;
}

/** What `nimbus:get-meals` returns — the shapes lifecycle.ts builds. */
export interface MealsSnapshot {
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
    dailyCarbs: number | null;
    dailyFibre: number | null;
    monthlyBudget: number | null;
  };
  ingredients: Array<{ id: string; name: string; aliases: string[]; unit: string; lastPrice: number | null }>;
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
      componentId: string | null;
      needed: { quantity: number; unit: string };
      status: "have" | "partial" | "missing" | "unknown";
      short: { quantity: number; unit: string } | null;
      /** The package it last came in, for "Buy · 1 kg pack". */
      packaging: string | null;
      /** The package that would be used first, when there is one. */
      stock: {
        expiry: "expired" | "urgent" | "soon" | "later" | "none";
        expiresAt: string | null;
        opened: boolean;
        confidence: Confidence;
      } | null;
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
  plan: Array<{
    meal: PlannedMeal;
    name: string;
    cost: number | null;
    nutrition: NutritionUI | null;
    badge: { kind: "leftover" | "pantry" | "pick" | "swap"; label: string } | null;
  }>;
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
      /** Latest price per shop, cheapest first. */
      prices: StorePriceUI[];
      /** The cheapest shop, and where its price came from. */
      shop: string | null;
      priceSource: string | null;
      mark: {
        kind: "unavailable" | "skip" | "substitute";
        storeId: string | null;
        substituteId: string | null;
      } | null;
      substitutes: Array<{ id: string; name: string }>;
    }>;
    setAside: Array<{ name: string; ingredientId: string | null; kind: string; substitute: string | null }>;
    saving: { mainStore: string; otherStores: string[]; saving: number } | null;
    toBuy: number;
    covered: Array<{ name: string; value: number | null }>;
    cost: number | null;
    unpriced: number;
    unknown: number;
  };
  hasDemoData: boolean;
  stores: Array<{ id: string; name: string }>;
  purchases: PurchaseUI[];
  spent: {
    byDay: Array<{ date: string; amount: number }>;
    week: number;
    month: number;
    monthlyBudget: number | null;
    toReview: number;
  };
  priceWatch: Array<{ ingredientId: string; name: string; prices: StorePriceUI[] }>;
  weekCost: {
    value: number | null;
    known: number;
    estimated: number;
    unknown: number;
    budget: number | null;
    overBudget: boolean;
  };
}

export interface StorePriceUI {
  storeId: string | null;
  storeName: string;
  pricePerBase: number;
  date: string;
  manual: boolean;
}

export interface PurchaseLineUI {
  id: string;
  raw: string;
  ingredientId: string | null;
  notFood: boolean;
  quantity: number | null;
  unit: string | null;
  price: number | null;
  confidence: number;
  confirmed: boolean;
}

export interface PurchaseUI {
  id: string;
  storeId: string | null;
  storeName: string | null;
  date: string;
  source: "manual" | "pdf" | "photo";
  status: "review" | "imported" | "history";
  lines: PurchaseLineUI[];
  total: number | null;
  fileName: string | null;
  check: { sum: number; matches: boolean | null; unpriced: number };
  spent: number;
}

/** What cooking would take, package by package (MealService.previewCook). */
export interface CookPreviewUI {
  deductions: Array<{
    itemId: string;
    name: string;
    packaging: string | null;
    place: StoragePlace;
    confidence: Confidence;
    use: { quantity: number; unit: string };
    remaining: { quantity: number; unit: string };
    empties: boolean;
  }>;
  short: Array<{ name: string; missing: { quantity: number; unit: string } | null; reason: string }>;
}

/** What the importer hands back: a draft to check, never a saved recipe. */
export interface ImportedRecipeUI {
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

export interface MealsBridge {
  getMeals(): Promise<MealsSnapshot>;
  saveRecipe(input: Record<string, unknown>, id?: string): Promise<unknown>;
  removeRecipe(id: string): Promise<void>;
  chooseRecipePhoto(id: string): Promise<boolean>;
  clearRecipePhoto(id: string): Promise<boolean>;
  addStock(input: Record<string, unknown>): Promise<unknown>;
  updateStock(id: string, changes: Record<string, unknown>): Promise<unknown>;
  correctStock(id: string, quantity: number, unit?: string, reason?: string): Promise<unknown>;
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
    scheduled: PlannedMeal | null;
  }>;
  previewCook(recipeId: string, servings: number): Promise<CookPreviewUI>;
  addMissingToShopping(recipeId: string, servings: number): Promise<number>;
  createPurchase(input: Record<string, unknown>): Promise<PurchaseUI>;
  importReceipt(): Promise<PurchaseUI | null>;
  updatePurchase(id: string, changes: Record<string, unknown>): Promise<unknown>;
  updatePurchaseLine(id: string, lineId: string, changes: Record<string, unknown>): Promise<unknown>;
  confirmPurchase(id: string, apply: Record<string, boolean>): Promise<unknown>;
  removePurchase(id: string): Promise<void>;
  markShopping(ingredientId: string, kind: string | null, extra?: Record<string, unknown>): Promise<void>;
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

export const bridge = (): MealsBridge => (window as unknown as { nimbus: MealsBridge }).nimbus;

export type MealsView = "today" | "plan" | "recipes" | "shopping" | "pantry" | "purchases" | "settings";
export type RecipeFilter =
  "all" | "home" | "quick" | "cheap" | "favourites" | "imported" | "single" | "multi" | "batch";

export interface MealsUiState {
  view: MealsView;
  recipeId: string | null;
  editing: string | null;
  imported: ImportedRecipeUI | null;
  recipeSearch: string;
  recipeSlot: MealSlot | "all";
  recipeFilter: RecipeFilter;
  recipeSort: "home" | "quick" | "cheap" | "recent" | "name";
  /** The servings the open recipe page is scaled to. */
  recipeServings: number | null;
  pantryFilter: "all" | StoragePlace | "expiring" | "unconfirmed";
  shoppingGroup: "category" | "meal" | "store";
  purchaseFilter: "all" | "review" | "receipts" | "manual";
  /** The purchase open in the review drawer. */
  reviewing: string | null;
  /** The food whose prices the price watch shows. */
  watching: string | null;
  planning: { date: string; slot: MealSlot; mealId: string | null } | null;
  message: string;
  error: string;
}

export const state: MealsUiState = {
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
  purchaseFilter: "all",
  reviewing: null,
  watching: null,
  planning: null,
  message: "",
  error: "",
};

export let snapshot: MealsSnapshot | null = null;
export let root: HTMLElement | null = null;
export function setRoot(element: HTMLElement | null): void {
  root = element;
}

// ---------- Small builders ----------

export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

export function input(type: string, className = "input"): HTMLInputElement {
  const element = make("input", className);
  element.type = type;
  return element;
}

export function select(options: Array<[string, string]>, value?: string): HTMLSelectElement {
  const element = make("select", "select");
  for (const [id, label] of options) element.appendChild(new Option(label, id));
  if (value !== undefined) element.value = value;
  return element;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = make("label", "meals-field");
  wrap.appendChild(make("span", "meals-field-label", label));
  wrap.appendChild(control);
  return wrap;
}

/** A rounded tag: the tab's whole vocabulary of state in one element. */
export function pill(
  text: string,
  kind: "calm" | "urgent" | "soon" | "accent" | "est" | "ok" | "left" = "calm"
): HTMLElement {
  return make("span", `meals-pill meals-pill-${kind}`, text);
}

/** A titled box, with something optional on the right of its header. */
export function panel(title: string, right?: HTMLElement | string): { box: HTMLElement; body: HTMLElement } {
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
export function counter(
  value: string,
  label: string,
  kind: "" | "urgent" | "soon" | "est" = ""
): HTMLElement {
  const box = make("div", `meals-counter${kind ? ` meals-counter-${kind}` : ""}`);
  box.append(make("strong", "meals-counter-value", value), make("span", "meals-counter-label", label));
  return box;
}

/** How much of a package is left. Estimated stock is drawn hatched, never solid. */
export function stockBar(share: number, estimated: boolean): HTMLElement {
  const bar = make("div", "meals-bar");
  const fill = make("span", estimated ? "meals-bar-est" : undefined);
  fill.style.width = `${Math.max(2, Math.min(100, Math.round(share * 100)))}%`;
  bar.appendChild(fill);
  return bar;
}

/** A dial for one macro: how much of a day's target today's meals come to. */
export function ring(percent: number | null, value: string, label: string): HTMLElement {
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
export function stepper(
  value: number,
  step: number,
  min: number,
  onChange: (next: number) => void
): HTMLElement {
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

export function chip(label: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const element = button(label, `meals-chip${on ? " is-on" : ""}`, onClick);
  element.setAttribute("aria-pressed", String(on));
  return element;
}

export const euro = (value: number | null): string =>
  value === null
    ? "—"
    : `${value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

/** "Tue 22 Sep", from an ISO date, without turning it into UTC first. */
export function dayLabel(iso: string, weekday: "short" | "long" | undefined = "short"): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", {
    weekday,
    day: "numeric",
    month: "short",
  });
}

/** How an expiry date reads next to a food: "today", "tomorrow", "in 4 days". */
export function expiryLabel(iso: string | null, today: string): string {
  if (!iso) return "";
  const days = Math.round(
    (new Date(`${iso}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export const EXPIRY_PILL: Record<string, "urgent" | "soon" | "calm"> = {
  expired: "urgent",
  urgent: "urgent",
  soon: "soon",
  later: "calm",
  none: "calm",
};

/** "19:30" minus the cooking time, as a clock. */
export function startTime(time: string, minutes: number | null): string | null {
  if (!minutes) return null;
  const [hours, mins] = time.split(":").map(Number);
  const start = new Date(2000, 0, 1, hours, mins - minutes);
  return `${`${start.getHours()}`.padStart(2, "0")}:${`${start.getMinutes()}`.padStart(2, "0")}`;
}

// ---------- Loading and rendering ----------

export async function refresh(): Promise<void> {
  try {
    snapshot = await bridge().getMeals();
    state.error = "";
  } catch (err) {
    state.error = errorText(err);
  }
  rerender();
}

/** Runs a change, then redraws from a fresh snapshot — every write goes through here. */
export async function act(work: () => Promise<unknown>, message = ""): Promise<void> {
  try {
    await work();
    state.message = message;
    state.error = "";
  } catch (err) {
    state.error = errorText(err);
  }
  await refresh();
}

/** Redraws the tab. Set by mealsTab.ts, so the views can ask for a redraw without importing it. */
let rerenderHook: () => void = () => undefined;
export function setRerender(fn: () => void): void {
  rerenderHook = fn;
}
export function rerender(): void {
  rerenderHook();
}

/**
 * Shows a dialog over the tab, as the design's modals are: a dimmed
 * backdrop, the box centred and scrollable. Clicking outside or Escape
 * closes it; so does any redraw, since it lives inside the tab's root.
 */
export function showModal(box: HTMLElement): void {
  if (!root) return;
  root.querySelector(".meals-modal")?.remove();
  const backdrop = make("div", "meals-modal");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) rerender();
  });
  box.classList.add("meals-modal-box");
  backdrop.appendChild(box);
  root.appendChild(backdrop);
  const onKey = (event: KeyboardEvent) => {
    if (!backdrop.isConnected) document.removeEventListener("keydown", onKey);
    else if (event.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      rerender();
    }
  };
  document.addEventListener("keydown", onKey);
}
