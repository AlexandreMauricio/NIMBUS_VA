import { servingsSlider } from "./servings";
import { cookServingsOf, spreadLeftovers } from "../../meals/plan";
import { suggestEatBy } from "../../meals/pantry";
import { MEAL_SLOT_LABELS } from "../../meals/types";
import type { MealSlot, PlannedMeal } from "../../meals/types";
import { formatAmount } from "../../meals/units";
import {
  CookPreviewUI,
  act,
  bridge,
  button,
  chip,
  dayLabel,
  errorText,
  field,
  input,
  make,
  panel,
  pill,
  rerender,
  snapshot,
  state,
  select,
  stepper,
  showModal,
} from "./common";

// ---------- Cooking ----------

/** The free slots from tomorrow's first meal up to the eat-by day — where leftovers can go. */
function freeSlotsUntil(eatBy: string, after: string): Array<{ date: string; slot: MealSlot }> {
  if (!snapshot) return [];
  const taken = new Set(snapshot.plan.map((p) => `${p.meal.date}|${p.meal.slot}`));
  const slots = snapshot.preferences.slots.filter((slot) => slot === "lunch" || slot === "dinner");
  const out: Array<{ date: string; slot: MealSlot }> = [];
  for (const date of snapshot.days) {
    if (date <= after || date > eatBy) continue;
    for (const slot of slots.length ? slots : snapshot.preferences.slots)
      if (!taken.has(`${date}|${slot}`)) out.push({ date, slot });
  }
  return out.slice(0, 4);
}

/**
 * The cook dialog, as the design draws it: how many servings were planned
 * and how many are actually being cooked, exactly what comes out of which
 * package (worked out in the main process, before anything moves), and
 * where the extra portions go — the fridge or the freezer, and optionally
 * straight into a free slot before they have to be eaten.
 */
