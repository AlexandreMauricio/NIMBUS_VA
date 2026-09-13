import { CardRulesInfo, TcgGame } from "../types";

/**
 * How many copies of a card to play, explained: what each count means,
 * the real chance of drawing it, and a suggestion for a given card from
 * the usual reasons to play fewer than the maximum.
 */

/** Cards in a first hand: 7 in Magic, Lorcana and Pokémon; 5 in One Piece and Yu-Gi-Oh!. */
export const OPENING_HAND: Record<TcgGame, number> = {
  mtg: 7,
  lorcana: 7,
  pokemon: 7,
  onepiece: 5,
  yugioh: 5,
};

/**
 * The chance, 0–100, of at least one of `copies` among the first `seen`
 * cards of a `deckSize` deck (hypergeometric).
 */
export function drawChance(deckSize: number, copies: number, seen: number): number {
  if (copies <= 0 || seen <= 0 || deckSize <= 0) return 0;
  if (copies >= deckSize || seen >= deckSize) return 100;
  let none = 1;
  for (let i = 0; i < seen; i++) none *= (deckSize - copies - i) / (deckSize - i);
  return Math.round((1 - Math.max(0, none)) * 100);
}

export interface CopyExplanation {
  copies: number;
  label: string;
  when: string;
  /** % to have at least one in the opening hand. */
  openingHand: number;
  /** % to have seen at least one after three more draws. */
  byTurnThree: number;
}

const MEANINGS: Record<number, [string, string]> = {
  4: [
    "Core",
    "What the deck is built around, or the best card at its job. You want it in almost every game, and a second copy is still good.",
  ],
  3: [
    "Strong",
    "Great, but drawing two hurts a little: a legendary card, an expensive card, a card that's best once per game.",
  ],
  2: ["Situational", "Good in some games or late in the game — you're happy to see one, rarely want two."],
  1: [
    "One-of",
    "A tool for a specific moment or a card you search for. You'll rarely draw it, so the deck mustn't depend on it.",
  ],
};

/** Each copy count from `maxCopies` down to 1, with its meaning and draw chances. */
export function explainCopies(game: TcgGame, deckSize: number, maxCopies: number): CopyExplanation[] {
  const hand = OPENING_HAND[game];
  const out: CopyExplanation[] = [];
  for (let copies = maxCopies; copies >= 1; copies--) {
    const [label, when] = MEANINGS[copies] ?? MEANINGS[1];
    out.push({
      copies,
      label,
      when,
      openingHand: drawChance(deckSize, copies, hand),
      byTurnThree: drawChance(deckSize, copies, hand + 3),
    });
  }
  return out;
}

export interface CopySuggestion {
  copies: number;
  /** Why fewer than the maximum, or null when the maximum is right. */
  reason: string | null;
}

/** The cost from which a card counts as expensive, by game and how fast the style is. A Yu-Gi-Oh! level is a tribute count, not a cost. */
const HEAVY_FROM: Record<"mtg" | "yugioh" | "other", Record<"fast" | "normal" | "slow", number>> = {
  mtg: { fast: 4, normal: 6, slow: 7 },
  yugioh: { fast: 7, normal: 7, slow: 99 },
  other: { fast: 5, normal: 7, slow: 8 },
};

/**
 * A suggested count for one card in a playstyle: the maximum, unless a
 * usual reason says fewer — a legendary (the second copy can't be played),
 * a card expensive for the style, a later evolution stage, a ban limit.
 */
export function suggestCopies(
  game: TcgGame,
  playstyle: string,
  maxCopies: number,
  card: { typeLine: string | null; rules: Pick<CardRulesInfo, "cost" | "kind" | "traits" | "banLimit"> }
): CopySuggestion {
  if (maxCopies <= 1) return { copies: 1, reason: null };
  const { cost, kind, traits, banLimit } = card.rules;
  if (banLimit !== null && banLimit !== undefined && banLimit < maxCopies) {
    return { copies: Math.max(0, banLimit), reason: `the banlist allows ${banLimit}` };
  }
  if (traits.includes("basic") || kind === "land") return { copies: maxCopies, reason: null };
  const fast = ["aggro", "tempo", "basics", "single-prize", "combo"].includes(playstyle);
  const slow = ["control", "ramp"].includes(playstyle);

  if (game === "mtg" && /\blegendary\b/i.test(card.typeLine ?? "") && kind !== "land") {
    return {
      copies: Math.min(maxCopies, 3),
      reason: "legendary — a second copy in hand can't be played while the first is out",
    };
  }
  if (game === "pokemon" && kind === "pokemon") {
    if (traits.includes("stage2"))
      return {
        copies: Math.min(maxCopies, 3),
        reason: "Stage 2 — play a few less than its Basic, as in a 4-3-3 line",
      };
    if (traits.includes("stage1"))
      return { copies: Math.min(maxCopies, 3), reason: "Stage 1 — one less than its Basic is usual" };
  }
  if (cost !== null && kind !== "leader") {
    const table = HEAVY_FROM[game === "mtg" || game === "yugioh" ? game : "other"];
    const heavy = table[fast ? "fast" : slow ? "slow" : "normal"];
    if (cost >= heavy) {
      return {
        copies: Math.min(maxCopies, 2),
        reason: `costs ${cost} — expensive for this style, and two stuck in hand early is a lost turn`,
      };
    }
  }
  return { copies: maxCopies, reason: null };
}
