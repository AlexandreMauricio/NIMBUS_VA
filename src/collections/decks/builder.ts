import { CardRulesInfo, TcgGame } from "../types";
import { DeckStats, KIND_LABELS, curveBuckets, deckStats } from "./stats";
import { DeckZone } from "./types";

/**
 * The deck builder helper's knowledge: for each game and format, what a
 * deck is built around (colours, inks, a leader, energy types, an
 * archetype), the playstyles it can take, what each playstyle's deck
 * usually looks like — its curve, its mix of card kinds, the counts that
 * game's players check — and how a plan measures up.
 *
 * These are community rules of thumb, not solved maths: starting points
 * a player then adjusts. Pure; used straight from the Decks tab.
 */

export interface IdentityChoice {
  id: string;
  label: string;
}

export interface BuilderIdentity {
  /** colors: pick from `choices`; leader: search the game's leaders; archetype: pick one from a list, or none. */
  kind: "colors" | "leader" | "archetype";
  label: string;
  choices: IdentityChoice[];
  min: number;
  max: number;
}

export interface CountTarget {
  /** A card kind (see stats.ts KIND_LABELS) or a highlight label ("Inkable"). */
  key: string;
  label: string;
  count: number;
  /** "at least" targets only warn when under. */
  atLeast?: boolean;
}

export interface Playstyle {
  id: string;
  name: string;
  summary: string;
  /** Recommended copies per curve bucket (stats.ts curveBuckets), not counting lands or basic energy. */
  curve: number[];
  kinds: CountTarget[];
  highlights: CountTarget[];
  /** Lands (Magic) or basic energy (Pokémon) the builder adds. */
  basics: number;
  tips: string[];
  /** Browse filters that suit the style, first ones first (see BuilderRole ids). */
  roles: string[];
}

export interface BuilderRole {
  id: string;
  label: string;
}

export interface CopyTier {
  copies: number;
  label: string;
}

export interface BuilderGuide {
  game: TcgGame;
  format: string;
  deckSize: number;
  maxCopies: number;
  identity: BuilderIdentity;
  playstyles: Playstyle[];
  roles: BuilderRole[];
  /** Importance tiers, most copies first. Empty when every card is a single copy. */
  tiers: CopyTier[];
  /** What the builder calls the cards it adds for you ("Basic lands"), or null. */
  basicsLabel: string | null;
  /** Legality choices for browsing (Magic constructed), first is the default. */
  legalities: IdentityChoice[];
}

// -------------------------------------------------------------- choices

export const MTG_COLORS: IdentityChoice[] = [
  { id: "W", label: "White" },
  { id: "U", label: "Blue" },
  { id: "B", label: "Black" },
  { id: "R", label: "Red" },
  { id: "G", label: "Green" },
];

export const MTG_BASIC_LANDS: Record<string, string> = {
  W: "Plains",
  U: "Island",
  B: "Swamp",
  R: "Mountain",
  G: "Forest",
};

export const LORCANA_INKS: IdentityChoice[] = [
  "Amber",
  "Amethyst",
  "Emerald",
  "Ruby",
  "Sapphire",
  "Steel",
].map((ink) => ({ id: ink, label: ink }));

export const POKEMON_TYPES: IdentityChoice[] = [
  "Grass",
  "Fire",
  "Water",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Dragon",
  "Colorless",
].map((type) => ({ id: type, label: type }));

/** Basic energy by type. Dragon and Colorless Pokémon have none of their own. */
export const POKEMON_BASIC_ENERGY: Record<string, string> = {
  Grass: "Grass Energy",
  Fire: "Fire Energy",
  Water: "Water Energy",
  Lightning: "Lightning Energy",
  Psychic: "Psychic Energy",
  Fighting: "Fighting Energy",
  Darkness: "Darkness Energy",
  Metal: "Metal Energy",
};

const kinds = (game: TcgGame, counts: Record<string, number>): CountTarget[] =>
  KIND_LABELS[game]
    .filter(([kind]) => counts[kind] !== undefined)
    .map(([kind, label]) => ({ key: kind, label, count: counts[kind] }));

const TIERS_4: CopyTier[] = [
  { copies: 4, label: "Core — you want it every game" },
  { copies: 3, label: "Strong" },
  { copies: 2, label: "Situational" },
  { copies: 1, label: "One-of" },
];

// ---------------------------------------------------------------- Magic

const MTG_ROLES: BuilderRole[] = [
  { id: "any", label: "Everything" },
  { id: "creature", label: "Creatures" },
  { id: "removal", label: "Removal" },
  { id: "draw", label: "Card draw" },
  { id: "ramp", label: "Ramp" },
  { id: "counterspell", label: "Counterspells" },
  { id: "wipe", label: "Board wipes" },
  { id: "land", label: "Nonbasic lands" },
];

