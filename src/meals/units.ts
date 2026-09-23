/**
 * Amounts of food, and the arithmetic that keeps them honest.
 *
 * A recipe asks for "300 g chicken", a receipt says "1 kg pack" and a
 * spoon measure says "2 tbsp olive oil". All of it has to add up when
 * cooking deducts from the pantry, so every amount is normalised to one of
 * three base units: **grams** for weight, **millilitres** for volume, and
 * **pieces** for things counted (eggs, lemons, tins).
 *
 * Weight and volume are deliberately *not* converted into each other:
 * 100 ml of oil is not 100 g of oil, and guessing a density would quietly
 * make every cost and calorie wrong. An amount in a unit the pantry can't
 * compare is left alone and reported as unknown instead.
 *
 * Pure: no I/O, no dates, no settings.
 */

export type BaseUnit = "g" | "ml" | "piece";

export interface Amount {
  quantity: number;
  unit: string;
}

/** Everything a quantity can be written in, and what one of it is in base units. */
const UNITS: Record<string, { base: BaseUnit; factor: number; label: string }> = {
  g: { base: "g", factor: 1, label: "g" },
  kg: { base: "g", factor: 1000, label: "kg" },
  mg: { base: "g", factor: 0.001, label: "mg" },
  ml: { base: "ml", factor: 1, label: "ml" },
  cl: { base: "ml", factor: 10, label: "cl" },
  dl: { base: "ml", factor: 100, label: "dl" },
  l: { base: "ml", factor: 1000, label: "l" },
  // Spoons and cups are volume. The usual metric kitchen values.
  tsp: { base: "ml", factor: 5, label: "tsp" },
  tbsp: { base: "ml", factor: 15, label: "tbsp" },
  cup: { base: "ml", factor: 240, label: "cup" },
  piece: { base: "piece", factor: 1, label: "×" },
  // Packaging sold as one thing: counted, like pieces.
  pack: { base: "piece", factor: 1, label: "pack" },
  tin: { base: "piece", factor: 1, label: "tin" },
  bunch: { base: "piece", factor: 1, label: "bunch" },
  clove: { base: "piece", factor: 1, label: "clove" },
  slice: { base: "piece", factor: 1, label: "slice" },
};

/** What the same unit can be written as — "gram", "grams", "gr" all mean g. */
const ALIASES: Record<string, string> = {
  gram: "g",
  grams: "g",
  gr: "g",
  gramas: "g",
  grama: "g",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  quilo: "kg",
  milligram: "mg",
  milligrams: "mg",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  litro: "l",
  litros: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cups: "cup",
  pieces: "piece",
  unit: "piece",
  units: "piece",
  un: "piece",
  x: "piece",
  packs: "pack",
  packet: "pack",
  package: "pack",
  tins: "tin",
  can: "tin",
  cans: "tin",
  bunches: "bunch",
  cloves: "clove",
  slices: "slice",
};

/** The units a user can pick, in the order they're offered. */
export const KNOWN_UNITS = Object.keys(UNITS);

/** "KG", "Kilos", " g " → "kg", "kg", "g"; anything unrecognised → null. */
export function normaliseUnit(unit: unknown): string | null {
  if (typeof unit !== "string") return null;
  const key = unit.trim().toLowerCase().replace(/\.$/, "");
  if (!key) return null;
  const resolved = ALIASES[key] ?? key;
  return resolved in UNITS ? resolved : null;
}

/** Which of the three base units something is measured in. */
export function baseUnit(unit: string): BaseUnit | null {
  const resolved = normaliseUnit(unit);
  return resolved ? UNITS[resolved].base : null;
}

/** How a unit is written next to a number: "300 g", "2 ×". */
export function unitLabel(unit: string): string {
  const resolved = normaliseUnit(unit);
  return resolved ? UNITS[resolved].label : unit;
}

/**
 * An amount in base units, or null when the unit isn't one NIMBUS knows.
 * This is what pantry stock, recipe needs and purchases are compared in.
 */
export function toBase(amount: Amount): { quantity: number; unit: BaseUnit } | null {
  const resolved = normaliseUnit(amount.unit);
  if (!resolved || !Number.isFinite(amount.quantity)) return null;
  const { base, factor } = UNITS[resolved];
  return { quantity: amount.quantity * factor, unit: base };
}

