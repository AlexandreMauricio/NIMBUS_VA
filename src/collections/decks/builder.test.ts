import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanCard, builderGuide, planSummary, recommendPlaystyles, splitBasics } from "./builder";
import { curveBuckets } from "./stats";
import { TCG_GAMES } from "../types";
import { DECK_FORMATS } from "./types";

const card = (
  name: string,
  quantity: number,
  kind: string,
  cost: number | null,
  colors: string[] = [],
  extra: Partial<PlanCard["rules"]> = {}
): PlanCard => ({
  sourceId: name,
  name,
  quantity,
  rules: { kind, cost, colors, traits: [], zone: "main", unlimitedCopies: false, ...extra },
});

test("every playstyle's curve matches its game's curve buckets and its targets fit the deck", () => {
  for (const game of TCG_GAMES) {
    for (const format of DECK_FORMATS[game.id]) {
      const guide = builderGuide(game.id, format.id);
      assert.ok(guide.playstyles.length >= 3, `${game.id} has playstyles`);
      const deckSize = game.id === "onepiece" ? 50 : guide.deckSize;
      for (const style of guide.playstyles) {
        const label = `${game.id}/${format.id}/${style.id}`;
        if (game.id === "pokemon") assert.equal(style.curve.length, 0, label);
        else assert.equal(style.curve.length, curveBuckets(game.id).length, label);
        const kindsTotal = style.kinds.reduce((s, k) => s + k.count, 0);
        assert.ok(kindsTotal <= deckSize, `${label}: kinds ${kindsTotal} fit in ${deckSize}`);
        if (game.id === "lorcana" || game.id === "onepiece") {
          assert.equal(
            style.curve.reduce((s, n) => s + n, 0),
            deckSize,
            label
          );
        }
        if (game.id === "mtg" && format.id === "constructed") {
          assert.equal(style.curve.reduce((s, n) => s + n, 0) + style.basics, 60, label);
        }
      }
    }
  }
});

test("Magic copy tiers go 4 to 1; Commander has none; Yu-Gi-Oh! starts at 3", () => {
  assert.deepEqual(
    builderGuide("mtg", "constructed").tiers.map((t) => t.copies),
    [4, 3, 2, 1]
  );
  assert.deepEqual(builderGuide("mtg", "commander").tiers, []);
  assert.deepEqual(
    builderGuide("yugioh", "advanced").tiers.map((t) => t.copies),
    [3, 2, 1]
  );
});

test("colours steer the recommendation: Boros is aggro, Dimir is control, green ramps", () => {
  const top = (identity: string[]) => recommendPlaystyles("mtg", "constructed", identity)[0];
  assert.equal(top(["R", "W"]).id, "aggro");
  assert.match(top(["R", "W"]).reason ?? "", /Boros/);
  assert.equal(top(["U", "B"]).id, "control");
  assert.equal(top(["G"]).id, "ramp");
  assert.equal(recommendPlaystyles("lorcana", "core", ["Sapphire", "Steel"])[0].id, "control");
  assert.equal(recommendPlaystyles("onepiece", "standard", ["Red"])[0].id, "aggro");
});

test("Pokémon and Yu-Gi-Oh! keep the guide's order, with no invented reason", () => {
  const pokemon = recommendPlaystyles("pokemon", "standard", ["Fire"]);
  assert.deepEqual(
    pokemon.map((r) => r.id),
    builderGuide("pokemon", "standard").playstyles.map((p) => p.id)
  );
  assert.ok(pokemon.every((r) => r.reason === null));
});

test("basics split by weight, every colour gets one when there's room", () => {
  assert.deepEqual(splitBasics(22, { R: 30, W: 10 }), { R: 17, W: 5 });
  assert.deepEqual(splitBasics(22, { R: 40, W: 0 }), { R: 21, W: 1 });
  assert.deepEqual(splitBasics(0, { R: 1 }), {});
});

test("a Boros aggro plan: 4 of each of 10 cards plus 22 basic lands is 62, and the advice says so", () => {
  const cards = [
    card("Monastery Swiftspear", 4, "creature", 1, ["R"], { pips: { R: 1 } }),
    card("Kytheon", 4, "creature", 1, ["W"], { pips: { W: 1 } }),
    card("Goblin Guide", 4, "creature", 1, ["R"], { pips: { R: 1 } }),
    card("Adeline", 4, "creature", 3, ["W"], { pips: { W: 2 } }),
    card("Lightning Bolt", 4, "instant", 1, ["R"], { pips: { R: 1 } }),
    card("Boros Charm", 4, "instant", 2, ["R", "W"], { pips: { R: 1, W: 1 } }),
    card("Bonecrusher Giant", 4, "creature", 3, ["R"], { pips: { R: 1 } }),
    card("Thalia", 4, "creature", 2, ["W"], { pips: { W: 1 } }),
    card("Play with Fire", 4, "instant", 1, ["R"], { pips: { R: 1 } }),
    card("Inspiring Vantage", 4, "land", 0, [], { produces: ["R", "W"] }),
  ];
  const plan = planSummary("mtg", "constructed", "aggro", ["R", "W"], cards);
  // 22 lands wanted, 4 nonbasic picked: 18 basics, split by colour use.
  assert.equal(
    Object.values(plan.basics).reduce((a, b) => a + b, 0),
    18
  );
  // More red cards, but Adeline's WW on turn 3 needs more white sources than red's one-drops do.
  assert.ok(plan.basics.Plains > plan.basics.Mountain);
  assert.deepEqual(
    plan.colours?.map((c) => [c.colour, c.needed]),
    [
      ["R", 14],
      ["W", 18],
    ]
  );
  assert.equal(plan.total, 58);
  assert.match(plan.advice.join(" "), /2 more cards to reach 60/);
  assert.equal(plan.ready, false);
  assert.equal(plan.kinds[0].label, "Creatures");
  assert.equal(plan.kinds[0].count, 24);
});

test("a One Piece plan counts the leader apart and asks for one when missing", () => {
  const leader = card("Zoro", 1, "leader", null, ["Red"], { zone: "leader" });
  const deck = Array.from({ length: 12 }, (_, i) =>
    card(`Char ${i}`, 4, "character", (i % 5) + 1, ["Red"], { traits: i < 3 ? ["counter"] : [] })
  );
  const without = planSummary("onepiece", "standard", "aggro", ["Red"], deck);
  assert.match(without.advice.join(" "), /Pick a leader/);
  const withLeader = planSummary("onepiece", "standard", "aggro", ["Red"], [leader, ...deck]);
  assert.equal(withLeader.total, 48);
  assert.doesNotMatch(withLeader.advice.join(" "), /Pick a leader/);
  assert.match(withLeader.advice.join(" "), /With a counter: 12 — Aggro \/ rush usually has at least 16/);
});

test("Pokémon basic energy follows the types, and a deck with no Basic Pokémon is flagged", () => {
  const cards = [card("Charizard ex", 3, "pokemon", null, ["Fire"], { traits: ["stage2", "ex"] })];
  const plan = planSummary("pokemon", "standard", "evolution", ["Fire"], cards);
  assert.deepEqual(plan.basics, { "Fire Energy": 8 });
  assert.match(plan.advice.join(" "), /No Basic Pokémon/);
});

test("a Yu-Gi-Oh! plan keeps extra deck monsters out of the 40", () => {
  const cards = [
    card("Ash Blossom", 3, "monster", 3),
    card("Accesscode Talker", 2, "monster", null, [], { zone: "extra" }),
  ];
  const plan = planSummary("yugioh", "advanced", "combo", [], cards);
  assert.equal(plan.total, 3);
});