function mtgPlaystyles(commander: boolean): Playstyle[] {
  if (commander) {
    const tips = [
      "About 37 lands, 10 ramp pieces, 10 card draw, 8 removal and 2–3 board wipes is the usual skeleton.",
      "Every card is a single copy, so redundancy comes from playing several cards that do the same job.",
    ];
    const creatures = (count: number) => kinds("mtg", { creature: count });
    return [
      {
        id: "aggro",
        name: "Go wide / aggro",
        summary: "Many cheap creatures and ways to pump them all; pressure every opponent early.",
        curve: [0, 10, 16, 16, 10, 6, 4],
        kinds: creatures(32),
        highlights: [],
        basics: 36,
        tips,
        roles: ["creature", "draw", "removal"],
      },
      {
        id: "midrange",
        name: "Midrange / value",
        summary: "Efficient threats backed by removal and card advantage; adapts to the table.",
        curve: [0, 8, 14, 15, 12, 7, 6],
        kinds: creatures(26),
        highlights: [],
        basics: 37,
        tips,
        roles: ["creature", "removal", "draw", "ramp"],
      },
      {
        id: "control",
        name: "Control",
        summary: "Answer threats, wipe boards, win late with a few powerful finishers.",
        curve: [0, 6, 12, 14, 12, 9, 9],
        kinds: creatures(14),
        highlights: [],
        basics: 37,
        tips,
        roles: ["removal", "wipe", "counterspell", "draw"],
      },
      {
        id: "ramp",
        name: "Ramp / big spells",
        summary: "Accelerate mana early to cast huge threats ahead of everyone else.",
        curve: [0, 8, 16, 12, 10, 8, 8],
        kinds: creatures(24),
        highlights: [],
        basics: 38,
        tips,
        roles: ["ramp", "creature", "draw"],
      },
    ];
  }
  return [
    {
      id: "aggro",
      name: "Aggro",
      summary: "Cheap creatures and burn or pump; win before the opponent stabilises.",
      curve: [0, 10, 14, 9, 4, 1, 0],
      kinds: kinds("mtg", { creature: 24 }),
      highlights: [],
      basics: 22,
      tips: [
        "Most of the deck should cost 1–2 so you can use all your mana every turn from turn one.",
        "About 22 lands is enough when little costs more than 3.",
      ],
      roles: ["creature", "removal"],
    },
    {
      id: "tempo",
      name: "Tempo",
      summary: "A few efficient threats protected by cheap interaction; stay a step ahead.",
      curve: [0, 8, 12, 9, 6, 2, 0],
      kinds: kinds("mtg", { creature: 16 }),
      highlights: [],
      basics: 23,
      tips: [
        "Threats that are hard to answer plus cheap counters and removal.",
        "Instants let you hold mana up on the opponent's turn.",
      ],
      roles: ["creature", "counterspell", "removal", "draw"],
    },
    {
      id: "midrange",
      name: "Midrange",
      summary: "Strong, resilient creatures and removal; win the long middle of the game.",
      curve: [0, 4, 9, 10, 8, 4, 1],
      kinds: kinds("mtg", { creature: 20 }),
      highlights: [],
      basics: 24,
      tips: [
        "Each card should be good on its own — two-for-ones and hard-to-remove threats.",
        "8–10 removal spells keep the opponent's best cards in check.",
      ],
      roles: ["creature", "removal", "draw"],
    },
    {
      id: "control",
      name: "Control",
      summary: "Counter, remove and wipe everything, then win with a few finishers.",
      curve: [0, 3, 8, 8, 7, 4, 4],
      kinds: kinds("mtg", { creature: 6 }),
      highlights: [],
      basics: 26,
      tips: [
        "Card draw keeps answers flowing; a handful of finishers is enough.",
        "More lands (25–27): you want to hit every land drop.",
      ],
      roles: ["removal", "counterspell", "wipe", "draw"],
    },
    {
      id: "ramp",
      name: "Ramp",
      summary: "Accelerate your mana, then cast threats the opponent can't match.",
      curve: [0, 4, 9, 7, 5, 4, 6],
      kinds: kinds("mtg", { creature: 14 }),
      highlights: [],
      basics: 25,
      tips: [
        "Early ramp (mana creatures, land search) makes the expensive top end castable.",
        "Keep a few answers so you survive until the big spells arrive.",
      ],
      roles: ["ramp", "creature", "draw"],
    },
  ];
}

