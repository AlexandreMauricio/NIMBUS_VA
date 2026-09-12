import { CardRulesInfo, TcgGame } from "../types";

/**
 * Decks — a list of cards per game, in that game's zones, checked against
 * that game's basic construction rules (see rules.ts).
 *
 * A deck card keeps a snapshot of what its rules need (copy key, zone,
 * colours, ban limit) from the card's page when it was added, so a deck can
 * be checked offline and instantly, without asking a database per card.
 */

export type DeckZone = "main" | "side" | "extra" | "leader";

export interface DeckCard {
  sourceId: string;
  name: string;
  zone: DeckZone;
  quantity: number;
  setCode: string | null;
  number: string | null;
  imageUrl: string | null;
  typeLine: string | null;
  rules: CardRulesInfo;
}

export interface Deck {
  id: string;
  game: TcgGame;
  name: string;
  /** One of DECK_FORMATS[game]. */
  format: string;
  notes: string | null;
  cards: DeckCard[];
  createdAt: string;
  updatedAt: string;
}

export interface DeckState {
  version: 1;
  decks: Deck[];
}

export interface DeckStore {
  load(): unknown;
  save(state: DeckState): void;
}

export interface DeckFormat {
  id: string;
  label: string;
}

/** The formats a deck can be checked against — the common one per game, and Commander for Magic. */
export const DECK_FORMATS: Record<TcgGame, DeckFormat[]> = {
  mtg: [
    { id: "constructed", label: "Constructed — 60+ cards, 4 copies, 15 sideboard" },
    { id: "commander", label: "Commander — 100 cards with the commander, 1 copy each" },
  ],
  pokemon: [{ id: "standard", label: "Standard — exactly 60 cards, 4 copies" }],
  yugioh: [{ id: "advanced", label: "Advanced — 40–60 main, 15 extra, 15 side, 3 copies and the banlist" }],
  lorcana: [{ id: "core", label: "Core — 60+ cards, 4 copies, up to 2 inks" }],
  onepiece: [{ id: "standard", label: "Standard — 1 leader and 50 cards, 4 copies, the leader's colours" }],
};

/** Which zones a game's decks use, in display order. */
export function zonesFor(game: TcgGame, format: string): DeckZone[] {
  switch (game) {
    case "mtg":
      return format === "commander" ? ["leader", "main"] : ["main", "side"];
    case "yugioh":
      return ["main", "extra", "side"];
    case "onepiece":
      return ["leader", "main"];
    default:
      return ["main"];
  }
}

export function zoneLabel(game: TcgGame, zone: DeckZone): string {
  if (zone === "leader") return game === "mtg" ? "Commander" : "Leader";
  if (zone === "side") return "Sideboard";
  if (zone === "extra") return "Extra deck";
  return game === "mtg" || game === "yugioh" ? "Main deck" : "Deck";
}

export const MAX_DECKS = 500;
export const MAX_DECK_CARD_QUANTITY = 99;
export const MAX_DECK_ENTRIES = 400;
