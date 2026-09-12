import { CollectionCard, TcgGame } from "../types";
import { Deck, DeckZone } from "./types";

/**
 * Each game's basic deck-construction rules, as checks with plain reasons.
 *
 * Deliberately the rules that are the same at a kitchen table and a
 * tournament — deck size, copy limits, the extra deck, a leader's colours,
 * Lorcana's two inks, the Yu-Gi-Oh! banlist as the card database reports
 * it — not every format's full banlist or rotation. Errors make a deck not
 * legal; warnings are worth a look.
 */

export interface DeckIssue {
  level: "error" | "warning";
  message: string;
}

export interface DeckCheck {
  counts: Partial<Record<DeckZone, number>>;
  total: number;
  issues: DeckIssue[];
  legal: boolean;
}

function countZone(deck: Deck, zone: DeckZone): number {
  return deck.cards.filter((card) => card.zone === zone).reduce((sum, card) => sum + card.quantity, 0);
}

/** Copies per copy key across the whole deck, with a display name for each. */
function copies(
  deck: Deck
): Map<string, { name: string; quantity: number; unlimited: boolean; banLimit: number | null }> {
  const byKey = new Map<
    string,
    { name: string; quantity: number; unlimited: boolean; banLimit: number | null }
  >();
  for (const card of deck.cards) {
    const key = card.rules.copyKey.toLowerCase();
    const entry = byKey.get(key) ?? {
      name: card.name,
      quantity: 0,
      unlimited: card.rules.unlimitedCopies,
      banLimit: card.rules.banLimit,
    };
    entry.quantity += card.quantity;
    byKey.set(key, entry);
  }
  return byKey;
}

