import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogService } from "../catalogService";
import { browsers, lorcastBrowseQuery, parseBrowseFilter, scryfallBrowseQuery } from "./browse";

const response = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as unknown as Response;

test("a filter from the page is checked: odd values fall back, text is cleaned", () => {
  const f = parseBrowseFilter({
    identity: ["R", 5, "W", "", "a".repeat(80)],
    role: "DROP TABLE",
    costMin: 2.5,
    costMax: 3,
    text: 'bolt" OR 1=1 (',
    legality: "vintage",
    page: 999,
  });
  assert.deepEqual(f.identity, ["R", "W", "a".repeat(60)]);
  assert.equal(f.role, "any");
  assert.equal(f.costMin, null);
  assert.equal(f.costMax, 3);
  assert.equal(f.text, "bolt OR 1 1");
  assert.equal(f.legality, "any");
  assert.equal(f.page, 0);
});

test("the Scryfall query combines colour identity, legality, role and mana value", () => {
  const q = scryfallBrowseQuery(
    parseBrowseFilter({ identity: ["R", "W"], role: "removal", legality: "standard", costMin: 1, costMax: 2 })
  );
  assert.equal(q, "id<=RW f:standard otag:removal -t:land mv>=1 mv<=2");
  assert.equal(scryfallBrowseQuery(parseBrowseFilter({ legality: "any" })), "id<=C -t:basic");
});

test("the Lorcast query asks by inks and type; songs are asked as actions", () => {
  assert.equal(
    lorcastBrowseQuery(parseBrowseFilter({ identity: ["Ruby", "Amethyst"], role: "song" })),
    "(i:ruby or i:amethyst) format:core t:action"
  );
});

test("Lorcana keeps only cards whose inks are all chosen, songs apart from actions, one per name", async () => {
  const card = (id: string, name: string, inks: string[], type: string[], cost: number) => ({
    id,
    name,
    inks,
    ink: inks[0],
    type,
    cost,
    inkwell: true,
  });
  const fetchFn = async () =>
    response({
      results: [
        card("1", "Be Prepared", ["Ruby"], ["Action", "Song"], 7),
        card("2", "Fire the Cannons", ["Ruby"], ["Action"], 1),
        card("3", "Off-colour Song", ["Ruby", "Steel"], ["Action", "Song"], 2),
        card("4", "Be Prepared", ["Ruby"], ["Action", "Song"], 7),
      ],
    });
  const page = await browsers(fetchFn).lorcana(
    parseBrowseFilter({ identity: ["Ruby", "Amethyst"], role: "song" })
  );
  assert.deepEqual(
    page.cards.map((c) => c.name),
    ["Be Prepared"]
  );
});

test("One Piece: leaders apart, a card shares a colour with the leader, standard art over alternates", async () => {
  const entry = (id: string, name: string, type: string, color: string, cost: string) => ({
    card_image_id: id,
    card_set_id: id.replace(/_.*$/, ""),
    card_name: name,
    card_type: type,
    card_color: color,
    card_cost: cost,
  });
  const fetchFn = async (url: string) =>
    response(
      url.includes("allSetCards")
        ? [
            entry("OP01-001", "Zoro", "Leader", "Red", ""),
            entry("OP01-006_p1", "Otama", "Character", "Red", "1"),
            entry("OP01-006", "Otama", "Character", "Red", "1"),
            entry("OP01-030", "Blue guy", "Character", "Blue", "2"),
          ]
        : []
    );
  const b = browsers(fetchFn);
  const leaders = await b.onepiece(parseBrowseFilter({ role: "leader" }));
  assert.deepEqual(
    leaders.cards.map((c) => c.name),
    ["Zoro"]
  );
  const red = await b.onepiece(parseBrowseFilter({ identity: ["Red"], role: "any" }));
  assert.deepEqual(
    red.cards.map((c) => c.sourceId),
    ["OP01-006"]
  );
});

test("browsed cards become resolvable, so a deck can be created from their ids", async () => {
  const fetchFn = async () =>
    response({
      data: [{ id: "bolt", name: "Lightning Bolt", cmc: 1, type_line: "Instant", colors: ["R"] }],
      has_more: false,
      total_cards: 1,
    });
  const service = new CatalogService(
    [],
    () => 1_000,
    async () => undefined,
    {},
    {},
    { mtg: browsers(fetchFn).mtg }
  );
  const page = await service.browse("mtg", { identity: ["R"], role: "any" });
  assert.equal(page.cards[0].rules.kind, "instant");
  assert.equal(service.resolve("mtg", "bolt")?.name, "Lightning Bolt");
  await assert.rejects(() => service.browse("pokemon", {}), /can't be browsed/);
});
