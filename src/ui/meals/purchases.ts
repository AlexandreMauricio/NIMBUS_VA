import { KNOWN_UNITS, unitLabel } from "../../meals/units";
import {
  MealsSnapshot,
  PurchaseUI,
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
  showModal,
  snapshot,
  state,
  stockBar,
} from "./common";

// ---------- Purchases & imports ----------

/** Below this, a matched line is outlined for a look (purchases.ts's SURE_MATCH). */
const SURE = 0.8;

const SOURCE_LABELS: Record<PurchaseUI["source"], string> = {
  manual: "Typed in",
  pdf: "Invoice PDF",
  photo: "Receipt photo",
};

/**
 * The Purchases & imports view, as the design draws it: somewhere to add a
 * purchase, the price watch for one food across shops, and the history —
 * with anything still waiting for a look at the top.
 */
export function purchasesView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");

  const top = make("div", "meals-panel-grid");
  top.append(addPanel(data), priceWatchPanel(data));
  wrap.appendChild(top);

  const head = make("div", "meals-toolbar meals-toolbar-split");
  head.appendChild(make("h5", "meals-section-title", "Purchase history"));
  const chips = make("div", "meals-chips");
  const filters: Array<[typeof state.purchaseFilter, string]> = [
    ["all", "All"],
    ["review", "Needs review"],
    ["receipts", "Receipts"],
    ["manual", "Manual"],
  ];
  for (const [id, label] of filters)
    chips.appendChild(
      chip(label, state.purchaseFilter === id, () => {
        state.purchaseFilter = id;
        rerender();
      })
    );
  head.appendChild(chips);
  wrap.appendChild(head);

  const shown = data.purchases.filter((purchase) =>
    state.purchaseFilter === "review"
      ? purchase.status === "review"
      : state.purchaseFilter === "receipts"
        ? purchase.source !== "manual"
        : state.purchaseFilter === "manual"
          ? purchase.source === "manual"
          : true
  );
  if (!shown.length) {
    wrap.appendChild(
      make(
        "p",
        "feed-empty",
        data.purchases.length ? "Nothing here with that filter." : "No purchases yet — add one above."
      )
    );
  } else {
    const table = make("table", "table meals-purchases");
    const headRow = make("tr");
    for (const title of ["Date", "Shop", "Items", "Total", "Source", "Status", ""])
      headRow.appendChild(make("th", undefined, title));
    table.appendChild(make("thead")).appendChild(headRow);
    const body = make("tbody");
    for (const purchase of shown) {
      const row = make("tr", purchase.status === "review" ? "is-review" : undefined);
      const unchecked = purchase.lines.filter((line) => !line.confirmed).length;
      row.append(
        make("td", undefined, dayLabel(purchase.date)),
        make("td", undefined, purchase.storeName ?? "—"),
        make("td", "is-number", String(purchase.lines.length)),
        make("td", "is-number", euro(purchase.spent)),
        make("td", undefined, SOURCE_LABELS[purchase.source])
      );
      const status = make("td");
      status.appendChild(
        purchase.status === "review"
          ? pill("● Needs review", "soon")
          : purchase.status === "imported"
            ? pill("Imported", "ok")
            : pill("History only")
      );
      if (purchase.status === "review" && unchecked)
        status.appendChild(make("span", "meals-line-meta", ` ${unchecked} to check · pantry not updated`));
      row.appendChild(status);
      const action = make("td", "is-number");
      action.appendChild(
        button(
          purchase.status === "review" ? `Review ${unchecked || ""} →`.replace("  ", " ") : "View",
          purchase.status === "review" ? "btn btn-primary" : "btn btn-ghost",
          () => openReview(purchase.id)
        )
      );
      row.appendChild(action);
      body.appendChild(row);
    }
    table.appendChild(body);
    const scroll = make("div", "meals-table-scroll");
    scroll.appendChild(table);
    wrap.appendChild(scroll);
  }
  return wrap;
}