/** How much each colour leans to each style, and what known colour pairs are played as. */
const MTG_COLOR_STYLES: Record<string, Record<string, number>> = {
  W: { aggro: 3, midrange: 2, control: 2, tempo: 1 },
  U: { tempo: 3, control: 3, midrange: 1, ramp: 1 },
  B: { midrange: 3, control: 2, aggro: 2, tempo: 1 },
  R: { aggro: 3, tempo: 2, midrange: 1, ramp: 1 },
  G: { ramp: 3, midrange: 2, aggro: 1 },
};
const MTG_PAIRS: Record<string, { name: string; styles: Record<string, number> }> = {
  WU: { name: "Azorius", styles: { control: 2, tempo: 1 } },
  UB: { name: "Dimir", styles: { control: 2, tempo: 1 } },
  BR: { name: "Rakdos", styles: { aggro: 2, midrange: 1 } },
  RG: { name: "Gruul", styles: { aggro: 1, ramp: 2 } },
  WG: { name: "Selesnya", styles: { midrange: 2, aggro: 1 } },
  WB: { name: "Orzhov", styles: { midrange: 2 } },
  UR: { name: "Izzet", styles: { tempo: 3 } },
  BG: { name: "Golgari", styles: { midrange: 3 } },
  WR: { name: "Boros", styles: { aggro: 3 } },
  UG: { name: "Simic", styles: { ramp: 2, tempo: 1 } },
};
const MTG_COLOR_NOTES: Record<string, string> = {
  W: "White has efficient small creatures and lifegain",
  U: "Blue has counterspells, card draw and evasion",
  B: "Black has removal and value from the graveyard",
  R: "Red has cheap damage and fast creatures",
  G: "Green has big creatures and mana acceleration",
};

// -------------------------------------------------------------- Lorcana

const LORCANA_ROLES: BuilderRole[] = [
  { id: "any", label: "Everything" },
  { id: "character", label: "Characters" },
  { id: "action", label: "Actions" },
  { id: "song", label: "Songs" },
  { id: "item", label: "Items" },
  { id: "location", label: "Locations" },
];

const inkable = (count: number): CountTarget => ({ key: "Inkable", label: "Inkable", count, atLeast: true });

const LORCANA_PLAYSTYLES: Playstyle[] = [
  {
    id: "aggro",
    name: "Aggro / lore race",
    summary: "Cheap characters that quest right away; reach 20 lore before the opponent can react.",
    curve: [8, 16, 14, 12, 6, 4, 0],
    kinds: kinds("lorcana", { character: 42, action: 6, song: 8, item: 4 }),
    highlights: [inkable(44)],
    basics: 0,
    tips: [
      "Lots of 1–3 cost characters with good lore; evasive ones are hard to stop.",
      "Around 44+ inkable cards keeps your inkwell growing every turn.",
    ],
    roles: ["character", "song"],
  },
  {
    id: "midrange",
    name: "Midrange",
    summary: "Solid characters, removal through challenges and songs, and a few strong 5+ cost cards.",
    curve: [4, 12, 14, 12, 10, 6, 2],
    kinds: kinds("lorcana", { character: 36, action: 8, song: 10, item: 6 }),
    highlights: [inkable(44)],
    basics: 0,
    tips: [
      "Songs let your characters pay for actions — count cheap singers alongside them.",
      "Mix questers with characters that challenge well.",
    ],
    roles: ["character", "song", "action"],
  },
  {
    id: "control",
    name: "Control",
    summary: "Remove and banish the opponent's characters, draw cards, then take over late.",
    curve: [2, 10, 12, 12, 10, 8, 6],
    kinds: kinds("lorcana", { character: 28, action: 14, song: 10, item: 8 }),
    highlights: [inkable(42)],
    basics: 0,
    tips: [
      "Removal actions and songs, card draw, and a few large characters to finish.",
      "High willpower characters survive challenges and hold the board.",
    ],
    roles: ["action", "song", "character", "item"],
  },
  {
    id: "ramp",
    name: "Ramp",
    summary: "Put extra cards into the inkwell early to play expensive threats ahead of time.",
    curve: [4, 10, 10, 10, 10, 8, 8],
    kinds: kinds("lorcana", { character: 30, action: 10, song: 8, item: 12 }),
    highlights: [inkable(46)],
    basics: 0,
    tips: [
      "Ramp effects are mostly Sapphire; items that add ink or draw are key.",
      "Keep enough early plays that you don't fall behind while ramping.",
    ],
    roles: ["item", "character", "action"],
  },
];

