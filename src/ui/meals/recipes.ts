import { MEAL_SLOTS, MEAL_SLOT_LABELS } from "../../meals/types";
import { matchIngredient } from "../../meals/names";
import type { MealSlot } from "../../meals/types";
import { KNOWN_UNITS, formatAmount, unitLabel } from "../../meals/units";
import {
  MealsSnapshot,
  MealsUiState,
  RecipeFilter,
  act,
  bridge,
  button,
  chip,
  dayLabel,
  errorText,
  euro,
  expiryLabel,
  field,
  input,
  make,
  panel,
  pill,
  rerender,
  root,
  select,
  state,
  stepper,
  showModal,
} from "./common";
import { openCook } from "./cook";

// ---------- Recipes ----------

export function openRecipe(id: string): void {
  state.view = "recipes";
  state.recipeId = id;
  state.recipeServings = null;
  rerender();
}

export function recipesView(data: MealsSnapshot): HTMLElement {
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
        rerender();
      })
    );
  }
  wrap.appendChild(slotRow);

  const filters: Array<[RecipeFilter, string, (r: MealsSnapshot["recipes"][number]) => boolean]> = [
    ["all", "No filter", () => true],
    ["home", "All at home", (r) => r.coverage.total > 0 && r.coverage.have === r.coverage.total],
    ["single", "Single dish", (r) => r.recipe.components.length < 2],
    ["multi", "Multi-dish", (r) => r.recipe.components.length >= 2],
    ["batch", "Batch-friendly", (r) => r.recipe.batch],
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
        rerender();
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
    rerender();
    const again = root?.querySelector("input[type=search]") as HTMLInputElement | null;
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  });
  const sort = select(
    [
      ["home", "Sort: most at home"],
      ["quick", "Sort: quickest"],
      ["cheap", "Sort: cheapest"],
      ["recent", "Sort: recently cooked"],
      ["name", "Sort: name"],
    ],
    state.recipeSort
  );
  sort.addEventListener("change", () => {
    state.recipeSort = sort.value as MealsUiState["recipeSort"];
    rerender();
  });
  controls.append(
    search,
    sort,
    button("+ New recipe", "btn btn-primary", () => {
      state.editing = "new";
      rerender();
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
      if (state.recipeSort === "recent")
        return (
          (b.recipe.lastCookedAt ?? "").localeCompare(a.recipe.lastCookedAt ?? "") ||
          a.recipe.name.localeCompare(b.recipe.name)
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
              : state.recipeSort === "recent"
                ? "when you last cooked it"
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

export function recipeCard(entry: MealsSnapshot["recipes"][number]): HTMLElement {
  const card = make("button", "meals-recipe-card");
  (card as HTMLButtonElement).type = "button";
  card.addEventListener("click", () => openRecipe(entry.recipe.id));
  const photo = photoBox(entry.recipe.photo, "meals-recipe-photo");
  if (entry.minutes) photo.appendChild(make("span", "meals-overlay-tag", `⏱ ${entry.minutes} min`));
  photo.appendChild(
    make("span", "meals-overlay-tag is-right", `${entry.coverage.have}/${entry.coverage.total} at home`)
  );
  card.appendChild(photo);
  const kinds = make("div", "meals-row meals-row-tight");
  for (const slot of entry.recipe.slots) kinds.appendChild(pill(MEAL_SLOT_LABELS[slot]));
  if (entry.recipe.components.length >= 2) kinds.appendChild(pill("Multi-dish"));
  if (entry.recipe.batch) kinds.appendChild(pill("Batch-friendly"));
  card.append(kinds, make("span", "meals-recipe-name", entry.recipe.name));
  if (entry.recipe.description) card.appendChild(make("span", "meals-recipe-desc", entry.recipe.description));
  const pills = make("div", "meals-row meals-row-tight");
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

export function recipePage(data: MealsSnapshot, entry: MealsSnapshot["recipes"][number]): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    button("← All recipes", "meals-link", () => {
      state.recipeId = null;
      rerender();
    })
  );
  const servings = state.recipeServings ?? entry.recipe.servings;
  const factor = servings / Math.max(1, entry.recipe.servings);

  const hero = make("section", "meals-hero meals-hero-recipe has-photo");
  const body = make("div", "meals-hero-body");
  const kinds = make("div", "meals-row meals-row-tight");
  for (const slot of entry.recipe.slots) kinds.appendChild(pill(MEAL_SLOT_LABELS[slot]));
  if (entry.recipe.components.length >= 2)
    kinds.appendChild(pill(`Multi-dish · ${entry.recipe.components.length} components`, "accent"));
  if (entry.recipe.batch) kinds.appendChild(pill("Batch-friendly", "accent"));
  if (entry.recipe.source?.startsWith("http")) kinds.appendChild(pill("Imported"));
  for (const tag of entry.recipe.tags) kinds.appendChild(pill(tag));
  body.appendChild(kinds);
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
      rerender();
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
      rerender();
    }),
    button("Edit", "btn btn-ghost", () => {
      state.editing = entry.recipe.id;
      rerender();
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
  hero.appendChild(recipePhoto(entry.recipe));
  wrap.appendChild(hero);

  const columns = make("div", "meals-recipe-columns");

  const ingredients = panel("Ingredients", `${entry.coverage.have} of ${entry.coverage.total} at home`);
  for (const group of byComponent(entry.recipe.components, entry.lines)) {
    if (group.name) ingredients.body.appendChild(make("p", "card-kicker meals-component-head", group.name));
    const lines = make("div", "meals-lines");
    for (const line of group.items) {
      const row = make("div", "meals-line");
      row.append(
        make(
          "span",
          "meals-amount",
          formatAmount({ quantity: line.needed.quantity * factor, unit: line.needed.unit })
        ),
        make("strong", undefined, line.text)
      );
      row.appendChild(lineStatus(line, data.today));
      lines.appendChild(row);
    }
    ingredients.body.appendChild(lines);
  }
  const missing = entry.lines.filter((line) => !line.optional && line.status !== "have").length;
  if (missing)
    ingredients.body.appendChild(
      button(
        `Add ${missing} missing to shopping`,
        "btn btn-secondary btn-block",
        () =>
          void act(async () => {
            const added = await bridge().addMissingToShopping(entry.recipe.id, servings);
            state.message = added
              ? `${added} item${added === 1 ? "" : "s"} added to the shopping list.`
              : "They're already on the shopping list.";
          })
      )
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
  if (entry.nutrition.fibre !== undefined)
    kv("Fibre", entry.nutrition.fibre === null ? "—" : `${entry.nutrition.fibre} g`);
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
      const text = make("div", "meals-step-body");
      text.appendChild(make("p", undefined, step.text));
      const part = entry.recipe.components.find((c) => c.id === step.componentId)?.name;
      if (step.minutes || part) {
        const tags = make("div", "meals-row meals-row-tight");
        if (step.minutes) tags.appendChild(pill(`${step.minutes} min`));
        if (part) tags.appendChild(pill(part));
        text.appendChild(tags);
      }
      row.append(make("span", "meals-step-n", String(index + 1)), text);
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
export function openImport(): void {
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
    rerender();
  });
  actions.append(
    go,
    button("Cancel", "btn btn-ghost", () => rerender())
  );
  body.appendChild(actions);
  showModal(box);
  url.focus();
}

export function recipeEditor(data: MealsSnapshot, id: string): HTMLElement {
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

  // Dishes: a meal of several ("Chicken", "Potatoes", "Spinach salad").
  // Lines and steps can each belong to one; none at all is one dish.
  const batchBox = input("checkbox", "");
  batchBox.checked = existing?.batch ?? false;
  const batchLabel = make("label", "meals-check");
  batchLabel.append(batchBox, document.createTextNode(" Batch-friendly — made to keep or freeze"));
  body.appendChild(batchLabel);

  body.appendChild(make("h6", "kicker", "Dishes"));
  let dishes: Array<{ key: string; name: string }> = (existing?.components ?? []).map((c) => ({
    key: c.id,
    name: c.name,
  }));
  const dishSelects: Array<HTMLSelectElement> = [];
  const dishRow = make("div", "meals-chips");
  const newDish = input("text");
  newDish.placeholder = "e.g. Spinach salad";
  newDish.maxLength = 60;
  const fillDishSelect = (picker: HTMLSelectElement) => {
    const current = picker.value;
    picker.replaceChildren(new Option("—", ""));
    for (const dish of dishes) picker.appendChild(new Option(dish.name, dish.key));
    picker.value = dishes.some((dish) => dish.key === current) ? current : "";
    picker.hidden = dishes.length === 0;
  };
  const drawDishes = () => {
    dishRow.replaceChildren();
    for (const dish of dishes)
      dishRow.appendChild(
        chip(`${dish.name} ✕`, true, () => {
          dishes = dishes.filter((entry) => entry.key !== dish.key);
          drawDishes();
        })
      );
    if (!dishes.length)
      dishRow.appendChild(make("span", "meals-note", "One dish. Add dishes for a meal of several."));
    for (const picker of dishSelects) fillDishSelect(picker);
  };
  const dishPicker = (value: string | null) => {
    const picker = make("select", "select meals-dish-select");
    dishSelects.push(picker);
    fillDishSelect(picker);
    picker.value = value && dishes.some((dish) => dish.key === value) ? value : "";
    return picker;
  };
  const addDish = () => {
    const dishName = newDish.value.trim();
    if (!dishName || dishes.length >= 8) return;
    dishes.push({ key: `new-${Date.now()}-${dishes.length}`, name: dishName });
    newDish.value = "";
    drawDishes();
  };
  newDish.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addDish();
  });
  const dishTools = make("div", "meals-toolbar");
  dishTools.append(newDish, button("+ Add dish", "btn btn-secondary", addDish));
  body.append(dishRow, dishTools);

  body.appendChild(make("h6", "kicker", "Ingredients"));
  const linesBox = make("div", "meals-lines");
  const lineRows: Array<{
    name: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLSelectElement;
    optional: HTMLInputElement;
    dish: HTMLSelectElement;
  }> = [];
  const addLine = (line?: {
    text: string;
    quantity: number | null;
    unit: string | null;
    optional: boolean;
    componentId?: string | null;
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
    const dish = dishPicker(line?.componentId ?? null);
    const entry = { name: lineName, quantity, unit, optional, dish };
    lineRows.push(entry);
    // Which food this line will be: "→ Chicken thighs", or a new one.
    const match = make("span", "meals-line-meta meals-match");
    const showMatch = () => {
      const typed = lineName.value.trim();
      const food = typed ? matchIngredient(typed, data.ingredients) : undefined;
      match.textContent = !typed ? "" : food ? `→ ${food.name}` : "No match · new food on save";
      match.classList.toggle("is-new", Boolean(typed) && !food);
    };
    lineName.addEventListener("input", showMatch);
    showMatch();
    row.append(quantity, unit, lineName, match, dish, optionalLabel);
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

  // Method: a row per step, each with its minutes and its dish.
  body.appendChild(make("h6", "kicker", "Method"));
  const stepsBox = make("div", "meals-lines");
  const stepRows: Array<{ text: HTMLTextAreaElement; minutes: HTMLInputElement; dish: HTMLSelectElement }> =
    [];
  const addStep = (step?: { text: string; minutes: number | null; componentId: string | null }) => {
    const row = make("div", "meals-line meals-line-edit meals-step-edit");
    const stepText = make("textarea", "input meals-step-text");
    stepText.rows = 2;
    stepText.maxLength = 2000;
    stepText.placeholder = `Step ${stepRows.length + 1}`;
    stepText.value = step?.text ?? "";
    const minutes = input("number");
    minutes.min = "0";
    minutes.placeholder = "min";
    minutes.value = step?.minutes ? String(step.minutes) : "";
    const dish = dishPicker(step?.componentId ?? null);
    const entry = { text: stepText, minutes, dish };
    stepRows.push(entry);
    row.append(stepText, minutes, dish);
    row.appendChild(
      button("✕", "meals-link", () => {
        const index = stepRows.indexOf(entry);
        if (index >= 0) stepRows.splice(index, 1);
        row.remove();
      })
    );
    stepsBox.appendChild(row);
  };
  for (const step of existing?.steps ?? []) addStep(step);
  for (const text of draft?.steps ?? []) addStep({ text, minutes: null, componentId: null });
  if (!stepRows.length) addStep();
  body.append(
    stepsBox,
    button("+ Add step", "meals-link", () => addStep())
  );
  drawDishes();

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
              batch: batchBox.checked,
              components: dishes,
              ingredients: lineRows
                .filter((row) => row.name.value.trim() && row.quantity.value)
                .map((row) => ({
                  name: row.name.value,
                  text: row.name.value,
                  quantity: Number(row.quantity.value),
                  unit: row.unit.value,
                  optional: row.optional.checked,
                  component: row.dish.value || null,
                })),
              steps: stepRows
                .filter((row) => row.text.value.trim())
                .map((row) => ({
                  text: row.text.value,
                  minutes: row.minutes.value ? Number(row.minutes.value) : null,
                  component: row.dish.value || null,
                })),
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
      rerender();
    })
  );
  body.appendChild(actions);
  wrap.appendChild(box);
  return wrap;
}

