import { STORAGE_LABELS, STORAGE_PLACES } from "../../meals/types";
import { KNOWN_UNITS, formatAmount, unitLabel } from "../../meals/units";
import {
  MealsSnapshot,
  act,
  bridge,
  button,
  chip,
  counter,
  euro,
  field,
  input,
  make,
  panel,
  rerender,
  pill,
  select,
  snapshot,
  state,
  showModal,
} from "./common";

// ---------- Shopping ----------

/**
 * The list is worked out from the plan every time, so there is nothing to
 * tick: **Bought** puts the food in the pantry, and the line disappears
 * because the kitchen now covers it.
 */
export function shoppingView(data: MealsSnapshot): HTMLElement {
  const wrap = make("div", "meals-view");
  const list = data.shopping;

  const counters = make("div", "meals-counters");
  counters.append(
    counter(String(list.toBuy), "to buy"),
    counter(list.cost === null ? "—" : `≈ ${euro(list.cost)}`, "estimated", "est"),
    counter(String(list.covered.length), "covered by the pantry"),
    counter(String(list.unpriced), "with no price yet", list.unpriced ? "soon" : "")
  );
  wrap.appendChild(counters);

  const toolbar = make("div", "meals-toolbar");
  const manualName = input("text");
  manualName.placeholder = "Bin bags, something for Sunday…";
  const manualQuantity = input("number");
  manualQuantity.step = "0.01";
  manualQuantity.min = "0";
  manualQuantity.placeholder = "amount";
  const manualUnit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    "piece"
  );
  toolbar.append(
    manualName,
    manualQuantity,
    manualUnit,
    button(
      "Add",
      "btn btn-secondary",
      () =>
        void act(
          () =>
            bridge().addShoppingItem({
              name: manualName.value,
              quantity: manualQuantity.value ? Number(manualQuantity.value) : null,
              unit: manualUnit.value,
            }),
          "Added to the list."
        )
    )
  );
  const grouping = make("div", "meals-chips");
  grouping.append(
    chip("By category", state.shoppingGroup === "category", () => {
      state.shoppingGroup = "category";
      rerender();
    }),
    chip("By store", state.shoppingGroup === "store", () => {
      state.shoppingGroup = "store";
      rerender();
    }),
    chip("By meal", state.shoppingGroup === "meal", () => {
      state.shoppingGroup = "meal";
      rerender();
    })
  );
  wrap.append(toolbar, grouping);
  if (list.saving)
    wrap.appendChild(
      make(
        "p",
        "meals-note",
        `Buying at ${[list.saving.mainStore, ...list.saving.otherStores].join(" + ")} saves ≈ ${euro(list.saving.saving)} over ${list.saving.mainStore} alone.`
      )
    );

  if (!list.lines.length) {
    wrap.appendChild(
      make(
        "p",
        "feed-empty",
        "Nothing to buy — the pantry covers what's planned. Plan more meals, or add something by hand."
      )
    );
    return wrap;
  }

  // Grouped either by the food's category, or by the meal that wants it.
  const categories = new Map<string, string>();
  for (const stock of data.stock) if (stock.category) categories.set(stock.ingredientId, stock.category);
  const groups = new Map<string, typeof list.lines>();
  for (const line of list.lines) {
    const keys =
      state.shoppingGroup === "store"
        ? [line.shop ?? "No price yet"]
        : state.shoppingGroup === "meal"
          ? line.manual
            ? ["Added by hand"]
            : line.forMeals.length
              ? line.forMeals
              : ["Other"]
          : [
              line.manual
                ? "Added by hand"
                : (line.ingredientId && categories.get(line.ingredientId)) || "Other",
            ];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  for (const [title, lines] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = make("section", "meals-group");
    const head = make("div", "meals-group-head");
    const groupCost = lines.reduce<number | null>(
      (sum, line) => (line.cost === null ? sum : (sum ?? 0) + line.cost),
      null
    );
    head.append(
      make("h6", undefined, title),
      make("span", "meals-group-meta", `${lines.length} item${lines.length === 1 ? "" : "s"}`),
      make("span", "meals-group-cost", groupCost === null ? "" : `≈ ${euro(groupCost)}`)
    );
    group.appendChild(head);
    for (const line of lines) {
      const row = make("div", "meals-srow");
      const what = make("div", "meals-srow-what");
      what.append(
        make("strong", undefined, line.name),
        make(
          "span",
          "meals-line-meta",
          line.manual ? "added by hand" : line.forMeals.length ? `for ${line.forMeals.join(", ")}` : ""
        )
      );
      row.appendChild(what);
      row.appendChild(
        make(
          "span",
          "meals-srow-need",
          line.needed
            ? `${formatAmount(line.needed)} needed${line.have ? ` · ${formatAmount({ quantity: line.have, unit: line.needed.unit })} at home` : ""}`
            : "amount unclear"
        )
      );
      row.appendChild(make("span", "meals-srow-buy", line.buy ? formatAmount(line.buy) : "—"));
      // The price, and where it came from: the cheapest shop and its receipt.
      const price = make("span", "meals-srow-price");
      price.appendChild(make("span", undefined, line.cost === null ? "" : `≈ ${euro(line.cost)}`));
      if (line.shop)
        price.appendChild(make("span", "meals-line-meta", `${line.shop} · ${line.priceSource ?? ""}`));
      row.appendChild(price);
      const actions = make("span", "meals-srow-actions");
      if (line.mark?.kind === "unavailable") actions.appendChild(pill("Unavailable", "urgent"));
      if (line.buy)
        actions.appendChild(
          button("Bought", "btn btn-secondary", () =>
            openBuy({
              name: line.name,
              ingredientId: line.ingredientId,
              quantity: line.buy!.quantity,
              unit: line.buy!.unit,
              itemId: line.itemId,
              shop: line.shop,
            })
          )
        );
      if (line.manual && line.itemId)
        actions.appendChild(
          button("Remove", "meals-link", () => void act(() => bridge().removeShoppingItem(line.itemId!)))
        );
      if (line.ingredientId && !line.mark)
        actions.appendChild(
          button(
            "Not in shop",
            "meals-link",
            () =>
              void act(() =>
                bridge().markShopping(line.ingredientId!, "unavailable", {
                  storeId: line.prices[0]?.storeId ?? null,
                })
              )
          )
        );
      row.appendChild(actions);
      group.appendChild(row);
      // Not in the shop: what could stand in for it, as the design offers.
      if (line.mark?.kind === "unavailable" && line.ingredientId) {
        const fallbacks = make("div", "meals-fallbacks");
        fallbacks.appendChild(make("span", "card-kicker", "Fallback"));
        for (const substitute of line.substitutes)
          fallbacks.appendChild(
            button(
              `↻ Substitute ${substitute.name} · in pantry`,
              "meals-alt-btn is-rec",
              () =>
                void act(() =>
                  bridge().markShopping(line.ingredientId!, "substitute", { substituteId: substitute.id })
                )
            )
          );
        const other = line.prices.find((p) => p.storeId !== line.mark!.storeId);
        if (other) fallbacks.appendChild(make("span", "meals-alt-btn", `↻ Try ${other.storeName}`));
        fallbacks.appendChild(
          button(
            "↻ Skip it",
            "meals-alt-btn",
            () => void act(() => bridge().markShopping(line.ingredientId!, "skip"))
          )
        );
        fallbacks.appendChild(
          button("Undo", "meals-link", () => void act(() => bridge().markShopping(line.ingredientId!, null)))
        );
        group.appendChild(fallbacks);
      }
    }
    wrap.appendChild(group);
  }

  if (list.setAside.length) {
    const { box, body } = panel("Set aside this week", `${list.setAside.length}`);
    for (const entry of list.setAside) {
      const row = make("div", "meals-line");
      row.append(
        make("strong", undefined, entry.name),
        make(
          "span",
          "meals-line-meta",
          entry.kind === "substitute" ? `using ${entry.substitute ?? "something else"} instead` : "skipped"
        ),
        button(
          "Put back",
          "meals-link",
          () => void act(() => bridge().markShopping(entry.ingredientId ?? "", null))
        )
      );
      body.appendChild(row);
    }
    wrap.appendChild(box);
  }

  if (list.covered.length) {
    const { box, body } = panel("Already in the kitchen", `${list.covered.length}`);
    body.appendChild(
      make(
        "p",
        "meals-note",
        list.covered
          .map((entry) => `${entry.name}${entry.value === null ? "" : ` (≈ ${euro(entry.value)})`}`)
          .join(" · ")
      )
    );
    wrap.appendChild(box);
  }
  wrap.appendChild(
    make(
      "p",
      "meals-note",
      "The list is the week's meals added up, minus the pantry — worked out each time you open it. Marking something bought puts it in the pantry, which is what makes the line go away."
    )
  );
  return wrap;
}