/** Adding a purchase: typed line by line here; receipts and invoices are read in a later version. */
function addPanel(data: MealsSnapshot): HTMLElement {
  const { box, body } = panel(
    "Add a purchase",
    data.spent.toReview ? pill(`● ${data.spent.toReview} waiting for review`, "soon") : undefined
  );
  box.classList.add("meals-drop");
  body.appendChild(pill("PDF"));
  body.appendChild(
    make(
      "p",
      "meals-note",
      "An invoice PDF is read here on the PC, or type what you bought. Each line is matched to your foods and waits for you to check it — nothing changes until you confirm."
    )
  );
  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Upload file",
      "btn btn-primary",
      () =>
        void act(async () => {
          const purchase = await bridge().importReceipt();
          if (purchase) {
            state.view = "purchases";
            state.reviewing = purchase.id;
          }
        })
    ),
    button("Type a purchase", "btn btn-secondary", () => openManualPurchase(data))
  );
  body.appendChild(actions);
  return box;
}

/** One food's latest price at each shop, cheapest first; typed-in prices drawn dashed. */
function priceWatchPanel(data: MealsSnapshot): HTMLElement {
  const watched =
    data.priceWatch.find((entry) => entry.ingredientId === state.watching) ?? data.priceWatch[0] ?? null;
  const picker = select(
    data.priceWatch.map((entry) => [entry.ingredientId, entry.name] as [string, string]),
    watched?.ingredientId
  );
  picker.addEventListener("change", () => {
    state.watching = picker.value;
    rerender();
  });
  const { box, body } = panel(
    watched ? `Price watch · ${watched.name}` : "Price watch",
    watched ? picker : undefined
  );
  if (!watched) {
    body.appendChild(
      make("p", "meals-note", "Prices appear here once a purchase is confirmed — per shop, per unit.")
    );
    return box;
  }
  const unit = data.ingredients.find((i) => i.id === watched.ingredientId)?.unit ?? "g";
  const per =
    unit === "piece"
      ? { factor: 1, label: "each" }
      : unit === "ml" || unit === "l"
        ? { factor: 1000, label: "per l" }
        : { factor: 1000, label: "per kg" };
  const top = Math.max(...watched.prices.map((p) => p.pricePerBase));
  const list = make("div", "meals-watch");
  for (const price of watched.prices) {
    const row = make("div", "meals-watch-row");
    row.append(
      make("span", undefined, price.storeName),
      stockBar(price.pricePerBase / top, price.manual),
      make(
        "span",
        `is-number${price.manual ? " meals-estimate" : ""}`,
        `${price.manual ? "≈ " : ""}${euro(Math.round(price.pricePerBase * per.factor * 100) / 100)}`
      )
    );
    list.appendChild(row);
  }
  body.appendChild(list);
  const cheapest = watched.prices[0];
  const foot = make("div", "meals-row meals-row-tight");
  foot.append(
    pill(`Cheapest · ${cheapest.storeName}`, "accent"),
    make(
      "span",
      "meals-line-meta",
      `${per.label} · ${cheapest.manual ? "typed" : "receipt"} ${dayLabel(cheapest.date)}`
    )
  );
  body.appendChild(foot);
  return box;
}

/** A purchase typed in: the shop, the day, and a row per line. It then opens for review. */
function openManualPurchase(data: MealsSnapshot): void {
  const { box, body } = panel("Type a purchase");
  box.classList.add("meals-dialog", "meals-modal-wide");
  const shop = input("text");
  shop.placeholder = "Shop";
  shop.setAttribute("list", "mealsStoreNames");
  const shops = make("datalist");
  shops.id = "mealsStoreNames";
  for (const store of data.stores) shops.appendChild(new Option(store.name));
  const day = input("date");
  day.value = data.today;
  const total = input("number");
  total.step = "0.01";
  total.min = "0";
  total.placeholder = "optional";
  const form = make("div", "meals-form");
  form.append(field("Shop", shop), field("Day", day), field("Total €", total));
  body.append(form, shops);

  const foods = make("datalist");
  foods.id = "mealsPurchaseFoods";
  for (const ingredient of data.ingredients) foods.appendChild(new Option(ingredient.name));
  body.appendChild(foods);
  const rows: Array<{
    name: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLSelectElement;
    price: HTMLInputElement;
  }> = [];
  const lines = make("div", "meals-lines");
  const addRow = () => {
    const row = make("div", "meals-line meals-line-edit");
    const name = input("text");
    name.placeholder = "What";
    name.setAttribute("list", "mealsPurchaseFoods");
    const quantity = input("number");
    quantity.step = "0.01";
    quantity.min = "0";
    quantity.placeholder = "amount";
    const unit = select(
      KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
      "g"
    );
    const price = input("number");
    price.step = "0.01";
    price.min = "0";
    price.placeholder = "€";
    rows.push({ name, quantity, unit, price });
    row.append(name, quantity, unit, price);
    lines.appendChild(row);
  };
  for (let i = 0; i < 3; i += 1) addRow();
  body.append(lines, button("+ Add line", "meals-link", addRow));

  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Check the lines →",
      "btn btn-primary",
      () =>
        void act(async () => {
          const purchase = await bridge().createPurchase({
            source: "manual",
            store: shop.value,
            date: day.value,
            total: total.value ? Number(total.value) : null,
            lines: rows
              .filter((row) => row.name.value.trim())
              .map((row) => ({
                raw: row.name.value,
                quantity: row.quantity.value ? Number(row.quantity.value) : null,
                unit: row.unit.value,
                price: row.price.value ? Number(row.price.value) : null,
              })),
          });
          state.view = "purchases";
          state.reviewing = purchase.id;
        })
    ),
    button("Cancel", "btn btn-ghost", () => rerender())
  );
  body.appendChild(actions);
  showModal(box);
}

