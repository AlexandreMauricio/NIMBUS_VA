import { MEAL_SLOTS, MEAL_SLOT_LABELS, PLAN_OBJECTIVES, PLAN_OBJECTIVE_LABELS } from "../../meals/types";
import type { MealSlot, PlanObjective } from "../../meals/types";
import {
  MealsSnapshot,
  act,
  bridge,
  button,
  chip,
  euro,
  field,
  input,
  make,
  panel,
  pill,
  select,
  stepper,
} from "./common";

// ---------- Household ----------

/** Words as removable chips, with a box to add one — restrictions and dislikes. */
function chipList(values: string[], placeholder: string): { box: HTMLElement; values: () => string[] } {
  const items = [...values];
  const box = make("div", "meals-chips meals-chip-list");
  const add = input("text");
  add.placeholder = placeholder;
  add.maxLength = 60;
  const draw = () => {
    box.replaceChildren();
    items.forEach((item, index) =>
      box.appendChild(
        button(`${item} ✕`, "meals-chip is-on", () => {
          items.splice(index, 1);
          draw();
        })
      )
    );
    box.appendChild(add);
  };
  const commit = () => {
    const value = add.value.trim();
    if (value && !items.some((item) => item.toLowerCase() === value.toLowerCase())) items.push(value);
    add.value = "";
    draw();
    add.focus();
  };
  add.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    }
  });
  draw();
  // A word typed but not yet entered still counts when saving.
  return { box, values: () => [...items, ...(add.value.trim() ? [add.value.trim()] : [])] };
}

export function settingsView(data: MealsSnapshot): HTMLElement {
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
  const monthly = input("number");
  monthly.step = "1";
  monthly.min = "0";
  monthly.placeholder = "none";
  monthly.value = data.preferences.monthlyBudget === null ? "" : String(data.preferences.monthlyBudget);
  const kcal = input("number");
  kcal.min = "0";
  kcal.placeholder = "none";
  kcal.value = data.preferences.dailyKcal === null ? "" : String(data.preferences.dailyKcal);
  const protein = input("number");
  protein.min = "0";
  protein.placeholder = "none";
  protein.value = data.preferences.dailyProtein === null ? "" : String(data.preferences.dailyProtein);
  const carbs = input("number");
  carbs.min = "0";
  carbs.placeholder = "none";
  carbs.value = data.preferences.dailyCarbs === null ? "" : String(data.preferences.dailyCarbs);
  const fibre = input("number");
  fibre.min = "0";
  fibre.placeholder = "none";
  fibre.value = data.preferences.dailyFibre === null ? "" : String(data.preferences.dailyFibre);
  const restrictions = chipList(data.preferences.restrictions, "+ e.g. No pork");
  const dislikes = chipList(data.preferences.dislikes, "+ e.g. Mushrooms");
  const overBudget = select(
    [
      ["swap", "Swap in cheaper meals"],
      ["warn", "Only warn me"],
    ],
    data.preferences.overBudget
  );
  const form = make("div", "meals-form");
  form.append(
    field("Budget €/day", budget),
    field("Budget €/month", monthly),
    field("Calories/day", kcal),
    field("Protein g/day", protein),
    field("Carbs g/day", carbs),
    field("Fibre g/day", fibre),
    field("When a plan goes over", overBudget)
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
  rules.body.append(
    field("Never suggest · by food, category or tag", restrictions.box),
    field("Avoid when possible", dislikes.box)
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
              restrictions: restrictions.values(),
              dislikes: dislikes.values(),
              overBudget: overBudget.value,
              dailyBudget: budget.value ? Number(budget.value) : null,
              monthlyBudget: monthly.value ? Number(monthly.value) : null,
              dailyKcal: kcal.value ? Number(kcal.value) : null,
              dailyProtein: protein.value ? Number(protein.value) : null,
              dailyCarbs: carbs.value ? Number(carbs.value) : null,
              dailyFibre: fibre.value ? Number(fibre.value) : null,
              slots: [...chosenSlots.entries()].filter(([, on]) => on).map(([slot]) => slot),
            }),
          "Saved."
        )
    )
  );
  wrap.appendChild(rules.box);
  wrap.appendChild(plannerDefaults(data));

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

/** What the planner does unless the controls bar says otherwise. */
function plannerDefaults(data: MealsSnapshot): HTMLElement {
  const prefs = data.preferences;
  const { box, body } = panel("Planning defaults");
  const minutes = (value: number | null) => {
    const box = input("number");
    box.min = "5";
    box.step = "5";
    box.placeholder = "no limit";
    box.value = value === null ? "" : String(value);
    return box;
  };
  const weekday = minutes(prefs.cookingTime.weekday);
  const weekend = minutes(prefs.cookingTime.weekend);
  const difficulty = select(
    [
      ["easy", "Easy only"],
      ["medium", "Up to medium"],
      ["any", "Anything"],
    ],
    prefs.difficulty
  );
  let repeats = prefs.maxRepeats;
  const form = make("div", "meals-form");
  form.append(
    field("Cooking time · weekdays (min)", weekday),
    field("Cooking time · weekends (min)", weekend),
    field("Difficulty", difficulty),
    field(
      "Max repeats per week",
      stepper(repeats, 1, 1, (next) => (repeats = Math.min(7, Math.max(1, Math.round(next)))))
    )
  );
  body.appendChild(form);

  const objectives = new Set<PlanObjective>(prefs.objectives);
  const chips = make("div", "meals-chips");
  for (const objective of PLAN_OBJECTIVES) {
    const on = chip(PLAN_OBJECTIVE_LABELS[objective], objectives.has(objective), () => {
      if (objectives.has(objective)) objectives.delete(objective);
      else objectives.add(objective);
      on.classList.toggle("is-on", objectives.has(objective));
      on.setAttribute("aria-pressed", String(objectives.has(objective)));
    });
    chips.appendChild(on);
  }
  body.append(make("p", "meals-field-label", "Default objectives"), chips);

  const auto = input("checkbox", "");
  auto.checked = prefs.autoLeftovers;
  const autoLabel = make("label", "meals-check");
  autoLabel.append(
    auto,
    document.createTextNode(" Plan leftovers automatically — cooking offers the next free slot")
  );
  body.appendChild(autoLabel);
  body.appendChild(
    make(
      "p",
      "meals-note",
      "The planner never uses a restriction, keeps within these times and difficulty, and favours your favourites without repeating a recipe more than this in a week."
    )
  );
  body.appendChild(
    button(
      "Save",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().updateMealPreferences({
              cookingTime: {
                weekday: weekday.value ? Number(weekday.value) : null,
                weekend: weekend.value ? Number(weekend.value) : null,
              },
              difficulty: difficulty.value,
              objectives: [...objectives],
              autoLeftovers: auto.checked,
              maxRepeats: repeats,
            }),
          "Saved."
        )
    )
  );
  return box;
}