/** A minutes field: the saved recipe's value, else an imported one, else empty. */
export function minutesValue(saved: number | null | undefined, imported: number | null | undefined): string {
  const value = saved ?? imported ?? null;
  return value === null ? "" : String(value);
}

/**
 * What a recipe line's status says, as the design writes it: "Buy · 1 kg
 * pack" when it's not at home (with the package it last came in), and
 * "Home · exp. tomorrow", "Home · opened" or "Home · ≈ est." when it is.
 */
export function lineStatus(
  line: MealsSnapshot["recipes"][number]["lines"][number],
  today: string
): HTMLElement {
  if (line.optional && line.status !== "have") return pill("optional");
  if (line.status === "unknown") return pill("can't measure", "est");
  if (line.status === "missing") return pill(line.packaging ? `Buy · ${line.packaging}` : "Buy", "accent");
  if (line.status === "partial")
    return pill(`Short ${line.short ? formatAmount(line.short) : ""}`.trim(), "urgent");
  const stock = line.stock;
  if (stock && (stock.expiry === "urgent" || stock.expiry === "expired"))
    return pill(`Home · exp. ${expiryLabel(stock.expiresAt, today).replace("tomorrow", "tmrw")}`, "urgent");
  if (stock?.opened) return pill("Home · opened", "soon");
  if (stock?.confidence === "estimated") return pill("Home · ≈ est.", "est");
  return pill("Home", "ok");
}