export function checkDeck(deck: Deck): DeckCheck {
  const issues: DeckIssue[] = [];
  const error = (message: string) => issues.push({ level: "error", message });
  const warn = (message: string) => issues.push({ level: "warning", message });
  const counts: Partial<Record<DeckZone, number>> = {};
  for (const zone of ["main", "side", "extra", "leader"] as DeckZone[]) {
    const n = countZone(deck, zone);
    if (n > 0) counts[zone] = n;
  }
  const main = counts.main ?? 0;
  const copyLimit = (limit: number) => {
    for (const entry of copies(deck).values()) {
      if (!entry.unlimited && entry.quantity > limit) {
        error(`${entry.quantity} copies of ${entry.name} — at most ${limit}`);
      }
    }
  };

  switch (deck.game as TcgGame) {
    case "mtg": {
      if (deck.format === "commander") {
        const commanders = counts.leader ?? 0;
        if (commanders !== 1) error(`A Commander deck needs exactly 1 commander (has ${commanders})`);
        const total = main + commanders;
        if (total !== 100) error(`${total} cards with the commander — Commander decks are exactly 100`);
        copyLimit(1);
        const identity = new Set(
          deck.cards.filter((c) => c.zone === "leader").flatMap((c) => c.rules.colors)
        );
        if (commanders === 1) {
          const outside = deck.cards
            .filter((c) => c.zone === "main" && c.rules.colors.some((colour) => !identity.has(colour)))
            .map((c) => c.name);
          if (outside.length)
            warn(`Outside the commander's colours: ${[...new Set(outside)].slice(0, 5).join(", ")}`);
        }
      } else {
        if (main < 60) error(`${main} cards in the main deck — at least 60`);
        if ((counts.side ?? 0) > 15) error(`${counts.side} cards in the sideboard — at most 15`);
        copyLimit(4);
      }
      break;
    }
    case "pokemon": {
      if (main !== 60) error(`${main} cards — a Pokémon deck is exactly 60`);
      copyLimit(4);
      const basics = deck.cards.some((c) => /^Pokemon · Basic\b/i.test(c.typeLine ?? ""));
      if (main > 0 && !basics) warn("No Basic Pokémon — the deck can't start a game");
      break;
    }
    case "yugioh": {
      if (main < 40 || main > 60) error(`${main} cards in the main deck — 40 to 60`);
      if ((counts.extra ?? 0) > 15) error(`${counts.extra} cards in the extra deck — at most 15`);
      if ((counts.side ?? 0) > 15) error(`${counts.side} cards in the side deck — at most 15`);
      for (const entry of copies(deck).values()) {
        const limit = entry.banLimit ?? 3;
        if (entry.quantity > limit) {
          error(
            limit === 0
              ? `${entry.name} is forbidden`
              : `${entry.quantity} copies of ${entry.name} — at most ${limit}${entry.banLimit !== null ? " (banlist)" : ""}`
          );
        }
      }
      const misplaced = deck.cards.filter(
        (c) => (c.rules.zone === "extra") !== (c.zone === "extra") && c.zone !== "side"
      );
      for (const card of misplaced) {
        error(
          card.rules.zone === "extra"
            ? `${card.name} belongs in the extra deck`
            : `${card.name} can't go in the extra deck`
        );
      }
      break;
    }
    case "lorcana": {
      if (main < 60) error(`${main} cards — a Lorcana deck is at least 60`);
      copyLimit(4);
      const inks = new Set(deck.cards.flatMap((c) => c.rules.colors));
      if (inks.size > 2) error(`${inks.size} inks (${[...inks].join(", ")}) — at most 2`);
      break;
    }
    case "onepiece": {
      const leaders = deck.cards.filter((c) => c.zone === "leader");
      const leaderCount = counts.leader ?? 0;
      if (leaderCount !== 1) error(`A deck needs exactly 1 leader (has ${leaderCount})`);
      for (const card of leaders) if (card.rules.zone !== "leader") error(`${card.name} isn't a leader`);
      for (const card of deck.cards.filter((c) => c.zone === "main" && c.rules.zone === "leader")) {
        error(`${card.name} is a leader — it goes in the leader slot`);
      }
      if (main !== 50) error(`${main} cards besides the leader — exactly 50`);
      copyLimit(4);
      const leaderColours = new Set(leaders.flatMap((c) => c.rules.colors));
      if (leaderCount === 1) {
        const offColour = deck.cards.filter(
          (c) => c.zone === "main" && !c.rules.colors.some((colour) => leaderColours.has(colour))
        );
        for (const card of offColour) error(`${card.name} isn't in the leader's colours`);
      }
      break;
    }
  }

  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return { counts, total, issues, legal: !issues.some((issue) => issue.level === "error") };
}

export interface MissingLine {
  name: string;
  needed: number;
  owned: number;
  missing: number;
}

/**
 * What the deck needs that the collection doesn't have, counting copies of
 * a card in any printing (a One Piece card by its number). Wishlist entries
 * don't count as owned.
 */
export function compareWithCollection(
  deck: Deck,
  collection: CollectionCard[]
): {
  lines: MissingLine[];
  missingTotal: number;
  ownedTotal: number;
} {
  const ownedByKey = new Map<string, number>();
  for (const card of collection) {
    if (card.game !== deck.game || card.status !== "owned") continue;
    const key = (deck.game === "onepiece" ? (card.number ?? card.name) : card.name).toLowerCase();
    ownedByKey.set(key, (ownedByKey.get(key) ?? 0) + card.quantity);
  }
  const lines: MissingLine[] = [];
  for (const [key, entry] of copies(deck)) {
    const owned = ownedByKey.get(key) ?? 0;
    lines.push({
      name: entry.name,
      needed: entry.quantity,
      owned,
      missing: Math.max(0, entry.quantity - owned),
    });
  }
  lines.sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  return {
    lines,
    missingTotal: lines.reduce((sum, line) => sum + line.missing, 0),
    ownedTotal: lines.reduce((sum, line) => sum + Math.min(line.needed, line.owned), 0),
  };
}
