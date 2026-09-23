import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceiptText, readDate, reconcile, repairOcrLine, sizeFromDescription } from "./receiptText";
import { foodNameGuesses, linePricePerBase, matchLine, pricesByStore, splitShopSaving } from "./purchases";
import { MealService } from "./mealService";
import type { MealsState, MealsStore, PriceRecord } from "./types";

const CONTINENTE = `
MODELO CONTINENTE HIPERMERCADOS SA
Loja Porto Boavista
NIF 502011475
19-09-2026 18:42
COXA FRANGO KG
    1,210 kg x 5,49 EUR/kg          6,65 C
LIMAO REDE 1KG                       1,29 C
IOG GREGO NAT 4X125G                 2,49 A
QJ MOZ 125G
    2 x 0,79                         1,58 A
DESCONTO CARTAO                     -0,20
ESP VERDE                            2,99 C
SACO REUT                            0,10 D
SUBTOTAL                            14,90
TOTAL                               14,90
MULTIBANCO                          14,90
IVA 6%                               0,70
Obrigado pela preferencia
`;

const LIDL = `
LIDL & Cia
Rua do Exemplo 12
Data: 16/09/26  Hora: 10:12
Leite meio gordo 1L          0,85 A
Ovos classe M 12un           2,39 A
Batata 2kg                   1,99 A
Total                        5,23
Cartao                       5,23
`;

test("purchases: a Continente receipt reads into lines with the right numbers", () => {
  const receipt = parseReceiptText(CONTINENTE);
  assert.equal(receipt.store, "Continente");
  assert.equal(receipt.date, "2026-09-19");
  assert.equal(receipt.total, 14.9);
  assert.deepEqual(
    receipt.lines.map((line) => [line.raw, line.quantity, line.unit, line.price]),
    [
      ["COXA FRANGO KG", 1.21, "kg", 6.65],
      ["LIMAO REDE 1KG", 1, "kg", 1.29],
      ["IOG GREGO NAT 4X125G", 500, "g", 2.49],
      // Two of the 125 g pack, less the card discount.
      ["QJ MOZ 125G", 250, "g", 1.38],
      ["ESP VERDE", 1, "piece", 2.99],
      ["SACO REUT", 1, "piece", 0.1],
    ]
  );
  // The lines add up to the printed total.
  assert.deepEqual(reconcile(receipt.lines, receipt.total), { sum: 14.9, matches: true, unpriced: 0 });
});

test("purchases: a Lidl receipt, and the header, VAT and payment lines are never items", () => {
  const receipt = parseReceiptText(LIDL);
  assert.equal(receipt.store, "Lidl");
  assert.equal(receipt.date, "2026-09-16");
  assert.equal(receipt.total, 5.23);
  assert.deepEqual(
    receipt.lines.map((line) => line.raw),
    ["Leite meio gordo 1L", "Ovos classe M 12un", "Batata 2kg"]
  );
  assert.deepEqual(receipt.lines[0], { raw: "Leite meio gordo 1L", quantity: 1, unit: "l", price: 0.85 });
});

test("purchases: pack sizes and dates as receipts write them", () => {
  assert.deepEqual(sizeFromDescription("IOG GREGO 4X125G"), { quantity: 500, unit: "g" });
  assert.deepEqual(sizeFromDescription("AZEITE 0,75L"), { quantity: 0.75, unit: "l" });
  assert.equal(sizeFromDescription("PAO"), null);
  assert.equal(readDate("19/09/26"), "2026-09-19");
  assert.equal(readDate("2026-09-19"), "2026-09-19");
  assert.equal(readDate("31-13-2026"), null);
});

test("purchases: receipt lines match foods — by words, Portuguese included, and for certain once learned", () => {
  const foods = [
    { id: "chicken", name: "Chicken thighs", aliases: [] },
    { id: "yoghurt", name: "Greek yoghurt", aliases: [] },
    { id: "lemon", name: "Lemons", aliases: [] },
  ];
  const chicken = matchLine("COXA FRANGO KG", foods);
  assert.equal(chicken.ingredientId, "chicken");
  assert.ok(chicken.confidence >= 0.8, `sure: ${chicken.confidence}`);
  const yoghurt = matchLine("IOG GREGO NAT 4X125G", foods);
  assert.equal(yoghurt.ingredientId, "yoghurt");
  assert.ok(yoghurt.confidence < 0.8, "extra words make it one to check");
  assert.equal(matchLine("ESP VERDE", foods).ingredientId, null);
  // An alias learned from a confirmed line matches for certain.
  const learned = [{ ...foods[2], aliases: ["LIMAO REDE 1KG"] }];
  assert.deepEqual(matchLine("limao rede 1kg", learned), { ingredientId: "lemon", confidence: 1 });
});

