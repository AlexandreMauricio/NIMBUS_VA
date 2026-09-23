import { dayRange } from "../../meals/plan";
import { servingsSlider } from "./servings";
import { MEAL_SLOTS, MEAL_SLOT_LABELS, PLAN_OBJECTIVES, PLAN_OBJECTIVE_LABELS } from "../../meals/types";
import type { MealSlot } from "../../meals/types";
import {
  MealsSnapshot,
  act,
  bridge,
  button,
  chip,
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

/**
 * The controls bar above the plan, as the design has it: how long, for how
 * many, which meals, the budget and the objectives — then Regenerate.
 * Anything not touched comes from the Household defaults.
 */
function plannerControls(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel("Plan the week");
  box.classList.add("meals-planner");
  const p = state.planner;
  const prefs = data.preferences;
  const slots = p.slots ?? prefs.slots;
  const objectives = p.objectives ?? prefs.objectives;
  const row = make("div", "meals-planner-row");

  const length = make("div", "meals-chips");
  for (const [days, label] of [
    [1, "1 day"],
    [3, "3 days"],
    [7, "Week"],
  ] as Array<[number, string]>)
    length.appendChild(
      chip(label, p.days === days, () => {
        p.days = days;
        rerender();
      })
    );
  const eating = input("number");
  eating.min = "1";
  eating.value = String(p.eating ?? data.servingsNeeded);
  eating.addEventListener("change", () => (p.eating = Number(eating.value) || null));
  const meals = make("div", "meals-chips");
  for (const slot of MEAL_SLOTS)
    meals.appendChild(
      chip(MEAL_SLOT_LABELS[slot], slots.includes(slot), () => {
        p.slots = slots.includes(slot) ? slots.filter((s) => s !== slot) : [...slots, slot];
        rerender();
      })
    );
  const perDay = input("number");
  perDay.step = "0.5";
  perDay.min = "0";
  perDay.placeholder = "none";
  const dayBudget = p.budgetPerDay === undefined ? prefs.dailyBudget : p.budgetPerDay;
  perDay.value = dayBudget === null ? "" : String(dayBudget);
  perDay.addEventListener("change", () => (p.budgetPerDay = perDay.value ? Number(perDay.value) : null));
  const whole = input("number");
  whole.step = "1";
  whole.min = "0";
  whole.placeholder = "none";
  whole.value = p.budgetTotal === null ? "" : String(p.budgetTotal);
  whole.addEventListener("change", () => (p.budgetTotal = whole.value ? Number(whole.value) : null));
  row.append(
    field("Length", length),
    field("Eating", eating),
    field("Meals", meals),
    field("Per day €", perDay),
    field("Whole plan €", whole)
  );
  body.appendChild(row);

  const goals = make("div", "meals-planner-row meals-planner-goals");
  const chips = make("div", "meals-chips");
  chips.appendChild(make("span", "meals-line-meta", "Objectives"));
  for (const objective of PLAN_OBJECTIVES)
    chips.appendChild(
      chip(PLAN_OBJECTIVE_LABELS[objective], objectives.includes(objective), () => {
        p.objectives = objectives.includes(objective)
          ? objectives.filter((o) => o !== objective)
          : [...objectives, objective];
        rerender();
      })
    );
  const run = make("div", "meals-row");
  run.append(
    button("Defaults", "meals-link", () => {
      state.view = "settings";
      rerender();
    }),
    button(
      data.proposal ? "Regenerate" : "Propose a plan",
      "btn btn-secondary",
      () => void act(() => bridge().generatePlan(plannerRequest(data)), "")
    )
  );
  goals.append(chips, run);
  body.appendChild(goals);
  return box;
}

/** What the controls bar asks for, with the defaults filled in. */
function plannerRequest(data: MealsSnapshot, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = state.planner;
  return {
    // A later week is planned from its first day; this week from today — never the past.
    from: state.weekOffset > 0 ? weekDays(data)[0] : data.today,
    days: p.days,
    eating: p.eating ?? data.servingsNeeded,
    slots: p.slots ?? data.preferences.slots,
    budgetPerDay: p.budgetPerDay === undefined ? data.preferences.dailyBudget : p.budgetPerDay,
    budgetTotal: p.budgetTotal,
    objectives: p.objectives ?? data.preferences.objectives,
    ...extra,
  };
}

/** "Proposed · not yet accepted": the figures, Accept and Discard, and the over-budget banner. */
function proposalHeader(data: MealsSnapshot): HTMLElement | null {
  const proposal = data.proposal;
  if (!proposal) return null;
  const wrap = make("div", "meals-proposal");
  const head = make("div", "meals-proposal-head");
  const title = make("div");
  const last = dayLabel(
    proposal.request.days > 1
      ? (data.days[proposal.request.days - 1] ?? proposal.request.from)
      : proposal.request.from
  );
  title.append(
    pill("Proposed · not yet accepted", "est"),
    make("h3", "meals-proposal-title", `${dayLabel(proposal.request.from)} – ${last}`)
  );
  const figures = make("div", "meals-facts");
  const figure = (label: string, value: string, warn = false) => {
    const box = make("div", "meals-fact");
    box.append(
      make("span", "card-kicker", label),
      make("span", `meals-fact-value${warn ? " is-warn" : ""}`, value)
    );
    figures.appendChild(box);
  };
  figure(
    "Cost",
    `≈ ${euro(proposal.cost)}${proposal.budget === null ? "" : ` / ${euro(proposal.budget)}`}`,
    proposal.over !== null
  );
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  figure("From pantry", count(proposal.fromPantry, "item"));
  figure(
    "Leftovers",
    `${count(proposal.leftoverPortions, "portion")} · ${count(proposal.leftoverMeals, "meal")}`
  );
  figure("To buy", count(proposal.toBuy, "item"));
  const actions = make("div", "meals-row");
  actions.append(
    button("Discard", "btn btn-ghost", () => void act(() => bridge().discardPlan(), "Proposal discarded.")),
    button("Accept plan", "btn btn-primary", () => void act(() => bridge().acceptPlan(), "The plan is in."))
  );
  head.append(title, figures, actions);
  wrap.appendChild(head);

  if (proposal.over !== null) {
    const banner = make("div", "meals-over-banner");
    const swapped = proposal.meals.filter((entry) => entry.meal.swapSaving);
    banner.append(
      pill(`Over budget · +${euro(proposal.over)}`, "soon"),
      make(
        "span",
        "meals-over-text",
        [
          swapped.length
            ? `${swapped.map((entry) => `${dayLabel(entry.meal.date).split(" ")[0]} ${entry.name.toLowerCase()} is already a budget swap`).join("; ")}.`
            : null,
          `The rest can't fit ${euro(proposal.budget)} for ${proposal.request.eating} × ${proposal.request.slots.length} meals × ${proposal.request.days} days.`,
        ]
          .filter(Boolean)
          .join(" ")
      )
    );
    const fixes = make("div", "meals-row meals-row-tight");
    for (const fix of proposal.fixes) {
      if (fix.kind === "raise")
        fixes.appendChild(
          button(`Raise to ${euro(fix.to)}`, "meals-alt-btn", () => {
            state.planner.budgetTotal = fix.to;
            state.planner.budgetPerDay = null;
            void act(() =>
              bridge().generatePlan(plannerRequest(data, { budgetTotal: fix.to, budgetPerDay: null }))
            );
          })
        );
      else if (fix.kind === "repeats")
        fixes.appendChild(
          button(
            "Allow repeats",
            "meals-alt-btn",
            () => void act(() => bridge().generatePlan(plannerRequest(data, { allowRepeats: true })))
          )
        );
      else
        fixes.appendChild(
          button(`Swap ${fix.name}`, "meals-alt-btn", () => {
            state.replacing = fix.mealId;
            rerender();
          })
        );
    }
    banner.appendChild(fixes);
    wrap.appendChild(banner);
  }
  if (proposal.gaps.length)
    wrap.appendChild(
      make(
        "p",
        "meals-note",
        `Left empty: ${proposal.gaps
          .map((gap) => `${dayLabel(gap.date)} ${MEAL_SLOT_LABELS[gap.slot].toLowerCase()} — ${gap.why}`)
          .join(" · ")}.`
      )
    );
  return wrap;
}

/** The days the plan shows: the seven from today, or the same seven moved by whole weeks. */
function weekDays(data: MealsSnapshot): string[] {
  if (state.weekOffset === 0) return data.days;
  const from = new Date(`${data.today}T12:00:00`);
  from.setDate(from.getDate() + state.weekOffset * 7);
  return dayRange(from, 7);
}

/** ‹ Last week · This week · Next week › — any week can be looked at; only today onwards changed. */
function weekNav(data: MealsSnapshot, days: string[]): HTMLElement {
  const nav = make("div", "meals-week-nav");
  const offset = state.weekOffset;
  const name =
    offset === 0
      ? "This week"
      : offset === 1
        ? "Next week"
        : offset === -1
          ? "Last week"
          : offset > 0
            ? `In ${offset} weeks`
            : `${-offset} weeks ago`;
  const go = (by: number | null) => () => {
    state.weekOffset = by === null ? 0 : state.weekOffset + by;
    rerender();
  };
  nav.append(
    button("‹", "btn btn-ghost", go(-1)),
    make("strong", undefined, name),
    make("span", "meals-line-meta", `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])}`),
    button("›", "btn btn-ghost", go(1))
  );
  if (offset !== 0) nav.appendChild(button("Back to this week", "meals-link", go(null)));
  if (days[days.length - 1] < data.today)
    nav.appendChild(make("span", "meals-line-meta", "· past days can be looked at, not changed"));
  return nav;
}

export function planView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  const days = weekDays(data);
  // Planning is for today onwards: the controls go when the whole week is past.
  if (days[days.length - 1] >= data.today) wrap.appendChild(plannerControls(data));
  const header = proposalHeader(data);
  if (header) wrap.appendChild(header);
  if (state.planning) wrap.appendChild(planEditor(data, state.planning));

  // What each cell shows: a proposed meal over the planned one, until accepted.
  const entries = [
    ...data.plan.filter(
      (p) => !data.proposal?.meals.some((q) => q.meal.date === p.meal.date && q.meal.slot === p.meal.slot)
    ),
    ...(data.proposal?.meals ?? []),
  ];

  // As the design draws it: a row per meal slot, a column per day. The
  // row label carries the slot's usual time and what it costs this week;
  // a day's header turns amber when the day goes over its budget.
  wrap.appendChild(weekNav(data, days));
  // A day's cost: worked out in main for this week, added up here for any other.
  const spendOf = (date: string) => {
    const known = data.spend.find((entry) => entry.date === date);
    if (known) return known;
    const costs = entries.filter((p) => p.meal.date === date && p.cost !== null).map((p) => p.cost!);
    const total = costs.length ? Math.round(costs.reduce((sum, cost) => sum + cost, 0) * 100) / 100 : null;
    return {
      date,
      total,
      over: data.preferences.dailyBudget !== null && (total ?? 0) > data.preferences.dailyBudget,
    };
  };
  const scroller = make("div", "meals-plan-scroll");
  const grid = make("div", "meals-plan-grid");
  grid.style.gridTemplateColumns = `6rem repeat(${days.length}, minmax(0, 1fr))`;
  grid.appendChild(make("div"));
  for (const date of days) {
    const spend = spendOf(date);
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
    const row = entries.filter((p) => p.meal.slot === slot && days.includes(p.meal.date));
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

    for (const date of days) {
      const past = date < data.today;
      // Leftovers first, then anything cooked alongside them for whoever they don't feed.
      const here = row
        .filter((p) => p.meal.date === date)
        .sort((a, b) => Number(b.meal.kind === "leftover") - Number(a.meal.kind === "leftover"));
      const entry = here[0];
      const beside = here.slice(1);
      const classes = ["meals-pcell"];
      if (date === data.today) classes.push("is-today");
      if (past) classes.push("is-past");
      if (!entry) classes.push("is-empty");
      if (entry?.meal.cookedAt) classes.push("is-done");
      if (entry?.badge?.kind === "leftover") classes.push("is-leftover");
      if (entry?.badge?.kind === "swap") classes.push("is-swap");
      if (entry?.badge?.kind === "pick") classes.push("is-pick");
      if (entry && data.proposal?.meals.includes(entry)) classes.push("is-proposed");
      // A meal opens the replace drawer; an empty slot, the form to fill it.
      const cell = button("", classes.join(" "), () => {
        if (past) return;
        if (entry) state.replacing = entry.meal.id;
        else state.planning = { date, slot, mealId: null };
        rerender();
      });
      if (entry) {
        const title = make("span", "meals-pcell-name", entry.name);
        // Locked: kept exactly as it is whenever the planner runs.
        if (entry.meal.locked) {
          const lock = make("span", "meals-pcell-lock", "🔒");
          lock.title = "Locked — never replaced when the planner runs";
          title.appendChild(lock);
        }
        cell.appendChild(title);
        const foot = make("span", "meals-pcell-foot");
        if (entry.badge) foot.appendChild(pill(entry.badge.label, BADGE_PILL[entry.badge.kind]));
        foot.appendChild(
          make(
            "span",
            "meals-cell-meta",
            [
              entry.cooks !== null && entry.cooks > entry.meal.servings
                ? `cook ${entry.cooks} · eat ${entry.meal.servings}`
                : entry.meal.kind === "leftover" && entry.meal.portions !== null
                  ? `${entry.meal.portions} of ${entry.meal.servings}p`
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
        for (const other of beside) {
          // Its own click: the dish alongside opens its own drawer.
          const part = make("span", "meals-pcell-beside", `+ ${other.name} · ${other.meal.servings}p`);
          part.title = "Cooked alongside the leftovers for whoever they don't feed";
          part.addEventListener("click", (event) => {
            event.stopPropagation();
            state.replacing = other.meal.id;
            rerender();
          });
          cell.appendChild(part);
        }
      } else {
        if (!past) cell.appendChild(make("span", "meals-cell-add", "+ Add"));
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
  const shown = new Set(entries.map((p) => p.badge?.kind).filter(Boolean));
  if (shown.has("leftover")) keyItem("↺ 2/3", "left", "leftover portions / people");
  if (shown.has("swap")) keyItem("€ −3,10", "soon", "budget swap");
  if (shown.has("pantry")) keyItem("◦ Pantry", "calm", "nothing to buy");
  if (shown.has("pick")) keyItem("✎ Your pick", "accent", "kept when regenerating");
  if (shown.has("kind")) keyItem("Out", "est", "not cooked at home");
  key.appendChild(make("span", "meals-plan-key-hint", "Click any meal to change it"));
  wrap.appendChild(key);
  return wrap;
}

const BADGE_PILL: Record<string, Parameters<typeof pill>[1]> = {
  kind: "est",
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
      ["takeaway", "Takeaway"],
      ["work", "At work"],
      ["friends", "At friends'"],
      ["skip", "Skipped"],
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
  // Leftovers in the kitchen, and those a batch planned before this meal will leave (within three days).
  const slotKey = (date: string, slot: MealSlot) => `${date}|${MEAL_SLOTS.indexOf(slot)}`;
  const upcoming = data.expectedLeftovers.filter(
    (expected) =>
      (expected.free > 0 || expected.mealId === existing?.fromMealId) &&
      slotKey(expected.date, expected.slot) < slotKey(target.date, target.slot) &&
      Date.parse(`${target.date}T12:00:00`) - Date.parse(`${expected.date}T12:00:00`) <= 3 * 86_400_000
  );
  const leftoverPicker = select(
    [
      ...data.leftovers.map(
        (l) => [l.id, `${l.name} — ${l.portions} portion(s) in the kitchen`] as [string, string]
      ),
      ...upcoming.map(
        (expected) =>
          [
            `from:${expected.mealId}`,
            `${expected.name} — ${expected.free} expected from ${dayLabel(expected.date)} ${MEAL_SLOT_LABELS[expected.slot].toLowerCase()}`,
          ] as [string, string]
      ),
    ],
    existing?.fromMealId ? `from:${existing.fromMealId}` : (existing?.leftoverId ?? undefined)
  );
  const portions = input("number");
  portions.min = "0.5";
  portions.step = "0.5";
  portions.placeholder = "as many as eat";
  portions.value = existing?.portions ? String(existing.portions) : "";
  const name = input("text");
  name.maxLength = 200;
  name.placeholder = "Where, or what — e.g. Divinos";
  name.value = existing?.name ?? "";
  const servings = input("number");
  servings.min = "1";
  servings.value = String(existing?.servings ?? data.servingsNeeded);
  // How much to cook: the recipe as written unless moved; the slider shows every amount as it moves.
  const recipeOf = () => data.recipes.find((r) => r.recipe.id === recipePicker.value)?.recipe;
  const eatingNow = () => Number(servings.value) || 1;
  const defaultCook = () => Math.max(recipeOf()?.servings ?? eatingNow(), eatingNow());
  let cooking = existing?.cookServings ?? defaultCook();
  let moved = existing?.cookServings !== null && existing?.cookServings !== undefined;
  const cookBox = make("div", "meals-cook-slider");
  let slider: ReturnType<typeof servingsSlider> | null = null;
  const drawSlider = () => {
    const recipe = recipeOf();
    cookBox.replaceChildren();
    slider = null;
    if (!recipe || kind.value !== "recipe") return;
    if (!moved) cooking = defaultCook();
    slider = servingsSlider(recipe, cooking, eatingNow, (next) => {
      cooking = next;
      moved = true;
    });
    cookBox.appendChild(slider.box);
  };
  const planLeftovers = input("checkbox", "");
  planLeftovers.checked = data.preferences.autoLeftovers;
  const planLeftoversLabel = make("label", "meals-check");
  planLeftoversLabel.append(
    planLeftovers,
    document.createTextNode(" Plan the extra portions as leftovers in the next free meals")
  );
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
  const portionsField = field("Portions of them", portions);
  const nameField = field("Name", name);
  rows.append(
    field("What", kind),
    recipeField,
    leftoverField,
    portionsField,
    nameField,
    field("Eating", servings),
    field("Time", time),
    field("Cost €", cost)
  );
  const applyKind = () => {
    recipeField.hidden = kind.value !== "recipe";
    leftoverField.hidden = kind.value !== "leftover";
    portionsField.hidden = kind.value !== "leftover";
    nameField.hidden = kind.value === "recipe" || kind.value === "leftover";
  };
  kind.addEventListener("change", () => {
    applyKind();
    drawSlider();
  });
  recipePicker.addEventListener("change", () => {
    moved = false;
    drawSlider();
  });
  servings.addEventListener("input", () => (moved ? slider?.set(cooking) : drawSlider()));
  applyKind();
  body.appendChild(rows);
  body.append(cookBox, planLeftoversLabel);
  drawSlider();
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
              leftoverId:
                kind.value === "leftover" && !leftoverPicker.value.startsWith("from:")
                  ? leftoverPicker.value
                  : null,
              fromMealId:
                kind.value === "leftover" && leftoverPicker.value.startsWith("from:")
                  ? leftoverPicker.value.slice(5)
                  : null,
              portions: kind.value === "leftover" && portions.value ? Number(portions.value) : null,
              name: name.value || null,
              servings: Number(servings.value) || 1,
              // Left where the recipe put it, it follows the recipe; moved, it's yours.
              cookServings: kind.value === "recipe" && moved ? cooking : null,
              planLeftovers: planLeftovers.checked,
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
