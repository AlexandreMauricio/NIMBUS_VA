import { logger } from "../logging/logger";
import { DetailFetcher } from "./catalogs/details";
import { sameCardName } from "./decks/decklist";
import {
  CardDetail,
  CardCatalog,
  CatalogCard,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  TCG_GAMES,
  TcgGame,
  isTcgGame,
} from "./types";

const RESULT_CACHE_MS = 10 * 60_000;
/** How long a search result can still be added to the collection. */
const RESOLVABLE_MS = 60 * 60_000;
const MAX_RESOLVABLE = 3000;
/** The least time between two requests to the same catalog. */
const MIN_REQUEST_GAP_MS = 150;
/** Scryfall allows about 2 requests a second on its search endpoints. */
const GAME_REQUEST_GAP_MS: Partial<Record<TcgGame, number>> = { mtg: 550 };

/** Cards by exact name, many per request — for games whose catalog offers it. */
export type BulkNameLookup = (names: string[]) => Promise<{ found: CardDetail[]; notFound: string[] }>;

export interface NameLookupResult {
  /** Found cards, keyed by the name as asked for, lowercased. */
  found: Map<string, CardDetail>;
  /** Names the catalog doesn't have. */
  notFound: string[];
  /** Names that couldn't be looked up just now — worth trying again. */
  failed: string[];
}

/** A double-faced Magic card is "Front // Back"; a decklist often names only the front. */
function nameMatches(cardName: string, asked: string): boolean {
  return sameCardName(cardName, asked) || sameCardName(cardName.split(" // ")[0], asked);
}

/**
 * Searches the card catalogs, one per game, and remembers what it found.
 *
 * Remembering is the security boundary as much as a cache: the Collections
 * tab adds a card by `game` + `sourceId` only, and the card's data (name,
 * set, image address, price) is taken from a result this service fetched
 * itself. A renderer can't add a card that no catalog returned, nor put an
 * image address of its choosing into the collection.
 */
export class CatalogService {
  private readonly catalogs = new Map<TcgGame, CardCatalog>();
  private readonly cache = new Map<string, { at: number; cards: CatalogCard[] }>();
  private readonly resolvable = new Map<string, { at: number; card: CatalogCard }>();
  private readonly lastRequestAt = new Map<TcgGame, number>();
  private readonly details = new Map<string, { at: number; detail: CardDetail | null }>();