test("purchases: prices per unit, per shop, cheapest first, and the two-shop saving", () => {
  assert.equal(linePricePerBase({ quantity: 1.21, unit: "kg", price: 6.65 })?.toFixed(5), "0.00550");
  assert.equal(linePricePerBase({ quantity: null, unit: "kg", price: 6.65 }), null);
  const stores = [
    { id: "lidl", name: "Lidl" },
    { id: "cont", name: "Continente" },
  ];
  const prices: PriceRecord[] = [
    { ingredientId: "chicken", storeId: "cont", pricePerBase: 0.00599, date: "2026-09-10", purchaseId: "p1" },
    { ingredientId: "chicken", storeId: "cont", pricePerBase: 0.00579, date: "2026-09-19", purchaseId: "p2" },
    { ingredientId: "chicken", storeId: "lidl", pricePerBase: 0.00549, date: "2026-09-16", purchaseId: null },
    { ingredientId: "chicken", storeId: "lidl", pricePerBase: 0.001, date: "2025-01-01", purchaseId: "old" },
  ];
  const byStore = pricesByStore(prices, "chicken", stores, "2026-09-23");
  assert.deepEqual(
    byStore.map((p) => [p.storeName, p.pricePerBase, p.manual]),
    [
      ["Lidl", 0.00549, true],
      ["Continente", 0.00579, false],
    ]
  );
  const saving = splitShopSaving([
    { baseQuantity: 1000, prices: byStore },
    { baseQuantity: 1, prices: [{ ...byStore[1], pricePerBase: 1.29 }] },
  ]);
  assert.deepEqual(saving, { mainStore: "Continente", otherStores: ["Lidl"], saving: 0.3 });
});

function service() {
  let state: MealsState | null = null;
  const store: MealsStore = {
    load: () => state,
    save: (next) => {
      state = JSON.parse(JSON.stringify(next)) as MealsState;
    },
  };
  return new MealService(store);
}

test("purchases: a purchase waits for review, then goes to prices, the pantry and the list as asked", () => {
  const meals = service();
  const chicken = meals.ensureIngredient("Chicken thighs", "g");
  meals.addShoppingItem({ name: "Chicken thighs", quantity: 1, unit: "kg" });
  const receipt = parseReceiptText(CONTINENTE);
  const purchase = meals.createPurchase({
    source: "photo",
    store: receipt.store,
    date: receipt.date,
    total: receipt.total,
    lines: receipt.lines,
  });
  assert.equal(purchase.status, "review");
  assert.equal(meals.listPantry().length, 0, "nothing moves before you confirm");
  const coxa = purchase.lines.find((line) => line.raw === "COXA FRANGO KG")!;
  assert.equal(coxa.ingredientId, chicken.id);
  assert.equal(coxa.confirmed, false, "read off paper: a guess until checked");

  // Check two lines: the chicken, and the bag as not food. The rest stay unchecked.
  meals.updatePurchaseLine(purchase.id, coxa.id, {});
  const bag = purchase.lines.find((line) => line.raw === "SACO REUT")!;
  meals.updatePurchaseLine(purchase.id, bag.id, { notFood: true });
  const confirmed = meals.confirmPurchase(purchase.id, { prices: true, pantry: true, shopping: true });
  assert.equal(confirmed.status, "imported");

  const pantry = meals.listPantry();
  assert.equal(pantry.length, 1, "only checked food goes into the kitchen");
  assert.equal(pantry[0].quantity, 1.21);
  assert.equal(pantry[0].confidence, "confirmed");
  const state = meals.getState();
  assert.equal(state.prices.length, 1);
  assert.equal(state.stores[0].name, "Continente");
  assert.equal(state.prices[0].storeId, state.stores[0].id);
  assert.equal(state.shopping.length, 0, "the hand-added chicken line is ticked off");
  assert.ok(
    state.ingredients.find((i) => i.id === chicken.id)!.aliases.includes("COXA FRANGO KG"),
    "the line's text is learned"
  );
  assert.throws(() => meals.confirmPurchase(purchase.id, {}), /already confirmed/);

  // Forgetting the purchase forgets its prices; the food stays.
  meals.removePurchase(purchase.id);
  assert.equal(meals.getState().prices.length, 0);
  assert.equal(meals.listPantry().length, 1);
});

