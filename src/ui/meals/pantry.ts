import { parseAmountText } from "../../meals/recipeImport";
import {
  CORRECTION_LABELS,
  CORRECTION_REASONS,
  MEAL_SLOT_LABELS,
  STORAGE_LABELS,
  STORAGE_PLACES,
} from "../../meals/types";
import type { CorrectionReason, StoragePlace } from "../../meals/types";
import { KNOWN_UNITS, formatAmount, unitLabel } from "../../meals/units";
import {
  EXPIRY_PILL,
  MealsSnapshot,
  MealsUiState,
  act,
  bridge,
  button,
  chip,
  counter,
  dayLabel,
  expiryLabel,
  field,
  input,
  make,
  panel,
  pill,
  rerender,
  select,
  snapshot,
  state,
  stockBar,
  showModal,
} from "./common";

// ---------- Pantry ----------

export function pantryView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");

  const counts = {
    urgent: data.stock.filter((s) => s.expiry === "urgent" || s.expiry === "expired").length,
    soon: data.stock.filter((s) => s.expiry === "soon").length,
    estimated: data.stock.filter((s) => s.confidence === "estimated").length,
    confirmed: data.stock.filter((s) => s.confidence === "confirmed").length,
  };
  const counters = make("div", "meals-counters");
  counters.append(
    counter(String(counts.urgent), "expire within 48 h", counts.urgent ? "urgent" : ""),
    counter(String(counts.soon), "expire this week", counts.soon ? "soon" : ""),
    counter(String(counts.estimated), "need a quick check", counts.estimated ? "est" : ""),
    counter(String(counts.confirmed), `of ${data.stock.length} confirmed`)
  );
  wrap.appendChild(counters);

  const filters: Array<[MealsUiState["pantryFilter"], string]> = [
    ["all", "All"],
    ["cupboard", "Cupboard"],
    ["fridge", "Fridge"],
    ["freezer", "Freezer"],
    ["expiring", "Expiring"],
    ["unconfirmed", "Estimated"],
  ];
  const chips = make("div", "meals-chips");
  for (const [filter, label] of filters)
    chips.appendChild(
      chip(label, state.pantryFilter === filter, () => {
        state.pantryFilter = filter;
        rerender();
      })
    );
  const toolbar = make("div", "meals-toolbar meals-toolbar-split");
  toolbar.appendChild(chips);
  if (counts.estimated)
    toolbar.appendChild(
      button(`Stock check · ${counts.estimated}`, "btn btn-secondary", () => startStockCheck())
    );
  wrap.appendChild(toolbar);
  wrap.appendChild(addStockForm(data));

  const stock = data.stock.filter((item) => {
    if (state.pantryFilter === "all") return true;
    if (state.pantryFilter === "expiring")
      return item.expiry === "urgent" || item.expiry === "soon" || item.expiry === "expired";
    if (state.pantryFilter === "unconfirmed") return item.confidence === "estimated";
    return item.items.some((entry) => entry.place === state.pantryFilter);
  });
  if (!stock.length)
    wrap.appendChild(make("p", "feed-empty", "Nothing here yet — add what's in the kitchen above."));

  // Grouped by where it's kept, which is how you actually look for food.
  const places: StoragePlace[] = ["fridge", "freezer", "cupboard"];
  for (const place of places) {
    const placeFilter =
      state.pantryFilter === "cupboard" || state.pantryFilter === "fridge" || state.pantryFilter === "freezer"
        ? state.pantryFilter
        : null;
    if (placeFilter && placeFilter !== place) continue;
    const rows = stock.flatMap((summary) =>
      summary.items.filter((item) => item.place === place).map((item) => ({ summary, item }))
    );
    if (!rows.length) continue;
    const group = make("section", "meals-group");
    const head = make("div", "meals-group-head");
    head.append(
      make("h6", undefined, STORAGE_LABELS[place]),
      make("span", "meals-group-meta", `${rows.length} item${rows.length === 1 ? "" : "s"}`)
    );
    group.appendChild(head);
    for (const { summary, item } of rows) {
      const row = make("div", "meals-prow");
      const what = make("div", "meals-prow-what");
      what.append(make("strong", undefined, summary.name));
      const meta = [summary.category, item.packaging, item.openedAt ? "opened" : null]
        .filter(Boolean)
        .join(" · ");
      if (meta) what.appendChild(make("span", "meals-line-meta", meta));
      row.appendChild(what);

      const amount = make("div", "meals-prow-amount");
      amount.appendChild(
        make("span", "meals-amount", formatAmount({ quantity: item.quantity, unit: item.unit }))
      );
      amount.appendChild(
        stockBar(
          item.startQuantity > 0 ? item.quantity / item.startQuantity : 1,
          item.confidence === "estimated"
        )
      );
      row.appendChild(amount);

      const tags = make("div", "meals-prow-tags");
      tags.appendChild(item.confidence === "estimated" ? pill("estimated", "est") : pill("confirmed", "ok"));
      if (item.expiresAt) {
        const level = summary.items.length === 1 ? summary.expiry : "later";
        tags.appendChild(pill(`use ${expiryLabel(item.expiresAt, data.today)}`, EXPIRY_PILL[level]));
      }
      row.appendChild(tags);

      const actions = make("div", "meals-prow-actions");
      actions.append(
        button("Correct", "btn btn-secondary", () => openCorrect(item, summary.name)),
        button("Remove", "meals-link", () => void act(() => bridge().removeStock(item.id)))
      );
      row.appendChild(actions);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }

  const leftovers = make("section", "meals-group");
  const head = make("div", "meals-group-head");
  head.append(
    make("h6", undefined, "Prepared food & leftovers"),
    make("span", "meals-group-meta", `${data.leftovers.reduce((sum, l) => sum + l.portions, 0)} portions`)
  );
  leftovers.appendChild(head);
  for (const leftover of data.leftovers) {
    const row = make("div", "meals-prow");
    const what = make("div", "meals-prow-what");
    // Which meal these portions are promised to, if any.
    const promised = data.plan
      .filter((p) => p.meal.kind === "leftover" && p.meal.leftoverId === leftover.id && !p.meal.cookedAt)
      .map((p) => `${dayLabel(p.meal.date)} ${MEAL_SLOT_LABELS[p.meal.slot].toLowerCase()}`);
    what.append(
      make("strong", undefined, leftover.name),
      make(
        "span",
        "meals-line-meta",
        `${STORAGE_LABELS[leftover.place]} · ${promised.length ? `Scheduled: ${promised.join(", ")}` : "Not scheduled"}`
      )
    );
    row.append(
      what,
      make("div", "meals-prow-amount", `${leftover.portions} portion${leftover.portions === 1 ? "" : "s"}`)
    );
    const tags = make("div", "meals-prow-tags");
    tags.appendChild(pill("cooked", "accent"));
    if (leftover.eatBy) tags.appendChild(pill(`eat by ${expiryLabel(leftover.eatBy, data.today)}`, "soon"));
    row.appendChild(tags);
    const actions = make("div", "meals-prow-actions");
    actions.append(
      button(
        "Ate one",
        "btn btn-secondary",
        () =>
          void act(() =>
            bridge().updateLeftover(leftover.id, { portions: Math.max(0, leftover.portions - 1) })
          )
      ),
      button("Remove", "meals-link", () => void act(() => bridge().removeLeftover(leftover.id)))
    );
    row.appendChild(actions);
    leftovers.appendChild(row);
  }
  if (!data.leftovers.length)
    leftovers.appendChild(
      make("p", "meals-note", "Nothing cooked and kept. Cooking more than you eat records it here.")
    );
  wrap.appendChild(leftovers);

  wrap.appendChild(
    make(
      "p",
      "meals-note",
      "Estimated stock is what NIMBUS worked out from the recipes you cooked — the hatched bars. Correcting an amount makes it confirmed again."
    )
  );
  return wrap;
}