/** Buying: how much came home, what it cost, and where it goes. */
export function openBuy(line: {
  name: string;
  ingredientId: string | null;
  quantity: number;
  unit: string;
  itemId: string | null;
  shop?: string | null;
}): void {
  const { box, body } = panel(`Bought · ${line.name}`);
  box.classList.add("meals-dialog");
  const quantity = input("number");
  quantity.step = "0.01";
  quantity.min = "0";
  quantity.value = String(line.quantity);
  const unit = select(
    KNOWN_UNITS.map((u) => [u, unitLabel(u) === "×" ? "each" : unitLabel(u)] as [string, string]),
    line.unit
  );
  const paid = input("number");
  paid.step = "0.01";
  paid.min = "0";
  paid.placeholder = "optional";
  const place = select(
    STORAGE_PLACES.map((p) => [p, STORAGE_LABELS[p]] as [string, string]),
    "cupboard"
  );
  const expires = input("date");
  const shop = input("text");
  shop.placeholder = "optional";
  shop.value = line.shop ?? "";
  shop.setAttribute("list", "mealsBuyShops");
  const shops = make("datalist");
  shops.id = "mealsBuyShops";
  for (const store of snapshot?.stores ?? []) shops.appendChild(new Option(store.name));
  body.appendChild(shops);
  const form = make("div", "meals-form");
  form.append(
    field("Amount", quantity),
    field("Unit", unit),
    field("Paid €", paid),
    field("Shop", shop),
    field("Where", place),
    field("Use by", expires)
  );
  body.appendChild(form);
  body.appendChild(
    make(
      "p",
      "meals-note",
      "What you paid becomes this food's price per unit, so recipe costs stop being guesses."
    )
  );
  const actions = make("div", "meals-row");
  actions.append(
    button(
      "Put in the pantry",
      "btn btn-primary",
      () =>
        void act(
          () =>
            bridge().buyItem({
              itemId: line.itemId,
              ingredientId: line.ingredientId,
              name: line.name,
              quantity: Number(quantity.value),
              unit: unit.value,
              paid: paid.value ? Number(paid.value) : null,
              store: shop.value || null,
              place: place.value,
              expiresAt: expires.value || null,
            }),
          `${line.name} is in the pantry.`
        )
    ),
    button("Cancel", "btn btn-ghost", () => rerender())
  );
  body.appendChild(actions);
  showModal(box);
}