const LORCANA_INK_STYLES: Record<string, Record<string, number>> = {
  Amber: { midrange: 3, aggro: 2, ramp: 1 },
  Amethyst: { control: 2, midrange: 2, aggro: 2 },
  Emerald: { aggro: 3, midrange: 1, control: 1 },
  Ruby: { aggro: 3, midrange: 2 },
  Sapphire: { ramp: 3, control: 2, midrange: 1 },
  Steel: { control: 3, midrange: 2, ramp: 1 },
};
const LORCANA_INK_NOTES: Record<string, string> = {
  Amber: "Amber has singers, healing and characters that support each other",
  Amethyst: "Amethyst has card draw, evasion and tricks",
  Emerald: "Emerald has evasive characters and bounce",
  Ruby: "Ruby has fast, aggressive characters and challenge removal",
  Sapphire: "Sapphire has ramp, items and resilient characters",
  Steel: "Steel has removal, damage and big-bodied characters",
};

// ------------------------------------------------------------ One Piece

const ONEPIECE_ROLES: BuilderRole[] = [
  { id: "any", label: "Everything" },
  { id: "character", label: "Characters" },
  { id: "event", label: "Events" },
  { id: "stage", label: "Stages" },
];

const counters = (count: number): CountTarget => ({
  key: "With a counter",
  label: "With a counter",
  count,
  atLeast: true,
});

const ONEPIECE_PLAYSTYLES: Playstyle[] = [
  {
    id: "aggro",
    name: "Aggro / rush",
    summary: "Attack from turn one with cheap and Rush characters; take life before blockers arrive.",
    curve: [8, 12, 12, 10, 5, 2, 1],
    kinds: kinds("onepiece", { character: 42, event: 8 }),
    highlights: [counters(16)],
    basics: 0,
    tips: [
      "Cheap attackers and Rush characters; events that raise power on your turn.",
      "Counters still matter — about 16 cards with a counter keep you alive.",
    ],
    roles: ["character", "event"],
  },
  {
    id: "midrange",
    name: "Midrange",
    summary: "A steady board of good characters, removal events and a strong 5–7 cost top end.",
    curve: [6, 10, 11, 10, 7, 4, 2],
    kinds: kinds("onepiece", { character: 40, event: 10 }),
    highlights: [counters(18)],
    basics: 0,
    tips: [
      "4- and 5-cost characters that remove or draw on play are the backbone.",
      "Aim for 18 or more cards with a counter.",
    ],
    roles: ["character", "event"],
  },
  {
    id: "control",
    name: "Control",
    summary: "KO, bounce or rest the opponent's board; win late with big finishers.",
    curve: [4, 10, 10, 10, 8, 4, 4],
    kinds: kinds("onepiece", { character: 36, event: 12, stage: 2 }),
    highlights: [counters(20)],
    basics: 0,
    tips: [
      "Removal events and on-play removal characters; a few 7+ cost finishers.",
      "Lots of counters (20+) so your life lasts.",
    ],
    roles: ["event", "character", "stage"],
  },
  {
    id: "ramp",
    name: "Ramp / DON!!",
    summary: "Gain extra DON!! early to land expensive characters a turn or two ahead.",
    curve: [4, 8, 8, 10, 8, 6, 6],
    kinds: kinds("onepiece", { character: 38, event: 10, stage: 2 }),
    highlights: [counters(16)],
    basics: 0,
    tips: [
      "DON!! acceleration is mostly Purple and Green; build the top end around it.",
      "Keep cheap blockers so you survive the early turns.",
    ],
    roles: ["character", "event", "stage"],
  },
];

const ONEPIECE_COLOR_STYLES: Record<string, Record<string, number>> = {
  Red: { aggro: 3, midrange: 1 },
  Green: { midrange: 3, ramp: 2 },
  Blue: { control: 3, midrange: 1 },
  Purple: { ramp: 3, control: 1 },
  Black: { control: 3, midrange: 2 },
  Yellow: { midrange: 2, aggro: 1, control: 1 },
};
const ONEPIECE_COLOR_NOTES: Record<string, string> = {
  Red: "Red attacks with Rush and power boosts",
  Green: "Green rests the opponent's cards and plays big characters",
  Blue: "Blue returns cards to hand and controls the board",
  Purple: "Purple ramps DON!! for expensive plays",
  Black: "Black KOs characters by cost",
  Yellow: "Yellow plays around life cards and triggers",
};

// -------------------------------------------------------------- Pokémon

const POKEMON_ROLES: BuilderRole[] = [
  { id: "pokemon", label: "Pokémon" },
  { id: "trainer", label: "Trainers" },
];

