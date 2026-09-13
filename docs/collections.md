# Collections

The things you collect and play outside the computer, starting with
**trading card games**. Code: [src/collections/](../src/collections/),
stored by [src/main/collectionStore.ts](../src/main/collectionStore.ts),
shown in the **Collections** tab.

## Two halves, kept apart

- **A catalog per game** answers one question: "which cards match this
  name?". Catalogs are read-only public card databases with no account.
  Only the text you search for is sent to them.
- **Your collection** lives in `%APPDATA%\nimbus\collection.json` and is
  never sent anywhere.

| Game                 | Catalog                                         | Key | Notes                                                                                                 |
| -------------------- | ----------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------- |
| Magic: The Gathering | [Scryfall](https://scryfall.com/docs/api)       | No  | Every printing; prices prefer Cardmarket EUR, then USD                                                |
| Pokémon TCG          | [TCGdex](https://tcgdex.dev)                    | No  | Chosen over pokemontcg.io, which returned a 502 when checked. Search results carry no rarity or price |
| Yu-Gi-Oh!            | [YGOPRODeck](https://ygoprodeck.com/api-guide/) | No  | One result per set printing (set code + rarity)                                                       |
| Disney Lorcana       | [Lorcast](https://lorcast.com/docs/api)         | No  | Names include the version ("Elsa — Concerned Sister")                                                 |
| One Piece Card Game  | [OPTCG API](https://optcgapi.com)               | No  | Community-run; booster sets and starter decks both searched; alternate arts are separate printings    |

NIMBUS identifies itself to every catalog and spaces requests to the same
one by at least 150 ms, as Scryfall asks. Results are cached for 10
minutes.

## Entries

An entry is **one printing, in one finish, with one status**: owned or
wishlist, foil or not. Adding the same card again adds to its quantity
instead of making a second row. A quantity of 0 removes it.

Prices are the catalog's own market figure at the time you added or
re-added the card, in that catalog's currency — for reference, not a
valuation, and not summed across currencies.

## The security boundary

The tab adds a card by **game + catalog id only**. The card's data — name,
set, image address, price — is taken from a result the main process
fetched itself within the last hour (`CatalogService.resolve`). So a page
can't add a card no catalog returned, or put an image address of its
choosing into your collection. Saved entries are validated one by one on
load, and only `https://` image addresses are kept.

Card images load straight from each catalog's image host, and those hosts
are listed by name in the page's Content Security Policy.

## Comics & manga

The **Comics & manga** view of the same tab. What matters about a collected
edition is **which issues it collects**: an Epic Collection and an Omnibus
overlap, a Masterworks fills a gap neither covers. So every book carries
**runs** — "Journey Into Mystery (1952) #110-125; Thor (1966) #126-130" — and
**coverage** is worked out across the whole shelf
([coverage.ts](../src/collections/books/coverage.ts)): each series, the
issues you hold once, twice (_duplicate_), in part (_partial_, from
"reprints material from"), and the gaps between — with any wishlist book
that would fill one. A run with no year joins the one series of that name
the shelf knows a year for; the same name with two years is two series.

Manga uses the same model one level up: "One Piece #1-45" is volumes 1–45,
and the first gap is the next volume to buy.

**Looking a book up — the Grand Comics Database** (comics.org, free, no
key). Search a series, pick a volume, and the form fills in its title,
ISBN and publisher, and — **when GCD's note says** — what it collects.
Checked while building: Epic Collections and Masterworks usually carry a
"Collects …" note; many omnibuses don't, and then the form says so and you
type the runs. Metron and Comic Vine were also checked and both need an
account; Google Books' anonymous quota was exhausted; Open Library had
nothing for Devir's Portuguese manga, which is typed in by hand. GCD is a
volunteer project: requests are spaced a second apart and kept for a day,
and only the series name or a numeric volume id is sent.

**When GCD has no contents — Wikipedia's lists.** Many omnibuses have an
ISBN on GCD but no note or story list ("Doctor Strange: Master of the
Mystic Arts Omnibus Vol. 1" has neither). Wikipedia's _Marvel Omnibus_,
_Marvel Epic Collection_, _Marvel Masterworks_ and _DC Omnibus_ list
pages have a row per edition with its contents and every printing's ISBN
([wikipedia.ts](../src/collections/books/wikipedia.ts)). A GCD volume
without contents is looked up there by ISBN; "Find contents by ISBN" does
the same on the form and on a book's page. The search box also searches the lists by title, beside GCD — so a book can be added while GCD is asking for a pause. The pages are downloaded whole
through Wikipedia's API (kept for a day) and matched locally — the ISBN
isn't sent. Wikipedia often leaves out series years ("Journey into
Mystery #83–109"); add one if the same name has two series.

**Typing runs.** `Series (year) #from-to`, separated by `;` or `,`.
`Annual #1` after a series means that series' annual; a bare `#140-145`
continues the series before it; `material from X #3` marks a partial
reprint. The form previews exactly how it reads, and says what it
couldn't read instead of guessing
([runs.ts](../src/collections/books/runs.ts), the same parser the main
process saves with).

**Pages.** Books opens on the **shelf** — Shelf, Reading, Wishlist and
Stats — with books grouped by series: "Thor Epic Collection", "Thor by
Jason Aaron Omnibus" and "Marvel Masterworks: The Mighty Thor" all sit
under **Thor** ([shelf.ts](../src/collections/books/shelf.ts)); a book's
_Shelf group_ field overrides that. A series opens its books, each with
what it collects and how much of it you already have elsewhere. A book
opens the issues it collects, each marked owned once, owned 2× (and where
else), or not owned. An issue opens its own page, looked up on GCD by
series, year and number: the story, credits merged per person, and
characters — plus links to League of Comic Geeks and the GCD page. The
page names what to look up; the main process builds the link, for those
two sites only. An issue without a year in its run is only found when
GCD's first page of results holds that exact series name.

**Reading.** Issues are marked read one by one (a checkbox on the book's
page, or "Mark as read" on the issue's), and kept for the shelf — read in
the Epic Collection is read in the Omnibus. A book with issues takes its
progress from them; a novel or a book without issues keeps a percentage.
Status follows: Not started, Reading, Read.

**Covers you choose** are resized to 600 px, saved in
`<userData>/book-covers/<book id>.jpg` and shown through the
`nimbus-cover://` scheme, which serves only that folder. **Novels** are a third kind, typed in by hand.

**Covers** come from Open Library's cover service by ISBN, looked for
once a session per book with an ISBN, a second apart. GCD's own cover
images refuse anything but a person's browser (checked with curl and
with Electron's own network stack — both 403), so single issues show a
placeholder; League of Comic Geeks has their covers.

The shelf is `books.json`, validated book by book on load.

## Card pages

Clicking a card opens its page — text, stats, legality, price, how many
you own and which decks use it. `nimbus:get-card-detail` takes a game and
catalog id only; the main process fetches the card from that game's
database (`catalogs/details.ts`) and caches it for an hour.

## Decks

`decks/` holds decks (`decks.json`), each with zones by game and format:
main and sideboard for Magic (commander and main for Commander), main,
extra and side for Yu-Gi-Oh!, leader and main for One Piece, main for
Pokémon and Lorcana. `rules.ts` checks the rules that hold at any table —
deck size, copy limits, the extra deck, a leader's or commander's colours,
Lorcana's two inks, the Yu-Gi-Oh! banlist as YGOPRODeck reports it — not
every format's full banlist or rotation. Errors make a deck not legal;
warnings are worth a look.

A deck is compared with the owned cards in your collection by name, in
any printing (One Piece by card number). Decklists import as
`4 Lightning Bolt` lines with `Sideboard` / `Extra` / `Commander` /
`Leader` headings. Magic names are looked up in bulk through Scryfall's
`/cards/collection` (75 a request, its default printing); other games
search each name and take the first exact match. Every catalog request
retries on 429 Too Many Requests. Names that don't exist are listed;
names that couldn't be looked up are put back in the import box.

**A deck's shape.** Each card keeps its cost, its kind and a few game
facts from its card page ([stats.ts](../src/collections/decks/stats.ts)),
and the deck page draws them: the curve — Magic's mana value without
lands, Lorcana's ink cost, One Piece's cost, Yu-Gi-Oh! monsters by level
(no tribute, one, two) — with the average, the count of each kind of card,
and what each game's players check: Lorcana's inkable cards, One Piece's
counters and triggers, Pokémon's Basic/Stage 1/Stage 2 and Supporters,
Items and Stadiums. Pokémon has no curve. Cards added before 0.5.16 have
none of this saved; the page counts them apart and offers **Update card
data**, which looks each one up again.

## The deck builder helper

**Build a deck with the helper** (top of the Decks tab) walks through a
deck in four steps; building by hand works as before.

1. **Game and format** — and, for Magic constructed, which cards to show
   (Standard, Pioneer, Modern or any).
2. **What it's built around**: Magic colours (1–5),
   Lorcana inks (1–2), a One Piece **leader** (searched; its colours decide
   the cards), Pokémon energy types (1–2), or a Yu-Gi-Oh! **archetype**
   (optional — without one it starts from staples and name searches).
3. **Playstyle**, ranked by how well it suits that choice
   ([builder.ts](../src/collections/decks/builder.ts)): Magic colours and
   known pairs (Boros leans aggro, Dimir control), Lorcana inks and One
   Piece colours each lean towards styles. Pokémon types and Yu-Gi-Oh!
   archetypes don't lean either way, so they aren't ranked and no reason is
   invented. Each style shows its typical curve, card mix, the counts that
   game checks (Lorcana inkable cards, One Piece counters, Pokémon Basics
   and Supporters) and a couple of tips. These are community rules of thumb
   to start from, not solved maths.
4. **Build.** On the left, cards that fit — by role (Magic: creatures,
   removal, card draw, ramp, counterspells, board wipes, nonbasic lands;
   other games by kind; Yu-Gi-Oh! staples), cost and name, with how many you
   own and "only cards I own". On the right, the plan: each card is added at
   full copies, and an importance menu lowers it — **4 Core, 3 Strong,
   2 Situational, 1 One-of** (3/2/1 for Yu-Gi-Oh!; Commander is one of each,
   with **Make commander**). The curve is drawn against the style's target,
   with the card mix, the total, the basic lands or energy the helper will
   add (split by how much each colour is played, and editable), and advice
   in plain words. **Create deck** makes a normal deck, checked by the usual
   rules.

**How many copies.** "How many copies of each card?" in the plan says
what 4, 3, 2 and 1 copies are for, with the real chance of drawing the
card — in the opening hand, and within three more draws — for the deck's
size ([copies.ts](../src/collections/decks/copies.ts), hypergeometric).
Each card's menu marks a **suggested** count, with the reason when it's
fewer than the maximum: a Magic legendary (3 — a second copy can't be
played while the first is out), a card expensive for the style (2), a
Pokémon Stage 1 or 2 (3), a Yu-Gi-Oh! ban limit. "Use the suggested
copies" applies them all; nothing changes on its own. Each card also shows
its chance to be in the opening hand at its current count.

**Magic colour balance** ([mana.ts](../src/collections/decks/mana.ts)).
Cards keep their coloured mana symbols (a hybrid symbol counts half to
each colour) and, for lands, the colours they make. For each colour the
plan shows its share of the symbols, how many lands make it, and how many
its most demanding spell needs — Frank Karsten's counts for casting a
spell on curve about 90% of the time (Adeline, {1}{W}{W} on turn 3: 18
white sources in 60 cards; Commander scales them by 1.5). Basic lands are
split so each colour first gets what it's short of, then the rest by
symbols; dual lands count for both colours. It says when a colour can't
reach its number, when a chosen colour isn't used, when one colour is 80%+
of the symbols (the other is a splash), and when three or more colours
have too few dual lands. The deck page shows the same balance for any
Magic deck. Three or more colours rank slower styles higher and name the
combination (Esper, Jund, …). Cards saved before 0.5.18 have no symbols
until **Update card data**.

**How cards are found** ([browse.ts](../src/collections/catalogs/browse.ts)),
each checked against the live API while building: Scryfall's search syntax
filters by colour identity, format, its community "oracle tags" for roles
and mana value, ordered by EDHREC popularity (most played first). Lorcast
is asked by ink and type, and cost, songs and "only these inks" are
filtered locally. The OPTCG API's full card lists are downloaded once a day
and filtered locally. TCGdex lists Standard-legal Pokémon by type (and
trainers), then looks up each shown page's cards. YGOPRODeck lists an
archetype, its staples, or a name search. Only the filters are sent.

**The boundary** is the same as everywhere else in Collections: browsing
makes each shown card resolvable in the main process, and creating the
deck sends card ids and counts only — the cards' data comes from what the
main process fetched. Basic lands and energy are accepted by their exact
names only.

## Not yet

- Set completion ("78 of 102"), and card language or condition.
- Full per-format banlists and rotation.
- Pokémon rarity and prices, which TCGdex only gives per card, at one
  request each.
