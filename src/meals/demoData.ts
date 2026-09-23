/**
 * A kitchen to try the Meals tab with: a few foods with real prices and
 * nutrition, four recipes, a stocked pantry, leftovers in the fridge, and
 * meals planned around today.
 *
 * It exists to make the tab testable without an evening of typing, so it
 * is built to be **removable**: everything it creates is recorded by id in
 * `MealsState.demoIds`, and "Remove demo data" deletes exactly those and
 * nothing else. Your own food is never touched, even if you added the
 * same ingredient by hand.
 *
 * The dates are relative to the day it's loaded — something going off
 * tomorrow, something next week, leftovers cooked two days ago — so the
 * expiry states and "needs attention" actually show something.
 *
 * Pure: it takes today and an id generator, and returns entries.
 */

import { isoDate, suggestEatBy } from "./pantry";
import type {
  Ingredient,
  Leftover,
  MealSlot,
  NutritionPer100,
  PantryItem,
  PlannedMeal,
  Recipe,
  StoragePlace,
} from "./types";

export interface DemoData {
  ingredients: Ingredient[];
  recipes: Recipe[];
  pantry: PantryItem[];
  leftovers: Leftover[];
  plan: PlannedMeal[];
}

/** Prices are per base unit (€/g, €/ml, €/piece), as purchases record them. */
interface DemoIngredient {
  key: string;
  name: string;
  unit: string;
  category: string;
  price: number | null;
  nutrition: NutritionPer100 | null;
  fridgeDays: number | null;
}

const INGREDIENTS: DemoIngredient[] = [
  {
    key: "chicken",
    name: "Chicken thighs",
    unit: "g",
    category: "Meat",
    price: 0.0055,
    nutrition: { kcal: 209, protein: 26, carbs: 0, fat: 11, fibre: 0 },
    fridgeDays: 2,
  },
  {
    key: "potato",
    name: "Baby potatoes",
    unit: "g",
    category: "Vegetables",
    price: 0.0012,
    nutrition: { kcal: 77, protein: 2, carbs: 17, fat: 0.1, fibre: 2.2 },
    fridgeDays: 20,
  },
  {
    key: "spinach",
    name: "Baby spinach",
    unit: "g",
    category: "Vegetables",
    price: 0.008,
    nutrition: { kcal: 23, protein: 2.9, carbs: 1.4, fat: 0.4, fibre: 2.2 },
    fridgeDays: 4,
  },
  {
    key: "yoghurt",
    name: "Greek yoghurt",
    unit: "g",
    category: "Dairy",
    price: 0.0042,
    nutrition: { kcal: 97, protein: 9, carbs: 3.6, fat: 5, fibre: 0 },
    fridgeDays: 7,
  },
  {
    key: "lemon",
    name: "Lemons",
    unit: "piece",
    category: "Fruit",
    price: 0.35,
    nutrition: null,
    fridgeDays: 14,
  },
  {
    key: "rice",
    name: "Rice",
    unit: "g",
    category: "Cupboard",
    price: 0.0015,
    nutrition: { kcal: 355, protein: 7, carbs: 78, fat: 0.9, fibre: 1.3 },
    fridgeDays: null,
  },
  {
    key: "beans",
    name: "Black beans",
    unit: "tin",
    category: "Cupboard",
    price: 0.89,
    nutrition: null,
    fridgeDays: null,
  },
  {
    key: "mince",
    name: "Minced beef",
    unit: "g",
    category: "Meat",
    price: 0.0079,
    nutrition: { kcal: 250, protein: 26, carbs: 0, fat: 15, fibre: 0 },
    fridgeDays: 2,
  },
  {
    key: "tomatoes",
    name: "Chopped tomatoes",
    unit: "tin",
    category: "Cupboard",
    price: 0.65,
    nutrition: null,
    fridgeDays: null,
  },
  {
    key: "onion",
    name: "Onions",
    unit: "piece",
    category: "Vegetables",
    price: 0.22,
    nutrition: null,
    fridgeDays: 30,
  },
  {
    key: "oats",
    name: "Rolled oats",
    unit: "g",
    category: "Cupboard",
    price: 0.0021,
    nutrition: { kcal: 379, protein: 13, carbs: 67, fat: 7, fibre: 10 },
    fridgeDays: null,
  },
  {
    key: "milk",
    name: "Milk",
    unit: "ml",
    category: "Dairy",
    price: 0.00092,
    nutrition: { kcal: 64, protein: 3.3, carbs: 4.8, fat: 3.6, fibre: 0 },
    fridgeDays: 5,
  },
  {
    key: "oliveoil",
    name: "Olive oil",
    unit: "ml",
    category: "Cupboard",
    price: 0.0072,
    nutrition: { kcal: 884, protein: 0, carbs: 0, fat: 100, fibre: 0 },
    fridgeDays: null,
  },
  {
    key: "parsley",
    name: "Parsley",
    unit: "bunch",
    category: "Herbs",
    price: null,
    nutrition: null,
    fridgeDays: 5,
  },
];