const pokemonHighlights = (basic: number, stage2: number, supporters: number): CountTarget[] => [
  { key: "Basic Pokémon", label: "Basic Pokémon", count: basic, atLeast: true },
  { key: "Stage 2", label: "Stage 2", count: stage2 },
  { key: "Supporters", label: "Supporters", count: supporters, atLeast: true },
];

const POKEMON_PLAYSTYLES: Playstyle[] = [
  {
    id: "basics",
    name: "Big Basics",
    summary: "Powerful Basic Pokémon ex that attack from the first turns — no evolving needed.",
    curve: [],
    kinds: kinds("pokemon", { pokemon: 12, trainer: 38, energy: 10 }),
    highlights: pokemonHighlights(10, 0, 12),
    basics: 10,
    tips: [
      "Two or three attackers at 3–4 copies each, plus plenty of draw and search.",
      "More energy (about 10) since attackers need it right away.",
    ],
    roles: ["pokemon", "trainer"],
  },
  {
    id: "evolution",
    name: "Evolution engine",
    summary: "Build a Stage 2 line (4-3-3 or 4-2-3) around an Ability or a big attacker.",
    curve: [],
    kinds: kinds("pokemon", { pokemon: 18, trainer: 34, energy: 8 }),
    highlights: pokemonHighlights(8, 6, 10),
    basics: 8,
    tips: [
      "Count evolution lines: more Basics than Stage 1s, more Stage 1s (or Rare Candy) than Stage 2s.",
      "Search items and Rare Candy make the line come together on time.",
    ],
    roles: ["pokemon", "trainer"],
  },
  {
    id: "single-prize",
    name: "Single-prize swarm",
    summary: "Many non-ex attackers that give up only one prize card each; out-trade the opponent.",
    curve: [],
    kinds: kinds("pokemon", { pokemon: 16, trainer: 36, energy: 8 }),
    highlights: pokemonHighlights(12, 0, 10),
    basics: 8,
    tips: [
      "The opponent must knock out six Pokémon instead of three — keep attackers cheap to power up.",
      "Ways to recover Pokémon from the discard pile keep the swarm going.",
    ],
    roles: ["pokemon", "trainer"],
  },
  {
    id: "control",
    name: "Control",
    summary: "Disrupt the opponent's hand and board, stall, and win by deck-out or slow damage.",
    curve: [],
    kinds: kinds("pokemon", { pokemon: 10, trainer: 44, energy: 6 }),
    highlights: pokemonHighlights(8, 0, 14),
    basics: 6,
    tips: ["Disruption Supporters and Items, healing and switching.", "Few Pokémon, but each one sturdy."],
    roles: ["trainer", "pokemon"],
  },
];

// ------------------------------------------------------------- Yu-Gi-Oh!

const YUGIOH_ROLES: BuilderRole[] = [
  { id: "any", label: "Everything" },
  { id: "monster", label: "Monsters" },
  { id: "spell", label: "Spells" },
  { id: "trap", label: "Traps" },
  { id: "staple", label: "Staples" },
];

const YUGIOH_PLAYSTYLES: Playstyle[] = [
  {
    id: "combo",
    name: "Combo",
    summary: "Chain Special Summons into powerful Extra Deck monsters in a single turn.",
    curve: [20, 3, 1],
    kinds: kinds("yugioh", { monster: 24, spell: 14, trap: 2 }),
    highlights: [],
    basics: 0,
    tips: [
      "Stay at 40 cards to draw your starters more often.",
      "Hand traps like Ash Blossom count as monsters and fit any deck.",
    ],
    roles: ["monster", "spell", "staple"],
  },
  {
    id: "midrange",
    name: "Midrange",
    summary: "A solid board each turn with backup from spells and a few traps.",
    curve: [15, 2, 1],
    kinds: kinds("yugioh", { monster: 18, spell: 14, trap: 8 }),
    highlights: [],
    basics: 0,
    tips: ["Search spells keep your key monsters coming.", "A few interruption traps protect your board."],
    roles: ["monster", "spell", "trap"],
  },
  {
    id: "control",
    name: "Control / backrow",
    summary: "Set traps and continuous spells that stop the opponent, and grind them out.",
    curve: [10, 3, 1],
    kinds: kinds("yugioh", { monster: 14, spell: 12, trap: 14 }),
    highlights: [],
    basics: 0,
    tips: [
      "Floodgates and negation traps; monsters that protect your backrow.",
      "Card draw spells keep traps coming.",
    ],
    roles: ["trap", "spell", "monster"],
  },
  {
    id: "beatdown",
    name: "Tribute beatdown",
    summary: "Tribute Summon big monsters and hit hard, supported by spells that ease summoning.",
    curve: [9, 4, 3],
    kinds: kinds("yugioh", { monster: 16, spell: 14, trap: 10 }),
    highlights: [],
    basics: 0,
    tips: [
      "Mostly low-level monsters to tribute, with 6–7 big ones on top.",
      "Tribute fodder that replaces itself keeps your hand full.",
    ],
    roles: ["monster", "spell", "trap"],
  },
];

