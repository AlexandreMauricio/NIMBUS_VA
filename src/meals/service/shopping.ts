/**
 * The shopping list and purchases, over MealsPlanning: what to buy, what
 * was bought where and for how much, and the prices that come from it.
 * See mealService.ts for the whole.
 */

import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { isoDate, mergeInto, planDeductions } from "../pantry";
import { pricePerBaseUnit, scaleFor } from "../recipes";
import { guessPlace, linePricePerBase, linePriceUnit, matchLine } from "../purchases";
import { buildShoppingList } from "../shopping";
import type { ShoppingList } from "../shopping";
import {
  MAX_PANTRY_ITEMS,
  MAX_SHOPPING_ITEMS,
  MAX_STORES,
  MAX_PURCHASES,
  MAX_PURCHASE_LINES,
  MAX_PRICES,
  PriceRecord,
  Purchase,
  PurchaseLine,
  PurchaseSource,
  ShoppingMark,
  ShoppingMarkKind,
  Store,
  ManualShoppingItem,
  PantryItem,
  STORAGE_PLACES,
  StoragePlace,
} from "../types";
import { ingredientKey } from "../names";
import { baseUnit, formatAmount, normaliseUnit, subtract } from "../units";
import { text, positive, isoDay, PURCHASE_SOURCES, money, parseBags, MARK_KINDS } from "../parse";
import { MealsPlanning } from "./planning";

export class MealsShopping extends MealsPlanning {
  // ---------- The shopping list ----------

  /**
   * What the days in `dates` need that the kitchen doesn't have, plus
   * whatever was added by hand. Worked out fresh every time — see
   * shopping.ts for why nothing about it is stored.
   */
  shoppingList(dates: string[]): ShoppingList {
    const days = new Set(dates);
    return buildShoppingList(
      this.state.plan.filter((meal) => days.has(meal.date)),
      new Map(this.state.recipes.map((recipe) => [recipe.id, recipe])),
      this.state.pantry,
      new Map(this.state.ingredients.map((ingredient) => [ingredient.id, ingredient])),
      this.state.shopping
    );
  }

  addShoppingItem(input: unknown): ManualShoppingItem {
    const r = (input ?? {}) as Record<string, unknown>;
    const name = text(r.name, 120);
    if (!name) throw new Error("What should go on the list?");
    if (this.state.shopping.length >= MAX_SHOPPING_ITEMS) throw new Error("The shopping list is full.");
    const known = this.findIngredient(name);
    const item: ManualShoppingItem = {
      id: randomUUID(),
      name,
      ingredientId: known?.id ?? null,
      quantity: positive(r.quantity),
      unit: normaliseUnit(r.unit),
      note: text(r.note, 200),
      addedAt: this.now(),
    };
    this.state.shopping.push(item);
    this.save();
    return item;
  }