export function openCook(recipeId: string, meal?: PlannedMeal): void {
  if (!snapshot) return;
  const data = snapshot;
  const entry = data.recipes.find((r) => r.recipe.id === recipeId);
  if (!entry) return;
  const planned = meal?.servings ?? data.servingsNeeded;
  let cooking = cookServingsOf(meal ?? { cookServings: null, servings: planned }, entry.recipe);
  let eating = Math.min(planned, cooking);
  let place: "fridge" | "freezer" = "fridge";
  let schedule: { date: string; slot: MealSlot } | null = null;
  let scheduleTouched = false;
  // Or spread over the next meals, as many portions as eat each time.
  let spreading = false;
  let spreadPlan: Array<{ date: string; slot: MealSlot; portions: number; short: number }> = [];
  const alreadyPlanned = meal
    ? data.plan.filter((p) => p.meal.kind === "leftover" && p.meal.fromMealId === meal.id && !p.meal.cookedAt)
    : [];
  const { box, body } = panel(`Cook · ${entry.recipe.name}`);
  box.classList.add("meals-dialog");

  const counts = make("div", "meals-form");
  const skip = input("checkbox", "");
  counts.append(
    field("Planned servings", make("span", "meals-fact-value", String(planned))),

    field(
      "Eaten now",
      stepper(eating, 1, 1, (next) => {
        eating = Math.min(next, cooking);
        drawLeftovers();
      })
    ),
    field("Don't touch the pantry", skip)
  );
  body.appendChild(counts);
  body.appendChild(
    servingsSlider(
      entry.recipe,
      cooking,
      () => eating,
      (next) => {
        cooking = next;
        eating = Math.min(eating, cooking);
        void refreshPreview();
        drawLeftovers();
      }
    ).box
  );

  // Milk or soy milk: when more than one food at home will do, you say which.
  const choose: Record<string, string> = {};
  const choicesBox = make("div", "meals-form meals-cook-choices");
  body.appendChild(choicesBox);
  const drawChoices = (preview: CookPreviewUI) => {
    choicesBox.replaceChildren();
    for (const choice of preview.choices) {
      const pick = select(
        choice.foods.map((food) => [food.ingredientId, food.name] as [string, string]),
        choose[choice.ingredientId] ?? choice.foods[0].ingredientId
      );
      pick.addEventListener("change", () => {
        choose[choice.ingredientId] = pick.value;
        void refreshPreview();
      });
      choicesBox.appendChild(field(`${choice.text} · use which?`, pick));
    }
    choicesBox.hidden = !preview.choices.length;
  };

  // What comes out of the pantry, package by package.
  body.appendChild(make("p", "card-kicker", "Pantry deductions"));
  const deductions = make("div", "meals-kv-list");
  body.appendChild(deductions);
  const drawPreview = (preview: CookPreviewUI) => {
    deductions.replaceChildren();
    for (const d of preview.deductions) {
      const row = make("div", "meals-kv");
      const what = [d.name, d.packaging].filter(Boolean).join(" · ");
      const remains = d.empties
        ? `use all ${formatAmount(d.use)}`
        : `use ${formatAmount(d.use)} · ${formatAmount(d.remaining)} remains`;
      row.append(make("span", undefined, what), make("strong", undefined, remains));
      deductions.appendChild(row);
    }
    for (const s of preview.short) {
      const row = make("div", "meals-kv");
      row.append(
        make("span", undefined, s.name),
        pill(
          s.reason === "unknown"
            ? "can't measure"
            : s.missing
              ? `short ${formatAmount(s.missing)}`
              : "missing",
          "urgent"
        )
      );
      deductions.appendChild(row);
    }
    if (!preview.deductions.length && !preview.short.length)
      deductions.appendChild(make("p", "meals-note", "Nothing to take out of the pantry."));
  };
  let previewToken = 0;
  const refreshPreview = async () => {
    const token = ++previewToken;
    try {
      const preview = await bridge().previewCook(recipeId, cooking, choose);
      if (token === previewToken) {
        drawChoices(preview);
        drawPreview(preview);
      }
    } catch (err) {
      deductions.replaceChildren(make("p", "form-error", errorText(err)));
    }
  };
  skip.addEventListener("change", () => {
    deductions.hidden = skip.checked;
  });
  void refreshPreview();

  // The extra portions: where they're kept, and whether they're promised to a meal.
  const leftovers = make("div", "meals-leftover-box");
  body.appendChild(leftovers);
  const drawLeftovers = () => {
    leftovers.replaceChildren();
    const extra = Math.round((cooking - eating) * 100) / 100;
    if (extra <= 0) {
      leftovers.hidden = true;
      schedule = null;
      return;
    }
    leftovers.hidden = false;
    const eatBy = suggestEatBy(new Date(), place);
    leftovers.appendChild(
      make("p", "card-kicker", `${extra} extra cooked portion${extra === 1 ? "" : "s"} → leftovers`)
    );
    const places = make("div", "meals-chips");
    places.append(
      chip(`Fridge · eat by ${dayLabel(suggestEatBy(new Date(), "fridge"))}`, place === "fridge", () => {
        place = "fridge";
        drawLeftovers();
      }),
      chip("Freezer · 3 months", place === "freezer", () => {
        place = "freezer";
        drawLeftovers();
      })
    );
    leftovers.appendChild(places);
    // Planned with the meal already: cooking fills those, as far as the portions go.
    if (alreadyPlanned.length) {
      schedule = null;
      spreading = false;
      leftovers.appendChild(
        make(
          "p",
          "meals-note",
          `Already planned: ${alreadyPlanned
            .map(
              (p) =>
                `${dayLabel(p.meal.date)} ${MEAL_SLOT_LABELS[p.meal.slot].toLowerCase()} (${p.meal.portions ?? p.meal.servings})`
            )
            .join(" · ")} — cooking fills them, as far as the portions go.`
        )
      );
      return;
    }
    const options = freeSlotsUntil(eatBy, meal?.date ?? data.today);
    spreadPlan = place === "fridge" ? spreadLeftovers(extra, data.servingsNeeded, options, eatBy) : [];
    // "Plan leftovers automatically": spread over the next meals (or the first one) until you choose otherwise.
    if (!scheduleTouched && data.preferences.autoLeftovers) {
      spreading = spreadPlan.length > 1;
      schedule = spreading ? null : (options[0] ?? null);
    }
    if (spreadPlan.length > 1) {
      const spreadChips = make("div", "meals-chips");
      spreadChips.appendChild(
        chip(
          `Spread: ${spreadPlan
            .map((s) => `${dayLabel(s.date)} ${MEAL_SLOT_LABELS[s.slot].toLowerCase()} (${s.portions})`)
            .join(" · ")}`,
          spreading,
          () => {
            spreading = true;
            schedule = null;
            scheduleTouched = true;
            drawLeftovers();
          }
        )
      );
      leftovers.appendChild(spreadChips);
    }
    if (schedule && !options.some((o) => o.date === schedule!.date && o.slot === schedule!.slot))
      schedule = null;
    const when = make("div", "meals-chips");
    for (const option of options) {
      const on = schedule?.date === option.date && schedule.slot === option.slot;
      when.appendChild(
        chip(
          `Schedule: ${dayLabel(option.date)} ${MEAL_SLOT_LABELS[option.slot].toLowerCase()} (${Math.min(extra, data.servingsNeeded)} of ${data.servingsNeeded})`,
          on,
          () => {
            schedule = option;
            spreading = false;
            scheduleTouched = true;
            drawLeftovers();
          }
        )
      );
    }
    when.appendChild(
      chip("Don't schedule", schedule === null && !spreading, () => {
        schedule = null;
        spreading = false;
        scheduleTouched = true;
        drawLeftovers();
      })
    );
    leftovers.appendChild(when);
    const lastShort = spreading ? (spreadPlan[spreadPlan.length - 1]?.short ?? 0) : 0;
    if (lastShort > 0)
      leftovers.appendChild(
        make(
          "p",
          "meals-note",
          `The last of those will need ${lastShort} more portion(s) — add a side in the plan.`
        )
      );
    if (schedule && extra < data.servingsNeeded)
      leftovers.appendChild(
        make(
          "p",
          "meals-note",
          `That meal will need ${Math.round((data.servingsNeeded - extra) * 100) / 100} more portion(s) — add a side in the plan.`
        )
      );
  };
  drawLeftovers();

  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Mark cooked",
      "btn btn-primary",
      () =>
        void act(async () => {
          const result = await bridge().cookMeal({
            mealId: meal?.id,
            recipeId,
            cookServings: cooking,
            eatServings: eating,
            leftoverPlace: place,
            skipPantry: skip.checked,
            scheduleLeftoverFor: spreading ? null : schedule,
            scheduleLeftovers: spreading ? spreadPlan : null,
            choose,
          });
          const parts = [
            result.deducted.length ? `${result.deducted.length} item(s) taken out of the pantry` : null,
            result.leftover ? `${result.leftover.portions} portion(s) kept as leftovers` : null,
            result.scheduled ? `planned for ${dayLabel(result.scheduled.date)}` : null,
            result.short.length ? `short of: ${result.short.map((s) => s.name).join(", ")}` : null,
          ].filter(Boolean);
          state.message = parts.length ? `Cooked. ${parts.join(" · ")}.` : "Cooked.";
        })
    ),
    button("Cancel", "btn btn-ghost", () => rerender())
  );
  body.appendChild(actions);
  showModal(box);
}
