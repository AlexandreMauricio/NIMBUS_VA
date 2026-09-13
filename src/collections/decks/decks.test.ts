import { test } from "node:test";
import assert from "node:assert/strict";
import { DeckService } from "./deckService";
import { checkDeck, compareWithCollection } from "./rules";
import { formatDecklist, parseDecklist, sameCardName } from "./decklist";
import { CardDetail, CollectionCard, TcgGame } from "../types";
import { DeckState, DeckStore } from "./types";
import { mapOptcgDetail, mapScryfallDetail, mapTcgdexDetail, mapYgoprodeckDetail } from "../catalogs/details";

// ------------------------------------------------ card pages (real shapes)

test("card pages carry what deck rules need, read from each game's real data", () => {
  const bolt = mapScryfallDetail({
    id: "b1",
    name: "Lightning Bolt",
    type_line: "Instant",
    oracle_text: "Lightning Bolt deals 3 damage to any target.",
    mana_cost: "{R}",
    colors: ["R"],
    legalities: { modern: "legal", standard: "not_legal" },
    image_uris: { small: "https://cards.scryfall.io/s.jpg", normal: "https://cards.scryfall.io/n.jpg" },
  })!;
  assert.equal(bolt.rules.unlimitedCopies, false);
  assert.deepEqual(bolt.legalities, [
    { format: "Standard", status: "not legal" },
    { format: "Modern", status: "legal" },
  ]);
  const mountain = mapScryfallDetail({ id: "m1", name: "Mountain", type_line: "Basic Land — Mountain" })!;
  assert.equal(mountain.rules.unlimitedCopies, true, "basic lands are unlimited");

  const stardust = mapYgoprodeckDetail(
    {
      data: [
        { id: 44508094, name: "Stardust Dragon", type: "Synchro Monster", frameType: "synchro", level: 8 },
      ],
    },
    "44508094"
  )!;
  assert.equal(stardust.rules.zone, "extra");
  const pot = mapYgoprodeckDetail(
    {
      data: [
        {
          id: 55144522,
          name: "Pot of Greed",
          type: "Spell Card",
          frameType: "spell",
          banlist_info: { ban_tcg: "Forbidden" },
        },
      ],
    },
    "55144522"
  )!;
  assert.equal(pot.rules.banLimit, 0);

  const energy = mapTcgdexDetail({
    id: "sv03-230",
    name: "Basic Fire Energy",
    category: "Energy",
    energyType: "Normal",
  })!;
  assert.equal(energy.rules.unlimitedCopies, true, "basic energy is unlimited");

  const luffy = mapOptcgDetail(
    [
      {
        card_name: "Monkey.D.Luffy (001)",
        card_set_id: "ST01-001",
        card_image_id: "ST01-001",
        card_type: "Leader",
        card_color: "Red",
      },
    ],
    "ST01-001"
  )!;
  assert.equal(luffy.rules.zone, "leader");
  assert.equal(luffy.rules.copyKey, "ST01-001");
});

// ------------------------------------------------------------------ rules

function detail(
  game: TcgGame,
  name: string,
  overrides: Partial<CardDetail["rules"]> = {},
  typeLine: string | null = null
): CardDetail {
  return {
    game,
    sourceId: `${game}:${name}`,
    name,
    setCode: null,
    setName: null,
    number: null,
    rarity: null,
    imageUrl: null,
    largeImageUrl: null,
    price: null,
    typeLine,
    text: null,
    flavor: null,
    stats: [],
    legalities: [],
    artist: null,
    rules: {
      copyKey: name,
      unlimitedCopies: false,
      zone: "main",
      colors: [],
      banLimit: null,
      cost: null,
      kind: null,
      traits: [],
      ...overrides,
    },
  };
}

function decks(saved?: unknown) {
  const saves: DeckState[] = [];
  const store: DeckStore = {
    load: () => saved ?? null,
    save: (s) => saves.push(JSON.parse(JSON.stringify(s))),
  };
  let n = 0;
  return {
    service: new DeckService(
      store,
      () => new Date("2026-09-13T12:00:00Z"),
      () => `d${++n}`
    ),
    saves,
  };
}

const messages = (deck: Parameters<typeof checkDeck>[0]) => checkDeck(deck).issues.map((i) => i.message);