interface DemoRecipe {
  key: string;
  name: string;
  description: string;
  slots: MealSlot[];
  servings: number;
  prep: number;
  cook: number;
  tags: string[];
  lines: Array<[string, number, string] | [string, number, string, "optional"]>;
  steps: string[];
  /** Minutes per step, in step order, where the recipe says. */
  stepMinutes?: Array<number | null>;
  /** Dishes of a multi-dish meal: [key, name]. */
  components?: Array<[string, string]>;
  /** Which dish each ingredient key and each step (by index) belongs to. */
  lineParts?: Record<string, string>;
  stepParts?: string[];
  batch?: boolean;
}

const RECIPES: DemoRecipe[] = [
  {
    key: "traybake",
    name: "Lemon chicken traybake",
    description:
      "Lemon-oregano chicken thighs over roast baby potatoes, with a yoghurt-dressed spinach salad. One tray, one bowl.",
    slots: ["dinner"],
    servings: 3,
    prep: 15,
    cook: 40,
    tags: ["one tray", "high protein"],
    lines: [
      ["chicken", 600, "g"],
      ["potato", 700, "g"],
      ["spinach", 150, "g"],
      ["yoghurt", 150, "g"],
      ["lemon", 2, "piece"],
      ["oliveoil", 30, "ml"],
      ["parsley", 1, "bunch", "optional"],
    ],
    steps: [
      "Heat the oven to 200 °C.",
      "Halve the potatoes, toss with oil, salt and half the lemon, and roast for 15 minutes.",
      "Add the chicken skin-side up and roast for another 25 minutes, until the skin crisps.",
      "Dress the spinach with the yoghurt and the rest of the lemon, and serve alongside.",
    ],
    stepMinutes: [null, 15, 25, 5],
    components: [
      ["chicken", "Chicken"],
      ["potatoes", "Potatoes"],
      ["salad", "Spinach salad"],
    ],
    lineParts: {
      chicken: "chicken",
      lemon: "chicken",
      potato: "potatoes",
      oliveoil: "potatoes",
      spinach: "salad",
      yoghurt: "salad",
      parsley: "salad",
    },
    stepParts: ["potatoes", "potatoes", "chicken", "salad"],
  },
  {
    key: "chilli",
    name: "Chilli con carne",
    description: "The batch-cooking one: enough for tonight and two lunches.",
    slots: ["lunch", "dinner"],
    servings: 6,
    prep: 10,
    cook: 50,
    tags: ["batch", "freezes well"],
    lines: [
      ["mince", 500, "g"],
      ["beans", 2, "tin"],
      ["tomatoes", 2, "tin"],
      ["onion", 2, "piece"],
      ["rice", 300, "g"],
      ["oliveoil", 15, "ml"],
    ],
    steps: [
      "Soften the onions in the oil.",
      "Brown the mince, then add the tomatoes, the drained beans and the spices.",
      "Simmer for 40 minutes while the rice cooks.",
    ],
    stepMinutes: [5, 10, 40],
    batch: true,
  },
  {
    key: "riceandbeans",
    name: "Rice and beans",
    description: "Twenty minutes, all from the cupboard.",
    slots: ["lunch", "dinner"],
    servings: 2,
    prep: 5,
    cook: 20,
    tags: ["quick", "cheap", "pantry"],
    lines: [
      ["rice", 200, "g"],
      ["beans", 1, "tin"],
      ["onion", 1, "piece"],
      ["oliveoil", 15, "ml"],
    ],
    steps: ["Cook the rice.", "Fry the onion, add the beans, and stir it through the rice."],
  },
  {
    key: "oats",
    name: "Porridge",
    description: "Breakfast, four minutes.",
    slots: ["breakfast"],
    servings: 1,
    prep: 1,
    cook: 5,
    tags: ["quick"],
    lines: [
      ["oats", 60, "g"],
      ["milk", 300, "ml"],
    ],
    steps: ["Simmer the oats in the milk for five minutes, stirring."],
  },
];

