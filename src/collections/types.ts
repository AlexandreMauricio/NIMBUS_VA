/**
 * Collections — the things you collect and play outside the computer,
 * starting with trading card games.
 *
 * Two halves, kept apart on purpose:
 *
 *  - a **catalog** per game (Scryfall, YGOPRODeck, TCGdex, Lorcast, the
 *    OPTCG API) that only answers "what cards match this name?" — read
 *    only, no account, nothing about you leaves the PC except the search
 *    text; and
 *  - **your collection**, which lives in `%APPDATA%\nimbus\collection.json`
 *    and is never sent anywhere.
 *
 * A card enters your collection only from a search result the main process
 * itself fetched (see CatalogService), so the renderer can never slip in
 * an image address or data of its own.
 */

export type TcgGame = "mtg" | "pokemon" | "yugioh" | "lorcana" | "onepiece";

export interface TcgGameInfo {
  id: TcgGame;
  name: string;
  /** Where its card data comes from, shown in the UI and the docs. */
  source: string;
}

export const TCG_GAMES: readonly TcgGameInfo[] = [
  { id: "mtg", name: "Magic: The Gathering", source: "Scryfall" },
  { id: "pokemon", name: "Pokémon TCG", source: "TCGdex" },
  { id: "yugioh", name: "Yu-Gi-Oh!", source: "YGOPRODeck" },
  { id: "lorcana", name: "Disney Lorcana", source: "Lorcast" },
  { id: "onepiece", name: "One Piece Card Game", source: "OPTCG API" },
];

export function isTcgGame(value: unknown): value is TcgGame {
  return TCG_GAMES.some((game) => game.id === value);
}

export interface CardPrice {
  value: number;
  currency: "USD" | "EUR";
}

/** One printing of a card, as a catalog describes it. */
export interface CatalogCard {
  game: TcgGame;
  /** The catalog's own id for this printing — stable, and what dedupes a collection. */
  sourceId: string;
  name: string;
  setCode: string | null;
  setName: string | null;
  /** Collector number or set position, e.g. "113", "OP01-025", "CT13-EN003". */
  number: string | null;
  rarity: string | null;
  /** A small image, from the catalog's own image host. */
  imageUrl: string | null;
  /** A market price as the catalog reports it — informational, one currency per source. */
  price: CardPrice | null;
}

export interface CardStat {
  label: string;
  value: string;
}

/** The facts deck rules need about a card — see decks/rules.ts. */
export interface CardRulesInfo {
  /** What copies are counted by: the name, a Lorcana name with its version, a One Piece card number. */
  copyKey: string;
  /** Basic lands, basic energy: any number allowed. */
  unlimitedCopies: boolean;
  /** Where it goes: Yu-Gi-Oh!'s extra deck, a One Piece leader, or the main deck. */
  zone: "main" | "extra" | "leader";
  /** Magic colours, Lorcana inks, One Piece colours, Pokémon types. */
  colors: string[];
  /** Yu-Gi-Oh! TCG: 0 forbidden, 1 limited, 2 semi-limited; null unrestricted. */
  banLimit: number | null;
}

/** A card's full page. */
export interface CardDetail extends CatalogCard {
  largeImageUrl: string | null;
  typeLine: string | null;
  text: string | null;
  flavor: string | null;
  stats: CardStat[];
  legalities: Array<{ format: string; status: string }>;
  artist: string | null;
  rules: CardRulesInfo;
}

/** Answers "which cards match this name?" for one game. */
export interface CardCatalog {
  readonly game: TcgGame;
  search(query: string): Promise<CatalogCard[]>;
}

export type CollectionStatus = "owned" | "wishlist";

export interface CollectionCard extends CatalogCard {
  /** NIMBUS's own id for this entry. */
  id: string;
  status: CollectionStatus;
  quantity: number;
  foil: boolean;
  notes: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface CollectionState {
  version: 1;
  cards: CollectionCard[];
}

/** Persistence, implemented by the client (src/main/collectionStore.ts). */
export interface CollectionStore {
  load(): unknown;
  save(state: CollectionState): void;
}

export interface CollectionFilter {
  game?: TcgGame;
  status?: CollectionStatus;
  /** Case-insensitive, over name, set and number. */
  text?: string;
}

export interface CollectionStats {
  /** Copies owned, counting quantity. */
  ownedCopies: number;
  /** Distinct owned entries. */
  ownedEntries: number;
  wishlistEntries: number;
  byGame: Record<TcgGame, { ownedCopies: number; wishlistEntries: number }>;
}

export const MAX_COLLECTION_ENTRIES = 20_000;
export const MAX_QUANTITY = 999;
export const MAX_NOTES_LENGTH = 500;
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
/** How many results a catalog search returns at most. */
export const MAX_SEARCH_RESULTS = 60;