test("Magic: 60 cards, 4 copies — but basic lands are unlimited", () => {
  const { service } = decks();
  let deck = service.create({ game: "mtg", name: "Burn" });
  deck = service.addCard(deck.id, detail("mtg", "Lightning Bolt"), undefined, 5);
  deck = service.addCard(deck.id, detail("mtg", "Mountain", { unlimitedCopies: true }), undefined, 20);
  assert.deepEqual(messages(deck), [
    "25 cards in the main deck — at least 60",
    "5 copies of Lightning Bolt — at most 4",
  ]);

  deck = service.setQuantity(deck.id, "mtg:Lightning Bolt", "main", 4);
  deck = service.addCard(deck.id, detail("mtg", "Mountain", { unlimitedCopies: true }), undefined, 36);
  const check = checkDeck(deck);
  assert.equal(check.counts.main, 60);
  assert.equal(check.legal, true);
});

test("Commander: exactly 100 with the commander, singleton, and colours flagged", () => {
  const { service } = decks();
  let deck = service.create({ game: "mtg", name: "Krenko", format: "commander" });
  deck = service.addCard(deck.id, detail("mtg", "Krenko, Mob Boss", { colors: ["R"] }), "leader");
  deck = service.addCard(deck.id, detail("mtg", "Counterspell", { colors: ["U"] }), undefined, 2);
  deck = service.addCard(deck.id, detail("mtg", "Mountain", { unlimitedCopies: true }), undefined, 97);
  assert.deepEqual(messages(deck), [
    "2 copies of Counterspell — at most 1",
    "Outside the commander's colours: Counterspell",
  ]);
});

test("Yu-Gi-Oh!: extra deck monsters belong there, and the banlist caps copies", () => {
  const { service } = decks();
  let deck = service.create({ game: "yugioh", name: "Synchro" });
  deck = service.addCard(deck.id, detail("yugioh", "Stardust Dragon", { zone: "extra" }));
  assert.equal(deck.cards[0].zone, "extra", "added where it belongs by default");
  deck = service.addCard(deck.id, detail("yugioh", "Stardust Dragon", { zone: "extra" }), "main");
  deck = service.addCard(deck.id, detail("yugioh", "Pot of Greed", { banLimit: 0 }));
  deck = service.addCard(deck.id, detail("yugioh", "Ash Blossom"), undefined, 4);
  const found = messages(deck);
  assert.ok(found.includes("6 cards in the main deck — 40 to 60"), found.join(" | "));
  assert.ok(found.includes("Pot of Greed is forbidden"));
  assert.ok(found.includes("4 copies of Ash Blossom — at most 3"));
  assert.ok(found.includes("Stardust Dragon belongs in the extra deck"));
});

test("Pokémon: exactly 60, basic energy unlimited, and a warning with no Basic Pokémon", () => {
  const { service } = decks();
  let deck = service.create({ game: "pokemon", name: "Fire" });
  deck = service.addCard(
    deck.id,
    detail("pokemon", "Basic Fire Energy", { unlimitedCopies: true }, "Energy · Normal · Fire"),
    undefined,
    60
  );
  const check = checkDeck(deck);
  assert.deepEqual(check.issues, [
    { level: "warning", message: "No Basic Pokémon — the deck can't start a game" },
  ]);
  assert.equal(check.legal, true, "a warning doesn't make it illegal");
});

test("Lorcana: at most two inks", () => {
  const { service } = decks();
  let deck = service.create({ game: "lorcana", name: "Three inks" });
  deck = service.addCard(
    deck.id,
    detail("lorcana", "Elsa — Concerned Sister", { colors: ["Ruby"] }),
    undefined,
    4
  );
  deck = service.addCard(deck.id, detail("lorcana", "Mickey — Brave", { colors: ["Amber"] }), undefined, 4);
  deck = service.addCard(deck.id, detail("lorcana", "Maui — Hero", { colors: ["Steel"] }), undefined, 52);
  assert.ok(messages(deck).includes("3 inks (Ruby, Amber, Steel) — at most 2"));
});

