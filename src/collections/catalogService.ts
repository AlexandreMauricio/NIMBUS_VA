import { logger } from "../logging/logger";
import {
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
/** The least time between two requests to the same catalog — Scryfall asks for 50–100 ms. */
const MIN_REQUEST_GAP_MS = 150;

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

  constructor(
    catalogs: CardCatalog[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
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

  /** A card from a recent search, by its game and catalog id — or null. */
  resolve(game: unknown, sourceId: unknown): CatalogCard | null {
    if (!isTcgGame(game) || typeof sourceId !== "string") return null;
    const hit = this.resolvable.get(`${game}|${sourceId}`);
    if (!hit || this.now() - hit.at > RESOLVABLE_MS) return null;
    return { ...hit.card };
  }

  private async pace(game: TcgGame): Promise<void> {
    const last = this.lastRequestAt.get(game);
    const wait = last === undefined ? 0 : MIN_REQUEST_GAP_MS - (this.now() - last);
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