/** Two amounts can be added or subtracted only within the same base unit. */
export function comparable(a: Amount, b: Amount): boolean {
  const left = toBase(a);
  const right = toBase(b);
  return left !== null && right !== null && left.unit === right.unit;
}

/**
 * `a` minus `b`, in `a`'s own unit, clamped at zero — taking 400 g from a
 * 1 kg pack leaves "0.6 kg", not "600 g", so the pantry keeps reading the
 * way the package does. Null when the two can't be compared.
 */
export function subtract(a: Amount, b: Amount): Amount | null {
  const left = toBase(a);
  const right = toBase(b);
  if (!left || !right || left.unit !== right.unit) return null;
  const remaining = Math.max(0, left.quantity - right.quantity);
  const factor = UNITS[normaliseUnit(a.unit)!].factor;
  return { quantity: round(remaining / factor), unit: normaliseUnit(a.unit)! };
}

/** `a` plus `b`, in `a`'s unit. Null when they can't be compared. */
export function add(a: Amount, b: Amount): Amount | null {
  const left = toBase(a);
  const right = toBase(b);
  if (!left || !right || left.unit !== right.unit) return null;
  const factor = UNITS[normaliseUnit(a.unit)!].factor;
  return { quantity: round((left.quantity + right.quantity) / factor), unit: normaliseUnit(a.unit)! };
}

/** Rounded to three decimals: enough for 0.5 tsp, short of floating-point noise. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The same amount written the way a person would: 1500 g → "1.5 kg",
 * 0.5 kg → "500 g", 2 piece → "2". Only within one base unit.
 */
export function formatAmount(amount: Amount, locale = "en"): string {
  const resolved = normaliseUnit(amount.unit);
  const base = resolved ? toBase(amount) : null;
  if (!resolved || !base) return `${number(amount.quantity, locale)} ${amount.unit}`.trim();
  if (base.unit === "piece") {
    const label = UNITS[resolved].label;
    return label === "×" ? `${number(base.quantity, locale)}` : `${number(base.quantity, locale)} ${label}`;
  }
  const big = base.unit === "g" ? "kg" : "l";
  if (Math.abs(base.quantity) >= 1000) return `${number(base.quantity / 1000, locale)} ${big}`;
  return `${number(base.quantity, locale)} ${base.unit}`;
}

function number(value: number, locale: string): string {
  const rounded = round(value);
  return rounded.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/**
 * The amount a recipe written for `base` servings needs for `wanted`.
 * Scaling is linear — the honest simplification; it says "about" everywhere
 * it's shown, and whole eggs get rounded up rather than asking for 1.5.
 */
export function scaleAmount(amount: Amount, base: number, wanted: number): Amount {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(wanted) || wanted <= 0) return amount;
  // The recipe's own servings are the recipe as written, untouched.
  if (wanted === base) return { quantity: amount.quantity, unit: amount.unit };
  return practicalAmount({ quantity: (amount.quantity * wanted) / base, unit: amount.unit });
}

/**
 * A scaled amount as you'd actually measure it: whole pieces (rounded up —
 * nobody cooks 2.4 chicken breasts), spoons to the half, cups to the
 * quarter, and grams and millilitres in steps that grow with the amount —
 * 1 under 10, 5 under 100, 10 under a kilo, 50 above — never below one
 * step. No 0.1 g of meat.
 */
export function practicalAmount(amount: Amount): Amount {
  const unit = normaliseUnit(amount.unit);
  if (!unit || !Number.isFinite(amount.quantity) || amount.quantity <= 0) return amount;
  const def = UNITS[unit];
  if (def.base === "piece")
    return { quantity: Math.max(1, Math.ceil(round(amount.quantity))), unit: amount.unit };
  const spoonStep: Record<string, number> = { tsp: 0.5, tbsp: 0.5, cup: 0.25 };
  if (spoonStep[unit]) {
    const step = spoonStep[unit];
    return { quantity: Math.max(step, Math.round(amount.quantity / step) * step), unit: amount.unit };
  }
  const base = amount.quantity * def.factor;
  const step = base < 10 ? 1 : base < 100 ? 5 : base < 1000 ? 10 : 50;
  const rounded = Math.max(step, Math.round(base / step) * step);
  return { quantity: round(rounded / def.factor), unit: amount.unit };
}