/** Opens a purchase in the review drawer (it redraws itself from each fresh snapshot). */
export function openReview(purchaseId: string): void {
  state.reviewing = purchaseId;
  rerender();
}

/**
 * The review drawer: each line as printed, the food it was matched to (a
 * select, with "Not food" and "New food"), how much and what it cost.
 * Uncertain lines are outlined; checking one confirms it. Then what the
 * purchase should change — prices, the pantry, the shopping list.
 */
export function reviewDrawer(data: MealsSnapshot): HTMLElement | null {
  const purchase = data.purchases.find((entry) => entry.id === state.reviewing);
  if (!purchase) {
    state.reviewing = null;
    return null;
  }
  const reviewing = purchase.status === "review";
  const { box, body } = panel(
    `${reviewing ? "Review" : "Purchase"} · ${SOURCE_LABELS[purchase.source].toLowerCase()}`,
    button("✕", "meals-link", () => {
      state.reviewing = null;
      rerender();
    })
  );
  box.classList.add("meals-drawer");
  body.appendChild(
    make(
      "h3",
      "meals-drawer-title",
      [
        purchase.storeName ?? "No shop",
        dayLabel(purchase.date),
        purchase.total !== null ? euro(purchase.total) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );
  const matched = purchase.lines.filter((line) => line.ingredientId && line.confidence >= SURE).length;
  const toLook = purchase.lines.filter((line) => !line.confirmed && !line.notFood).length;
  const notFood = purchase.lines.filter((line) => line.notFood).length;
  const check = purchase.check;
  body.appendChild(
    make(
      "p",
      "meals-note",
      [
        `${purchase.lines.length} lines`,
        `${matched} matched`,
        toLook ? `${toLook} need a look` : null,
        notFood ? `${notFood} not food` : null,
        check.matches === null
          ? `lines total ${euro(check.sum)}`
          : check.matches
            ? `lines total ${euro(check.sum)} — matches the total`
            : `lines total ${euro(check.sum)} — the total says ${euro(purchase.total)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    )
  );

  const table = make("div", "meals-review");
  const header = make("div", "meals-review-row is-head");
  for (const title of ["As written", "Matched to", "Amount", "Price", ""])
    header.appendChild(make("span", undefined, title));
  table.appendChild(header);
  const foodOptions: Array<[string, string]> = [
    ["", "? Choose a food"],
    ["__notfood", "Not food · skip"],
    ["__new", "New food: as written"],
    ...data.ingredients
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => [i.id, i.name] as [string, string]),
  ];
  for (const line of purchase.lines) {
    const unsure = !line.confirmed && !line.notFood && line.confidence < SURE;
    const row = make(
      "div",
      `meals-review-row${unsure ? " is-unsure" : ""}${line.confirmed ? " is-checked" : ""}`
    );
    row.appendChild(make("span", "meals-review-raw", line.raw));
    const food = select(foodOptions, line.notFood ? "__notfood" : (line.ingredientId ?? ""));
    food.disabled = !reviewing;
    const matchCell = make("div", "meals-review-match");
    matchCell.appendChild(food);
    matchCell.appendChild(
      make(
        "span",
        `meals-line-meta${unsure ? " is-warn" : ""}`,
        line.notFood
          ? "History only"
          : line.confirmed
            ? "Checked"
            : line.ingredientId
              ? `Matched · ${Math.round(line.confidence * 100)}%`
              : "No match"
      )
    );
    row.appendChild(matchCell);
    const quantity = input("number");
    quantity.step = "0.001";
    quantity.min = "0";
    quantity.value = line.quantity === null ? "" : String(line.quantity);
    quantity.disabled = !reviewing;
    const unit = select(
      KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
      line.unit ?? "piece"
    );
    unit.disabled = !reviewing;
    const amount = make("div", "meals-review-amount");
    amount.append(quantity, unit);
    row.appendChild(amount);
    const price = input("number");
    price.step = "0.01";
    price.value = line.price === null ? "" : String(line.price);
    price.disabled = !reviewing;
    row.appendChild(price);
    const save = () =>
      void act(() =>
        bridge().updatePurchaseLine(purchase.id, line.id, {
          ingredientId: food.value && !food.value.startsWith("__") ? food.value : null,
          newFood: food.value === "__new" ? line.raw : undefined,
          notFood: food.value === "__notfood",
          quantity: quantity.value ? Number(quantity.value) : null,
          unit: unit.value,
          price: price.value ? Number(price.value) : null,
        })
      );
    if (reviewing) {
      for (const control of [food, quantity, unit, price]) control.addEventListener("change", save);
      row.appendChild(
        line.confirmed ? make("span", "meals-review-ok", "✓") : button("✓", "btn btn-secondary", save)
      );
    } else row.appendChild(make("span"));
    table.appendChild(row);
  }
  const scroll = make("div", "meals-table-scroll");
  scroll.appendChild(table);
  body.appendChild(scroll);

  if (reviewing) {
    const apply = make("div", "meals-apply");
    apply.appendChild(make("p", "card-kicker", "Apply this purchase to"));
    const checked = purchase.lines.filter((l) => l.confirmed && !l.notFood && l.ingredientId);
    const box1 = checkbox(
      `Purchase history & prices · ${checked.filter((l) => l.price !== null).length} price records`
    );
    const box2 = checkbox(
      `Pantry stock · adds ${checked.filter((l) => l.quantity !== null).length} items as confirmed`
    );
    const box3 = checkbox("Tick matching shopping-list items");
    apply.append(box1.label, box2.label, box3.label);
    if (toLook)
      apply.appendChild(
        make("p", "meals-note", `${toLook} line(s) not checked yet are kept in the total but not applied.`)
      );
    body.appendChild(apply);
    const actions = make("div", "meals-row");
    actions.append(
      button(
        "Confirm import",
        "btn btn-primary",
        () =>
          void act(async () => {
            await bridge().confirmPurchase(purchase.id, {
              prices: box1.input.checked,
              pantry: box2.input.checked,
              shopping: box3.input.checked,
            });
            state.reviewing = null;
          }, "Purchase confirmed.")
      ),
      button("Save for later", "btn btn-ghost", () => {
        state.reviewing = null;
        rerender();
      }),
      button(
        "Delete",
        "btn btn-ghost",
        () =>
          void act(async () => {
            await bridge().removePurchase(purchase.id);
            state.reviewing = null;
          }, "Purchase deleted.")
      )
    );
    body.appendChild(actions);
  } else {
    body.appendChild(
      button(
        "Delete — forgets its prices; the food stays in the pantry",
        "btn btn-ghost",
        () =>
          void act(async () => {
            await bridge().removePurchase(purchase.id);
            state.reviewing = null;
          }, "Purchase deleted.")
      )
    );
  }
  const backdrop = make("div", "meals-drawer-backdrop");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      state.reviewing = null;
      rerender();
    }
  });
  backdrop.appendChild(box);
  return backdrop;
}

function checkbox(text: string): { label: HTMLElement; input: HTMLInputElement } {
  const label = make("label", "meals-check");
  const box = input("checkbox", "");
  box.checked = true;
  label.append(box, document.createTextNode(` ${text}`));
  return { label, input: box };
}

/** "3 lines to check" for the Today shopping panel and the tab header. */
export function reviewCount(): number {
  return snapshot?.spent.toReview ?? 0;
}