export function addStockForm(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel("Add stock");
  const name = input("text");
  name.placeholder = "Food";
  name.setAttribute("list", "mealsIngredientNames");
  const datalist = make("datalist");
  datalist.id = "mealsIngredientNames";
  for (const ingredient of data.ingredients) datalist.appendChild(new Option(ingredient.name));
  const quantity = input("number");
  quantity.step = "0.01";
  quantity.min = "0";
  const unit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    "g"
  );
  const place = select(
    STORAGE_PLACES.map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "cupboard"
  );
  const expires = input("date");
  const form = make("div", "meals-form");
  form.append(
    field("Food", name),
    field("Amount", quantity),
    field("Unit", unit),
    field("Where", place),
    field("Use by", expires)
  );
  body.append(form, datalist);
  const addRow = make("div", "meals-row");
  addRow.appendChild(
    button(
      "Add to pantry",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().addStock({
              name: name.value,
              quantity: Number(quantity.value),
              unit: unit.value,
              place: place.value,
              expiresAt: expires.value || null,
            }),
          "Added."
        )
    )
  );
  body.appendChild(addRow);
  return box;
}

/**
 * "Correct stock": what's actually there. Whatever the number, it becomes
 * confirmed. The amount can be typed as text ("250 g", "3 pcs"), picked
 * from None left / Half / Full package, and carries why it changed.
 *
 * `next` is set during a stock check: confirming moves on to the next
 * estimated item instead of closing.
 */
