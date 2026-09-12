import { test } from "node:test";
import assert from "node:assert/strict";
import { CollectionService } from "./collectionService";
import { CatalogService } from "./catalogService";
import { ScryfallCatalog, mapScryfall } from "./catalogs/scryfall";
import { mapYgoprodeck } from "./catalogs/ygoprodeck";
import { mapTcgdex } from "./catalogs/tcgdex";
import { mapLorcast } from "./catalogs/lorcast";
import { OptcgCatalog, mapOptcg } from "./catalogs/optcg";
import { CardCatalog, CatalogCard, CollectionState, CollectionStore, TcgGame } from "./types";

// Shapes below are trimmed from real responses fetched while building this.

const fakeResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

// ------------------------------------------------------------- catalogs

test("Scryfall: every printing, EUR first, and the front face's image for double-faced cards", () => {
  const cards = mapScryfall({
    data: [
      {
        id: "a1",
        name: "Lightning Bolt",
        set: "clb",
        set_name: "Commander Legends: Battle for Baldur's Gate",
        collector_number: "187",
        rarity: "common",
        image_uris: { small: "https://cards.scryfall.io/small/front/a1.jpg" },
        prices: { usd: "1.52", eur: "1.44" },
      },
      {
        id: "a2",
        name: "Delver of Secrets // Insectile Aberration",
        set: "isd",
        set_name: "Innistrad",
        collector_number: "51",
        rarity: "common",
        card_faces: [{ image_uris: { small: "https://cards.scryfall.io/small/front/a2.jpg" } }, {}],
        prices: { usd: "0.30", eur: null },
      },
      { id: "", name: "broken" },
    ],
  });

  assert.equal(cards.length, 2, "the malformed card is skipped");
  assert.deepEqual(cards[0], {
    game: "mtg",
    sourceId: "a1",
    name: "Lightning Bolt",
    setCode: "CLB",
    setName: "Commander Legends: Battle for Baldur's Gate",
    number: "187",
    rarity: "common",
    imageUrl: "https://cards.scryfall.io/small/front/a1.jpg",
    price: { value: 1.44, currency: "EUR" },
  });
  assert.equal(cards[1].imageUrl, "https://cards.scryfall.io/small/front/a2.jpg");
  assert.deepEqual(cards[1].price, { value: 0.3, currency: "USD" }, "USD when there is no EUR price");
});

