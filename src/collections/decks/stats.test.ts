import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapLorcastDetail,
  mapOptcgDetail,
  mapScryfallDetail,
  mapTcgdexDetail,
  mapYgoprodeckDetail,
  mtgKind,
} from "../catalogs/details";
import { CardDetail } from "../types";
import { DeckService } from "./deckService";
import { StatCard, bucketIndex, deckStats } from "./stats";

const card = (
  quantity: number,
  kind: string | null,
  cost: number | null,
  traits: string[] = []
): StatCard => ({
  quantity,
  zone: "main",
  rules: { kind, cost, traits },
});

// ----------------------------------------------------------- card data

test("Magic cards keep their mana value, kind and basic-land trait", () => {
  const bolt = mapScryfallDetail({ id: "a", name: "Lightning Bolt", cmc: 1, type_line: "Instant" });
  assert.deepEqual([bolt?.rules.cost, bolt?.rules.kind, bolt?.rules.traits], [1, "instant", []]);
  const mountain = mapScryfallDetail({
    id: "b",
    name: "Mountain",
    cmc: 0,
    type_line: "Basic Land — Mountain",
  });
  assert.deepEqual([mountain?.rules.kind, mountain?.rules.traits], ["land", ["basic"]]);
  assert.equal(mtgKind("Artifact Creature — Golem"), "creature");
  assert.equal(mtgKind("Sorcery // Land"), "sorcery");
  assert.equal(mtgKind("Legendary Enchantment Artifact"), "artifact");
});

test("Lorcana cards keep ink cost, songs as their own kind, and inkable", () => {
  const song = mapLorcastDetail({
    id: "s",
    name: "Be Our Guest",
    cost: 2,
    inkwell: true,
    type: ["Action", "Song"],
  });
  assert.deepEqual([song?.rules.cost, song?.rules.kind, song?.rules.traits], [2, "song", ["inkable"]]);
  const elsa = mapLorcastDetail({ id: "e", name: "Elsa", cost: 8, inkwell: false, type: ["Character"] });
  assert.deepEqual([elsa?.rules.kind, elsa?.rules.traits], ["character", []]);
});

test("One Piece cards keep cost, counters and triggers; a leader has no cost", () => {
  const [character] = [
    mapOptcgDetail(
      [
        {
          card_image_id: "OP01-006",
          card_name: "Otama",
          card_type: "Character",
          card_cost: "1",
          counter_amount: 2000,
          card_text: "[Trigger] Draw 1 card.",
          card_color: "Red",
        },
      ],
      "OP01-006"
    ),
  ];
  assert.deepEqual(
    [character?.rules.cost, character?.rules.kind, character?.rules.traits],
    [1, "character", ["counter", "trigger"]]
  );
  const leader = mapOptcgDetail(
    [
      {
        card_image_id: "OP01-001",
        card_name: "Zoro",
        card_type: "Leader",
        card_cost: null,
        card_color: "Red",
      },
    ],
    "OP01-001"
  );
  assert.deepEqual([leader?.rules.cost, leader?.rules.kind], [null, "leader"]);
});

test("Pokémon cards keep their category and stage; basic energy is basic", () => {
  const charizard = mapTcgdexDetail({ id: "x", name: "Charizard ex", category: "Pokemon", stage: "Stage2" });
  assert.deepEqual([charizard?.rules.kind, charizard?.rules.traits], ["pokemon", ["stage2", "ex"]]);
  const iono = mapTcgdexDetail({ id: "i", name: "Iono", category: "Trainer", trainerType: "Supporter" });
  assert.deepEqual([iono?.rules.kind, iono?.rules.traits], ["trainer", ["supporter"]]);
  const fire = mapTcgdexDetail({ id: "f", name: "Fire Energy", category: "Energy", energyType: "Normal" });
  assert.deepEqual([fire?.rules.kind, fire?.rules.traits], ["energy", ["basic"]]);
});

