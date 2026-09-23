import { MEAL_SLOTS, MEAL_SLOT_LABELS } from "../../meals/types";
import type { MealSlot } from "../../meals/types";
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
  stepper,
} from "./common";

// ---------- Settings ----------

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
  const restrictions = input("text");
  restrictions.value = data.preferences.restrictions.join(", ");
  restrictions.placeholder = "No pork, Gluten-free";
  const dislikes = input("text");
  dislikes.value = data.preferences.dislikes.join(", ");
  dislikes.placeholder = "Mushrooms, coriander";
  const form = make("div", "meals-form");
  form.append(
    field("Budget €/day", budget),
    field("Budget €/month", monthly),
    field("Calories/day", kcal),
    field("Protein g/day", protein),
    field("Carbs g/day", carbs),
    field("Fibre g/day", fibre),
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
