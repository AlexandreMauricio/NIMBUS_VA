import { MEAL_SLOT_LABELS } from "../../meals/types";
import {
  MealsSnapshot,
  PlanEntryUI,
  ReplaceOptionUI,
  act,
  bridge,
  button,
  chip,
  dayLabel,
  errorText,
  euro,
  field,
  input,
  make,
  panel,
  pill,
  rerender,
  state,
} from "./common";
import { openCook } from "./cook";

// ---------- The replace drawer ----------

/** The options for the open meal, fetched once per snapshot. */
let cache: { mealId: string; data: MealsSnapshot; options: ReplaceOptionUI[] | null; error: string } | null =
  null;
/** The option being previewed in "Effect of replacing". */
let previewing: { mealId: string; recipeId: string } | null = null;

const CUSTOM_KINDS: Array<[string, string]> = [
  ["out", "Eating out"],
  ["takeaway", "Takeaway"],
  ["friends", "At friends'"],
  ["work", "At work"],
  ["skip", "Skip meal"],
  ["custom", "Something I'll make"],
];

function findEntry(data: MealsSnapshot, mealId: string): { entry: PlanEntryUI; proposed: boolean } | null {
  const proposed = data.proposal?.meals.find((entry) => entry.meal.id === mealId);
  if (proposed) return { entry: proposed, proposed: true };
  const planned = data.plan.find((entry) => entry.meal.id === mealId);
  return planned ? { entry: planned, proposed: false } : null;
}

function close(): void {
  state.replacing = null;
  previewing = null;
  rerender();
}

const signed = (value: number) => `${value >= 0 ? "+" : "−"}${euro(Math.abs(value))}`;

/**
 * The drawer the design opens from any meal: why it was suggested, how far
 * leftovers go, what it could be replaced with — a suggestion, one of your
 * recipes, or something that isn't a recipe — what that would change, and
 * Regenerate / Lock.
 */
