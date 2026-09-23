/**
 * Reading a recipe off a web page.
 *
 * Nearly every cooking site publishes its recipes as **schema.org
 * Recipe** metadata — a block of JSON in the page for search engines. So
 * there is no scraping, no guessing at the site's HTML and no AI here:
 * the block is read, and a page without one simply can't be imported.
 *
 * What comes back is a **draft**, never a saved recipe. Ingredient lines
 * are free text ("2 tbsp olive oil", "1 ½ lemons, juiced"), so each is
 * parsed into an amount, a unit and a name, and anything the parser is
 * unsure about is marked for the user to check in the editor before
 * saving. Getting this wrong quietly would put nonsense in the pantry.
 *
 * Pure: the caller fetches the page (the main process does, so the
 * renderer never names a URL that gets fetched with its own permissions).
 */

import { normaliseUnit } from "./units";
import type { MealSlot } from "./types";

export interface ImportedIngredient {
  /** The line as written on the page. */
  text: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  optional: boolean;
  /** Why this line needs a look: no amount found, or a unit NIMBUS can't measure. */
  warning: string | null;
}

export interface ImportedRecipe {
  name: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: ImportedIngredient[];
  steps: string[];
  slots: MealSlot[];
  source: string;
  /** How many lines need checking before saving. */
  needsChecking: number;
}

/** Fractions as recipes write them, including the single characters. */
const FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅙": 1 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

/** "1 1/2", "1½", "½", "2.5", "2,5" → a number, and what's left of the text. */
function readQuantity(text: string): { quantity: number | null; rest: string } {
  let rest = text.trim();
  let quantity: number | null = null;
  // A range ("2-3 apples") takes the larger: better a spare apple than a short recipe.
  const range = /^(\d+(?:[.,]\d+)?)\s*(?:-|–|to)\s*(\d+(?:[.,]\d+)?)/.exec(rest);
  if (range) {
    quantity = Math.max(Number(range[1].replace(",", ".")), Number(range[2].replace(",", ".")));
    return { quantity, rest: rest.slice(range[0].length).trim() };
  }
  const whole = /^(\d+(?:[.,]\d+)?)/.exec(rest);
  if (whole) {
    quantity = Number(whole[1].replace(",", "."));
    rest = rest.slice(whole[0].length).trim();
  }
  const written = /^(\d+)\s*\/\s*(\d+)/.exec(rest);
  if (written) {
    const value = Number(written[1]) / Number(written[2]);
    quantity = (quantity ?? 0) + value;
    rest = rest.slice(written[0].length).trim();
  } else if (rest && FRACTIONS[rest[0]] !== undefined) {
    quantity = (quantity ?? 0) + FRACTIONS[rest[0]];
    rest = rest.slice(1).trim();
  }
  return { quantity: quantity === null ? null : Math.round(quantity * 1000) / 1000, rest };
}

const OPTIONAL_HINTS = /\b(to taste|optional|for garnish|to serve|if you like|q\.?b\.?)\b/i;

/**
 * One ingredient line into an amount, a unit and a food.
 *
 * "1 lemon" has no unit and is one piece; "a pinch of salt" has no amount
 * at all and is flagged rather than turned into a number.
 */
export function parseIngredientLine(line: string): ImportedIngredient {
  const text = line.replace(/\s+/g, " ").trim();
  const optional = OPTIONAL_HINTS.test(text);
  const withoutNote = text
    .replace(/\(([^)]*)\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const { quantity, rest } = readQuantity(withoutNote);
  let unit: string | null = null;
  let name = rest;
  const firstWord = /^([A-Za-zÀ-ÿ.]+)\b/.exec(rest);
  if (firstWord) {
    const candidate = normaliseUnit(firstWord[1]);
    if (candidate) {
      unit = candidate;
      name = rest.slice(firstWord[0].length).trim();
    }
  }
  // "200 g of flour" and "a pinch of salt" both keep the food, not the grammar.
  name = name
    .replace(/^of\s+/i, "")
    .replace(/^(a|an|some)\s+/i, "")
    .replace(/^[,\s]+/, "");
  // Everything after the first comma is preparation, not the food:
  // "chicken thighs, bone in" is chicken thighs.
  const food = name.split(",")[0].trim() || name.trim();

  let warning: string | null = null;
  if (quantity === null && !optional) warning = "No amount found";
  else if (!unit && quantity !== null) unit = "piece";
  if (!food) warning = "No ingredient found";

  return {
    text,
    name: food,
    quantity,
    unit,
    optional,
    warning,
  };
}

/** An ISO 8601 duration ("PT1H30M") in minutes — how schema.org writes times. */
export function durationMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(value.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.name === "string") return record.name.trim();
  }
  return null;
}

