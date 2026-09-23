import { cookServingsOf } from "../../meals/plan";
import { MEAL_SLOTS, MEAL_SLOT_LABELS, STORAGE_LABELS } from "../../meals/types";
import { formatAmount } from "../../meals/units";
import {
  EXPIRY_PILL,
  MealsSnapshot,
  act,
  bridge,
  button,
  dayLabel,
  euro,
  expiryLabel,
  make,
  panel,
  pill,
  rerender,
  ring,
  startTime,
  state,
} from "./common";
import { openCook } from "./cook";
import { openRecipe, photoBox } from "./recipes";

// ---------- Today ----------

export function todayView(data: MealsSnapshot): HTMLElement {
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
        rerender();
      })
    );
    const grid = make("div", "meals-meal-grid");
    for (const entry of todays) grid.appendChild(mealCard(entry, data, entry === next));
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

export function emptyHero(): HTMLElement {
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
      rerender();
    }),
    button("Browse recipes", "btn btn-secondary", () => {
      state.view = "recipes";
      rerender();
    })
  );
  body.appendChild(actions);
  hero.appendChild(body);
  return hero;
}

export function heroCard(data: MealsSnapshot, entry: MealsSnapshot["plan"][number]): HTMLElement {
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
  const cookServings = cookServingsOf(entry.meal, recipe?.recipe);
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
            // This meal's share of them, when a batch is spread over several.
            () =>
              bridge().eatLeftover(
                entry.meal.id,
                entry.meal.leftoverId!,
                entry.meal.portions ?? entry.meal.servings
              ),
            "Leftovers eaten."
          )
      )
    );
  }
  actions.appendChild(
    button("Swap", "btn btn-ghost", () => {
      state.replacing = entry.meal.id;
      state.replaceTab = "suggestions";
      rerender();
    })
  );
  body.appendChild(actions);
  hero.appendChild(body);

  // The right-hand column: what the recipe is short of, or that nothing is.
  // The right-hand column: what it takes, and which of it is in the kitchen.
  const side = make("div", "meals-hero-side");
  if (recipe?.recipe.photo) side.appendChild(photoBox(recipe.recipe.photo, "meals-hero-sidephoto"));
  if (recipe) {
    const missing = recipe.lines.filter((line) => !line.optional && line.status !== "have");
    side.appendChild(
      make(
        "p",
        "card-kicker",
        missing.length ? `What it takes · ${missing.length} not at home` : "What it takes · everything is in"
      )
    );
    const list = make("div", "meals-hero-list");
    const factor = cookServings / Math.max(1, recipe.recipe.servings);
    for (const line of recipe.lines.slice(0, 9)) {
      const row = make("div", "meals-hero-line");
      row.append(
        make(
          "span",
          "meals-hero-amount",
          formatAmount({ quantity: line.needed.quantity * factor, unit: line.needed.unit })
        ),
        make("span", "meals-hero-name", line.text)
      );
      row.appendChild(
        line.status === "have"
          ? pill("✓", "ok")
          : line.optional
            ? pill("optional")
            : pill(line.short ? `short ${formatAmount(line.short)}` : "missing", "urgent")
      );
      list.appendChild(row);
    }
    side.appendChild(list);
    if (missing.length)
      side.appendChild(
        button("See the shopping list →", "meals-link", () => {
          state.view = "shopping";
          rerender();
        })
      );
  }
  hero.appendChild(side);
  return hero;
}

export function mealCard(
  entry: MealsSnapshot["plan"][number],
  data: MealsSnapshot,
  isNext = false
): HTMLElement {
  const card = make("article", `meals-meal-card${entry.meal.cookedAt ? " is-done" : ""}`);
  const photo = data.recipes.find((r) => r.recipe.id === entry.meal.recipeId)?.recipe.photo ?? null;
  // Every card has its picture area, as the design draws it — a photo when the recipe has one.
  card.appendChild(photoBox(photo, "meals-meal-photo"));
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
      // As the design words it: what this meal is waiting on.
      entry.meal.cookedAt
        ? "Eaten ✓"
        : isNext
          ? "Up next"
          : entry.meal.kind === "out"
            ? "Out"
            : entry.meal.kind === "leftover"
              ? "Reheat"
              : "Planned"
    )
  );
  card.append(top, make("div", "meals-meal-name", entry.name));
  const pills = make("div", "meals-row meals-row-tight");
  if (entry.nutrition?.kcal) pills.appendChild(pill(`≈ ${entry.nutrition.kcal} kcal`));
  pills.appendChild(
    entry.cost !== null
      ? pill(`≈ ${euro(entry.cost)}`)
      : entry.meal.kind === "leftover"
        ? pill("already cooked", "accent")
        : pill("no price", "est")
  );
  card.appendChild(pills);
  const actions = make("div", "meals-row meals-row-tight");
  if (!entry.meal.cookedAt && entry.meal.kind === "recipe" && entry.meal.recipeId)
    actions.appendChild(button("Cook", "meals-link", () => openCook(entry.meal.recipeId!, entry.meal)));
  actions.appendChild(
    button("Edit", "meals-link", () => {
      state.view = "plan";
      state.planning = { date: entry.meal.date, slot: entry.meal.slot, mealId: entry.meal.id };
      rerender();
    })
  );
  card.appendChild(actions);
  return card;
}