export function replaceDrawer(data: MealsSnapshot): HTMLElement | null {
  if (!state.replacing) return null;
  const found = findEntry(data, state.replacing);
  if (!found) {
    state.replacing = null;
    return null;
  }
  const { entry, proposed } = found;
  const meal = entry.meal;
  if (!cache || cache.mealId !== meal.id || cache.data !== data) {
    cache = { mealId: meal.id, data, options: null, error: "" };
    const mine = cache;
    bridge()
      .replaceOptions(meal.id)
      .then(
        (options) => {
          mine.options = options;
        },
        (err) => {
          mine.error = errorText(err);
        }
      )
      .finally(() => {
        if (cache === mine) rerender();
      });
  }
  const options = cache.options;

  const { box, body } = panel(
    `${MEAL_SLOT_LABELS[meal.slot]} · ${dayLabel(meal.date)} · ${meal.servings} ${meal.servings === 1 ? "person" : "people"}`,
    button("✕", "meals-link", close)
  );
  box.classList.add("meals-drawer", "meals-replace");
  const title = make("div", "meals-row");
  title.append(make("h3", "meals-drawer-title", entry.name));
  if (meal.locked) title.appendChild(pill("Locked", "accent"));
  if (entry.badge) title.appendChild(pill(entry.badge.label));
  body.appendChild(title);

  if (meal.reasons.length) {
    body.appendChild(make("p", "card-kicker", "Why this was suggested"));
    const why = make("ul", "meals-why");
    for (const reason of meal.reasons) why.appendChild(make("li", undefined, reason));
    body.appendChild(why);
  }

  // Leftovers that don't feed everyone: how far they go, and what's at home to go with them.
  if (meal.kind === "leftover") {
    const leftover = data.leftovers.find((l) => l.id === meal.leftoverId);
    const portions = Math.min(leftover?.portions ?? 0, meal.servings);
    const short = Math.max(0, meal.servings - portions);
    const cover = make("div", "meals-leftover-box");
    cover.appendChild(make("p", "card-kicker", `Coverage · ${meal.servings} eating`));
    const bar = make("div", "meals-coverage");
    const have = make("span", "is-have");
    have.style.flex = String(portions || 0.001);
    const need = make("span", "is-need");
    need.style.flex = String(short || 0.001);
    bar.append(have, need);
    cover.appendChild(bar);
    const kv = (label: string, value: string, warn = false) => {
      const row = make("div", `meals-kv${warn ? " is-warn" : ""}`);
      row.append(make("span", undefined, label), make("strong", undefined, value));
      cover.appendChild(row);
    };
    kv(leftover?.name ?? "Leftovers", `${portions} portion${portions === 1 ? "" : "s"}`);
    if (short) {
      kv("Still needed", `${short} portion${short === 1 ? "" : "s"}`, true);
      const sides = (options ?? [])
        .filter((o) => o.coverage.total > 0 && o.coverage.have === o.coverage.total)
        .slice(0, 3);
      if (sides.length)
        cover.appendChild(
          make("p", "meals-note", `All at home to make alongside: ${sides.map((s) => s.name).join(", ")}.`)
        );
    }
    body.appendChild(cover);
  }

  if (meal.cookedAt) {
    body.appendChild(make("p", "meals-note", "Already cooked."));
  } else {
    body.appendChild(make("p", "card-kicker", "Replace with"));
    const tabs = make("div", "meals-seg");
    for (const [id, label] of [
      ["suggestions", "Suggestions"],
      ["mine", "My recipes"],
      ["custom", "Custom meal"],
    ] as Array<[typeof state.replaceTab, string]>)
      tabs.appendChild(
        button(label, state.replaceTab === id ? "is-on" : "", () => {
          state.replaceTab = id;
          rerender();
        })
      );
    body.appendChild(tabs);
    if (cache.error) body.appendChild(make("p", "form-error", cache.error));
    if (state.replaceTab === "custom") body.appendChild(customForm(meal.id, meal.servings, entry.name));
    else if (!options) body.appendChild(make("p", "meals-note", "Finding what fits…"));
    else {
      const shown = state.replaceTab === "suggestions" ? options.filter((o) => !o.note).slice(0, 3) : options;
      body.append(optionList(meal.id, shown), effectBox(meal.id, shown));
    }
  }

  const actions = make("div", "meals-row");
  // Two things in one meal: a takeaway for one, leftovers for another.
  if (!proposed)
    actions.appendChild(
      button("+ Another meal here", "btn btn-ghost", () => {
        state.replacing = null;
        state.view = "plan";
        state.planning = { date: meal.date, slot: meal.slot, mealId: null };
        rerender();
      })
    );
  if (!meal.cookedAt) {
    actions.append(
      button(
        "Regenerate this slot",
        "btn btn-secondary",
        () => void act(() => bridge().regenerateSlot(meal.id))
      ),
      button(
        meal.locked ? "Unlock" : "Lock",
        "btn btn-ghost",
        () => void act(() => bridge().lockMeal(meal.id, !meal.locked))
      )
    );
    if (!proposed && meal.kind === "recipe" && meal.recipeId)
      actions.appendChild(
        button("Cook", "btn btn-ghost", () => {
          state.replacing = null;
          openCook(meal.recipeId!, meal);
        })
      );
  }
  if (!proposed) {
    actions.append(
      button("Edit details", "btn btn-ghost", () => {
        state.replacing = null;
        state.view = "plan";
        state.planning = { date: meal.date, slot: meal.slot, mealId: meal.id };
        rerender();
      }),
      button(
        "Remove",
        "btn btn-ghost",
        () =>
          void act(async () => {
            await bridge().removePlannedMeal(meal.id);
            state.replacing = null;
          })
      )
    );
  }
  body.appendChild(actions);

  const backdrop = make("div", "meals-drawer-backdrop");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.appendChild(box);
  return backdrop;
}

/** Recipes on offer: a line each — what changes, "Use", and a preview of the effect on a click. */
function optionList(mealId: string, options: ReplaceOptionUI[]): HTMLElement {
  const wrap = make("div", "meals-options");
  if (state.replaceTab === "mine") {
    const chips = make("div", "meals-chips");
    for (const [id, label] of [
      ["budget", "Fits budget"],
      ["pantry", "Uses pantry"],
      ["favourites", "Favourites"],
    ] as Array<[string, string]>)
      chips.appendChild(
        chip(label, mineFilter === id, () => {
          mineFilter = mineFilter === id ? null : id;
          rerender();
        })
      );
    wrap.appendChild(chips);
  }
  const shown = options.filter((o) =>
    state.replaceTab !== "mine" || !mineFilter
      ? true
      : mineFilter === "budget"
        ? o.delta !== null && o.delta <= 0
        : mineFilter === "pantry"
          ? o.coverage.total > 0 && o.coverage.have === o.coverage.total
          : o.favourite
  );
  if (!shown.length) wrap.appendChild(make("p", "meals-note", "Nothing else fits this meal."));
  for (const option of shown) {
    const row = make("div", `meals-option${previewing?.recipeId === option.recipeId ? " is-on" : ""}`);
    const what = button("", "meals-option-what", () => {
      previewing = { mealId, recipeId: option.recipeId };
      rerender();
    });
    what.append(
      make("strong", undefined, option.name),
      make(
        "span",
        `meals-line-meta${option.note ? " is-warn" : ""}`,
        [
          option.delta === null ? null : signed(option.delta),
          option.minutes ? `${option.minutes} min` : null,
          option.coverage.total ? `${option.coverage.have}/${option.coverage.total} at home` : null,
          option.note,
        ]
          .filter(Boolean)
          .join(" · ")
      )
    );
    row.append(
      what,
      button(
        "Use",
        "btn btn-secondary",
        () =>
          void act(async () => {
            await bridge().replaceMeal(mealId, { kind: "recipe", recipeId: option.recipeId });
            previewing = null;
            state.replacing = null;
          }, `${option.name} it is.`)
      )
    );
    wrap.appendChild(row);
  }
  return wrap;
}

