# Meals

Recipes, what's in the kitchen, and what's being eaten when — the Meals
tab, and `src/meals/` behind it. Everything is on this PC: no service is
called, nothing about your food leaves the machine.

What exists today: **recipes** (typed or imported from a URL), the
**pantry**, **leftovers**, a **plan you fill in yourself**, and the
**shopping list** that falls out of the two. The meal generator, nutrition
lookups, purchases and price history are not built — see
[Not yet](#not-yet). Settings can load **demo data** to try all of it on.

## The three things, and why they're separate

| Thing          | What it is                                                      | Where                       |
| -------------- | --------------------------------------------------------------- | --------------------------- |
| **Ingredient** | A food you buy and cook with ("Chicken thighs")                 | `types.ts`, `mealService.ts` |
| **Pantry item**| How much of it you have, where, and until when                  | `pantry.ts`                 |
| **Leftover**   | Food already cooked, counted in portions                        | `pantry.ts`                 |
| **Recipe**     | What to make, in ingredients and steps — one dish, or several   | `recipes.ts`                |
| **Planned meal**| One meal, in one slot, on one day                              | `plan.ts`                   |

A recipe line and a pantry item both point at the same **ingredient id**,
which is why the app can say "6 of 9 at home". `ensureIngredient` is the
only place a food comes into being: it matches on name and aliases first,
ignoring case, accents and a trailing plural, so "Chicken thighs",
"chicken thigh" and "CHICKEN THIGHS" are one food, not three.

## How an estimate looks

The one visual rule the tab never breaks: **an estimate looks like an
estimate.** Anything NIMBUS worked out is hatched or dashed and carries
"≈" — the pantry bar of estimated stock, the estimated part of a day's
spend column, the "estimated" pill, the header's estimated total.
Anything you confirmed is drawn solid.

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

The cook dialog shows all of this **before** anything moves: planned
servings against what you're actually cooking, what comes out of which
package ("use 900 g · 1.1 kg remains"), and where the extra portions go —
the fridge with its eat-by date or the freezer — optionally straight into
a free lunch or dinner before they have to be eaten.

## Meals of several dishes

A recipe can be **one dish or several**: the traybake in the demo is
"Chicken", "Potatoes" and "Spinach salad". Each ingredient line and each
method step can belong to one of them, and the recipe page groups them
that way, with the dish as a tag on its steps. A recipe with no dishes is
one dish, and every recipe written before this existed stays exactly as
it was. The list filters on **Single dish**, **Multi-dish** and
**Batch-friendly** (made to keep or freeze). Imported recipes arrive as
one list — the recipe data sites publish has no dishes — and the editor
lets you add dishes and move lines between them.

## Photos

A recipe can have a **photo**, chosen in NIMBUS's own file dialog, resized
to at most 1200 px and kept in `%APPDATA%\nimbus\recipe-photos\`. It is
served to the page as `nimbus-cover://recipe/<id>.jpg` — the renderer
never names a path, and the saved recipe can only point at that address.
Recipe cards, the recipe page and today's meal cards show it; without one
they show the design's soft placeholder.

## Cost and nutrition

Both are estimates, and both say what they were worked out from.

- **Cost** uses the last price paid per ingredient, held per base unit
  (€/g, €/ml, €/piece), so package size doesn't matter. Until purchases
  exist, a price is only there if you typed it.
- **Nutrition** uses each ingredient's per-100 g/ml values — calories,
  protein, carbs, fat and fibre. A line counted
  in pieces can't be turned into calories until an ingredient says what
  one piece weighs, so it's listed as missing instead of guessed.

A recipe page says "Nutrition from 8 of 9 ingredients · no data for
parsley" rather than showing a confident wrong number.

## The tab

Six views, all from one snapshot the main process works out
(`nimbus:get-meals`). The layout follows the design mock-up the feature
was drawn from — a hero card for the next meal, panels for the day's
figures, chips for filters, counters above the lists, and grouped tables
for the shopping list and the pantry:

- **Today** — a hero card for the next meal (when to start cooking, its
  cost, and its ingredients beside it, ticked or marked short),
  a card per meal today with what it's waiting on ("Up next", "Reheat",
  "Eaten ✓"), then panels: **nutrition** as dials against the daily
  targets (calories, protein, and carbs and fibre when set), **spend** as a column a day with the budget as a dashed
  line, **what needs eating**, **leftovers**, the shopping total, and the
  week's dinners as a strip.
