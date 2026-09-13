import { splitBasicsByWeight } from "./split";

/**
 * Magic colour balance: how much of each colour a deck's spells ask for,
 * how many lands of each colour it takes to cast them on time, and how to
 * split the basic lands so no colour is starved.
 *
 * The source counts are Frank Karsten's ("How Many Sources Do You Need to
 * Consistently Cast Your Spells?", 2022 update, 60-card decks): how many
 * lands producing a colour give about a 90% chance to cast a spell on
 * curve. A 100-card Commander deck scales them up by its land count. They
 * are guidance, and the deck page says so.
 */

export const COLOUR_NAMES: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
};

/** Karsten's sources for 60 cards: coloured symbols → the turn it's cast → sources. */
const SOURCES_60: Record<number, Record<number, number>> = {
  1: { 1: 14, 2: 13, 3: 12, 4: 11, 5: 10, 6: 9 },
  2: { 2: 21, 3: 18, 4: 16, 5: 15, 6: 14 },
  3: { 3: 23, 4: 21, 5: 19, 6: 18 },
  4: { 4: 24, 5: 22, 6: 21 },
};

/** Lands producing a colour needed to cast a spell with `symbols` of it by turn `manaValue`, in a deck of `deckSize`. */
export function sourcesNeeded(symbols: number, manaValue: number, deckSize = 60): number {
  const n = Math.min(4, Math.max(1, Math.floor(symbols)));
  const turn = Math.min(6, Math.max(n, Math.round(manaValue) || 1));
  const base = SOURCES_60[n][turn] ?? SOURCES_60[n][Math.max(...Object.keys(SOURCES_60[n]).map(Number))];
  // Commander plays ~37 lands to a 60-card deck's ~24: scale the same way.
  return deckSize > 60 ? Math.round(base * 1.5) : base;
}

export interface ManaCard {
  name: string;
  quantity: number;
  kind: string | null;
  cost: number | null;
  pips?: Record<string, number>;
  produces?: string[];
  basic?: boolean;
}

export interface ColourLine {
  colour: string;
  label: string;
  /** Coloured symbols of this colour across the deck's spells, counting copies. */
  symbols: number;
  /** Share of all coloured symbols, 0–100. */
  share: number;
  /** Copies of spells that need this colour. */
  cards: number;
  /** Lands that make it: basics given plus nonbasic lands in the deck. */
  sources: number;
  /** Sources the most demanding spell of this colour asks for, and which spell. */
  needed: number;
  hardest: string | null;
}

export interface ColourBalance {
  lines: ColourLine[];
  /** Basic lands per colour letter. */
  basics: Record<string, number>;
  advice: string[];
}

/**
 * Splits `basicCount` basic lands across the chosen colours so each gets the
 * sources its hardest spell needs where possible, then shares what's left
 * by how many symbols each colour has — and says what doesn't add up.
 */
export function balanceColours(
  identity: string[],
  cards: ManaCard[],
  basicCount: number,
  deckSize = 60
): ColourBalance {
  const colours = identity.filter((c) => COLOUR_NAMES[c]);
  const spells = cards.filter((c) => c.kind !== "land");
  const lands = cards.filter((c) => c.kind === "land" && !c.basic);

  const lines: ColourLine[] = colours.map((colour) => {
    let symbols = 0;
    let copies = 0;
    let needed = 0;
    let hardest: string | null = null;
    for (const card of spells) {
      const n = card.pips?.[colour] ?? 0;
      if (n <= 0) continue;
      symbols += n * card.quantity;
      copies += card.quantity;
      if (n >= 1) {
        const need = sourcesNeeded(n, card.cost ?? n, deckSize);
        if (need > needed) {
          needed = need;
          hardest = card.name;
        }
      }
    }
    const nonbasic = lands.filter((l) => l.produces?.includes(colour)).reduce((s, l) => s + l.quantity, 0);
    return {
      colour,
      label: COLOUR_NAMES[colour],
      symbols,
      share: 0,
      cards: copies,
      sources: nonbasic,
      needed,
      hardest,
    };
  });
  const totalSymbols = lines.reduce((s, l) => s + l.symbols, 0);
  for (const line of lines) line.share = totalSymbols ? Math.round((line.symbols / totalSymbols) * 100) : 0;

  // Basics: first what each colour is short of, then the rest by symbols.
  const shortfall: Record<string, number> = {};
  for (const line of lines) shortfall[line.colour] = Math.max(0, line.needed - line.sources);
  const shortTotal = Object.values(shortfall).reduce((a, b) => a + b, 0);
  const advice: string[] = [];
  let basics: Record<string, number> = {};
  if (basicCount > 0 && lines.length) {
    if (shortTotal === 0) {
      basics = splitBasicsByWeight(
        basicCount,
        Object.fromEntries(lines.map((l) => [l.colour, totalSymbols ? l.symbols : 1]))
      );
    } else if (shortTotal <= basicCount) {
      basics = { ...shortfall };
      const extra = splitBasicsByWeight(
        basicCount - shortTotal,
        Object.fromEntries(lines.map((l) => [l.colour, totalSymbols ? l.symbols : 1]))
      );
      for (const [c, n] of Object.entries(extra)) basics[c] = (basics[c] ?? 0) + n;
    } else {
      basics = splitBasicsByWeight(basicCount, shortfall);
    }
    for (const colour of Object.keys(basics)) if (!basics[colour]) delete basics[colour];
  }
  for (const line of lines) line.sources += basics[line.colour] ?? 0;

  // What doesn't add up, worst first.
  for (const line of lines) {
    if (line.needed > line.sources && line.hardest) {
      advice.push(
        `${line.label}: ${line.sources} lands make it, but ${line.hardest} wants about ${line.needed} to be cast on time — add dual lands, cut some ${line.label.toLowerCase()} symbols, or move it later in the curve.`
      );
    }
  }
  if (lines.length >= 2 && totalSymbols > 0) {
    for (const line of lines) {
      if (line.symbols === 0) {
        advice.push(
          `Nothing needs ${line.label.toLowerCase()} yet — drop the colour and the mana gets more reliable.`
        );
      }
    }
    const main = lines.reduce((a, b) => (a.share >= b.share ? a : b));
    if (main.share >= 80) {
      advice.push(
        `${main.share}% of the coloured symbols are ${main.label.toLowerCase()} — the other colour${lines.length > 2 ? "s are" : " is"} a splash: keep those cards to one symbol, or play mono-${main.label.toLowerCase()}.`
      );
    }
  }
  if (lines.length >= 3) {
    const duals = lands.reduce(
      (s, l) => s + ((l.produces ?? []).filter((m) => colours.includes(m)).length >= 2 ? l.quantity : 0),
      0
    );
    if (duals < 6) {
      advice.push(
        `${lines.length} colours with ${duals} dual lands — three or more colours usually need 8+ lands that make two of them ("Nonbasic lands" finds them).`
      );
    }
  }
  return { lines, basics, advice };
}