let mineFilter: string | null = null;

/** A meal that isn't a recipe: out, takeaway, at friends', skipped, or something you'll make. */
function customForm(mealId: string, servings: number, current: string): HTMLElement {
  const wrap = make("div", "meals-custom");
  let kind = "custom";
  const kinds = make("div", "meals-chips");
  const name = input("text");
  name.maxLength = 200;
  name.value = current;
  const people = input("number");
  people.min = "1";
  people.value = String(servings);
  const cost = input("number");
  cost.step = "0.01";
  cost.min = "0";
  cost.placeholder = "≈ €";
  const ingredients = input("text");
  ingredients.placeholder = "e.g. 400 g salt cod, 6 eggs, 500 g potatoes";
  const addMissing = input("checkbox", "");
  addMissing.checked = true;
  const saveRecipe = input("checkbox", "");
  const drawKinds = () => {
    kinds.replaceChildren();
    for (const [id, label] of CUSTOM_KINDS)
      kinds.appendChild(
        chip(label, kind === id, () => {
          kind = id;
          drawKinds();
          own.hidden = kind !== "custom";
          if (kind !== "custom" && kind !== "out") name.value = label;
        })
      );
  };
  const own = make("div", "meals-form");
  const check = (box: HTMLInputElement, text: string) => {
    const label = make("label", "meals-check");
    label.append(box, document.createTextNode(` ${text}`));
    return label;
  };
  own.append(
    field("Ingredients · optional", ingredients),
    check(addMissing, "Add missing ingredients to the shopping list"),
    check(saveRecipe, "Save as a recipe for next time")
  );
  drawKinds();
  const form = make("div", "meals-form");
  form.append(field("Meal name", name), field("Servings", people), field("Cost · optional", cost));

  wrap.append(kinds, form, own);
  wrap.appendChild(
    make(
      "p",
      "meals-note",
      "A custom meal without ingredients counts as its cost and doesn't touch the pantry or nutrition."
    )
  );
  wrap.appendChild(
    button(
      "Use this",
      "btn btn-secondary",
      () =>
        void act(async () => {
          await bridge().replaceMeal(mealId, {
            kind,
            name: name.value,
            servings: Number(people.value) || servings,
            cost: kind === "skip" ? 0 : cost.value ? Number(cost.value) : null,
            ingredients: kind === "custom" ? ingredients.value : undefined,
            addMissing: addMissing.checked,
            saveAsRecipe: saveRecipe.checked,
          });
          previewing = null;
          state.replacing = null;
        }, "Changed.")
    )
  );
  return wrap;
}

/** "Effect of replacing": the plan's cost, the shopping list's difference, and that nothing else moves. */
function effectBox(mealId: string, options: ReplaceOptionUI[]): HTMLElement {
  const box = make("div", "meals-effect");
  box.appendChild(make("p", "card-kicker", "Effect of replacing"));
  const chosen = previewing;
  const target =
    chosen && chosen.mealId === mealId && options.some((o) => o.recipeId === chosen.recipeId)
      ? chosen
      : options[0]
        ? { mealId, recipeId: options[0].recipeId }
        : null;
  if (!target) {
    box.appendChild(make("p", "meals-note", "Pick an option to see what it changes."));
    return box;
  }
  const name = options.find((o) => o.recipeId === target.recipeId)?.name ?? "";
  box.appendChild(make("p", "meals-line-meta", `With ${name}:`));
  const list = make("div", "meals-kv-list");
  box.appendChild(list);
  bridge()
    .replaceEffect(mealId, target.recipeId)
    .then(
      (effect) => {
        const kv = (label: string, value: string) => {
          const row = make("div", "meals-kv");
          row.append(make("span", undefined, label), make("strong", undefined, value));
          list.appendChild(row);
        };
        kv("Plan cost", `${euro(effect.before)} → ${euro(effect.after)}`);
        const shopping = [...effect.less.map((t) => `−${t}`), ...effect.more.map((t) => `+${t}`)];
        kv("Shopping list", shopping.length ? shopping.join(", ") : "Unchanged");
        kv("Other meals", "Unchanged");
      },
      (err) => list.appendChild(make("p", "form-error", errorText(err)))
    );
  return box;
}