- **Plan** — a row per meal slot and a column per day for the next week,
  each row with its usual time and what it costs, each day's cost turning
  amber over budget. A cell takes a recipe, leftovers, something you'll
  make, or a night out with its own price, and carries a badge: **↺ 2/3**
  when leftovers feed two of three people, **◦ Pantry** when everything
  it needs is at home (judged at the servings it's cooked for). Nothing
  is generated: you put meals in slots.
- **Recipes** — chips for the meal and for filters (all at home, ≤ 30 min,
  ≤ 2 €/serving, favourites, imported), each with a count, sorted by what's
  at home, time, cost, name or **recently cooked**; cards showing
  time, calories, protein, cost per serving and how much is at home; and a
  recipe page with a **servings stepper** that rescales every amount, the
  ingredients against the pantry — "Home · exp. tmrw", "Home · opened",
  "Home · ≈ est.", or "Buy · 1 kg pack" with the package it last came in —
  **Add missing to shopping**, numbered method steps with their minutes,
  nutrition, where it appears in your plan, and how often you've cooked
  it. The editor shows which known food each line will be ("→ Chicken
  thighs"), or that saving creates a new one.
- **Shopping** — what the week needs that the kitchen hasn't got, why
  each line is there, and **Bought** to put it in the pantry at the price
  you paid.
- **Pantry** — four counters (expiring within 48 h, this week, needing a
  check, confirmed), chips to filter, **Stock check** to walk through every
  estimated item in turn, then a group per place with a bar per item
  showing how much of the package is left, **Correct**, and the prepared
  food and leftovers below, each saying which meal it's scheduled for.
  Correcting takes the amount as you'd say it ("250 g", "3 pcs"), offers
  None left / Half / Full package, and keeps why (estimate was off, used
  outside a recipe, thrown away, found more).
- **Settings** — who eats and how much (a label, a multiplier and a note —
  no profiles), restrictions, dislikes, the meal slots, and a daily budget.

## The shopping list

The list is **derived, not stored**: every time it's opened, the planned
meals for the week are added up, the pantry is taken off, and what's left
is the list ([shopping.ts](../src/meals/shopping.ts)). That has one
property worth the trouble — marking something bought puts it in the
pantry, and the line disappears because the kitchen now covers it. There
is nothing to tick, un-tick or keep in step.

The subtraction happens once across the whole week, not per meal: three
dinners each wanting 200 g of rice need 600 g, and the 500 g in the
cupboard covers all but 100 g — so the list asks for 100 g, not 200 g
three times.

**Bought** also asks what you paid, and turns it into that ingredient's
price per unit (€5.49 for a 1 kg pack is €0.00549 a gram). That is how
recipe costs stop being guesses: every price comes from something you
actually bought. Things no recipe knows about — bin bags, "something for
Sunday" — are added by hand and are the only part of the list that is
stored.

Meals already cooked are left out, and so are optional lines: nobody
shops for a pinch of salt.

## Purchases, shops and prices

**Purchases & imports** keeps what you bought. A purchase is typed in
line by line (receipts and invoices are read in later versions), and each
line is **matched** to one of your foods — by its words, receipt
abbreviations spelled out ("IOG" is iogurte) and common Portuguese food
names understood ("COXA FRANGO" is chicken thighs) — with how sure the
match is. Nothing changes yet: the purchase waits in **review**, where
uncertain lines are outlined and each can be pointed at a food, a new
food, or **not food** (a bag stays in the total, never in the kitchen).

**Confirm import** then applies the lines you checked, to what you tick:
**prices** (per unit, at that shop, on that day), the **pantry** (as
confirmed stock), and the **shopping list** (lines for those foods ticked
off). A line never checked is left out rather than guessed into the
kitchen. Each confirmed line's words become a name for its food, so the
same receipt line matches for certain next time
([purchases.ts](../src/meals/purchases.ts)).

With prices from more than one shop:

- a food **costs** its cheapest recent price (90 days) at any shop, so
  recipe and plan costs follow what you actually pay;
- the **price watch** shows one food's latest price at each shop — typed
  prices dashed, receipt prices solid;
- the shopping list can be grouped **by store**, says where each line is
  cheapest and where the price came from, and how much buying at two
  shops saves over the one that prices most of the list;
- a line **not in the shop** offers fallbacks — a food of the same kind
  that's in the pantry, the next shop, or skipping it this week.

**Bought** on the shopping list asks which shop too, and Today's spend
panel shows what the plan costs against what was actually **spent** this
week and this month (Settings takes a monthly budget). Deleting a purchase
forgets its prices; the food it put in the pantry stays.

## Importing a recipe from a URL

Recipes → **Import from a URL** reads the page's **schema.org Recipe**
metadata — the block of JSON nearly every cooking site publishes for
search engines ([recipeImport.ts](../src/meals/recipeImport.ts)). There
is no scraping, no site-specific parsing and no AI: a page without that
block simply can't be imported, and says so.

What comes back is a **draft in the editor**, never a saved recipe.
Ingredient lines are free text, so each is parsed into an amount, a unit
and a food — "600g chicken thighs, bone in" becomes 600 g of chicken
thighs, "1 1/2 tbsp" and "½ lemon" become numbers, "2-3 sprigs" takes the
larger, "(optional)" and "to taste" mark the line optional. Anything the
parser can't pin down ("a pinch of salt") is flagged in amber for you to
fix before saving, because putting a wrong amount into the pantry quietly
is worse than asking.

The address is the one thing in Meals the renderer names, so the main
process checks it: http(s) only, never a loopback or private-network host
(which would make NIMBUS a way to reach your own network), time-bounded,
and only the first megabyte is read. The page is parsed, never rendered.

## Demo data

Settings → **Load demo data** fills the tab with a kitchen to try it on:
foods with real prices and nutrition, four recipes, a stocked pantry with
something going off tomorrow, leftovers in the fridge, and meals planned
around today — so every state (urgent, soon, estimated, cooked, eating
out) is visible at once.

Everything it creates is recorded by id in `MealsState.demoIds`, so
**Remove demo data** takes out exactly those entries. Your own recipes,
stock and plan are never touched — and a demo ingredient that one of your
own recipes has started using stays, so nothing you wrote loses its
ingredients.

## Where it lives

```
src/meals/            [1] Core — no Electron, no filesystem
  types.ts               Ingredients, recipes, pantry, leftovers, the plan
  units.ts               g / ml / piece, conversion, scaling, formatting
  pantry.ts              Stock summaries, expiry, coverage, deductions
  recipes.ts             Cost, nutrition, timings
  plan.ts                Servings needed, a day's meals, plan cost
  shopping.ts            The plan minus the pantry, plus manual items
  recipeImport.ts        schema.org Recipe metadata into a draft
  demoData.ts            A removable demo kitchen
  mealService.ts         Validation, identity, CRUD and cooking, over a store
src/main/mealStore.ts [2] meals.json (atomic write, set aside if unreadable)
src/meals/names.ts    [1] How food names are compared (shared with the editor)
src/ui/mealsTab.ts    [5] The tab: header, view switch, render
src/ui/meals/         [5] One module per view (today, plan, cook, recipes,
                          shopping, pantry, settings) and common.ts
```

Servings for the household come from the people in Settings: each one's
factor added up and **rounded up** — you can't cook 2.8 portions, and that
rounding is where most leftovers come from.

## Not yet

Deliberately absent, and the order they're planned in:

1. **Nutrition from Open Food Facts** — filling an ingredient's per-100 g
   values by name or barcode, cached locally. Until then, values are
   typed (or come from the demo data), and a recipe says how many of its
   ingredients it could use.
2. **Reading receipts** — invoice PDFs and photographed receipts, read on
   the PC into the same review. The parser for their text exists
   ([receiptText.ts](../src/meals/receiptText.ts)); the reading is next.
3. **The generator** — filling a week against the objectives (use the
   pantry first, use leftovers, save money, quick, high protein) and the
   budget, with the "why this was suggested" explanation. Restrictions,
   dislikes and the budget are already stored for it; nothing filters
   recipes today.
4. **The briefing and Attention** — `meals` already exists as a briefing
   category, unused. "Take the chicken out of the freezer" is the obvious
   first signal.
5. Leftovers scheduled into the plan automatically (by hand, from the
   cook dialog, already works).