  /**
   * Puts what a recipe is short of on the shopping list, as lines of their
   * own — for cooking something that isn't in the plan. A food already on
   * the list by hand isn't added twice. Returns how many were added.
   */
  addMissingToShopping(recipeId: unknown, servings: unknown): number {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) throw new Error("That recipe is gone.");
    const plan = planDeductions(
      recipe.ingredients,
      this.state.pantry,
      scaleFor(recipe, positive(servings, recipe.servings)!),
      { family: this.family() }
    );
    let added = 0;
    for (const entry of plan.short) {
      const ingredientId = entry.ingredient.ingredientId;
      if (this.state.shopping.some((item) => item.ingredientId === ingredientId)) continue;
      if (this.state.shopping.length >= MAX_SHOPPING_ITEMS) break;
      const food = this.state.ingredients.find((i) => i.id === ingredientId);
      this.state.shopping.push({
        id: randomUUID(),
        name: food?.name ?? entry.ingredient.text,
        ingredientId,
        quantity: entry.missing ? Math.round(entry.missing.quantity * 1000) / 1000 : null,
        unit: entry.missing?.unit ?? null,
        note: `for ${recipe.name}`,
        addedAt: this.now(),
      });
      added += 1;
    }
    if (added) this.save();
    return added;
  }

  removeShoppingItem(id: unknown): void {
    this.state.shopping = this.state.shopping.filter((item) => item.id !== id);
    this.save();
  }

  /**
   * Buying something: it goes into the pantry as **confirmed** stock, and
   * what it cost becomes that ingredient's price per unit, so every recipe
   * using it is costed from a real receipt rather than a guess. A manual
   * line is removed once bought; a line the plan asked for disappears by
   * itself, because the pantry now covers it.
   */
  buy(input: unknown): PantryItem {
    const r = (input ?? {}) as Record<string, unknown>;
    const quantity = positive(r.quantity);
    const unit = normaliseUnit(r.unit);
    if (quantity === null || !unit) throw new Error("How much did you buy?");
    const item = this.addStock({
      ingredientId: r.ingredientId,
      name: r.name,
      quantity,
      unit,
      place: r.place,
      expiresAt: r.expiresAt,
      packaging: r.packaging,
      confidence: "confirmed",
    });
    const paid = typeof r.paid === "number" && Number.isFinite(r.paid) && r.paid >= 0 ? r.paid : null;
    if (paid !== null) {
      const price = pricePerBaseUnit(paid, { quantity, unit });
      if (price !== null) {
        this.updateIngredient(item.ingredientId, { lastPrice: price, priceUnit: baseUnit(unit) });
        const store = text(r.store, 60) ? this.ensureStore(r.store) : null;
        this.recordPrice({
          ingredientId: item.ingredientId,
          storeId: store?.id ?? null,
          pricePerBase: price,
          unit: baseUnit(unit),
          date: this.today(),
          purchaseId: null,
        });
      }
    }
    this.state.shoppingMarks = this.state.shoppingMarks.filter(
      (mark) => mark.ingredientId !== item.ingredientId
    );
    if (typeof r.itemId === "string" && r.itemId) this.removeShoppingItem(r.itemId);
    else this.save();
    return item;
  }

  // ---------- Shops, purchases and prices ----------

  listStores(): Store[] {
    return [...this.state.stores];
  }

  /** A shop by name, created the first time it's named. */
  ensureStore(name: unknown): Store {
    const cleaned = text(name, 60);
    if (!cleaned) throw new Error("A shop needs a name.");
    const key = ingredientKey(cleaned);
    const existing = this.state.stores.find((store) => ingredientKey(store.name) === key);
    if (existing) return existing;
    if (this.state.stores.length >= MAX_STORES) throw new Error("Too many shops.");
    const store = { id: randomUUID(), name: cleaned };
    this.state.stores.push(store);
    this.save();
    return store;
  }

  /** A price paid, kept with its unit — which becomes the unit the food is priced in. */
  private recordPrice(record: PriceRecord): void {
    const food = this.state.ingredients.find((i) => i.id === record.ingredientId);
    if (food) {
      food.lastPrice = record.pricePerBase;
      food.priceUnit = record.unit;
    }
    this.state.prices.push(record);
    if (this.state.prices.length > MAX_PRICES)
      this.state.prices.splice(0, this.state.prices.length - MAX_PRICES);
  }

  listPurchases(): Purchase[] {
    return [...this.state.purchases].sort(
      (a, b) => b.date.localeCompare(a.date) || b.addedAt.localeCompare(a.addedAt)
    );
  }

  /**
   * A purchase to check: its lines as read or typed, each matched to a
   * known food where one fits (with how sure), waiting in "review" until
   * you confirm it. Nothing in the kitchen changes yet.
   */
  createPurchase(input: unknown): Purchase {
    const r = (input ?? {}) as Record<string, unknown>;
    if (this.state.purchases.length >= MAX_PURCHASES) throw new Error("Too many purchases kept.");
    const source = PURCHASE_SOURCES.includes(r.source as PurchaseSource)
      ? (r.source as PurchaseSource)
      : "manual";
    const rawLines = Array.isArray(r.lines) ? r.lines.slice(0, MAX_PURCHASE_LINES) : [];
    const lines: PurchaseLine[] = [];
    for (const raw of rawLines) {
      const l = (raw ?? {}) as Record<string, unknown>;
      const lineText = text(l.raw ?? l.name, 200);
      if (!lineText) continue;
      const typed =
        typeof l.ingredientId === "string" && this.state.ingredients.some((i) => i.id === l.ingredientId);
      const match = typed
        ? { ingredientId: l.ingredientId as string, confidence: 1 }
        : matchLine(lineText, this.state.ingredients);
      lines.push({
        id: randomUUID(),
        raw: lineText,
        ingredientId: match.ingredientId,
        notFood: l.notFood === true,
        quantity: positive(l.quantity),
        unit: normaliseUnit(l.unit),
        price: money(l.price),
        // What you typed yourself is known; what was read off paper is a guess until checked.
        confidence:
          source === "manual" && match.ingredientId ? Math.max(match.confidence, 0.9) : match.confidence,
        confirmed: source === "manual" && Boolean(match.ingredientId) && match.confidence >= 0.8,
        place: STORAGE_PLACES.includes(l.place as StoragePlace)
          ? (l.place as StoragePlace)
          : guessPlace(
              lineText,
              this.state.ingredients.find((i) => i.id === match.ingredientId) ?? null,
              this.state.pantry
            ),
        bags: null,
        stocked: [],
      });
    }
    if (!lines.length) throw new Error("A purchase needs at least one line.");
    const store = text(r.store, 60) ? this.ensureStore(r.store) : null;
    const purchase: Purchase = {
      id: randomUUID(),
      storeId: store?.id ?? null,
      date: isoDay(r.date) ?? this.today(),
      source,
      status: "review",
      lines,
      total: money(r.total),
      fileName: text(r.fileName, 200),
      addedAt: this.now(),
      updatedAt: this.now(),
    };
    this.state.purchases.push(purchase);
    this.save();
    return purchase;
  }

  /** Checking one line: which food (or not food), how much, what it cost. The line is then confirmed. */
  updatePurchaseLine(purchaseId: unknown, lineId: unknown, changes: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    const line = purchase.lines.find((entry) => entry.id === lineId);
    if (!line) throw new Error("That line is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.ingredientId !== undefined) {
      if (c.ingredientId === null) line.ingredientId = null;
      else if (
        typeof c.ingredientId === "string" &&
        this.state.ingredients.some((i) => i.id === c.ingredientId)
      )
        line.ingredientId = c.ingredientId;
      else throw new Error("That food isn't known.");
    }
    const before = line.ingredientId;
    if (typeof c.newFood === "string" && text(c.newFood, 120)) {
      const food = this.ensureIngredient(c.newFood, normaliseUnit(c.unit) ?? line.unit ?? "g");
      line.ingredientId = food.id;
      if (typeof c.countsAs === "string" && c.countsAs && food.id !== c.countsAs)
        this.setCountsAs(food, c.countsAs);
    }
    // Freezing in bags: to the freezer, each bag its own item; sizes adding up to more than bought are refused.
    if (c.bags !== undefined) {
      const bags = parseBags(c.bags);
      const total = bags?.reduce((sum, size) => sum + size, 0) ?? 0;
      if (bags && line.quantity !== null && total > line.quantity + 1e-6)
        throw new Error("Those bags hold more than was bought.");
      line.bags = bags && bags.length > 1 ? bags : bags && line.quantity !== null ? bags : null;
      if (line.bags) line.place = "freezer";
    }
    // A place you chose stays; a different food brings its own guess.
    if (STORAGE_PLACES.includes(c.place as StoragePlace)) line.place = c.place as StoragePlace;
    else if (line.ingredientId !== before)
      line.place = guessPlace(
        line.raw,
        this.state.ingredients.find((i) => i.id === line.ingredientId) ?? null,
        this.state.pantry
      );
    if (c.notFood !== undefined) line.notFood = c.notFood === true;
    if (c.quantity !== undefined) line.quantity = positive(c.quantity);
    if (c.unit !== undefined) line.unit = normaliseUnit(c.unit);
    if (c.price !== undefined) line.price = money(c.price);
    line.confirmed = true;
    line.confidence = line.ingredientId || line.notFood ? 1 : line.confidence;
    purchase.updatedAt = this.now();
    this.save();
    return purchase;
  }

  updatePurchase(purchaseId: unknown, changes: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    const c = (changes ?? {}) as Record<string, unknown>;
    if (c.store !== undefined) purchase.storeId = text(c.store, 60) ? this.ensureStore(c.store).id : null;
    if (c.date !== undefined) purchase.date = isoDay(c.date) ?? purchase.date;
    if (c.total !== undefined) purchase.total = money(c.total);
    purchase.updatedAt = this.now();
    this.save();
    return purchase;
  }

  /**
   * Confirming a purchase: every line you've checked that is a food,
   * with an amount, applied to what you ask —
   *
   *  - `prices`: its price per unit, at that shop, on that day;
   *  - `pantry`: the food into the kitchen, as confirmed stock;
   *  - `shopping`: lines added by hand for that food ticked off (the ones
   *    worked out from the plan go by themselves, now the pantry has it).
   *
   * Each confirmed line's text becomes an alias of its food, so the same
   * receipt line matches for certain next time. Lines never checked are
   * left out rather than guessed into the kitchen.
   */
  confirmPurchase(purchaseId: unknown, apply: unknown): Purchase {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) throw new Error("That purchase is gone.");
    if (purchase.status !== "review") throw new Error("That purchase is already confirmed.");
    const a = (apply ?? {}) as Record<string, unknown>;
    const toPrices = a.prices !== false;
    const toPantry = a.pantry !== false;
    const toShopping = a.shopping !== false;
    for (const line of purchase.lines) {
      if (!line.confirmed || line.notFood || !line.ingredientId) continue;
      const ingredient = this.state.ingredients.find((i) => i.id === line.ingredientId);
      if (!ingredient) continue;
      // The line's own words, remembered as a name for this food.
      const lineKey = ingredientKey(line.raw);
      const known = [ingredient.name, ...ingredient.aliases].some((name) => ingredientKey(name) === lineKey);
      if (lineKey && !known && ingredient.aliases.length < 20) ingredient.aliases.push(line.raw);
      const perBase = linePricePerBase(line);
      if (toPrices && perBase !== null) {
        this.recordPrice({
          ingredientId: ingredient.id,
          storeId: purchase.storeId,
          pricePerBase: perBase,
          unit: linePriceUnit(line),
          date: purchase.date,
          purchaseId: purchase.id,
        });
      }
      if (toPantry && line.quantity !== null && line.unit) {
        const place = line.bags ? "freezer" : line.place;
        const unit = line.unit;
        // Frozen in bags: one pantry item per bag, each used whole. Else one item.
        const portions = line.bags ?? [line.quantity];
        line.stocked = [];
        for (const quantity of portions) {
          if (this.state.pantry.length >= MAX_PANTRY_ITEMS) break;
          const item: PantryItem = {
            id: randomUUID(),
            ingredientId: ingredient.id,
            name: ingredient.name,
            quantity,
            unit,
            startQuantity: quantity,
            place,
            confidence: "confirmed",
            packaging: line.bags ? `frozen bag of ${formatAmount({ quantity, unit })}` : null,
            openedAt: null,
            // In the fridge, a food with a known keeping time gets an eat-by date.
            expiresAt:
              place === "fridge" && ingredient.fridgeDays
                ? isoDate(new Date(Date.parse(this.now()) + ingredient.fridgeDays * 86_400_000))
                : null,
            lastCorrection: null,
            wholeBag: Boolean(line.bags),
            addedAt: this.now(),
            updatedAt: this.now(),
          };
          this.state.pantry = mergeInto(this.state.pantry, item);
          // Remember where it went — a new item, or topped up into one already there.
          const into =
            this.state.pantry.find((entry) => entry.id === item.id) ??
            this.state.pantry.find(
              (entry) =>
                entry.ingredientId === ingredient.id &&
                entry.place === place &&
                entry.updatedAt === item.updatedAt
            );
          if (into) line.stocked.push({ itemId: into.id, quantity, unit });
        }
      }
      if (toShopping) {
        this.state.shopping = this.state.shopping.filter((item) => item.ingredientId !== ingredient.id);
        this.state.shoppingMarks = this.state.shoppingMarks.filter(
          (mark) => mark.ingredientId !== ingredient.id
        );
      }
      ingredient.updatedAt = this.now();
    }
    purchase.status = toPantry ? "imported" : "history";
    purchase.updatedAt = this.now();
    this.save();
    logger.info("Purchase confirmed", { lines: purchase.lines.length, status: purchase.status });
    return purchase;
  }

  /** Forgets a purchase and the prices it recorded. What it put in the pantry stays — that's food now. */
  /**
   * Deleting a purchase forgets its prices. With `takeBack`, what it put in
   * the pantry comes out again — as much as it added, from the item it
   * went into, if that's still there — for a purchase entered by mistake
   * or to try things. Returns how many pantry items changed.
   */
  removePurchase(purchaseId: unknown, options: unknown = {}): number {
    const purchase = this.state.purchases.find((entry) => entry.id === purchaseId);
    if (!purchase) return 0;
    let changed = 0;
    if (((options ?? {}) as Record<string, unknown>).takeBack === true)
      for (const stocked of purchase.lines.flatMap((line) => line.stocked)) {
        const item = this.state.pantry.find((entry) => entry.id === stocked.itemId);
        if (!item) continue;
        const left = subtract(item, stocked);
        if (!left) continue;
        changed += 1;
        if (left.quantity <= 1e-9) this.state.pantry = this.state.pantry.filter((entry) => entry !== item);
        else {
          if (item.unit === stocked.unit)
            item.startQuantity = Math.max(left.quantity, item.startQuantity - stocked.quantity);
          item.quantity = left.quantity;
          item.unit = left.unit;
          item.updatedAt = this.now();
        }
      }
    this.state.purchases = this.state.purchases.filter((entry) => entry !== purchase);
    this.state.prices = this.state.prices.filter((record) => record.purchaseId !== purchaseId);
    this.save();
    return changed;
  }

  /**
   * A note on a food of this week's list: not in the shop ("unavailable",
   * optionally which shop), skipped this week, or replaced by another food.
   * Clearing (kind null) removes the note. Notes are forgotten after a week.
   */
  markShopping(ingredientId: unknown, kind: unknown, extra: unknown = {}): void {
    if (typeof ingredientId !== "string" || !ingredientId) throw new Error("Which food?");
    this.state.shoppingMarks = this.state.shoppingMarks.filter((mark) => mark.ingredientId !== ingredientId);
    if (kind !== null && MARK_KINDS.includes(kind as ShoppingMarkKind)) {
      const e = (extra ?? {}) as Record<string, unknown>;
      const substitute =
        typeof e.substituteId === "string" && this.state.ingredients.some((i) => i.id === e.substituteId)
          ? e.substituteId
          : null;
      if (kind === "substitute" && !substitute) throw new Error("Substitute with what?");
      this.state.shoppingMarks.push({
        ingredientId,
        kind: kind as ShoppingMarkKind,
        substituteId: substitute,
        storeId: typeof e.storeId === "string" && e.storeId ? e.storeId : null,
        at: this.now(),
      });
    }
    this.save();
  }

  /** The week's notes on the shopping list, older ones dropped. */
  shoppingMarks(): ShoppingMark[] {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return this.state.shoppingMarks.filter((mark) => mark.at >= weekAgo);
  }
}