test("Yu-Gi-Oh! monsters keep their level; spells and traps have none", () => {
  const monster = mapYgoprodeckDetail(
    { data: [{ name: "Blue-Eyes", type: "Normal Monster", level: 8 }] },
    "1"
  );
  assert.deepEqual([monster?.rules.kind, monster?.rules.cost], ["monster", 8]);
  const spell = mapYgoprodeckDetail({ data: [{ name: "Pot of Greed", type: "Spell Card" }] }, "2");
  assert.deepEqual([spell?.rules.kind, spell?.rules.cost], ["spell", null]);
});

// ---------------------------------------------------------------- stats

test("a Magic curve counts spells by mana value and leaves lands out", () => {
  const stats = deckStats("mtg", [
    card(4, "creature", 1),
    card(4, "instant", 2),
    card(2, "creature", 7),
    card(20, "land", 0),
  ]);
  assert.equal(stats.curveTitle, "Mana value");
  assert.deepEqual(
    stats.curve.map((b) => b.count),
    [0, 4, 4, 0, 0, 0, 2]
  );
  assert.equal(stats.averageCost, 2.6);
  assert.deepEqual(stats.kinds, [
    { label: "Creatures", count: 6 },
    { label: "Instants", count: 4 },
    { label: "Lands", count: 20 },
  ]);
});

test("cards saved without card data are counted as unknown, not guessed", () => {
  const stats = deckStats("mtg", [card(4, null, null), card(4, "creature", 2)]);
  assert.equal(stats.unknown, 4);
  assert.equal(stats.curve[2].count, 4);
});

test("Lorcana counts inkable cards; One Piece counters leave the leader out", () => {
  const lorcana = deckStats("lorcana", [card(4, "character", 2, ["inkable"]), card(4, "song", 3)]);
  assert.deepEqual(lorcana.highlights, [{ label: "Inkable", count: 4 }]);
  const onepiece = deckStats(
    "onepiece",
    [
      { quantity: 1, zone: "leader", rules: { kind: "leader", cost: null, traits: [] } },
      card(4, "character", 2, ["counter"]),
    ],
    ["main", "leader"]
  );
  assert.deepEqual(onepiece.highlights[0], { label: "With a counter", count: 4 });
  assert.deepEqual(onepiece.kinds, [{ label: "Characters", count: 4 }]);
});

test("Pokémon has no curve but counts stages; Yu-Gi-Oh! groups levels by tributes", () => {
  const pokemon = deckStats("pokemon", [
    card(4, "pokemon", null, ["basic"]),
    card(2, "pokemon", null, ["stage2"]),
  ]);
  assert.equal(pokemon.curveTitle, null);
  assert.deepEqual(
    pokemon.highlights.slice(0, 3).map((h) => h.count),
    [4, 0, 2]
  );
  assert.equal(bucketIndex("yugioh", 4), 0);
  assert.equal(bucketIndex("yugioh", 6), 1);
  assert.equal(bucketIndex("yugioh", 12), 2);
});

// -------------------------------------------------------------- refresh

test("an old deck card without card data can be refreshed, keeping its quantity and zone", () => {
  const saved = {
    decks: [
      {
        id: "d1",
        game: "mtg",
        name: "Old",
        format: "constructed",
        cards: [
          {
            sourceId: "bolt",
            name: "Lightning Bolt",
            zone: "side",
            quantity: 3,
            rules: { copyKey: "Lightning Bolt" },
          },
        ],
      },
    ],
  };
  const service = new DeckService({ load: () => saved, save: () => undefined });
  assert.equal(service.get("d1").cards[0].rules.kind, null);
  const detail = mapScryfallDetail({
    id: "bolt",
    name: "Lightning Bolt",
    cmc: 1,
    type_line: "Instant",
  }) as CardDetail;
  const deck = service.refreshCards("d1", [detail]);
  assert.deepEqual(
    [deck.cards[0].quantity, deck.cards[0].zone, deck.cards[0].rules.kind, deck.cards[0].rules.cost],
    [3, "side", "instant", 1]
  );
});
