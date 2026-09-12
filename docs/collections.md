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

| Game | Catalog | Key | Notes |
| --- | --- | --- | --- |
| Magic: The Gathering | [Scryfall](https://scryfall.com/docs/api) | No | Every printing; prices prefer Cardmarket EUR, then USD |
| Pokémon TCG | [TCGdex](https://tcgdex.dev) | No | Chosen over pokemontcg.io, which returned a 502 when checked. Search results carry no rarity or price |
| Yu-Gi-Oh! | [YGOPRODeck](https://ygoprodeck.com/api-guide/) | No | One result per set printing (set code + rarity) |
| Disney Lorcana | [Lorcast](https://lorcast.com/docs/api) | No | Names include the version ("Elsa — Concerned Sister") |
| One Piece Card Game | [OPTCG API](https://optcgapi.com) | No | Community-run; booster sets and starter decks both searched; alternate arts are separate printings |

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

## Not yet

- Comics (Comic Vine) and manga (ISBN lookup, for Devir PT-PT volumes) —
  the next catalogs. Their volume and issue-range data needs its own entry
  shape, not a card's.
- Set completion ("78 of 102"), decks, and card language or condition.
- Pokémon rarity and prices, which TCGdex only gives per card, at one
  request each.