export function nutritionPanel(data: MealsSnapshot, todays: MealsSnapshot["plan"]): HTMLElement {
  const { box, body } = panel("Nutrition today", pill("≈ per person · estimate", "est"));
  const eaten = todays.filter((entry) => entry.nutrition);
  const totals = eaten.reduce(
    (sum, entry) => ({
      kcal: sum.kcal + (entry.nutrition?.kcal ?? 0),
      protein: sum.protein + (entry.nutrition?.protein ?? 0),
      carbs: sum.carbs + (entry.nutrition?.carbs ?? 0),
      fibre: sum.fibre + (entry.nutrition?.fibre ?? 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fibre: 0 }
  );
  const targets = data.preferences;
  const rings = make("div", "meals-rings");
  const dial = (value: number, target: number | null, unit: string, label: string) =>
    ring(target ? (value / target) * 100 : null, `${Math.round(value)}${unit}`, label);
  rings.append(
    dial(totals.kcal, targets.dailyKcal, " kcal", "Calories"),
    dial(totals.protein, targets.dailyProtein, " g", "Protein")
  );
  // Carbs and fibre join in when there's a target for them or anything to show.
  if (targets.dailyCarbs || totals.carbs)
    rings.appendChild(dial(totals.carbs, targets.dailyCarbs, " g", "Carbs"));
  if (targets.dailyFibre || totals.fibre)
    rings.appendChild(dial(totals.fibre, targets.dailyFibre, " g", "Fibre"));
  body.appendChild(rings);
  const withoutData = todays.length - eaten.length;
  body.appendChild(
    make(
      "p",
      "meals-note",
      [
        targets.dailyKcal || targets.dailyProtein || targets.dailyCarbs || targets.dailyFibre
          ? "% of the daily target set in Household"
          : "Set a daily target in Household to see how far through the day this is",
        withoutData ? `${withoutData} of today's meals have no nutrition data` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  return box;
}

export function spendPanel(data: MealsSnapshot): HTMLElement {
  const budget = data.preferences.dailyBudget;
  const { box, body } = panel(
    "Food spend · this week",
    budget === null ? "no budget set" : `${euro(budget)}/day budget`
  );
  // The headline, as the design has it: what the week's plan comes to, and what was actually spent.
  const headline = make("div", "meals-big-row");
  headline.append(
    make("span", "meals-big", data.weekCost.value === null ? "—" : `≈ ${euro(data.weekCost.value)}`),
    make("span", "meals-line-meta", `planned · ${euro(data.spent.week)} spent`)
  );
  body.appendChild(headline);
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
  const monthName = new Date(`${data.today}T00:00:00`).toLocaleDateString("en-GB", { month: "short" });
  body.appendChild(
    make(
      "p",
      "meals-note",
      `${monthName}: ${euro(data.spent.month)} spent${data.spent.monthlyBudget === null ? "" : ` of ${euro(data.spent.monthlyBudget)}`}`
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

export function attentionPanel(data: MealsSnapshot): HTMLElement {
  const urgent = data.stock.filter(
    (item) => item.expiry === "urgent" || item.expiry === "expired" || item.expiry === "soon"
  );
  const unconfirmed = data.stock.filter((item) => item.confidence === "estimated");
  const { box, body } = panel(
    "Needs attention",
    button("Pantry →", "meals-link", () => {
      state.view = "pantry";
      rerender();
    })
  );
  const list = make("div", "meals-lines");
  // Out of the freezer: tonight for tomorrow's meals, now for today's.
  for (const defrost of data.defrost) {
    const row = make("div", "meals-line");
    const when = defrost.date === data.today ? "now" : "tonight";
    row.append(
      make("strong", undefined, `Take out ${defrost.items.join(", ")}`),
      make(
        "span",
        "meals-line-meta",
        `for ${defrost.date === data.today ? "today's" : "tomorrow's"} ${MEAL_SLOT_LABELS[defrost.slot].toLowerCase()} · ${defrost.meal}`
      ),
      pill(`defrost ${when}`, defrost.date === data.today ? "urgent" : "soon")
    );
    list.appendChild(row);
  }
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
  if (!list.childNodes.length)
    list.appendChild(make("p", "meals-note", "Nothing going off, and no guesses to check."));
  body.appendChild(list);
  if (unconfirmed.length) {
    // One line for every guess, rather than the same sentence per food.
    const row = make("div", "meals-line");
    row.append(
      make(
        "span",
        "meals-line-meta",
        `NIMBUS worked these out: ${unconfirmed.map((item) => item.name).join(", ")}`
      ),
      pill("estimated", "est"),
      button("Check them →", "meals-link", () => {
        state.view = "pantry";
        state.pantryFilter = "unconfirmed";
        rerender();
      })
    );
    body.appendChild(row);
  }
  return box;
}

export function leftoverPanel(data: MealsSnapshot): HTMLElement {
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
        [
          `${leftover.portions} portion${leftover.portions === 1 ? "" : "s"}`,
          STORAGE_LABELS[leftover.place].toLowerCase(),
          data.plan
            .filter(
              (p) => p.meal.kind === "leftover" && p.meal.leftoverId === leftover.id && !p.meal.cookedAt
            )
            .map((p) => `${dayLabel(p.meal.date)} ${MEAL_SLOT_LABELS[p.meal.slot].toLowerCase()}`)
            .join(", ") || "not scheduled",
        ].join(" · ")
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

export function shoppingPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "Shopping",
    button("Open list →", "meals-link", () => {
      state.view = "shopping";
      rerender();
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

export function weekStripPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "This week's dinners",
    button("Planner →", "meals-link", () => {
      state.view = "plan";
      rerender();
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