/** A picture area: the photo when there is one, the design's soft gradient when not. */
export function photoBox(photo: string | null, className: string): HTMLElement {
  const box = make("div", `meals-photo ${className}`);
  if (photo) {
    const img = make("img");
    img.src = photo;
    img.alt = "";
    img.loading = "lazy";
    box.appendChild(img);
  }
  return box;
}

/** The recipe page's photo, with the buttons to choose or remove it. */
function recipePhoto(recipe: MealsSnapshot["recipes"][number]["recipe"]): HTMLElement {
  const box = photoBox(recipe.photo, "meals-hero-photo");
  const tools = make("div", "meals-photo-tools");
  tools.appendChild(
    button(
      recipe.photo ? "Change photo" : "Add a photo",
      "btn btn-secondary",
      () =>
        void act(async () => {
          await bridge().chooseRecipePhoto(recipe.id);
        })
    )
  );
  if (recipe.photo)
    tools.appendChild(
      button(
        "Remove",
        "btn btn-ghost",
        () =>
          void act(async () => {
            await bridge().clearRecipePhoto(recipe.id);
          }, "Photo removed.")
      )
    );
  box.appendChild(tools);
  return box;
}

/**
 * Lines grouped by the dish they belong to, in the recipe's order of
 * dishes; lines with no dish come first, under no heading. A single-dish
 * recipe is one group with no name.
 */
export function byComponent<T extends { componentId: string | null }>(
  components: Array<{ id: string; name: string }>,
  items: T[]
): Array<{ name: string | null; items: T[] }> {
  const groups: Array<{ name: string | null; items: T[] }> = [];
  const loose = items.filter(
    (item) => !item.componentId || !components.some((c) => c.id === item.componentId)
  );
  if (loose.length) groups.push({ name: components.length ? "Also" : null, items: loose });
  for (const component of components) {
    const own = items.filter((item) => item.componentId === component.id);
    if (own.length) groups.push({ name: component.name, items: own });
  }
  if (groups.length === 1 && groups[0].name === "Also") groups[0].name = null;
  return groups;
}