test("YGOPRODeck: one result per set printing, and a card with no printings still appears", () => {
  const cards = mapYgoprodeck({
    data: [
      {
        id: 46986414,
        name: "Dark Magician",
        card_images: [{ image_url_small: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg" }],
        card_sets: [
          {
            set_name: "2016 Mega-Tins",
            set_code: "CT13-EN003",
            set_rarity: "Ultra Rare",
            set_rarity_code: "(UR)",
            set_price: "6.97",
          },
          {
            set_name: "Battle of Chaos",
            set_code: "25TH-EN001",
            set_rarity: "Ultra Rare",
            set_rarity_code: "(UR)",
            set_price: "0.00",
          },
        ],
      },
      { id: 99, name: "Brand New Card", card_images: [] },
    ],
  });

  assert.equal(cards.length, 3);
  assert.equal(cards[0].sourceId, "46986414:CT13-EN003:(UR)");
  assert.equal(cards[0].setName, "2016 Mega-Tins");
  assert.deepEqual(cards[0].price, { value: 6.97, currency: "USD" });
  assert.equal(cards[1].price, null, "a 0.00 price is no price");
  assert.equal(cards[2].sourceId, "99");
  assert.equal(cards[2].imageUrl, null);
});

test("TCGdex: set code from the card id, set name from the set list, a sized image", () => {
  const cards = mapTcgdex(
    [
      {
        id: "swsh3-136",
        localId: "136",
        name: "Furret",
        image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
      },
      { id: "tk-hs-r-2", localId: "2", name: "Pikachu" },
    ],
    new Map([["swsh3", "Darkness Ablaze"]])
  );
  assert.equal(cards[0].setCode, "swsh3");
  assert.equal(cards[0].setName, "Darkness Ablaze");
  assert.equal(cards[0].number, "136");
  assert.equal(cards[0].imageUrl, "https://assets.tcgdex.net/en/swsh/swsh3/136/low.webp");
  assert.equal(cards[1].setCode, "tk-hs-r", "a set id that itself contains dashes keeps them");
  assert.equal(cards[1].imageUrl, null);
});

test("Lorcast: the character and version together, since many characters share a name", () => {
  const [elsa] = mapLorcast({
    results: [
      {
        id: "crd_1",
        name: "Elsa",
        version: "Concerned Sister",
        set: { code: "11", name: "Winterspell" },
        collector_number: "125",
        rarity: "Uncommon",
        image_uris: { digital: { small: "https://cards.lorcast.io/card/digital/small/crd_1.avif" } },
        prices: { usd: 0.11, usd_foil: 0.3 },
      },
    ],
  });
  assert.equal(elsa.name, "Elsa — Concerned Sister");
  assert.equal(elsa.setName, "Winterspell");
  assert.deepEqual(elsa.price, { value: 0.11, currency: "USD" });
});

test("OPTCG: alternate arts are their own printings, and starter decks are searched too", async () => {
  const booster = {
    card_name: "Roronoa Zoro (025)",
    set_name: "Romance Dawn",
    set_id: "OP-01",
    rarity: "SR",
    card_set_id: "OP01-025",
    card_image_id: "OP01-025",
    card_image: "https://optcgapi.com/media/static/Card_Images/OP01-025.jpg",
    market_price: 3.46,
  };
  const altArt = { ...booster, card_image_id: "OP01-025_p1", market_price: 40 };
  assert.deepEqual(
    mapOptcg([booster, altArt]).map((card) => card.sourceId),
    ["OP01-025", "OP01-025_p1"]
  );

  const starter = {
    ...booster,
    set_name: "Starter Deck 1: Straw Hat Crew",
    set_id: "ST-01",
    card_image_id: "ST01-013",
  };
  const catalog = new OptcgCatalog(async (url) =>
    url.includes("/sets/") ? fakeResponse(200, [booster, altArt]) : fakeResponse(200, [starter, booster])
  );
  const found = await catalog.search("zoro");
  assert.deepEqual(
    found.map((card) => card.sourceId),
    ["OP01-025", "OP01-025_p1", "ST01-013"],
    "merged, with the booster card not listed twice"
  );

  const decksDown = new OptcgCatalog(async (url) => {
    if (url.includes("/decks/")) throw new Error("down");
    return fakeResponse(200, [booster]);
  });
  assert.equal((await decksDown.search("zoro")).length, 1, "starter decks failing doesn't lose the sets");
});

test("'nothing matched' is no results, but a server error is a failure", async () => {
  const notFound = new ScryfallCatalog(async () => fakeResponse(404, { object: "error" }));
  assert.deepEqual(await notFound.search("zzqqxx"), []);

  const broken = new ScryfallCatalog(async () => fakeResponse(503, {}));
  await assert.rejects(() => broken.search("bolt"), /503/);
});

// -------------------------------------------------------- catalog service

function card(overrides: Partial<CatalogCard> = {}): CatalogCard {
  return {
    game: "mtg",
    sourceId: "a1",
    name: "Lightning Bolt",
    setCode: "CLB",
    setName: "Battle for Baldur's Gate",
    number: "187",
    rarity: "common",
    imageUrl: "https://cards.scryfall.io/small/front/a1.jpg",
    price: { value: 1.44, currency: "EUR" },
    ...overrides,
  };
}

function fakeCatalog(game: TcgGame, results: CatalogCard[] | Error) {
  const calls: string[] = [];
  const catalog: CardCatalog = {
    game,
    search: async (query) => {
      calls.push(query);
      if (results instanceof Error) throw results;
      return results;
    },
  };
  return { catalog, calls };
}

test("searches are checked, cached, and paced", async () => {
  let clock = 1_000_000;
  const slept: number[] = [];
  const { catalog, calls } = fakeCatalog("mtg", [card()]);
  const service = new CatalogService(
    [catalog],
    () => clock,
    async (ms) => {
      slept.push(ms);
    }
  );

  await assert.rejects(() => service.search("chess", "bolt"), /Choose a game/);
  await assert.rejects(() => service.search("pokemon", "pikachu"), /no card database/);
  await assert.rejects(() => service.search("mtg", "b"), /at least 2/);
  await assert.rejects(() => service.search("mtg", "x".repeat(101)), /at most 100/);

  await service.search("mtg", "  Lightning   Bolt ");
  await service.search("mtg", "lightning bolt");
  assert.deepEqual(calls, ["Lightning Bolt"], "the second search came from the cache");

  clock += 11 * 60_000;
  await service.search("mtg", "lightning bolt");
  assert.equal(calls.length, 2, "an old result is fetched again");
  assert.equal(slept.length, 0, "no wait when the last request was long ago");

  await service.search("mtg", "counterspell");
  assert.equal(slept.length, 1, "back-to-back requests to one catalog are spaced out");
});

test("only a card a search actually returned can be resolved for adding", async () => {
  let clock = 0;
  const { catalog } = fakeCatalog("mtg", [card(), card({ game: "yugioh", sourceId: "smuggled" })]);
  const service = new CatalogService(
    [catalog],
    () => clock,
    async () => {}
  );

  assert.equal(service.resolve("mtg", "a1"), null, "nothing searched yet");
  const results = await service.search("mtg", "bolt");
  assert.equal(results.length, 1, "a result claiming another game is dropped");
  assert.equal(service.resolve("mtg", "a1")?.name, "Lightning Bolt");
  assert.equal(service.resolve("yugioh", "smuggled"), null);
  assert.equal(service.resolve("mtg", "made-up"), null);

  clock += 61 * 60_000;
  assert.equal(service.resolve("mtg", "a1"), null, "and only for a while");
});

test("a catalog failing is reported plainly", async () => {
  const { catalog } = fakeCatalog("mtg", new Error("ECONNRESET"));
  const service = new CatalogService(
    [catalog],
    () => 0,
    async () => {}
  );
  await assert.rejects(() => service.search("mtg", "bolt"), /couldn't be reached/);
});

// ------------------------------------------------------------ collection

function collection(saved?: unknown) {
  const saves: CollectionState[] = [];
  const store: CollectionStore = {
    load: () => saved ?? null,
    save: (state) => saves.push(JSON.parse(JSON.stringify(state))),
  };
  let clock = Date.parse("2026-09-12T10:00:00Z");
  let n = 0;
  const service = new CollectionService(
    store,
    () => new Date((clock += 1000)),
    () => `c${++n}`
  );
  return { service, saves };
}

test("adding the same printing again adds to its quantity; foil and wishlist are their own entries", () => {
  const { service } = collection();
  service.add(card());
  const again = service.add(card(), { quantity: 3 });
  assert.equal(again.quantity, 4);
  assert.equal(service.list().length, 1);

  service.add(card(), { foil: true });
  service.add(card(), { status: "wishlist" });
  assert.equal(service.list().length, 3);
  assert.equal(service.list({ status: "wishlist" }).length, 1);

  assert.throws(() => service.add(card(), { quantity: 0 }), /from 1 to 999/);
});

test("quantity, status, foil and notes can change; quantity 0 removes the card", () => {
  const { service } = collection();
  const entry = service.add(card());
  assert.equal(
    service.update(entry.id, { quantity: 2, notes: "  from the prerelease  " })?.notes,
    "from the prerelease"
  );
  assert.equal(service.update(entry.id, { status: "wishlist", foil: true })?.status, "wishlist");

  assert.throws(() => service.update(entry.id, { quantity: -1 }), /0 to 999/);
  assert.throws(() => service.update(entry.id, { status: "stolen" }), /owned or wishlist/);

  assert.equal(service.update(entry.id, { quantity: 0 }), null);
  assert.deepEqual(service.list(), []);
  assert.throws(() => service.update(entry.id, { quantity: 1 }), /no longer in the collection/);
});

test("filters, newest first, and counts per game", () => {
  const { service } = collection();
  service.add(card(), { quantity: 4 });
  service.add(
    card({ game: "onepiece", sourceId: "OP01-025", name: "Roronoa Zoro", setName: "Romance Dawn" }),
    {
      quantity: 2,
    }
  );
  service.add(card({ game: "lorcana", sourceId: "crd_1", name: "Elsa — Concerned Sister" }), {
    status: "wishlist",
  });

  assert.deepEqual(
    service.list().map((entry) => entry.name),
    ["Elsa — Concerned Sister", "Roronoa Zoro", "Lightning Bolt"]
  );
  assert.equal(service.list({ game: "onepiece" }).length, 1);
  assert.equal(service.list({ text: "romance" })[0]?.name, "Roronoa Zoro", "set names are searched too");

  const stats = service.stats();
  assert.equal(stats.ownedCopies, 6);
  assert.equal(stats.ownedEntries, 2);
  assert.equal(stats.wishlistEntries, 1);
  assert.equal(stats.byGame.mtg.ownedCopies, 4);
  assert.equal(stats.byGame.lorcana.wishlistEntries, 1);
  assert.equal(stats.byGame.pokemon.ownedCopies, 0);
});

test("the collection survives a restart, and malformed saved entries are skipped", () => {
  const first = collection();
  first.service.add(card(), { quantity: 2 });
  const saved = first.saves.at(-1);

  const good = saved!.cards[0];
  const restarted = collection({
    version: 1,
    cards: [
      good,
      { ...good, id: "bad-game", game: "chess" },
      { ...good, id: "bad-quantity", quantity: 0 },
      { ...good, id: "bad-image", imageUrl: "javascript:alert(1)" },
      { ...good, id: good.id, name: "duplicate id" },
      "nonsense",
    ],
  });
  const entries = restarted.service.list();
  assert.deepEqual(entries.map((entry) => entry.id).sort(), [good.id, "bad-image"].sort());
  assert.equal(
    entries.find((entry) => entry.id === "bad-image")?.imageUrl,
    null,
    "only https images are kept"
  );
  assert.equal(entries.find((entry) => entry.id === good.id)?.quantity, 2);
});
