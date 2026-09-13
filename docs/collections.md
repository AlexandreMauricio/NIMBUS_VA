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

**Reading progress** is a percentage per book; anything between 0 and 100
is on the Reading page. **Novels** are a third kind, typed in by hand.

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

## Not yet

- Set completion ("78 of 102"), and card language or condition.
- Full per-format banlists and rotation.
- Pokémon rarity and prices, which TCGdex only gives per card, at one
  request each.
