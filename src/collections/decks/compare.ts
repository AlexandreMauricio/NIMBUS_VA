import { bucketIndex, curveBuckets } from "./stats";

/**
 * Comparing a Commander deck with reference decks — EDHREC's average decks
 * for the same commander (the average, budget and expensive builds, and
 * the average of each popular theme): what each deck's shape is, how they
 * measure against the usual Commander deckbuilding guidelines, which cards
 * they agree on that yours lacks, and which of yours they don't play.
 *
 * Card roles (ramp, card draw, removal, board wipes) are read from each
 * card's rules text with plain patterns, so they're estimates — good
 * enough to see "8 ramp against their 12", not a card-by-card verdict.
 * Pure; the main process fetches the decks and the cards' text.
 */

export interface ReferenceCard {
  name: string;
  quantity: number;
}

export interface ReferenceDeck {
  id: string;
  label: string;
  /** How many decklists the average was built from, when known. */
  decks: number | null;
  cards: ReferenceCard[];
}

/** What the comparison needs to know about a card, by its name. */
export interface CompareCardInfo {
  sourceId: string;
  name: string;
  kind: string | null;
  cost: number | null;
  text: string | null;
  imageUrl: string | null;
}

export type CardRole = "ramp" | "draw" | "removal" | "wipe";

export const ROLE_LABELS: Record<CardRole, string> = {
  ramp: "Ramp",
  draw: "Card draw",
  removal: "Targeted removal",
  wipe: "Board wipes",
};

