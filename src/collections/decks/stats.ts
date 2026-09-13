import { CardRulesInfo, TcgGame } from "../types";
import { DeckZone } from "./types";

/**
 * A deck's shape at a glance: its curve (what it costs to play, by
 * turn), its kinds of card, and the counts each game's players check —
 * Lorcana's inkable cards, One Piece's counters, Pokémon's stages.
 *
 * Pure, and used by both the deck page and the deck builder, which runs it
 * over a plan that isn't a deck yet.
 */

export interface StatBar {
  label: string;
  count: number;
}

export interface CurveBucket {
  label: string;
  min: number;
  /** Inclusive; null for the open-ended last bucket. */
  max: number | null;
}

export interface DeckStats {
  /** What the curve measures ("Mana value", "Ink cost"…); null when the game has no curve. */
  curveTitle: string | null;
  curve: StatBar[];
  /** Average cost of the cards the curve counts, to one decimal. */
  averageCost: number | null;
  kinds: StatBar[];
  highlights: StatBar[];
  /** Copies saved without card data (added before 0.5.16). */
  unknown: number;
}

export interface StatCard {
  quantity: number;
  zone: DeckZone;
  rules: Pick<CardRulesInfo, "cost" | "kind" | "traits">;
}

const range = (label: string, min: number, max: number | null): CurveBucket => ({ label, min, max });

const CURVES: Record<
  TcgGame,
  { title: string; buckets: CurveBucket[]; counts: (kind: string) => boolean } | null
> = {
  mtg: {
    title: "Mana value",
    buckets: [
      range("0", 0, 0),
      range("1", 1, 1),
      range("2", 2, 2),
      range("3", 3, 3),
      range("4", 4, 4),
      range("5", 5, 5),
      range("6+", 6, null),
    ],
    counts: (kind) => kind !== "land",
  },
  lorcana: {
    title: "Ink cost",
    buckets: [
      range("1", 0, 1),
      range("2", 2, 2),
      range("3", 3, 3),
      range("4", 4, 4),
      range("5", 5, 5),
      range("6", 6, 6),
      range("7+", 7, null),
    ],
    counts: () => true,
  },
  onepiece: {
    title: "Cost",
    buckets: [
      range("1", 0, 1),
      range("2", 2, 2),
      range("3", 3, 3),
      range("4", 4, 4),
      range("5", 5, 5),
      range("6", 6, 6),
      range("7+", 7, null),
    ],
    counts: (kind) => kind !== "leader",
  },
  yugioh: {
    title: "Monster level",
    buckets: [
      range("1–4 (no tribute)", 0, 4),
      range("5–6 (1 tribute)", 5, 6),
      range("7+ (2 tributes)", 7, null),
    ],
    counts: (kind) => kind === "monster",
  },
  pokemon: null,
};

/** The kinds of card a game has, in the order they're shown, with their labels. */
export const KIND_LABELS: Record<TcgGame, Array<[string, string]>> = {
  mtg: [
    ["creature", "Creatures"],
    ["instant", "Instants"],
    ["sorcery", "Sorceries"],
    ["artifact", "Artifacts"],
    ["enchantment", "Enchantments"],
    ["planeswalker", "Planeswalkers"],
    ["battle", "Battles"],
    ["land", "Lands"],
  ],
  lorcana: [
    ["character", "Characters"],
    ["action", "Actions"],
    ["song", "Songs"],
    ["item", "Items"],
    ["location", "Locations"],
  ],
  onepiece: [
    ["character", "Characters"],
    ["event", "Events"],
    ["stage", "Stages"],
  ],
  pokemon: [
    ["pokemon", "Pokémon"],
    ["trainer", "Trainers"],
    ["energy", "Energy"],
  ],
  yugioh: [
    ["monster", "Monsters"],
    ["spell", "Spells"],
    ["trap", "Traps"],
  ],
};

/** The curve's buckets for a game, or [] when it has none. */
export function curveBuckets(game: TcgGame): CurveBucket[] {
  return CURVES[game]?.buckets ?? [];
}

/** Which bucket a cost falls in, or -1. */
export function bucketIndex(game: TcgGame, cost: number): number {
  return curveBuckets(game).findIndex((b) => cost >= b.min && (b.max === null || cost <= b.max));
}

/** Whether a card of this kind counts towards the game's curve. */
export function countsOnCurve(game: TcgGame, kind: string | null): boolean {
  const curve = CURVES[game];
  return !!curve && kind !== null && curve.counts(kind);
}

export function deckStats(game: TcgGame, cards: StatCard[], zones: DeckZone[] = ["main"]): DeckStats {
  const inPlay = cards.filter((card) => zones.includes(card.zone));
  const curveDef = CURVES[game];
  const curve = (curveDef?.buckets ?? []).map((b) => ({ label: b.label, count: 0 }));
  let costSum = 0;
  let costCount = 0;
  let unknown = 0;
  const kindCounts = new Map<string, number>();
  const trait = (name: string, card: StatCard) => (card.rules.traits.includes(name) ? card.quantity : 0);
  const highlightTotals = new Map<string, number>();
  const addHighlight = (label: string, n: number) =>
    highlightTotals.set(label, (highlightTotals.get(label) ?? 0) + n);

  for (const card of inPlay) {
    const { kind, cost } = card.rules;
    if (kind === null) {
      unknown += card.quantity;
      continue;
    }
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + card.quantity);
    if (curveDef && curveDef.counts(kind) && cost !== null) {
      const i = bucketIndex(game, cost);
      if (i >= 0) curve[i].count += card.quantity;
      costSum += cost * card.quantity;
      costCount += card.quantity;
    }
    switch (game) {
      case "lorcana":
        addHighlight("Inkable", trait("inkable", card));
        break;
      case "onepiece":
        if (kind !== "leader") {
          addHighlight("With a counter", trait("counter", card));
          addHighlight("With a trigger", trait("trigger", card));
        }
        break;
      case "pokemon":
        if (kind === "pokemon") {
          addHighlight("Basic Pokémon", trait("basic", card));
          addHighlight("Stage 1", trait("stage1", card));
          addHighlight("Stage 2", trait("stage2", card));
        }
        if (kind === "trainer") {
          addHighlight("Supporters", trait("supporter", card));
          addHighlight("Items", trait("item", card) + trait("tool", card));
          addHighlight("Stadiums", trait("stadium", card));
        }
        break;
    }
  }

  const kinds = KIND_LABELS[game]
    .filter(([kind]) => (kindCounts.get(kind) ?? 0) > 0)
    .map(([kind, label]) => ({ label, count: kindCounts.get(kind) ?? 0 }));
  // A kind this list doesn't know yet still shows, under its own name.
  for (const [kind, count] of kindCounts) {
    if (!KIND_LABELS[game].some(([known]) => known === kind) && !(game === "onepiece" && kind === "leader")) {
      kinds.push({ label: kind.charAt(0).toUpperCase() + kind.slice(1), count });
    }
  }

  return {
    curveTitle: curveDef?.title ?? null,
    curve,
    averageCost: costCount ? Math.round((costSum / costCount) * 10) / 10 : null,
    kinds,
    highlights: [...highlightTotals].map(([label, count]) => ({ label, count })),
    unknown,
  };
}
