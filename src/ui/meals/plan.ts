import { MEAL_SLOT_LABELS } from "../../meals/types";
import type { MealSlot } from "../../meals/types";
import {
  MealsSnapshot,
  act,
  bridge,
  button,
  dayLabel,
  euro,
  field,
  input,
  make,
  panel,
  pill,
  rerender,
  select,
  state,
} from "./common";

// ---------- Plan ----------

export function planView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  wrap.appendChild(
    make(
      "p",
      "meals-note",
      `Cooking for ${data.servingsNeeded} serving${data.servingsNeeded === 1 ? "" : "s"}, from the people in Settings. Click a slot to fill it.`
    )
  );
  if (state.planning) wrap.appendChild(planEditor(data, state.planning));

  // As the design draws it: a row per meal slot, a column per day. The
  // row label carries the slot's usual time and what it costs this week;
  // a day's header turns amber when the day goes over its budget.
  const scroller = make("div", "meals-plan-scroll");
  const grid = make("div", "meals-plan-grid");
  grid.style.gridTemplateColumns = `6rem repeat(${data.days.length}, minmax(0, 1fr))`;
  grid.appendChild(make("div"));
  for (const date of data.days) {
    const spend = data.spend.find((entry) => entry.date === date);
    const head = make("div", `meals-plan-day${date === data.today ? " is-today" : ""}`);
    const [weekday, day] = dayLabel(date).split(" ");
    head.append(
      make("span", "meals-plan-daynum", day ?? ""),
      make("span", "card-kicker", weekday ?? ""),
      make(
        "span",
        `meals-plan-daycost${spend?.over ? " is-over" : ""}`,
        !spend || spend.total === null ? "" : `≈ ${euro(spend.total)}`
      )
    );
    grid.appendChild(head);
  }

  for (const slot of data.preferences.slots) {
    const row = data.plan.filter((p) => p.meal.slot === slot && data.days.includes(p.meal.date));
    const times = row.map((p) => p.meal.time).filter((t): t is string => Boolean(t));
    const usual = times.sort(
      (a, b) => times.filter((t) => t === b).length - times.filter((t) => t === a).length
    )[0];
    const total = row.reduce<number | null>((sum, p) => (p.cost === null ? sum : (sum ?? 0) + p.cost), null);
    const label = make("div", "meals-plan-slot");
    label.append(
      make("span", "meals-plan-slotname", MEAL_SLOT_LABELS[slot]),
      make("span", "meals-plan-slotmeta", usual ?? ""),
      make("span", "meals-plan-slotmeta", total === null ? "" : `≈ ${euro(total)}`)
    );
    grid.appendChild(label);

    for (const date of data.days) {
      const entry = row.find((p) => p.meal.date === date);
      const classes = ["meals-pcell"];
      if (date === data.today) classes.push("is-today");
      if (!entry) classes.push("is-empty");
      if (entry?.meal.cookedAt) classes.push("is-done");
      if (entry?.badge?.kind === "leftover") classes.push("is-leftover");
      if (entry?.badge?.kind === "swap") classes.push("is-swap");
      if (entry?.badge?.kind === "pick") classes.push("is-pick");
      const cell = button("", classes.join(" "), () => {
        state.planning = { date, slot, mealId: entry?.meal.id ?? null };
        rerender();
      });
      if (entry) {
        cell.appendChild(make("span", "meals-pcell-name", entry.name));
        const foot = make("span", "meals-pcell-foot");
        if (entry.badge) foot.appendChild(pill(entry.badge.label, BADGE_PILL[entry.badge.kind]));
        foot.appendChild(
          make(
            "span",
            "meals-cell-meta",
            [
              entry.meal.cookServings && entry.meal.cookServings > entry.meal.servings
                ? `cook ×${entry.meal.cookServings}`
                : `${entry.meal.servings}p`,
              entry.meal.kind === "out" && entry.cost === null
                ? "not budgeted"
                : entry.cost === null
                  ? null
                  : `≈ ${euro(entry.cost)}`,
              entry.meal.cookedAt ? "cooked" : null,
            ]
              .filter(Boolean)
              .join(" · ")
          )
        );
        cell.appendChild(foot);
      } else {
        cell.appendChild(make("span", "meals-cell-add", "+ Add"));
      }
      grid.appendChild(cell);
    }
  }
  scroller.appendChild(grid);
  wrap.appendChild(scroller);

  const key = make("div", "meals-plan-key");
  const keyItem = (label: string, kind: Parameters<typeof pill>[1], text: string) => {
    key.append(pill(label, kind), make("span", undefined, text));
  };
  // Only the badges the grid actually shows.
  const shown = new Set(data.plan.map((p) => p.badge?.kind).filter(Boolean));
  if (shown.has("leftover")) keyItem("↺ 2/3", "left", "leftover portions / people");
  if (shown.has("swap")) keyItem("€ −3,10", "soon", "budget swap");
  if (shown.has("pantry")) keyItem("◦ Pantry", "calm", "nothing to buy");
  if (shown.has("pick")) keyItem("✎ Your pick", "accent", "kept when regenerating");
  key.appendChild(make("span", "meals-plan-key-hint", "Click any meal to change it"));
  wrap.appendChild(key);
  return wrap;
}

const BADGE_PILL: Record<string, Parameters<typeof pill>[1]> = {
  leftover: "left",
  pantry: "calm",
  pick: "accent",
  swap: "soon",
};

export function planEditor(
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
      rerender();
    })
  );
  body.appendChild(actions);
  return box;
}
