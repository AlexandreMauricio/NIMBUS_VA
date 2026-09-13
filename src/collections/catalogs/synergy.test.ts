import { test } from "node:test";
import assert from "node:assert/strict";
import { CardDetail } from "../types";
import { CardSources } from "./browse";
import { mapLorcastDetail, mapOptcgDetail, mapScryfallDetail } from "./details";
import { edhrecSlug, mtgThemes, parseSynergyContext, synergyFinders } from "./synergy";

const response = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

test("EDHREC page names drop punctuation and accents, and use the front face", () => {
  assert.equal(edhrecSlug("Urza's Saga"), "urzas-saga");
  assert.equal(edhrecSlug("Krenko, Mob Boss"), "krenko-mob-boss");
  assert.equal(edhrecSlug("Lim-Dûl's Vault"), "lim-duls-vault");
  assert.equal(
    edhrecSlug("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"),
    "fable-of-the-mirror-breaker"
  );
});

test("Magic themes come from the card's text and type, at most three", () => {
  const krenko = mapScryfallDetail({
    id: "k",
    name: "Krenko, Mob Boss",
    type_line: "Legendary Creature — Goblin Warrior",
    oracle_text:
      "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.",
  }) as CardDetail;
  assert.deepEqual(
    mtgThemes(krenko).map((t) => t.label),
    ["More Goblins for it", "Also about tokens", "Rewards Goblins"]
  );
  const bolt = mapScryfallDetail({
    id: "b",
    name: "Lightning Bolt",
    type_line: "Instant",
    oracle_text: "Deal 3.",
  });
  assert.deepEqual(
    mtgThemes(bolt as CardDetail).map((t) => t.label),
    ["Rewards casting spells"]
  );
});

test("the context from the page is checked", () => {
  assert.deepEqual(parseSynergyContext({ identity: ["R", "<script>", 3], legality: "vintage" }), {
    identity: ["R"],
    legality: "any",
  });
});

test("Magic: EDHREC's high-lift cards first, kept to the plan's colours, then theme searches", async () => {
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.includes("json.edhrec.com")) {
      return response({
        container: {
          json_dict: {
            cardlists: [
              { header: "Top Cards", cardviews: [{ name: "Sol Ring" }] },
              {
                header: "High Lift Cards",
                cardviews: [{ name: "Raging Goblin" }, { name: "Swords to Plowshares" }],
              },
            ],
          },
        },
      });
    }
    if (url.includes("/cards/collection")) {
      const names = JSON.parse(String(init?.body)).identifiers.map((i: { name: string }) => i.name);
      assert.deepEqual(names, ["Raging Goblin", "Swords to Plowshares"]);
      return response({
        data: [
          {
            id: "rg",
            name: "Raging Goblin",
            type_line: "Creature — Goblin",
            colors: ["R"],
            mana_cost: "{R}",
          },
          { id: "sw", name: "Swords to Plowshares", type_line: "Instant", colors: ["W"], mana_cost: "{W}" },
        ],
      });
    }
    return response({
      data: [{ id: "gg", name: "Goblin Bushwhacker", type_line: "Creature — Goblin", colors: ["R"] }],
    });
  };
  const sources = {} as CardSources;
  const guide = mapScryfallDetail({
    id: "g",
    name: "Goblin Guide",
    type_line: "Creature — Goblin Scout",
    oracle_text: "Haste",
  }) as CardDetail;
  const result = await synergyFinders(fetchFn, sources).mtg(guide, { identity: ["R"], legality: "any" });
  assert.deepEqual(
    result.cards.map((c) => [c.detail.name, c.reason]),
    [
      ["Raging Goblin", "Played with it far more often than usual"],
      ["Goblin Bushwhacker", "Rewards Goblins"],
    ]
  );
  assert.match(result.source, /EDHREC/);
});

test("One Piece: cards of the types it looks for, and cards that reward its type, in its colours", async () => {
  const entry = (id: string, name: string, type: string, color: string, subTypes: string, text = "") =>
    mapOptcgDetail(
      [
        {
          card_image_id: id,
          card_set_id: id,
          card_name: name,
          card_type: type,
          card_color: color,
          sub_types: subTypes,
          card_text: text,
          card_cost: "2",
        },
      ],
      id
    ) as CardDetail;
  const nami = entry(
    "OP01-016",
    "Nami",
    "Character",
    "Red",
    "Straw Hat Crew",
    '[On Play] Look at 5 cards; reveal up to 1 "Straw Hat Crew" type Character card other than [Nami].'
  );
  const pool = [
    entry("A", "Sanji", "Character", "Red", "Straw Hat Crew"),
    entry("B", "Crew Captain", "Event", "Red", "Navy", 'Give a "Straw Hat Crew" type Character +2000.'),
    entry("C", "Blue Sanji", "Character", "Blue", "Straw Hat Crew"),
    entry("D", "Unrelated", "Character", "Red", "Navy"),
  ];
  const sources: CardSources = { json: async () => null, onePieceCards: async () => pool };
  const result = await synergyFinders(fetch, sources).onepiece(nami, { identity: ["Red"], legality: "any" });
  assert.deepEqual(
    result.cards.map((c) => [c.detail.name, c.reason]),
    [
      ["Sanji", "A Straw Hat Crew card it looks for"],
      ["Crew Captain", "Rewards Straw Hat Crew cards"],
    ]
  );
});

test("Lorcana: Princesses for a Princess-rewarding card, songs for a Singer, never the card itself", async () => {
  const card = (
    id: string,
    name: string,
    version: string,
    type: string[],
    classifications: string[],
    text: string
  ) => ({
    id,
    name,
    version,
    type,
    classifications,
    text,
    inks: ["Amber"],
    cost: 3,
  });
  const ariel = mapLorcastDetail(
    card(
      "1",
      "Ariel",
      '"Spectacular Singer"',
      ["Character"],
      [],
      "Singer 5. Whenever a Princess character of yours sings a song, gain lore."
    )
  ) as CardDetail;
  const pool = [
    card("2", "Ariel", "Spectacular Singer", ["Character"], ["Storyborn", "Princess"], "Singer 5."),
    card("3", "Aurora", "Waking Beauty", ["Character"], ["Storyborn", "Princess"], ""),
    card("4", "Part of Your World", "", ["Action", "Song"], [], "Return a character."),
    card("5", "Goofy", "Musketeer", ["Character"], ["Storyborn", "Hero"], ""),
  ];
  const sources: CardSources = { json: async () => ({ results: pool }), onePieceCards: async () => [] };
  const result = await synergyFinders(fetch, sources).lorcana(ariel, {
    identity: ["Amber"],
    legality: "any",
  });
  assert.deepEqual(
    result.cards.map((c) => [c.detail.name, c.reason]),
    [
      ["Aurora — Waking Beauty", "A Princess for its ability"],
      ["Part of Your World", "A song it can sing"],
    ]
  );
});
