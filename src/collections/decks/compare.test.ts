import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CardRole,
  CompareCardInfo,
  cardRoles,
  compareWithReferences,
  deckProfile,
  groupCompareCards,
  nameKey,
} from "./compare";
import {
  averageDeck,
  blendDecks,
  commanderReferences,
  edhrecColours,
  similarCommanders,
} from "../catalogs/edhrec";

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
  assert.deepEqual(
    result.yourCards.map((c) => [c.name, c.inDecks]),
    [
      ["Goblin Guide", 0],
      ["Sol Ring", 1],
    ]
  );
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

test("a card can hold more than one role", () => {
  assert.deepEqual(
    cardRoles({
      kind: "creature",
      text: "When this enters, destroy target artifact. {T}: Add {G}. Whenever it attacks, draw a card.",
    }),
    ["ramp", "draw", "removal"]
  );
});

test("similar commanders: a colour page's commanders, or a theme page's top commanders, without your own", async () => {
  const urls: string[] = [];
  const view = (name: string, slug: string, decks: number) => ({ name, sanitized: slug, num_decks: decks });
  const fetchFn = async (url: string) => {
    urls.push(url);
    if (url.includes("/tags/")) {
      return response({
        container: {
          json_dict: {
            cardlists: [
              { tag: "newcommanders", cardviews: [view("New One", "new-one", 3)] },
              {
                tag: "topcommanders",
                cardviews: [
                  view("Zegana", "zegana", 900),
                  view("Mine", "mine", 800),
                  view("Hakbal", "hakbal", 700),
                ],
              },
            ],
          },
        },
      });
    }
    return response({
      container: {
        json_dict: { cardlists: [{ cardviews: [view("Hakbal", "hakbal", 25196), view("../x", "../x", 1)] }] },
      },
    });
  };
  assert.equal(edhrecColours(["g", "u"])?.slug, "simic");
  assert.equal(edhrecColours(["W", "U", "B", "R", "G"])?.name, "Five-Color");
  const themed = await similarCommanders("simic", "plus-1-plus-1-counters", "mine", fetchFn);
  assert.equal(urls[0], "https://json.edhrec.com/pages/tags/plus-1-plus-1-counters/simic.json");
  assert.deepEqual(
    themed.map((c) => c.slug),
    ["zegana", "hakbal"]
  );
  const plain = await similarCommanders("simic", null, "mine", fetchFn);
  assert.equal(urls[1], "https://json.edhrec.com/pages/commanders/simic.json");
  assert.deepEqual(
    plain.map((c) => c.slug),
    ["hakbal"]
  );
});

test("blended decks keep what most decks share, basics at their average count, up to 99 cards", () => {
  const deck = (cards: Array<[string, number]>) => ({
    id: "",
    label: "",
    decks: null,
    cards: cards.map(([name, quantity]) => ({ name, quantity })),
  });
  const blended = blendDecks(
    "similar",
    "Similar",
    [
      deck([
        ["Sol Ring", 1],
        ["Forest", 10],
        ["Hardened Scales", 1],
        ["Oddity", 1],
      ]),
      deck([
        ["Sol Ring", 1],
        ["Forest", 12],
        ["Hardened Scales", 1],
      ]),
      deck([
        ["sol ring", 1],
        ["Forest", 11],
        ["Other", 1],
      ]),
    ],
    13
  );
  assert.deepEqual(
    blended.cards.map((c) => [c.name, c.quantity]),
    [
      ["Forest", 11],
      ["Sol Ring", 1],
      ["Hardened Scales", 1],
    ]
  );
  assert.equal(blended.decks, 3);
});

test("the card lists group by mana value, type, role or how many average decks play a card", () => {
  const card = (name: string, kind: string, cost: number | null, roles: CardRole[], inDecks: number) => ({
    name,
    kind,
    cost,
    roles,
    inDecks,
  });
  const list = [
    card("Worldspine Wurm", "creature", 11, [], 0),
    card("Sol Ring", "artifact", 1, ["ramp"], 2),
    card("Rishkar's Expertise", "sorcery", 6, ["draw"], 1),
    card("Command Tower", "land", 0, ["ramp"], 2),
  ];
  assert.deepEqual(
    groupCompareCards(list, "cost", "name", 2).map((g) => [g.label, g.cards.map((c) => c.name)]),
    [
      ["Mana value 1", ["Sol Ring"]],
      ["Mana value 6+", ["Rishkar's Expertise", "Worldspine Wurm"]],
      ["Lands", ["Command Tower"]],
    ]
  );
  assert.deepEqual(
    groupCompareCards(list, "agreement", "name", 2).map((g) => g.label),
    ["In 2 of 2 average decks", "In 1 of 2 average decks", "In none of the average decks"]
  );
  assert.deepEqual(
    groupCompareCards(list, "role", "name", 2).map((g) => [g.key, g.cards.length]),
    [
      ["ramp", 2],
      ["draw", 1],
      ["none", 1],
    ]
  );
  assert.deepEqual(
    groupCompareCards(list, "kind", "cost", 2).map((g) => g.key),
    ["creature", "sorcery", "artifact", "land"]
  );
  assert.deepEqual(
    groupCompareCards(list, "none", "agreement", 2)[0].cards.map((c) => c.name),
    ["Command Tower", "Sol Ring", "Rishkar's Expertise", "Worldspine Wurm"]
  );
});