// ---------------------------------------------------------------- guide

export function builderGuide(game: TcgGame, format: string): BuilderGuide {
  switch (game) {
    case "mtg": {
      const commander = format === "commander";
      return {
        game,
        format,
        deckSize: commander ? 100 : 60,
        maxCopies: commander ? 1 : 4,
        identity: { kind: "colors", label: "Colours", choices: MTG_COLORS, min: 1, max: commander ? 5 : 3 },
        playstyles: mtgPlaystyles(commander),
        roles: MTG_ROLES,
        tiers: commander ? [] : TIERS_4,
        basicsLabel: "Basic lands",
        legalities: commander
          ? [{ id: "commander", label: "Commander" }]
          : [
              { id: "standard", label: "Standard" },
              { id: "pioneer", label: "Pioneer" },
              { id: "modern", label: "Modern" },
              { id: "any", label: "Any card" },
            ],
      };
    }
    case "lorcana":
      return {
        game,
        format,
        deckSize: 60,
        maxCopies: 4,
        identity: { kind: "colors", label: "Inks", choices: LORCANA_INKS, min: 1, max: 2 },
        playstyles: LORCANA_PLAYSTYLES,
        roles: LORCANA_ROLES,
        tiers: TIERS_4,
        basicsLabel: null,
        legalities: [],
      };
    case "onepiece":
      return {
        game,
        format,
        deckSize: 51,
        maxCopies: 4,
        identity: { kind: "leader", label: "Leader", choices: [], min: 1, max: 1 },
        playstyles: ONEPIECE_PLAYSTYLES,
        roles: ONEPIECE_ROLES,
        tiers: TIERS_4,
        basicsLabel: null,
        legalities: [],
      };
    case "pokemon":
      return {
        game,
        format,
        deckSize: 60,
        maxCopies: 4,
        identity: { kind: "colors", label: "Energy types", choices: POKEMON_TYPES, min: 1, max: 2 },
        playstyles: POKEMON_PLAYSTYLES,
        roles: POKEMON_ROLES,
        tiers: TIERS_4,
        basicsLabel: "Basic energy",
        legalities: [],
      };
    case "yugioh":
      return {
        game,
        format,
        deckSize: 40,
        maxCopies: 3,
        identity: { kind: "archetype", label: "Archetype", choices: [], min: 0, max: 1 },
        playstyles: YUGIOH_PLAYSTYLES,
        roles: YUGIOH_ROLES,
        tiers: TIERS_4.slice(1),
        basicsLabel: null,
        legalities: [],
      };
  }
}

export interface PlaystyleRecommendation {
  id: string;
  /** Higher is a better fit; only the order matters. */
  score: number;
  /** Why, in a sentence — or null when the choice doesn't lean either way. */
  reason: string | null;
}

/**
 * Playstyles ordered by how well they suit the chosen colours or inks
 * (for One Piece, the leader's colours). Pokémon types and Yu-Gi-Oh!
 * archetypes don't lean one way, so those keep the guide's order.
 */