export function openCorrect(
  item: { id: string; quantity: number; unit: string; startQuantity: number },
  name: string,
  next?: () => void
): void {
  const { box, body } = panel(`Correct stock · ${name}`);
  box.classList.add("meals-dialog");
  const estimate = make("div", "meals-kv");
  estimate.append(
    make("span", undefined, "NIMBUS estimate"),
    make("strong", "meals-estimate", formatAmount({ quantity: item.quantity, unit: item.unit }))
  );
  body.appendChild(estimate);

  const amount = input("text");
  amount.placeholder = `e.g. 250 g or 3 pcs — or just a number in ${unitLabel(item.unit)}`;
  const reason = select(
    CORRECTION_REASONS.map((r) => [r, CORRECTION_LABELS[r]] as [string, string]),
    "estimate"
  );
  const quick = make("div", "meals-chips");
  const setAmount = (quantity: number, why?: CorrectionReason) => {
    amount.value =
      `${Math.round(quantity * 1000) / 1000} ${unitLabel(item.unit) === "×" ? "" : item.unit}`.trim();
    if (why) reason.value = why;
  };
  quick.append(
    chip("None left", false, () => setAmount(0)),
    chip("Half", false, () => setAmount(item.quantity / 2)),
    chip("Full package", false, () => setAmount(item.startQuantity, "found"))
  );
  const form = make("div", "meals-form");
  form.append(field("Actual amount", amount), field("Reason (optional)", reason));
  body.append(quick, form);
  const problem = make("p", "form-error");
  problem.hidden = true;
  body.appendChild(problem);

  const confirm = () => {
    const typed = amount.value.trim();
    let quantity: number | null = null;
    let unit: string | undefined;
    if (!typed) quantity = item.quantity;
    else if (/^\d+([.,]\d+)?$/.test(typed)) quantity = Number(typed.replace(",", "."));
    else {
      const parsed = parseAmountText(typed);
      if (parsed) {
        quantity = parsed.quantity;
        unit = parsed.unit;
      }
    }
    if (quantity === null || !Number.isFinite(quantity) || quantity < 0) {
      problem.textContent = "That amount doesn't read as a number.";
      problem.hidden = false;
      return;
    }
    void act(
      () => bridge().correctStock(item.id, quantity!, unit, reason.value),
      quantity === 0 ? "Confirmed: none left." : "Stock confirmed."
    ).then(() => next?.());
  };
  amount.addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirm();
  });

  const actions = make("div", "meals-row");
  actions.append(
    button(next ? "Confirm and next" : "Confirm amount", "btn btn-primary", confirm),
    button(next ? "Stop checking" : "Cancel", "btn btn-ghost", () => rerender())
  );
  if (next) actions.appendChild(button("Skip", "btn btn-ghost", () => (rerender(), next())));
  body.appendChild(actions);
  showModal(box);
  amount.focus();
}

/**
 * "Stock check": each estimated item in turn, oldest guess first, in the
 * correct dialog — the quick way to make the whole pantry true again.
 */
export function startStockCheck(skipped: Set<string> = new Set()): void {
  if (!snapshot) return;
  const pending = snapshot.stock
    .flatMap((summary) => summary.items.map((item) => ({ summary, item })))
    .filter(({ item }) => item.confidence === "estimated" && !skipped.has(item.id));
  const first = pending[0];
  if (!first) {
    state.message = "Stock check done — everything is confirmed.";
    rerender();
    return;
  }
  skipped.add(first.item.id);
  openCorrect(first.item, `${first.summary.name} (${pending.length} to check)`, () =>
    startStockCheck(skipped)
  );
}
