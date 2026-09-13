import { test } from "node:test";
import assert from "node:assert/strict";
import { CompareCardInfo, cardRoles, compareWithReferences, deckProfile, nameKey } from "./compare";
import { averageDeck, commanderReferences } from "../catalogs/edhrec";

const info = (name: string, kind: string, cost: number | null, text: string): [string, CompareCardInfo] => [
  nameKey(name),
  { sourceId: name, name, kind, cost, text, imageUrl: null },
];

const cards = new Map<string, CompareCardInfo>([
  info("Sol Ring", "artifact", 1, "{T}: Add {C}{C}."),
  info(
    "Cultivate",
    "sorcery",
    3,
    "Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand."
  ),
  info(
    "Rhystic Study",
    "enchantment",
    3,
    "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."
  ),
  info(
    "Swords to Plowshares",
    "instant",
    1,
    "Exile target creature. Its controller gains life equal to its power."
  ),
  info(
    "Blasphemous Act",
    "sorcery",
    9,
    "This spell costs {1} less to cast for each creature on the battlefield. Blasphemous Act deals 13 damage to each creature."
  ),
  info(
    "Zagoth Triome",
    "land",
    0,
    "({T}: Add {B}, {R}, or {G}.) Cycling {3} ({3}, Discard this card: Draw a card.)"
  ),
  info("Goblin Guide", "creature", 1, "Haste"),
]);

test("roles from rules text: ramp, draw, removal, wipes — and a cycling land is none of them", () => {
  const roles = (name: string) => cardRoles(cards.get(nameKey(name))!);
  assert.deepEqual(roles("Sol Ring"), ["ramp"]);
  assert.deepEqual(roles("Cultivate"), ["ramp"]);
  assert.deepEqual(roles("Rhystic Study"), ["draw"]);
  assert.deepEqual(roles("Swords to Plowshares"), ["removal"]);
  assert.deepEqual(roles("Blasphemous Act"), ["wipe"]);
  assert.deepEqual(roles("Zagoth Triome"), []);
  assert.deepEqual(roles("Goblin Guide"), []);
});

test("a deck's profile counts lands (basics included without lookup), kinds, curve and roles", () => {
  const profile = deckProfile(
    "Mine",
    [
      { name: "Sol Ring", quantity: 1 },
      { name: "Swords to Plowshares", quantity: 1 },
      { name: "Mountain", quantity: 30 },
      { name: "Zagoth Triome", quantity: 1 },
    ],
    cards
  );
  assert.equal(profile.total, 33);
  assert.equal(profile.lands, 31);
  assert.equal(profile.averageCost, 1);
  assert.deepEqual(profile.roles, { ramp: 1, draw: 0, removal: 1, wipe: 0 });
  assert.equal(profile.curve[1], 2);
});

test("comparison: guidelines per deck, overlap, what they agree on that you lack, and what's only yours", () => {
  const mine = [
    { name: "Sol Ring", quantity: 1 },
    { name: "Goblin Guide", quantity: 1 },
    { name: "Mountain", quantity: 37 },
  ];
  const refs = [
    {
      id: "",
      label: "Average",
      decks: 100,
      cards: [
        { name: "Sol Ring", quantity: 1 },
        { name: "Cultivate", quantity: 1 },
        { name: "Rhystic Study", quantity: 1 },
      ],
    },
    {
      id: "budget",
      label: "Budget",
      decks: null,
      cards: [
        { name: "Cultivate", quantity: 1 },
        { name: "Swords to Plowshares", quantity: 1 },
      ],
    },
    { id: "tokens", label: "Tokens", decks: null, cards: [{ name: "Blasphemous Act", quantity: 1 }] },
  ];
  const result = compareWithReferences(mine, refs, cards);
  const lands = result.guidelines.find((g) => g.key === "lands")!;
  assert.deepEqual([lands.values[0], lands.status], [37, "ok"]);
  const ramp = result.guidelines.find((g) => g.key === "ramp")!;
  assert.deepEqual([ramp.values, ramp.status], [[1, 2, 1, 0], "low"]);
  // Of my two non-basic cards, the average plays one.
  assert.deepEqual(result.overlap, [50, 0, 0]);
  // With three decks, "agreed" means at least two of them: only Cultivate.
  assert.deepEqual(
    result.missing.map((m) => [m.name, m.inDecks]),
    [["Cultivate", 2]]
  );
  assert.deepEqual(result.onlyMine, ["Goblin Guide"]);
});

test("a double-faced card matches its front face", () => {
  assert.equal(
    nameKey("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"),
    "fable of the mirror-breaker"
  );
});

const response = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

test("EDHREC: a commander's variants (average, budget, expensive, themes) and an average deck by type", async () => {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    if (url.includes("/commanders/")) {
      return response({
        container: { json_dict: { card: { num_decks: 43956 } } },
        panels: {
          taglinks: [
            { slug: "goblins", value: "Goblins", count: 5398 },
            { slug: "../evil", value: "Bad", count: 1 },
          ],
        },
      });
    }
    return response({
      deck: {
        cards: {
          Creature: [["Goblin Guide", 1]],
          Land: [
            ["Mountain", 30],
            ["Bad", "x"],
          ],
        },
      },
    });
  };
  const refs = await commanderReferences("Krenko, Mob Boss", fetchFn);
  assert.equal(urls[0], "https://json.edhrec.com/pages/commanders/krenko-mob-boss.json");
  assert.deepEqual(
    refs.variants.map((v) => [v.id, v.label, v.decks]),
    [
      ["", "Average deck", 43956],
      ["budget", "Budget average", null],
      ["expensive", "Expensive average", null],
      ["goblins", "Goblins average", 5398],
    ]
  );
  const deck = await averageDeck(refs.slug, refs.variants[3], fetchFn);
  assert.equal(urls[1], "https://json.edhrec.com/pages/average-decks/krenko-mob-boss/goblins.json");
  assert.deepEqual(deck.cards, [
    { name: "Goblin Guide", quantity: 1 },
    { name: "Mountain", quantity: 30 },
  ]);
  await assert.rejects(() => averageDeck("../x", refs.variants[0], fetchFn), /isn't a commander/);
});