/** "4 servings", "Serves 4", 4 → 4. */
function readServings(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : firstString(value);
  if (!text) return null;
  const match = /(\d+)/.exec(text);
  if (!match) return null;
  const servings = Number(match[1]);
  return servings > 0 && servings <= 100 ? servings : null;
}

/** Instructions can be strings, HowToStep objects, or HowToSections of those. */
function readSteps(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string")
    return value
      .split(/\n+/)
      .map((step) => stripTags(step).trim())
      .filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((entry) => readSteps(entry, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.itemListElement) return readSteps(record.itemListElement, depth + 1);
    const text = firstString(record.text ?? record.name);
    return text ? [stripTags(text)] : [];
  }
  return [];
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Which meal a page's category suggests — only when it's unmistakable. */
function readSlots(value: unknown): MealSlot[] {
  const text = (firstString(value) ?? "").toLowerCase();
  const slots: MealSlot[] = [];
  if (/breakfast|brunch|pequeno-almoço/.test(text)) slots.push("breakfast");
  if (/lunch|almoço/.test(text)) slots.push("lunch");
  if (/dinner|main|supper|jantar/.test(text)) slots.push("dinner");
  if (/dessert|sobremesa|cake|pudding/.test(text)) slots.push("dessert");
  if (/snack|starter|appetizer/.test(text)) slots.push("snack");
  return slots;
}

/** Every JSON-LD block in a page, flattened through @graph and arrays. */
function jsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    let parsed: unknown;
    try {
      // A leading byte-order mark would make JSON.parse throw on a valid block.
      const block = match[1].trim();
      parsed = JSON.parse(block.charCodeAt(0) === 0xfeff ? block.slice(1) : block);
    } catch {
      continue; // A malformed block is skipped; another one may still carry the recipe.
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const entry = queue.shift();
      if (Array.isArray(entry)) queue.push(...entry);
      else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        objects.push(record);
        if (record["@graph"]) queue.push(record["@graph"]);
      }
    }
  }
  return objects;
}

function isRecipe(record: Record<string, unknown>): boolean {
  const type = record["@type"];
  if (typeof type === "string") return type.toLowerCase() === "recipe";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase() === "recipe");
  return false;
}

/**
 * The recipe in a page, or null when there isn't one NIMBUS can read.
 * `url` is only used as the recipe's source.
 */
export function parseRecipePage(html: string, url: string): ImportedRecipe | null {
  const recipe = jsonLdObjects(html).find(isRecipe);
  if (!recipe) return null;
  const name = firstString(recipe.name);
  if (!name) return null;
  const rawIngredients = Array.isArray(recipe.recipeIngredient)
    ? recipe.recipeIngredient
    : Array.isArray(recipe.ingredients)
      ? recipe.ingredients
      : [];
  const ingredients = rawIngredients
    .map((line) => (typeof line === "string" ? stripTags(line) : firstString(line)))
    .filter((line): line is string => Boolean(line))
    .slice(0, 60)
    .map(parseIngredientLine);
  const description = firstString(recipe.description);
  return {
    name: stripTags(name),
    description: description ? stripTags(description).slice(0, 2000) : null,
    servings: readServings(recipe.recipeYield),
    prepMinutes: durationMinutes(recipe.prepTime),
    cookMinutes: durationMinutes(recipe.cookTime) ?? durationMinutes(recipe.totalTime),
    ingredients,
    steps: readSteps(recipe.recipeInstructions).slice(0, 60),
    slots: [...new Set(readSlots(recipe.recipeCategory))],
    source: url,
    needsChecking: ingredients.filter((line) => line.warning !== null).length,
  };
}

/**
 * An amount typed as text — "250 g", "1,5 kg", "3 pcs", "½" — or null when
 * there's no number in it. A number with no unit is counted in pieces.
 */
export function parseAmountText(value: string): { quantity: number; unit: string } | null {
  const parsed = parseIngredientLine(value.replace(/(\d),(\d)/g, "$1.$2"));
  if (parsed.quantity === null) return null;
  return { quantity: parsed.quantity, unit: parsed.unit ?? "piece" };
}
