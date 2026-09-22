# Meals

Recipes, what's in the kitchen, and what's being eaten when — the Meals
tab, and `src/meals/` behind it. Everything is on this PC: no service is
called, nothing about your food leaves the machine.

This is the first part of a bigger plan. What exists today is the
foundation the rest sits on: **recipes**, the **pantry**, **leftovers**
and a **plan you fill in yourself**. The generator, the shopping list,
receipts and price history are not built — see
[Not yet](#not-yet).

## The three things, and why they're separate

| Thing          | What it is                                                      | Where                       |
| -------------- | --------------------------------------------------------------- | --------------------------- |
| **Ingredient** | A food you buy and cook with ("Chicken thighs")                 | `types.ts`, `mealService.ts` |
| **Pantry item**| How much of it you have, where, and until when                  | `pantry.ts`                 |
| **Leftover**   | Food already cooked, counted in portions                        | `pantry.ts`                 |
| **Recipe**     | What to make, in ingredients and steps                          | `recipes.ts`                |
| **Planned meal**| One meal, in one slot, on one day                              | `plan.ts`                   |

A recipe line and a pantry item both point at the same **ingredient id**,
which is why the app can say "6 of 9 at home". `ensureIngredient` is the
only place a food comes into being: it matches on name and aliases first,
ignoring case, accents and a trailing plural, so "Chicken thighs",
"chicken thigh" and "CHICKEN THIGHS" are one food, not three.

## Confirmed and estimated

The rule the whole pantry is built around: **NIMBUS may do the
arithmetic, but it may never present its own arithmetic as fact.**

- **Confirmed** stock is what you said is there.
- **Estimated** stock is what NIMBUS worked out by subtracting what a
  recipe used when you pressed Cook.

Cooking marks everything it touched as estimated, and the item stays
labelled that way — in the list, and in its own "Estimated" filter —
until you use **Correct** and say what's actually in the cupboard. That
makes it confirmed again, whatever the number, because correcting is the
one moment you actually looked.

## Amounts

Everything is normalised to grams, millilitres or pieces
([units.ts](../src/meals/units.ts)). Weight and volume are deliberately
**never** converted into each other: 100 ml of oil is not 100 g of oil,
and a guessed density would quietly make every cost and calorie wrong. An
amount in a unit that can't be compared is reported as "can't measure"
rather than assumed.

Subtracting keeps the unit you wrote: taking 400 g from a 1 kg pack
leaves "0.6 kg", so the pantry still reads the way the package does.
Scaling a recipe is linear, and a line counted in pieces rounds **up** —
three eggs for two people is five eggs for three, not 4.5.

## Cooking

**Cook** is the one action that changes several things at once:

1. It takes the ingredients out of the pantry, using the package that
   **expires first** — the thing a person does without thinking, and
   which a naive "first item in the list" would get wrong.
2. Anything it couldn't cover is reported ("short of: lemons"), never
   invented or left silently negative.
3. Portions cooked but not eaten become **leftovers**, with an eat-by
   date: three days in the fridge, three months in the freezer, counted
   from today — the conservative end of the usual advice.
4. The planned meal is marked cooked, and the recipe's "cooked 4 times"
   goes up.

**Don't touch the pantry** skips step 1, for when you cooked from
something you had never recorded.

## Cost and nutrition

Both are estimates, and both say what they were worked out from.

- **Cost** uses the last price paid per ingredient, held per base unit
  (€/g, €/ml, €/piece), so package size doesn't matter. Until purchases
  exist, a price is only there if you typed it.
- **Nutrition** uses each ingredient's per-100 g/ml values. A line counted
  in pieces can't be turned into calories until an ingredient says what
  one piece weighs, so it's listed as missing instead of guessed.

A recipe page says "Nutrition from 8 of 9 ingredients · no data for
parsley" rather than showing a confident wrong number.

## The tab

Five views, all from one snapshot the main process works out
(`nimbus:get-meals`):

- **Today** — the next meal (with when to start cooking, its cost and how
  much of it is at home), today's meals, what needs eating first, and what
  the next seven days cost against the budget.
- **Plan** — a column per day for the next week, a cell per meal slot.
  A cell takes a recipe, leftovers, something you'll make, or a night out
  with its own price. Nothing is generated: you put meals in slots.
- **Recipes** — the library, sorted by how much of each is at home
  (default), quickest, cheapest or by name, with a page per recipe and an
  editor.
- **Pantry** — stock by food with its expiry state, filters (place,
  expiring, estimated), **Correct**, and the leftovers list.
- **Settings** — who eats and how much (a label, a multiplier and a note —
  no profiles), restrictions, dislikes, the meal slots, and a daily budget.

## Where it lives

```
src/meals/            [1] Core — no Electron, no filesystem
  types.ts               Ingredients, recipes, pantry, leftovers, the plan
  units.ts               g / ml / piece, conversion, scaling, formatting
  pantry.ts              Stock summaries, expiry, coverage, deductions
  recipes.ts             Cost, nutrition, timings
  plan.ts                Servings needed, a day's meals, plan cost
  mealService.ts         Validation, identity, CRUD and cooking, over a store
src/main/mealStore.ts [2] meals.json (atomic write, set aside if unreadable)
src/ui/mealsTab.ts    [5] The tab
```

Servings for the household come from the people in Settings: each one's
factor added up and **rounded up** — you can't cook 2.8 portions, and that
rounding is where most leftovers come from.

## Not yet

Deliberately absent, and the order they're planned in:

1. **Shopping list** — what the plan needs that the pantry doesn't cover.
   The arithmetic already exists (`coverRecipe`, `planDeductions` report
   exactly this); it needs a list, manual items and ticking off.
2. **Recipe import from a URL** — reading a page's recipe metadata
   (schema.org JSON-LD) into the editor for checking before saving.
3. **Nutrition from Open Food Facts** — filling an ingredient's per-100 g
   values by name or barcode, cached locally.
4. **Purchases and prices** — typed purchases first, then digital PDF
   invoices parsed on the PC; price-per-store history and a price watch
   come from those records. Photographs of receipts need OCR, which
   NIMBUS has no engine for.
5. **The generator** — filling a week against the objectives (use the
   pantry first, use leftovers, save money, quick, high protein) and the
   budget, with the "why this was suggested" explanation. Restrictions,
   dislikes and the budget are already stored for it; nothing filters
   recipes today.
6. **The briefing and Attention** — `meals` already exists as a briefing
   category, unused. "Take the chicken out of the freezer" is the obvious
   first signal.