test("purchases: prices only keeps the purchase as history, and shopping notes last a week", () => {
  const meals = service();
  const eggs = meals.ensureIngredient("Eggs", "piece");
  const purchase = meals.createPurchase({
    store: "Mercado",
    lines: [{ name: "Eggs", quantity: 12, unit: "piece", price: 2.4 }],
  });
  assert.equal(purchase.lines[0].confirmed, true, "typed lines matched for sure count as checked");
  meals.confirmPurchase(purchase.id, { prices: true, pantry: false, shopping: false });
  assert.equal(meals.listPurchases()[0].status, "history");
  assert.equal(meals.listPantry().length, 0);
  assert.equal(meals.getState().prices[0].pricePerBase, 0.2);

  meals.markShopping(eggs.id, "unavailable");
  assert.equal(meals.shoppingMarks().length, 1);
  meals.markShopping(eggs.id, null);
  assert.equal(meals.shoppingMarks().length, 0);
  assert.throws(() => meals.markShopping(eggs.id, "substitute", {}), /Substitute with what/);
});

test("purchases: the demo brings two shops and two purchases, and takes exactly them back", () => {
  const meals = service();
  meals.ensureStore("Mercado");
  meals.loadDemoData();
  const loaded = meals.getState();
  assert.deepEqual(
    loaded.stores.map((s) => s.name),
    ["Mercado", "Lidl", "Continente"]
  );
  assert.equal(loaded.purchases.length, 2);
  assert.ok(loaded.prices.length >= 4);
  assert.equal(loaded.purchases.filter((p) => p.status === "review").length, 1);
  meals.removeDemoData();
  const after = meals.getState();
  assert.deepEqual(
    after.stores.map((s) => s.name),
    ["Mercado"]
  );
  assert.equal(after.purchases.length, 0);
  assert.equal(after.prices.length, 0);
});

test("purchases: text read off a photo — prices repaired where OCR slips, and no line lost", () => {
  assert.equal(repairOcrLine("LIMAD REDE IKE      1286"), "LIMAD REDE IKE      12,86");
  assert.equal(repairOcrLine("IOG GREGO NAT 4X1256 2,484"), "IOG GREGO NAT 4X1256 2,48");
  assert.equal(repairOcrLine("PAO FORMA      1,O9"), "PAO FORMA      1,09");
  assert.equal(
    repairOcrLine("OVOS CLASSE M 12"),
    "OVOS CLASSE M 12",
    "a single space before a short number is a size"
  );
  // What tesseract made of a rendered test receipt.
  const receipt = parseReceiptText(
    [
      "CONTINENTE HIPERMERCADOS",
      "19-09-2076 18:42",
      "",
      "COXA FRANGO KG      E.B5 6",
      "LIMAD REDE IKE = 1286",
      "IDG GREGO NAT 4X1256 2,484",
      "TOTAL           10,48",
    ].join("\n"),
    { ocr: true }
  );
  assert.equal(receipt.store, "Continente");
  assert.equal(receipt.total, 10.48);
  assert.deepEqual(
    receipt.lines.map((line) => [line.raw, line.price]),
    [
      // Nothing to repair here: kept, with its price left for you to type.
      ["COXA FRANGO KG E.B5 6", null],
      ["LIMAD REDE IKE =", 12.86],
      ["IDG GREGO NAT 4X1256", 2.48],
    ]
  );
});

test("purchases: a new food's name is guessed from the receipt line, amounts dropped", () => {
  assert.deepEqual(foodNameGuesses("COXA FRANGO KG"), ["Chicken thigh", "Coxa frango"]);
  assert.deepEqual(foodNameGuesses("PEITO DE FRANGO 1,210 kg"), ["Chicken breast", "Peito de frango"]);
  assert.deepEqual(foodNameGuesses("IOG. NAT. 4X125G"), ["Iogurte natural"]);
  assert.deepEqual(foodNameGuesses("LTE MG UHT 1L"), ["Leite meio gordo uht"]);
  assert.deepEqual(foodNameGuesses("1,99"), []);
});

test("purchases: a new food takes the name you write, and the receipt's words match it next time", () => {
  const meals = service();
  const lines = [{ name: "BEB SOJA ALPRO 1L", quantity: 1, unit: "l", price: 2.19 }];
  const first = meals.createPurchase({ store: "Continente", lines });
  const line = first.lines[0];
  assert.equal(line.ingredientId, null);
  meals.updatePurchaseLine(first.id, line.id, { newFood: "Soy milk", quantity: 1, unit: "l", price: 2.19 });
  meals.confirmPurchase(first.id, { prices: true, pantry: true, shopping: false });
  const soy = meals.getState().ingredients.find((i) => i.name === "Soy milk")!;
  assert.ok(soy, "named as written by you, not by the receipt");
  assert.ok(soy.aliases.includes("BEB SOJA ALPRO 1L"));
  const second = meals.createPurchase({ store: "Continente", lines });
  assert.equal(second.lines[0].ingredientId, soy.id);
  assert.equal(second.lines[0].confidence, 1);
});
