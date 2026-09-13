import { test } from "node:test";
import assert from "node:assert/strict";
import { manaPips } from "../catalogs/details";
import { drawChance, explainCopies, suggestCopies } from "./copies";
import { ManaCard, balanceColours, sourcesNeeded } from "./mana";
import { builderGuide, recommendPlaystyles } from "./builder";

const spell = (name: string, quantity: number, cost: number, pips: Record<string, number>): ManaCard => ({
  name,
  quantity,
  kind: "creature",
  cost,
  pips,
});

// ---------------------------------------------------------------- symbols

test("mana symbols: generic ignored, hybrid half each, Phyrexian and 2/C count fully", () => {
  assert.deepEqual(manaPips("{2}{W}{W}"), { W: 2 });
  assert.deepEqual(manaPips("{R/G}{R/G}"), { R: 1, G: 1 });
  assert.deepEqual(manaPips("{1}{B/P}{2/U}"), { B: 1, U: 1 });
  assert.deepEqual(manaPips(null), {});
});

test("Karsten's sources: a turn-one one-drop wants 14, a turn-two double wants 21, Commander scales up", () => {
  assert.equal(sourcesNeeded(1, 1), 14);
  assert.equal(sourcesNeeded(2, 2), 21);
  assert.equal(sourcesNeeded(1, 9), 9);
  assert.equal(sourcesNeeded(3, 3, 100), 35);
});

// ---------------------------------------------------------------- balance

test("basics go first where the hardest spell needs them, then by symbols", () => {
  // Mostly red one-drops, but a WW three-drop needs 18 white sources.
  const balance = balanceColours(
    ["R", "W"],
    [spell("Goblin Guide", 16, 1, { R: 1 }), spell("Adeline", 4, 3, { W: 2 })],
    22
  );
  const white = balance.lines.find((l) => l.colour === "W");
  const red = balance.lines.find((l) => l.colour === "R");
  assert.equal(white?.needed, 18);
  assert.equal(red?.needed, 14);
  // 18 + 14 = 32 > 22: can't meet both, so it splits by shortfall and says so.
  assert.equal((balance.basics.R ?? 0) + (balance.basics.W ?? 0), 22);
  assert.match(balance.advice.join(" "), /White: \d+ lands make it, but Adeline wants about 18/);
});

test("dual lands count as sources for both colours and leave basics free", () => {
  const balance = balanceColours(
    ["U", "B"],
    [
      spell("Counterspell", 8, 2, { U: 2 }),
      spell("Removal", 8, 2, { B: 1 }),
      { name: "Watery Grave", quantity: 4, kind: "land", cost: 0, produces: ["U", "B"] },
    ],
    20
  );
  const blue = balance.lines.find((l) => l.colour === "U");
  assert.equal(blue?.needed, 21);
  assert.ok((blue?.sources ?? 0) >= 17, "4 duals plus most basics");
  assert.equal(
    Object.values(balance.basics).reduce((a, b) => a + b, 0),
    20
  );
});

test("a colour nothing needs, and a colour that's 80%+ of the symbols, are pointed out", () => {
  const unused = balanceColours(["R", "G"], [spell("Bolt", 20, 1, { R: 1 })], 22);
  assert.match(unused.advice.join(" "), /Nothing needs green yet/);
  const splash = balanceColours(
    ["R", "G"],
    [spell("Bolt", 36, 1, { R: 1 }), spell("Fringe", 2, 2, { G: 1 })],
    22
  );
  assert.match(splash.advice.join(" "), /95% of the coloured symbols are red/);
});

test("three colours without enough dual lands are warned about", () => {
  const balance = balanceColours(
    ["W", "U", "B"],
    [spell("A", 12, 2, { W: 1 }), spell("B", 12, 2, { U: 1 }), spell("C", 12, 2, { B: 1 })],
    24
  );
  assert.match(balance.advice.join(" "), /3 colours with 0 dual lands/);
});

test("Magic allows one to five colours, and three or more lean to slower styles with the combination's name", () => {
  assert.equal(builderGuide("mtg", "constructed").identity.max, 5);
  const esper = recommendPlaystyles("mtg", "constructed", ["W", "U", "B"]);
  assert.notEqual(esper[0].id, "aggro");
  assert.match(esper[0].reason ?? "", /Esper .* slower/);
  const five = recommendPlaystyles("mtg", "constructed", ["W", "U", "B", "R", "G"]);
  assert.match(five[0].reason ?? "", /Five-colour/);
  assert.equal(five[five.length - 1].id, "aggro");
});

// ----------------------------------------------------------------- copies

test("draw chances: 4 copies in 60 are in the opening hand about 40% of the time", () => {
  assert.equal(drawChance(60, 4, 7), 40);
  assert.equal(drawChance(60, 1, 7), 12);
  assert.equal(drawChance(40, 3, 5), 34);
  const explained = explainCopies("mtg", 60, 4);
  assert.deepEqual(
    explained.map((e) => [e.copies, e.label, e.openingHand, e.byTurnThree]),
    [
      [4, "Core", 40, 53],
      [3, "Strong", 32, 43],
      [2, "Situational", 22, 31],
      [1, "One-of", 12, 17],
    ]
  );
});

test("suggested copies: legendary 3, expensive for aggro 2, Stage 2 3, the banlist wins, otherwise the maximum", () => {
  const rules = (over: object) => ({
    cost: 2,
    kind: "creature",
    traits: [] as string[],
    banLimit: null,
    ...over,
  });
  assert.equal(
    suggestCopies("mtg", "aggro", 4, { typeLine: "Legendary Creature — Human", rules: rules({}) }).copies,
    3
  );
  assert.equal(
    suggestCopies("mtg", "aggro", 4, { typeLine: "Creature", rules: rules({ cost: 5 }) }).copies,
    2
  );
  assert.equal(
    suggestCopies("mtg", "control", 4, { typeLine: "Creature", rules: rules({ cost: 5 }) }).copies,
    4
  );
  assert.equal(
    suggestCopies("pokemon", "evolution", 4, {
      typeLine: null,
      rules: rules({ kind: "pokemon", cost: null, traits: ["stage2"] }),
    }).copies,
    3
  );
  assert.equal(
    suggestCopies("yugioh", "combo", 3, { typeLine: null, rules: rules({ banLimit: 1 }) }).copies,
    1
  );
  const plain = suggestCopies("lorcana", "midrange", 4, {
    typeLine: null,
    rules: rules({ kind: "character" }),
  });
  assert.deepEqual(plain, { copies: 4, reason: null });
});