/** Days from today, and what that day's ISO date is. */
function dayFrom(today: Date, days: number): string {
  return isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
}

/**
 * Builds the demo kitchen. `id` is the generator (the service passes
 * `randomUUID`), `today` the day it's being loaded.
 */
export function buildDemoData(today: Date, id: () => string): DemoData {
  const now = new Date().toISOString();
  const ingredients = new Map<string, Ingredient>();
  for (const entry of INGREDIENTS) {
    ingredients.set(entry.key, {
      id: id(),
      name: entry.name,
      aliases: [],
      unit: entry.unit,
      category: entry.category,
      nutrition: entry.nutrition,
      nutritionSource: entry.nutrition ? "demo" : null,
      lastPrice: entry.price,
      fridgeDays: entry.fridgeDays,
      lastPackaging: null,
      addedAt: now,
      updatedAt: now,
    });
  }

  const recipes = new Map<string, Recipe>();
  for (const entry of RECIPES) {
    const components = (entry.components ?? []).map(([key, name]) => ({ key, id: id(), name }));
    const part = (key: string | undefined) => components.find((c) => c.key === key)?.id ?? null;
    recipes.set(entry.key, {
      id: id(),
      name: entry.name,
      description: entry.description,
      slots: entry.slots,
      servings: entry.servings,
      prepMinutes: entry.prep,
      cookMinutes: entry.cook,
      components: components.map(({ id: componentId, name }) => ({ id: componentId, name })),
      ingredients: entry.lines.map((line) => ({
        ingredientId: ingredients.get(line[0])!.id,
        text: ingredients.get(line[0])!.name.toLowerCase(),
        quantity: line[1] as number,
        unit: line[2] as string,
        optional: line[3] === "optional",
        componentId: part(entry.lineParts?.[line[0]]),
      })),
      steps: entry.steps.map((text, index) => ({
        text,
        minutes: entry.stepMinutes?.[index] ?? null,
        componentId: part(entry.stepParts?.[index]),
      })),
      batch: entry.batch === true,
      photo: null,
      tags: entry.tags,
      source: "demo",
      notes: null,
      favourite: entry.key === "traybake",
      lastCookedAt: null,
      timesCooked: entry.key === "chilli" ? 4 : 0,
      addedAt: now,
      updatedAt: now,
    });
  }

  // A pantry with something urgent, something for next week, and staples
  // that never expire — so every expiry state is visible at once.
  const stock: Array<[string, number, string, StoragePlace, number | null, string | null, boolean]> = [
    ["chicken", 1, "kg", "fridge", 2, "1 kg pack", false],
    ["potato", 2, "kg", "cupboard", null, "2 kg bag", false],
    ["spinach", 200, "g", "fridge", 1, "200 g bag", false],
    ["yoghurt", 250, "g", "fridge", 3, "500 g tub, opened", false],
    ["lemon", 3, "piece", "fridge", 9, null, true],
    ["rice", 1, "kg", "cupboard", null, "1 kg bag", false],
    ["beans", 2, "tin", "cupboard", null, null, false],
    ["tomatoes", 3, "tin", "cupboard", null, null, false],
    ["onion", 4, "piece", "cupboard", null, null, true],
    ["oats", 500, "g", "cupboard", null, "500 g box", false],
    ["milk", 1, "l", "fridge", 4, null, false],
    ["oliveoil", 750, "ml", "cupboard", null, null, false],
    ["mince", 500, "g", "freezer", 60, "frozen", false],
  ];
  const pantry: PantryItem[] = stock.map(([key, quantity, unit, place, expiresIn, packaging, estimated]) => ({
    id: id(),
    ingredientId: ingredients.get(key)!.id,
    name: ingredients.get(key)!.name,
    quantity,
    unit,
    startQuantity: quantity,
    place,
    confidence: estimated ? "estimated" : "confirmed",
    packaging,
    openedAt: packaging !== null && packaging.includes("opened") ? now : null,
    expiresAt: expiresIn === null ? null : dayFrom(today, expiresIn),
    lastCorrection: null,
    addedAt: now,
    updatedAt: now,
  }));

  const cookedOn = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
  const leftovers: Leftover[] = [
    {
      id: id(),
      name: "Chilli con carne",
      recipeId: recipes.get("chilli")!.id,
      portions: 2,
      place: "fridge",
      cookedAt: cookedOn.toISOString(),
      eatBy: suggestEatBy(cookedOn, "fridge"),
      addedAt: now,
      updatedAt: now,
    },
    {
      id: id(),
      name: "Bolognese sauce",
      recipeId: null,
      portions: 4,
      place: "freezer",
      cookedAt: cookedOn.toISOString(),
      eatBy: suggestEatBy(cookedOn, "freezer"),
      addedAt: now,
      updatedAt: now,
    },
  ];

  const planned: Array<[number, MealSlot, string, number, string | null, number | null]> = [
    [0, "breakfast", "oats", 1, "08:00", null],
    [0, "lunch", "leftover:chilli", 2, "13:00", null],
    [0, "dinner", "traybake", 3, "19:30", 5],
    [1, "breakfast", "oats", 1, "08:00", null],
    [1, "lunch", "out:Canteen at work", 1, "13:00", null],
    [1, "dinner", "riceandbeans", 3, "19:30", null],
    [2, "dinner", "chilli", 3, "19:30", 6],
    [3, "lunch", "leftover:chilli", 2, "13:00", null],
    [3, "dinner", "traybake", 3, "20:00", null],
    [4, "dinner", "riceandbeans", 3, "19:30", null],
  ];
  const plan: PlannedMeal[] = planned.map(([offset, slot, what, servings, time, cookServings]) => {
    const isOut = what.startsWith("out:");
    const isLeftover = what.startsWith("leftover:");
    const recipeKey = isOut || isLeftover ? null : what;
    return {
      id: id(),
      date: dayFrom(today, offset),
      slot,
      kind: isOut ? "out" : isLeftover ? "leftover" : "recipe",
      recipeId: recipeKey ? recipes.get(recipeKey)!.id : null,
      leftoverId: isLeftover ? leftovers[0].id : null,
      name: isOut ? what.slice(4) : null,
      servings,
      cookServings,
      time,
      cost: isOut ? 6.5 : null,
      notes: null,
      cookedAt: null,
      addedAt: now,
      updatedAt: now,
    };
  });

  return {
    ingredients: [...ingredients.values()],
    recipes: [...recipes.values()],
    pantry,
    leftovers,
    plan,
  };
}