test("One Piece: one leader, 50 cards, the leader's colours, alternate arts counted together", () => {
  const { service } = decks();
  let deck = service.create({ game: "onepiece", name: "Luffy" });
  deck = service.addCard(deck.id, detail("onepiece", "Monkey.D.Luffy", { zone: "leader", colors: ["Red"] }));
  assert.equal(deck.cards[0].zone, "leader");
  const zoro = detail("onepiece", "Roronoa Zoro", { copyKey: "OP01-025", colors: ["Red"] });
  const zoroAlt = { ...zoro, sourceId: "OP01-025_p1" };
  deck = service.addCard(deck.id, zoro, undefined, 3);
  deck = service.addCard(deck.id, zoroAlt, undefined, 2);
  deck = service.addCard(
    deck.id,
    detail("onepiece", "Nami", { copyKey: "OP01-016", colors: ["Blue"] }),
    undefined,
    45
  );
  const found = messages(deck);
  assert.ok(found.includes("5 copies of Roronoa Zoro — at most 4"), found.join(" | "));
  assert.ok(found.includes("Nami isn't in the leader's colours"));
  assert.equal(checkDeck(deck).counts.main, 50);
});

// ------------------------------------------------------ against collection

test("what the deck needs that the collection doesn't have, in any printing", () => {
  const { service } = decks();
  let deck = service.create({ game: "mtg", name: "Burn" });
  deck = service.addCard(deck.id, detail("mtg", "Lightning Bolt"), undefined, 4);
  deck = service.addCard(deck.id, detail("mtg", "Goblin Guide"), undefined, 4);
  const owned = (name: string, quantity: number, status: CollectionCard["status"] = "owned") =>
    ({ game: "mtg", name, quantity, status, number: null }) as CollectionCard;
  const result = compareWithCollection(deck, [
    owned("Lightning Bolt", 2),
    owned("Lightning Bolt", 1),
    owned("Goblin Guide", 4, "wishlist"),
  ]);
  assert.deepEqual(
    result.lines.map((l) => `${l.name} ${l.owned}/${l.needed}`),
    ["Goblin Guide 0/4", "Lightning Bolt 3/4"]
  );
  assert.equal(result.missingTotal, 5);
  assert.equal(result.ownedTotal, 3);
});

// -------------------------------------------------------------- decklists

test("decklists: forgiving to read, and what's written reads back", () => {
  const { lines, unread } = parseDecklist(
    "Main deck\n4x Lightning Bolt\n20 Mountain (M11) 146\n// a comment\n\nSideboard:\n2 Pyroblast\nSB: 1 Smash to Smithereens\nsome junk"
  );
  assert.deepEqual(
    lines.map((l) => `${l.zone}:${l.quantity} ${l.name}`),
    ["main:4 Lightning Bolt", "main:20 Mountain", "side:2 Pyroblast", "side:1 Smash to Smithereens"]
  );
  assert.deepEqual(unread, ["some junk"]);

  const { service } = decks();
  let deck = service.create({ game: "mtg", name: "Burn" });
  deck = service.addCard(deck.id, detail("mtg", "Lightning Bolt"), undefined, 4);
  deck = service.addCard(deck.id, detail("mtg", "Pyroblast"), "side", 2);
  const text = formatDecklist(deck, "mtg");
  assert.equal(text, "Main deck\n4 Lightning Bolt\n\nSideboard\n2 Pyroblast");
  assert.deepEqual(
    parseDecklist(text).lines.map((l) => `${l.zone}:${l.quantity} ${l.name}`),
    ["main:4 Lightning Bolt", "side:2 Pyroblast"]
  );
  assert.ok(sameCardName("Elsa - Concerned Sister", "elsa — concerned sister"));
});

test("decks survive a restart; bad saved cards are dropped; changing format moves orphaned zones", () => {
  const first = decks();
  let deck = first.service.create({ game: "mtg", name: "Burn" });
  deck = first.service.addCard(deck.id, detail("mtg", "Pyroblast"), "side", 2);
  deck = first.service.update(deck.id, { format: "commander" });
  assert.equal(deck.cards[0].zone, "main", "Commander has no sideboard");

  const saved = first.saves.at(-1)!;
  saved.decks[0].cards.push({ ...saved.decks[0].cards[0], sourceId: "", name: "bad" });
  const restarted = decks(saved);
  assert.equal(restarted.service.list().length, 1);
  assert.equal(restarted.service.list()[0].cards.length, 1);

  assert.throws(() => restarted.service.create({ game: "chess", name: "x" }), /Choose a game/);
  assert.throws(() => restarted.service.addCard(deck.id, detail("pokemon", "Pikachu")), /different game/);
});

// ------------------------------------------------ imports within rate limits

