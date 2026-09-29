import { MEAL_SLOT_LABELS } from "../../meals/types";
import type { MealSlot } from "../../meals/types";
import { MealsSnapshot, act, bridge, button, dayLabel, expiryLabel, make, panel, pill } from "./common";
import { openCook } from "./cook";

// ---------- What you can make ----------

type RecipeEntry = MealsSnapshot["recipes"][number];

interface Match {
  entry: RecipeEntry;
  /** Lines not at home (or not enough of): what you'd need. */
  missing: string[];
  /** Foods at home that go off soon, that this recipe uses up. */
  expiring: Array<{ name: string; when: string | null }>;
}

/**
 * Your recipes against the pantry: which you can make now, and which are
 * one or two things away — foods that are about to go off first. Worked out
 * from the snapshot's own recipe lines, so a food that counts as another
 * (soy milk for milk) is at home too.
 */
function matches(data: MealsSnapshot): { ready: Match[]; almost: Match[] } {
  const all: Match[] = data.recipes
    .filter((entry) => entry.lines.some((line) => !line.optional))
    .map((entry) => {
      const needed = entry.lines.filter((line) => !line.optional);
      return {
        entry,
        missing: needed
          .filter((line) => line.status === "missing" || line.status === "partial")
          .map((line) => line.text),
        expiring: needed
          .filter(
            (line) =>
              line.status !== "missing" &&
              line.stock !== null &&
              (line.stock.expiry === "urgent" ||
                line.stock.expiry === "soon" ||
                line.stock.expiry === "expired")
          )
          .map((line) => ({ name: line.text, when: line.stock!.expiresAt })),
      };
    });
  const order = (a: Match, b: Match) =>
    b.expiring.length - a.expiring.length ||
    a.missing.length - b.missing.length ||
    Number(b.entry.recipe.favourite) - Number(a.entry.recipe.favourite) ||
    (a.entry.minutes ?? 999) - (b.entry.minutes ?? 999) ||
    a.entry.recipe.name.localeCompare(b.entry.recipe.name);
  return {
    ready: all.filter((m) => m.missing.length === 0).sort(order),
    almost: all.filter((m) => m.missing.length > 0 && m.missing.length <= 2).sort(order),
  };
}

/** The next lunch or dinner with nothing planned: tonight, else tomorrow. */
function nextFreeSlot(data: MealsSnapshot): { date: string; slot: MealSlot; label: string } | null {
  const taken = new Set(data.plan.map((p) => `${p.meal.date}|${p.meal.slot}`));
  const tomorrow = data.days[1] ?? data.today;
  const hour = new Date().getHours();
  const options: Array<{ date: string; slot: MealSlot; label: string }> = [
    ...(hour < 14 ? [{ date: data.today, slot: "lunch" as MealSlot, label: "lunch today" }] : []),
    ...(hour < 21 ? [{ date: data.today, slot: "dinner" as MealSlot, label: "tonight" }] : []),
    { date: tomorrow, slot: "lunch", label: "tomorrow's lunch" },
    { date: tomorrow, slot: "dinner", label: "tomorrow's dinner" },
  ];
  return (
    options.find(
      (option) => data.preferences.slots.includes(option.slot) && !taken.has(`${option.date}|${option.slot}`)
    ) ?? null
  );
}

/** The "What you can make" panel: at the top of the pantry. */
export function fromPantryPanel(data: MealsSnapshot): HTMLElement {
  const { ready, almost } = matches(data);
  const { box, body } = panel(
    "What you can make",
    `${ready.length} ready · ${almost.length} a thing or two away`
  );
  box.classList.add("meals-from-pantry");
  if (!data.recipes.length) {
    body.appendChild(
      make("p", "meals-note", "Add recipes and this shows which you can make from what's at home.")
    );
    return box;
  }
  const slot = nextFreeSlot(data);

  const row = (match: Match) => {
    const line = make("div", "meals-line");
    const what = make("div", "meals-line-what");
    what.appendChild(make("strong", undefined, match.entry.recipe.name));
    const meta = [
      match.entry.minutes ? `${match.entry.minutes} min` : null,
      match.entry.cost.value !== null
        ? `≈ ${(match.entry.cost.value / Math.max(1, match.entry.recipe.servings)).toFixed(2).replace(".", ",")} €/serving`
        : null,
      match.missing.length ? `needs ${match.missing.join(", ")}` : "everything's at home",
    ].filter(Boolean);
    what.appendChild(make("span", "meals-line-meta", meta.join(" · ")));
    line.appendChild(what);
    for (const food of match.expiring.slice(0, 2))
      line.appendChild(
        pill(
          `uses ${food.name.toLowerCase()}${food.when ? ` · ${expiryLabel(food.when, data.today)}` : ""}`,
          "soon"
        )
      );
    if (match.entry.recipe.favourite) line.appendChild(pill("♥", "accent"));
    const actions = make("div", "meals-row meals-row-tight");
    if (!match.missing.length)
      actions.appendChild(button("Cook", "btn btn-secondary", () => openCook(match.entry.recipe.id)));
    if (slot)
      actions.appendChild(
        button(
          `Plan ${slot.label}`,
          "btn btn-ghost",
          () =>
            void act(
              () =>
                bridge().planMeal({
                  date: slot.date,
                  slot: slot.slot,
                  kind: "recipe",
                  recipeId: match.entry.recipe.id,
                  servings: data.servingsNeeded,
                }),
              `${match.entry.recipe.name} planned for ${dayLabel(slot.date)} ${MEAL_SLOT_LABELS[slot.slot].toLowerCase()}.`
            )
        )
      );
    if (match.missing.length)
      actions.appendChild(
        button(
          "Add missing to shopping",
          "btn btn-ghost",
          () =>
            void act(
              () => bridge().addMissingToShopping(match.entry.recipe.id, match.entry.recipe.servings),
              "On the shopping list."
            )
        )
      );
    line.appendChild(actions);
    return line;
  };

  if (ready.length) {
    body.appendChild(make("p", "card-kicker", "Ready now"));
    for (const match of ready.slice(0, 6)) body.appendChild(row(match));
  } else
    body.appendChild(make("p", "meals-note", "Nothing can be made entirely from what's at home right now."));
  if (almost.length) {
    body.appendChild(make("p", "card-kicker", "A thing or two away"));
    for (const match of almost.slice(0, 6)) body.appendChild(row(match));
  }
  return box;
}