const ROLE_PATTERNS: Record<CardRole, RegExp> = {
  ramp: /\{T\}: Add \{|\badd (one|two|three) mana\b|\badd \{[WUBRGC]\}|search your library for (a|up to \w+) (basic )?lands?\b|\bcreate (a|two|three|\w+) Treasure|put (a|up to \w+) land cards? [^.]*onto the battlefield/i,
  draw: /\bdraws? (a|two|three|four|five|x|that many|\w+) cards?\b/i,
  removal:
    /\b(destroy|exile) (up to one )?target (creature|artifact|enchantment|planeswalker|permanent|nonland permanent|nonland)|deals? (\d+|x|damage equal to [^.]+) damage to (any target|target creature)|return target (creature|nonland permanent)[^.]* to its owner's hand|target (player|opponent) sacrifices/i,
  wipe: /\b(destroy|exile) all (other )?(creatures|nonland permanents|permanents|artifacts|enchantments)|deals? \w+ damage to each creature|all creatures get -|each player sacrifices (all|a creature)/i,
};

/** A card's roles, estimated from its rules text. A board wipe isn't also counted as targeted removal; lands aren't ramp or draw. */
export function cardRoles(info: Pick<CompareCardInfo, "kind" | "text">): CardRole[] {
  const text = info.text ?? "";
  if (!text) return [];
  const roles: CardRole[] = [];
  if (info.kind !== "land" && ROLE_PATTERNS.ramp.test(text)) roles.push("ramp");
  // A land that cycles ("draw a card") is still a land.
  if (info.kind !== "land" && ROLE_PATTERNS.draw.test(text)) roles.push("draw");
  if (ROLE_PATTERNS.wipe.test(text)) roles.push("wipe");
  else if (ROLE_PATTERNS.removal.test(text)) roles.push("removal");
  return roles;
}

export interface Guideline {
  key: "lands" | CardRole;
  label: string;
  min: number;
  max: number | null;
  why: string;
}

/**
 * The deckbuilding template most Commander players start from (as taught
 * by The Command Zone's template and EDHREC's guides): about 37 lands, 10
 * ramp, 10 card draw, 8–10 targeted removal, 2–3 board wipes — the rest is
 * the deck's plan.
 */
export const COMMANDER_GUIDELINES: Guideline[] = [
  {
    key: "lands",
    label: "Lands",
    min: 36,
    max: 38,
    why: "Enough to hit a land drop every turn up to five or six; fewer with lots of cheap ramp.",
  },
  {
    key: "ramp",
    label: "Ramp",
    min: 10,
    max: null,
    why: "Mana rocks, mana creatures and land search get you to your commander and big spells ahead of the table.",
  },
  {
    key: "draw",
    label: "Card draw",
    min: 10,
    max: null,
    why: "Games are long and there are three opponents: running out of cards loses more games than anything.",
  },
  {
    key: "removal",
    label: "Targeted removal",
    min: 8,
    max: null,
    why: "Answers for the one creature, artifact or enchantment that would otherwise win the game.",
  },
  {
    key: "wipe",
    label: "Board wipes",
    min: 2,
    max: 4,
    why: "A reset when someone gets far ahead — fewer if your own plan is a wide board.",
  },
];

export interface DeckProfile {
  label: string;
  total: number;
  lands: number;
  /** Copies per kind ("creature", "instant"…). */
  kinds: Record<string, number>;
  /** Average mana value of the non-land cards. */
  averageCost: number | null;
  curve: number[];
  roles: Record<CardRole, number>;
}

export interface MissingCard {
  name: string;
  /** How many of the reference decks play it. */
  inDecks: number;
  info: CompareCardInfo | null;
}

export interface GuidelineRow extends Guideline {
  /** Mine first, then each reference deck. */
  values: number[];
  status: "ok" | "low" | "high";
}

export interface DeckComparison {
  profiles: DeckProfile[];
  guidelines: GuidelineRow[];
  /** Per reference deck: the share of your non-basic cards it also plays, 0–100. */
  overlap: number[];
  /** Cards most reference decks play that yours doesn't, most agreed on first. */
  missing: MissingCard[];
  /** Your non-basic cards none of the reference decks play. */
  onlyMine: string[];
  /** Your cards whose text couldn't be looked up, so their roles aren't counted. */
  unknown: number;
}

/** A card's name for matching: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki" matches its front face. */
export const nameKey = (name: string): string => name.split(" // ")[0].trim().toLowerCase();

const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes"]);
const isBasic = (name: string) => BASIC_LANDS.has(nameKey(name).replace(/^snow-covered /, ""));

export function deckProfile(
  label: string,
  cards: ReferenceCard[],
  info: Map<string, CompareCardInfo>
): DeckProfile {
  const kinds: Record<string, number> = {};
  const roles: Record<CardRole, number> = { ramp: 0, draw: 0, removal: 0, wipe: 0 };
  const curve = curveBuckets("mtg").map(() => 0);
  let lands = 0;
  let total = 0;
  let costSum = 0;
  let costCount = 0;
  for (const card of cards) {
    total += card.quantity;
    const known = info.get(nameKey(card.name));
    const kind = known?.kind ?? (isBasic(card.name) ? "land" : null);
    if (kind) kinds[kind] = (kinds[kind] ?? 0) + card.quantity;
    if (kind === "land") {
      lands += card.quantity;
      continue;
    }
    if (known?.cost !== null && known?.cost !== undefined) {
      const i = bucketIndex("mtg", known.cost);
      if (i >= 0) curve[i] += card.quantity;
      costSum += known.cost * card.quantity;
      costCount += card.quantity;
    }
    if (known) for (const role of cardRoles(known)) roles[role] += card.quantity;
  }
  return {
    label,
    total,
    lands,
    kinds,
    averageCost: costCount ? Math.round((costSum / costCount) * 100) / 100 : null,
    curve,
    roles,
  };
}

export function compareWithReferences(
  mine: ReferenceCard[],
  references: ReferenceDeck[],
  info: Map<string, CompareCardInfo>
): DeckComparison {
  const profiles = [
    deckProfile("Your deck", mine, info),
    ...references.map((r) => deckProfile(r.label, r.cards, info)),
  ];

  const guidelines: GuidelineRow[] = COMMANDER_GUIDELINES.map((g) => {
    const values = profiles.map((p) => (g.key === "lands" ? p.lands : p.roles[g.key]));
    const status = values[0] < g.min ? "low" : g.max !== null && values[0] > g.max ? "high" : "ok";
    return { ...g, values, status };
  });

  const myNames = new Set(mine.filter((c) => !isBasic(c.name)).map((c) => nameKey(c.name)));
  const refSets = references.map(
    (r) => new Set(r.cards.filter((c) => !isBasic(c.name)).map((c) => nameKey(c.name)))
  );
  const overlap = refSets.map((set) =>
    myNames.size ? Math.round(([...myNames].filter((n) => set.has(n)).length / myNames.size) * 100) : 0
  );

  const counts = new Map<string, { name: string; inDecks: number }>();
  references.forEach((r, i) => {
    for (const card of r.cards) {
      const key = nameKey(card.name);
      if (isBasic(card.name) || myNames.has(key) || !refSets[i].has(key)) continue;
      const entry = counts.get(key) ?? { name: card.name, inDecks: 0 };
      entry.inDecks += 1;
      counts.set(key, entry);
    }
  });
  // One reference deck: everything it has that you don't. Several: what at least half agree on.
  const needed = Math.max(1, Math.ceil(references.length / 2));
  const missing = [...counts.values()]
    .filter((m) => m.inDecks >= needed)
    .sort((a, b) => b.inDecks - a.inDecks || a.name.localeCompare(b.name))
    .map((m) => ({ ...m, info: info.get(nameKey(m.name)) ?? null }));

  const onlyMine = mine
    .filter((c) => !isBasic(c.name) && !refSets.some((set) => set.has(nameKey(c.name))))
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));

  const unknown = mine.filter((c) => !isBasic(c.name) && !info.get(nameKey(c.name))?.text).length;
  return { profiles, guidelines, overlap, missing, onlyMine, unknown };
}