  constructor(
    catalogs: CardCatalog[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly detailFetchers: Partial<Record<TcgGame, DetailFetcher>> = {},
    private readonly bulkByName: Partial<Record<TcgGame, BulkNameLookup>> = {}
  ) {
    for (const catalog of catalogs) this.catalogs.set(catalog.game, catalog);
  }

  games(): Array<{ id: TcgGame; name: string; source: string; available: boolean }> {
    return TCG_GAMES.map((game) => ({ ...game, available: this.catalogs.has(game.id) }));
  }

  async search(game: unknown, query: unknown): Promise<CatalogCard[]> {
    if (!isTcgGame(game)) throw new Error("Choose a game to search.");
    const catalog = this.catalogs.get(game);
    if (!catalog) throw new Error("That game has no card database yet.");
    const text = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
    if (text.length < MIN_QUERY_LENGTH) throw new Error(`Type at least ${MIN_QUERY_LENGTH} characters.`);
    if (text.length > MAX_QUERY_LENGTH)
      throw new Error(`Searches are at most ${MAX_QUERY_LENGTH} characters.`);

    const key = `${game}|${text.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < RESULT_CACHE_MS) return cached.cards.map((card) => ({ ...card }));

    await this.pace(game);
    let cards: CatalogCard[];
    try {
      cards = (await catalog.search(text)).filter((card) => card.game === game);
    } catch (err) {
      logger.warn("Card search failed", { game, error: String(err) });
      throw new Error("The card database couldn't be reached. Try again in a moment.");
    }

    const at = this.now();
    this.cache.set(key, { at, cards });
    for (const card of cards) this.resolvable.set(`${game}|${card.sourceId}`, { at, card });
    this.prune(at);
    return cards.map((card) => ({ ...card }));
  }

  /**
   * A card's full page, by game and catalog id. Kept for an hour, and —
   * like a search result — resolvable for adding to the collection or a
   * deck afterwards.
   */
  async getDetail(game: unknown, sourceId: unknown): Promise<CardDetail> {
    if (!isTcgGame(game)) throw new Error("Choose a game.");
    if (typeof sourceId !== "string" || !sourceId || sourceId.length > 120)
      throw new Error("That isn't a card id.");
    const fetcher = this.detailFetchers[game];
    if (!fetcher) throw new Error("That game has no card pages yet.");
    const key = `${game}|${sourceId}`;
    const cached = this.details.get(key);
    let detail: CardDetail | null;
    if (cached && this.now() - cached.at < RESOLVABLE_MS) {
      detail = cached.detail;
    } else {
      await this.pace(game);
      try {
        detail = await fetcher(sourceId);
      } catch (err) {
        logger.warn("Card page failed", { game, error: String(err) });
        throw new Error("The card database couldn't be reached. Try again in a moment.");
      }
      this.details.set(key, { at: this.now(), detail });
    }
    if (!detail || detail.game !== game) throw new Error("The card database doesn't have that card.");
    this.resolvable.set(key, { at: this.now(), card: detail });
    return { ...detail };
  }

  /**
   * Cards by exact name — what a decklist import needs. Uses the game's
   * bulk lookup when it has one (Magic: 75 names a request); otherwise a
   * paced search and card lookup per name. Every card found becomes
   * resolvable, like a search result.
   */
  async lookupByNames(game: unknown, names: string[]): Promise<NameLookupResult> {
    if (!isTcgGame(game)) throw new Error("Choose a game.");
    const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()].slice(0, 250);
    const result: NameLookupResult = { found: new Map(), notFound: [], failed: [] };
    const remember = (asked: string, detail: CardDetail) => {
      result.found.set(asked.toLowerCase(), detail);
      const key = `${game}|${detail.sourceId}`;
      this.details.set(key, { at: this.now(), detail });
      this.resolvable.set(key, { at: this.now(), card: detail });
    };

    const bulk = this.bulkByName[game];
    if (bulk) {
      try {
        await this.pace(game);
        const { found } = await bulk(unique);
        for (const asked of unique) {
          const match = found.find((card) => nameMatches(card.name, asked));
          if (match) remember(asked, match);
          else result.notFound.push(asked);
        }
      } catch (err) {
        logger.warn("Bulk card lookup failed", { game, error: String(err) });
        result.failed.push(...unique);
      }
      return result;
    }

    for (const asked of unique) {
      try {
        const cards = await this.search(game, asked);
        const match = cards.find((card) => nameMatches(card.name, asked));
        if (!match) {
          result.notFound.push(asked);
          continue;
        }
        remember(asked, await this.getDetail(game, match.sourceId));
      } catch (err) {
        if (/doesn't have that card|at least|at most/i.test(String(err))) result.notFound.push(asked);
        else result.failed.push(asked);
      }
    }
    return result;
  }

  /** A card from a recent search, by its game and catalog id — or null. */
  resolve(game: unknown, sourceId: unknown): CatalogCard | null {
    if (!isTcgGame(game) || typeof sourceId !== "string") return null;
    const hit = this.resolvable.get(`${game}|${sourceId}`);
    if (!hit || this.now() - hit.at > RESOLVABLE_MS) return null;
    return { ...hit.card };
  }

  private async pace(game: TcgGame): Promise<void> {
    const last = this.lastRequestAt.get(game);
    const gap = GAME_REQUEST_GAP_MS[game] ?? MIN_REQUEST_GAP_MS;
    const wait = last === undefined ? 0 : gap - (this.now() - last);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt.set(game, this.now());
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) if (now - entry.at >= RESULT_CACHE_MS) this.cache.delete(key);
    for (const [key, entry] of this.resolvable)
      if (now - entry.at > RESOLVABLE_MS) this.resolvable.delete(key);
    // Oldest first, when a long session searched a lot.
    while (this.resolvable.size > MAX_RESOLVABLE) {
      const oldest = this.resolvable.keys().next().value;
      if (oldest === undefined) break;
      this.resolvable.delete(oldest);
    }
  }
}