test("a 429 is waited out and retried, honouring Retry-After", async () => {
  const { fetchWithRetry, catalogRetry } = await import("../catalogs/http");
  const waits: number[] = [];
  const original = catalogRetry.sleep;
  catalogRetry.sleep = async (ms) => {
    waits.push(ms);
  };
  try {
    let calls = 0;
    const response = await fetchWithRetry(
      async () => {
        calls++;
        return calls < 3
          ? new Response("", { status: 429, headers: calls === 1 ? { "Retry-After": "2" } : {} })
          : new Response("{}", { status: 200 });
      },
      "https://api.scryfall.com/x",
      {}
    );
    assert.equal(response.status, 200);
    assert.deepEqual(waits, [2000, 2000]);
    const gaveUp = await fetchWithRetry(async () => new Response("", { status: 429 }), "https://x", {});
    assert.equal(gaveUp.status, 429, "gives up after 3 retries");
  } finally {
    catalogRetry.sleep = original;
  }
});

test("a Commander import looks Magic cards up 75 names a request", async () => {
  const { scryfallCardsByName } = await import("../catalogs/details");
  const names = Array.from({ length: 100 }, (_, i) => `Card ${i}`);
  const bodies: Array<{ identifiers: Array<{ name: string }> }> = [];
  const result = await scryfallCardsByName(names, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const data = body.identifiers
      .filter((id: { name: string }) => id.name !== "Card 7")
      .map((id: { name: string }) => ({
        id: id.name.replace(" ", "-"),
        name: id.name,
        type_line: "Instant",
      }));
    const notFound = body.identifiers.filter((id: { name: string }) => id.name === "Card 7");
    return new Response(JSON.stringify({ data, not_found: notFound }), { status: 200 });
  });
  assert.deepEqual(
    bodies.map((b) => b.identifiers.length),
    [75, 25]
  );
  assert.equal(result.found.length, 99);
  assert.deepEqual(result.notFound, ["Card 7"]);
});

test("lookupByNames matches double-faced fronts and separates not found from unreachable", async () => {
  const { CatalogService } = await import("../catalogService");
  const bulk = async () => ({
    found: [
      mapScryfallDetail({
        id: "d1",
        name: "Delver of Secrets // Insectile Aberration",
        type_line: "Creature",
      })!,
      mapScryfallDetail({ id: "s1", name: "Sol Ring", type_line: "Artifact" })!,
    ],
    notFound: ["Nope"],
  });
  const service = new CatalogService([], Date.now, async () => {}, {}, { mtg: bulk });
  const result = await service.lookupByNames("mtg", ["Delver of Secrets", "sol ring", "Nope"]);
  assert.equal(result.found.get("delver of secrets")?.sourceId, "d1");
  assert.equal(result.found.get("sol ring")?.sourceId, "s1");
  assert.deepEqual(result.notFound, ["Nope"]);
  assert.ok(service.resolve("mtg", "s1"), "found cards can be added like search results");

  const down = new CatalogService(
    [],
    Date.now,
    async () => {},
    {},
    {
      mtg: async () => {
        throw new Error("The card database answered 500.");
      },
    }
  );
  const failed = await down.lookupByNames("mtg", ["Sol Ring"]);
  assert.deepEqual(failed.failed, ["Sol Ring"]);
  assert.deepEqual(failed.notFound, []);
});

test("asked to wait longer than is worth it, a request stops at once and says how long", async () => {
  const { fetchWithRetry, catalogRetry, getCatalogJson, RateLimitedError, waitText } =
    await import("../catalogs/http");
  const original = catalogRetry.sleep;
  let slept = 0;
  catalogRetry.sleep = async () => {
    slept++;
  };
  try {
    let calls = 0;
    const limited = async () => {
      calls++;
      return new Response("", { status: 429, headers: { "Retry-After": "855" } });
    };
    const response = await fetchWithRetry(limited, "https://www.comics.org/api/x", {});
    assert.equal(response.status, 429);
    assert.equal(calls, 1, "no retries when the wait is 14 minutes");
    assert.equal(slept, 0);
    await assert.rejects(
      () => getCatalogJson("https://www.comics.org/api/x", limited),
      (err: unknown) => err instanceof RateLimitedError && err.retryAfterSeconds === 855
    );
    assert.equal(waitText(855), "about 14 minutes");
    assert.equal(waitText(null), "a few minutes");
  } finally {
    catalogRetry.sleep = original;
  }
});
