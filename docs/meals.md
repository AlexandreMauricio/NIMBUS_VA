# Meals

Recipes, what's in the kitchen, and what's being eaten when — the Meals
tab, and `src/meals/` behind it. Everything is on this PC: no service is
called, nothing about your food leaves the machine.

What exists today: **recipes** (typed or imported from a URL), the
**pantry**, **leftovers**, a **plan** — filled in yourself or proposed by
the [planner](#the-planner) — the **shopping list** that falls out of the
two, and **purchases** with prices per shop. Nutrition lookups are not
built — see [Not yet](#not-yet). Household can load **demo data** to try
all of it on.

## The three things, and why they're separate

| Thing            | What it is                                                    | Where                        |
| ---------------- | ------------------------------------------------------------- | ---------------------------- |
| **Ingredient**   | A food you buy and cook with ("Chicken thighs")               | `types.ts`, `mealService.ts` |
| **Pantry item**  | How much of it you have, where, and until when                | `pantry.ts`                  |
| **Leftover**     | Food already cooked, counted in portions                      | `pantry.ts`                  |
| **Recipe**       | What to make, in ingredients and steps — one dish, or several | `recipes.ts`                 |
| **Planned meal** | One meal, in one slot, on one day                             | `plan.ts`                    |

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

## Batches and leftovers

A meal has two numbers: how many are **eating** (from Household, or 12
when family is over) and how much it **cooks** — the recipe as written
unless you move it, never less than who's eating. Rice and beans written
for 5 cooks 5 for the 2 of you; the other 3 are leftovers.

- **The servings slider** (plan editor and cook dialog) moves how much is
  cooked, with every ingredient line following it, rounded to amounts
  you'd measure ([units.ts](../src/meals/units.ts) `practicalAmount`):
  whole pieces rounded up, spoons to the half, grams and millilitres in
  steps of 1 / 5 / 10 / 50 as the amount grows — never 0.1 g of meat. The
  recipe's own servings are left exactly as written.
- **The extra portions are planned**: into the next free lunches and
  dinners within three days, as many as eat each time — 3 extra for 2
  people is 2 at the next meal and 1 at the one after. That last one
  doesn't feed everyone, so the planner puts **something alongside** in
  the same meal for the rest (the grid shows it under the leftovers), and
  prefers something small rather than another big batch.
- Leftovers planned from a meal not cooked yet point at that meal;
  **cooking it** makes them real leftovers and gives each planned meal its
  share, in order, as far as what was actually cooked goes. Removing or
  replacing the meal takes its planned leftovers (and what was alongside
  them) with it.
- The cook dialog offers to **spread** new leftovers over the next free
  meals, one meal, or none; "Plan leftovers automatically" in Household
  picks the spread for you.
- Costs follow the batch: the meal costs what cooking all of it costs,
  its leftovers cost nothing, and a day's budget counts only the servings
  eaten that day.

## Frozen bags

Meat bought in bulk goes into the freezer in bags, and a bag is defrosted
**whole** ([freezer.ts](../src/meals/freezer.ts)).

- In the purchase review, a line of meat or fish (or anything set to go to
  the freezer) offers **how to bag it** — one bag, bags the size your planned meals use, or
  singles — and says which fits your meals ("2 bags of 3 · fits your
  meals" when two planned dinners use 3 each). Choosing one sends it to
  the freezer as that many pantry items, each marked as a bag.
- Cooking takes a bag **all at once**: a recipe needing 2 chicken breasts,
  with 6 in one bag, uses all 6. So a meal planned with it **cooks enough
  for the whole bag** (6 servings instead of 2), and the extra is planned
  as leftovers like any batch. Meals planned earlier are counted first,
  so two meals don't both count on the same bag.
- The cook dialog shows a bag's surplus and offers "Cook 6 servings to use
  the whole bag".
- **Needs attention** on Today says what to take out of the freezer: tonight
  for tomorrow's meals, now for today's.

## Food families

Some foods stand in for others: soy milk for milk, a brand of passata for
passata. A food can **count as** a more general one (click its name in the
pantry, or choose it when a receipt line becomes a new food). Then:

- a recipe line asking for **Milk** is covered by milk, soy milk, or both
  together — for "at home", the shopping list and cooking;
- a line asking for **Soy milk** takes only soy milk;
- in the pantry they stay separate items, each with its own amount.

When more than one food of the family is at home, the cook dialog asks
which to use (the one the recipe names is offered first). Families are one
level deep: pointing Soy milk at Plant milk, which counts as Milk, points
it at Milk.

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
  it needs is at home (judged at the servings it's cooked for), **€ −3,10**
  when the planner swapped it in to save money, **✎ Your pick** beside the
  planner's own. Above the grid, the [planner](#the-planner)'s controls;
  a click on any meal opens the **replace drawer**.
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
- **Household** — who eats and how much (a label, a multiplier and a note —
  no profiles), budgets and targets, what happens when a plan goes over,
  restrictions and dislikes as chips, the meal slots, and the planning
  defaults: cooking time on weekdays and weekends, difficulty, default
  objectives, "plan leftovers automatically" and max repeats a week.

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
line by line, or read from an **invoice PDF** or a **receipt photo** —
chosen in NIMBUS's own dialog and read on this PC (the PDF's text with
pdfjs, the photo with tesseract.js and its bundled Portuguese model),
then parsed the same way typed text is ([receiptText.ts](../src/meals/receiptText.ts): weights,
multiples, discounts, and the header, total, VAT and payment lines left
out). OCR on thermal paper is rough, so a photo's lines all arrive
unchecked, the usual misreads of a price are repaired ("1286" is 12,86),
and a line whose price couldn't be read is kept for you to fill in
rather than dropped. Each line is **matched** to one of your foods — by its words, receipt
abbreviations spelled out ("IOG" is iogurte) and common Portuguese food
names understood ("COXA FRANGO" is chicken thighs) — with how sure the
match is. Nothing changes yet: the purchase waits in **review**, where
uncertain lines are outlined and each can be pointed at a food, a new
food, or **not food** (a bag stays in the total, never in the kitchen).
A **new food** is named by you: receipts shorten and spell things every
way, so the box starts from a guess — the amounts dropped, the
abbreviations spelled out, and the English when every word is known
("COXA FRANGO KG" offers "Chicken thigh" or "Coxa frango") — and you
write what it really is. Typing the name of a food you already have
links the line to it instead.

**Confirm import** then applies the lines you checked (✓ only checks a
line — nothing moves before this), to what you tick: **prices** (per
unit, at that shop, on that day), the **pantry** (as confirmed stock),
and the **shopping list** (lines for those foods ticked off). Each line
says where it **goes to** — cupboard, fridge or freezer — guessed as the
freezer when the line says frozen ("congelado"), else wherever that food
already is, else the fridge for milk, yoghurt, cheese, meat and fish
(long-life "UHT" stays in the cupboard), else the cupboard; you change it
before confirming. In the fridge, a food with a known keeping time gets
an eat-by date. A line never checked is left out rather than guessed into the
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
week and this month (Household takes a monthly budget). Any purchase can
be deleted from the history (✕): its prices are forgotten, and — ticked
by default — what it put in the pantry comes out again, as much as it
added, from the item it went into (for a purchase typed by mistake or
made to try things).

## The planner

`src/meals/generator.ts`, pure and deterministic: the same kitchen and
the same days always give the same plan, and nothing is asked of a model.
The controls bar above the plan says what to fill — 1 day, 3 days or a
week, how many are eating, which meals, a budget per day or for the whole
plan, and the objectives — and anything left alone comes from Household.

1. **What stays.** Anything in those days you placed yourself ("Your
   pick"), locked, or already cooked is kept and counted.
2. **Leftovers first.** With "use leftovers", each unscheduled leftover
   goes into the earliest free lunch or dinner before its eat-by date,
   saying how far it goes ("Only covers 2 of 3 — 1 more portion needed").
3. **Rules that are never broken.** Restrictions (matched against the
   recipe's foods, their categories and its tags), the cooking-time limit
   for weekdays or weekends, the difficulty, and max repeats a week. A
   slot stays empty rather than break one.
4. **A score for the rest**, each part written down as a reason: the share
   of ingredients at home, food expiring within 48 h or the week, cost
   against what's left of the day's budget, quick / easy / high protein
   when asked, **favourites +0.8**, **a penalty for recipes planned or
   cooked in the last few days**, and dislikes pushing a recipe right down.
   The best goes in, the pantry is used up as it goes, and the next slot
   is scored against what's left.
5. **Over budget.** With "swap in cheaper meals", the planner's dearest
   choices are swapped for the cheapest that still fit, each marked
   "Budget swap: −3,10 €". What's still over becomes the banner's fixes:
   raise the budget to the cost, allow repeats, or swap a named meal.

The result is a **proposal** — dashed, "Proposed · not yet accepted",
with its cost, pantry lines used, leftovers placed and lines to buy — kept
in `meals.json` until **Accept plan** (which replaces only the planner's
own earlier meals in those days) or **Discard**.

**The replace drawer** opens from any meal (and from Today's **Swap**): why
it was suggested, how far leftovers go and what's all at home to go with
them, then three tabs — **Suggestions** (the best three), **My recipes**
(fits budget, uses pantry, favourites; recipes a rule would normally keep
out are shown with why), and **Custom meal** (eating out, takeaway, at
friends', skip, or something you'll make — its ingredients can go on the
shopping list and it can be saved as a recipe). **Effect of replacing**
shows the plan's cost before and after and what the shopping list gains or
loses. **Regenerate this slot** takes the next-best recipe; **Lock** keeps
a meal through every regenerate. Whatever you choose is your pick.

When a recipe that's planned is edited, the editor asks whether the
planned meals follow the edit or **keep the version they were planned
with** (snapshotted as a meal of their own, with the cost it had).

With **plan leftovers automatically** on, the cook dialog preselects the
next free slot for the extra portions.

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

Household → **Load demo data** fills the tab with a kitchen to try it on:
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
  generator.ts           The planner: proposals, replace options, effects
  shopping.ts            The plan minus the pantry, plus manual items
  recipeImport.ts        schema.org Recipe metadata into a draft
  demoData.ts            A removable demo kitchen
  mealService.ts         Validation, identity, CRUD and cooking, over a store
src/main/mealStore.ts [2] meals.json (atomic write, set aside if unreadable)
src/meals/names.ts    [1] How food names are compared (shared with the editor)
src/ui/mealsTab.ts    [5] The tab: header, view switch, render
src/ui/meals/         [5] One module per view (today, plan, cook, recipes,
                          shopping, pantry, purchases, replace, settings)
                          and common.ts
```

Servings for the household come from the people in Household: each one's
factor added up and **rounded up** — you can't cook 2.8 portions, and that
rounding is where most leftovers come from.

## Not yet

Deliberately absent, and the order they're planned in:

1. **Nutrition from Open Food Facts** — filling an ingredient's per-100 g
   values by name or barcode, cached locally. Until then, values are
   typed (or come from the demo data), and a recipe says how many of its
   ingredients it could use.
2. **Scanned PDFs** — a PDF that is only a picture is refused with a
   note to upload it as a photo; reading its pages as images directly
   would join them up.
3. **The briefing and Attention** — `meals` already exists as a briefing
   category, unused. "Take the chicken out of the freezer" is the obvious
   first signal.
4. **Side dishes as meals of their own** — the replace drawer names what's
   all at home to go with leftovers that don't feed everyone, but adding
   one puts it in its own slot rather than beside the leftovers.