export function recommendPlaystyles(
  game: TcgGame,
  format: string,
  identity: string[]
): PlaystyleRecommendation[] {
  const guide = builderGuide(game, format);
  const tables: Partial<Record<TcgGame, [Record<string, Record<string, number>>, Record<string, string>]>> = {
    mtg: [MTG_COLOR_STYLES, MTG_COLOR_NOTES],
    lorcana: [LORCANA_INK_STYLES, LORCANA_INK_NOTES],
    onepiece: [ONEPIECE_COLOR_STYLES, ONEPIECE_COLOR_NOTES],
  };
  const table = tables[game];
  const scores = new Map(guide.playstyles.map((p, i) => [p.id, -i / 100]));
  if (!table || !identity.length) {
    return guide.playstyles.map((p) => ({ id: p.id, score: scores.get(p.id) ?? 0, reason: null }));
  }
  const [styles, notes] = table;
  for (const colour of identity) {
    for (const [style, weight] of Object.entries(styles[colour] ?? {})) {
      if (scores.has(style)) scores.set(style, (scores.get(style) ?? 0) + weight);
    }
  }
  let pairName: string | null = null;
  if (game === "mtg" && identity.length === 2) {
    const order = MTG_COLORS.map((c) => c.id);
    const key = [...identity].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("");
    const pair = MTG_PAIRS[key];
    if (pair) {
      pairName = pair.name;
      for (const [style, weight] of Object.entries(pair.styles)) {
        if (scores.has(style)) scores.set(style, (scores.get(style) ?? 0) + weight);
      }
    }
  }
  const noteText = identity
    .map((c) => notes[c])
    .filter(Boolean)
    .join("; ");
  const best = Math.max(...scores.values());
  return guide.playstyles
    .map((p) => {
      const score = scores.get(p.id) ?? 0;
      const reason =
        score === best
          ? `${pairName ? `${pairName} (${identity.join("")}) often plays this. ` : ""}${noteText}.`
          : null;
      return { id: p.id, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

// ----------------------------------------------------------------- plan

export interface PlanCard {
  sourceId: string;
  name: string;
  quantity: number;
  /** Where the player put it — a Magic commander. Otherwise where the card belongs. */
  zone?: DeckZone;
  rules: Pick<CardRulesInfo, "cost" | "kind" | "traits" | "colors" | "zone" | "unlimitedCopies">;
}

/** A plan card's zone: the player's choice, else the card's own (a leader, an extra-deck monster). */
export function planZone(card: Pick<PlanCard, "zone" | "rules">): DeckZone {
  return card.zone ?? card.rules.zone;
}

export interface PlanTargetLine {
  label: string;
  count: number;
  target: number;
  atLeast: boolean;
}

export interface PlanSummary {
  /** Cards in the deck proper — for One Piece the leader is counted apart. */
  total: number;
  deckSize: number;
  stats: DeckStats;
  curveTargets: number[];
  kinds: PlanTargetLine[];
  highlights: PlanTargetLine[];
  /** The basic lands or energy the builder adds, by card name. */
  basics: Record<string, number>;
  advice: string[];
  /** About how many different cards to pick for this style, before choosing copies. */
  suggestedPicks: number;
  ready: boolean;
}

/**
 * Splits `total` basics across colours by weight (largest remainder),
 * giving every chosen colour at least one when there's room.
 */
export function splitBasics(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights);
  if (total <= 0 || !keys.length) return {};
  const sum = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  const shares = keys.map((k) => ({
    k,
    exact: sum > 0 ? (Math.max(0, weights[k]) / sum) * total : total / keys.length,
  }));
  const out: Record<string, number> = {};
  for (const s of shares) out[s.k] = Math.floor(s.exact);
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const s of [...shares].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact))
  )) {
    if (left <= 0) break;
    out[s.k]++;
    left--;
  }
  if (total >= keys.length) {
    for (const k of keys) {
      if (out[k] === 0) {
        const donor = keys.reduce((a, b) => (out[a] >= out[b] ? a : b));
        if (out[donor] > 1) {
          out[donor]--;
          out[k] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * How a plan measures up against a playstyle: totals, the curve and kind
 * mix against their targets, the basics to add, and plain advice.
 * `basicsOverride` replaces the style's basic count when the player set one.
 */
export function planSummary(
  game: TcgGame,
  format: string,
  playstyleId: string,
  identity: string[],
  cards: PlanCard[],
  basicsOverride: number | null = null
): PlanSummary {
  const guide = builderGuide(game, format);
  const style = guide.playstyles.find((p) => p.id === playstyleId) ?? guide.playstyles[0];
  const advice: string[] = [];

  // Basics: Magic lands and Pokémon energy, split by how much each colour is played.
  const basicNames = game === "mtg" ? MTG_BASIC_LANDS : game === "pokemon" ? POKEMON_BASIC_ENERGY : {};
  // Lands or energy you picked yourself (nonbasic lands, special energy) take basic slots.
  const pickedSlots = cards
    .filter((c) => c.rules.kind === (game === "mtg" ? "land" : "energy"))
    .reduce((s, c) => s + c.quantity, 0);
  const basicCount = guide.basicsLabel ? Math.max(0, basicsOverride ?? style.basics - pickedSlots) : 0;
  const weights: Record<string, number> = {};
  for (const colour of identity) if (basicNames[colour]) weights[colour] = 0;
  for (const card of cards) {
    for (const colour of card.rules.colors) {
      if (weights[colour] !== undefined) weights[colour] += card.quantity;
    }
  }
  const basics: Record<string, number> = {};
  for (const [colour, n] of Object.entries(splitBasics(basicCount, weights))) {
    if (n > 0) basics[basicNames[colour]] = n;
  }
  if (guide.basicsLabel && basicCount > 0 && !Object.keys(weights).length) {
    advice.push(
      game === "pokemon"
        ? "Dragon and Colorless have no basic energy of their own — add the energy your attackers use."
        : "Choose a colour so basic lands can be added."
    );
  }

  const statCards = [
    ...cards.map((c) => ({ quantity: c.quantity, zone: planZone(c), rules: c.rules })),
    ...Object.entries(basics).map(([, quantity]) => ({
      quantity,
      zone: "main" as DeckZone,
      rules: {
        cost: game === "mtg" ? 0 : null,
        kind: game === "mtg" ? "land" : "energy",
        traits: ["basic"],
      },
    })),
  ];
  const stats = deckStats(game, statCards, ["main", "leader"]);
  // A Magic commander counts towards 100; a One Piece leader and an extra deck don't count towards the deck.
  const inDeck = statCards.filter((c) => c.zone === "main" || (c.zone === "leader" && game === "mtg"));
  const total = inDeck.reduce((s, c) => s + c.quantity, 0);
  const deckSize = game === "onepiece" ? 50 : guide.deckSize;

  const line = (t: CountTarget, bars: Array<{ label: string; count: number }>): PlanTargetLine => ({
    label: t.label,
    count: bars.find((b) => b.label === t.label)?.count ?? 0,
    target: t.count,
    atLeast: t.atLeast === true,
  });
  const kindLines = style.kinds.map((t) => line(t, stats.kinds));
  const highlightLines = style.highlights.map((t) => line(t, stats.highlights));

  // Totals first — the thing that makes a deck a deck.
  const leaders = cards.filter((c) => planZone(c) === "leader").length;
  if (game === "onepiece" && leaders !== 1) advice.push("Pick a leader.");
  if (game === "mtg" && format === "commander" && leaders !== 1 && cards.length) {
    advice.push("Mark one legendary creature as the commander.");
  }
  if (total < deckSize) advice.push(`${deckSize - total} more cards to reach ${deckSize}.`);
  else if (total > deckSize) {
    const over = total - deckSize;
    advice.push(
      game === "mtg" && format !== "commander"
        ? `${over} over ${deckSize} — legal, but every extra card makes your best ones rarer to draw.`
        : guide.tiers.length
          ? `${over} over ${deckSize} — lower the copies of your least important cards.`
          : `${over} over ${deckSize} — take some cards out.`
    );
  }
  if (game === "yugioh") {
    const extra = statCards.filter((c) => c.zone === "extra").reduce((s, c) => s + c.quantity, 0);
    if (extra > 15) advice.push(`${extra} cards for the extra deck — at most 15.`);
  }

  // The curve, where it matters most: the cheap end for fast decks, the top for slow ones.
  const buckets = curveBuckets(game);
  if (buckets.length && style.curve.length === buckets.length && total >= deckSize * 0.5) {
    const scale = (() => {
      const planned = stats.curve.reduce((s, b) => s + b.count, 0);
      const wanted = style.curve.reduce((s, n) => s + n, 0);
      return wanted > 0 && planned > 0 ? planned / wanted : 1;
    })();
    stats.curve.forEach((bar, i) => {
      const target = Math.round(style.curve[i] * scale);
      const diff = bar.count - target;
      if (diff <= -4)
        advice.push(`${style.name} usually wants about ${target} at ${bar.label} (you have ${bar.count}).`);
      if (diff >= 4)
        advice.push(
          `${bar.count} cards at ${bar.label} is heavy for ${style.name} — about ${target} is usual.`
        );
    });
  }
  for (const l of [...kindLines, ...highlightLines]) {
    if (total < deckSize * 0.5) break;
    if (l.count < l.target - (l.atLeast ? 0 : 4)) {
      advice.push(
        `${l.label}: ${l.count} — ${style.name} usually has ${l.atLeast ? "at least " : "about "}${l.target}.`
      );
    } else if (!l.atLeast && l.count > l.target + 6) {
      advice.push(`${l.label}: ${l.count} — more than the ${l.target} or so ${style.name} usually plays.`);
    }
  }
  if (
    game === "pokemon" &&
    total > 0 &&
    !cards.some((c) => c.rules.kind === "pokemon" && c.rules.traits.includes("basic"))
  ) {
    advice.push("No Basic Pokémon yet — a deck can't start a game without one.");
  }

  const slots = deckSize - (guide.basicsLabel ? style.basics : 0);
  const averageCopies = guide.maxCopies === 1 ? 1 : guide.maxCopies === 3 ? 2.6 : 3.3;
  return {
    total,
    deckSize,
    stats,
    curveTargets: style.curve,
    kinds: kindLines,
    highlights: highlightLines,
    basics,
    advice,
    suggestedPicks: Math.round(slots / averageCopies),
    ready: total === deckSize || (game === "mtg" && format !== "commander" && total >= deckSize),
  };
}
