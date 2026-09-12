import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import {
  CatalogCard,
  CollectionCard,
  CollectionFilter,
  CollectionState,
  CollectionStats,
  CollectionStatus,
  CollectionStore,
  MAX_COLLECTION_ENTRIES,
  MAX_NOTES_LENGTH,
  MAX_QUANTITY,
  TCG_GAMES,
  TcgGame,
  isTcgGame,
} from "./types";

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value) && value.length <= 2000;
}

/** One saved entry, checked field by field. Anything malformed is dropped, never half-used. */
export function parseCollectionCard(raw: unknown): CollectionCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (!isTcgGame(r.game)) return null;
  if (typeof r.sourceId !== "string" || !r.sourceId || r.sourceId.length > 200) return null;
  const name = text(r.name, 200);
  if (!name) return null;
  if (r.status !== "owned" && r.status !== "wishlist") return null;
  const quantity = typeof r.quantity === "number" && Number.isInteger(r.quantity) ? r.quantity : NaN;
  if (!(quantity >= 1 && quantity <= MAX_QUANTITY)) return null;
  const price =
    r.price &&
    typeof r.price === "object" &&
    typeof (r.price as Record<string, unknown>).value === "number" &&
    ["USD", "EUR"].includes((r.price as Record<string, unknown>).currency as string)
      ? (r.price as CollectionCard["price"])
      : null;
  return {
    id: r.id,
    game: r.game,
    sourceId: r.sourceId,
    name,
    setCode: text(r.setCode, 50),
    setName: text(r.setName, 200),
    number: text(r.number, 50),
    rarity: text(r.rarity, 50),
    imageUrl: isHttpsUrl(r.imageUrl) ? r.imageUrl : null,
    price,
    status: r.status,
    quantity,
    foil: r.foil === true,
    notes: text(r.notes, MAX_NOTES_LENGTH),
    addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Your card collection: what you own and what you're after. Core only —
 * persistence is the injected store, and nothing here touches the network.
 *
 * An entry is one printing, in one finish, with one status. Adding the
 * same card again (same game, printing, foil and status) adds to its
 * quantity instead of making a duplicate row.
 */
export class CollectionService {
  private cards: CollectionCard[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store?: CollectionStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {
    let raw: unknown = null;
    try {
      raw = store?.load() ?? null;
    } catch (err) {
      logger.warn("Could not read the collection — starting empty", { error: String(err) });
    }
    const list = raw && typeof raw === "object" ? (raw as { cards?: unknown }).cards : null;
    if (Array.isArray(list)) {
      let skipped = 0;
      const seen = new Set<string>();
      for (const entry of list.slice(0, MAX_COLLECTION_ENTRIES)) {
        const card = parseCollectionCard(entry);
        if (card && !seen.has(card.id)) {
          seen.add(card.id);
          this.cards.push(card);
        } else {
          skipped++;
        }
      }
      if (skipped > 0)
        logger.warn(`Skipped ${skipped} malformed collection entr${skipped === 1 ? "y" : "ies"}`);
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a printing found in a catalog, or adds to the quantity of the matching entry. */
  add(
    card: CatalogCard,
    options: { status?: CollectionStatus; foil?: boolean; quantity?: number } = {}
  ): CollectionCard {
    const status: CollectionStatus = options.status === "wishlist" ? "wishlist" : "owned";
    const foil = options.foil === true;
    const quantity = options.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new Error(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }
    const nowIso = this.now().toISOString();

    const existing = this.cards.find(
      (entry) =>
        entry.game === card.game &&
        entry.sourceId === card.sourceId &&
        entry.foil === foil &&
        entry.status === status
    );
    if (existing) {
      existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
      existing.price = card.price ?? existing.price;
      existing.updatedAt = nowIso;
      this.save();
      return { ...existing };
    }

    if (this.cards.length >= MAX_COLLECTION_ENTRIES) {
      throw new Error(`The collection is full (${MAX_COLLECTION_ENTRIES} entries).`);
    }
    const entry: CollectionCard = {
      ...card,
      id: this.newId(),
      status,
      quantity,
      foil,
      notes: null,
      addedAt: nowIso,
      updatedAt: nowIso,
    };
    this.cards.push(entry);
    this.save();
    return { ...entry };
  }

  /** Changes quantity, status, finish or notes. A quantity of 0 removes the entry. */
  update(id: string, changes: unknown): CollectionCard | null {
    const entry = this.cards.find((card) => card.id === id);
    if (!entry) throw new Error("That card is no longer in the collection.");
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      throw new Error("Nothing to change.");
    const c = changes as Record<string, unknown>;

    if ("quantity" in c) {
      const quantity = c.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > MAX_QUANTITY
      ) {
        throw new Error(`Quantity must be a whole number from 0 to ${MAX_QUANTITY}.`);
      }
      if (quantity === 0) {
        this.remove(id);
        return null;
      }
      entry.quantity = quantity;
    }
    if ("status" in c) {
      if (c.status !== "owned" && c.status !== "wishlist")
        throw new Error("Status must be owned or wishlist.");
      entry.status = c.status;
    }
    if ("foil" in c) {
      if (typeof c.foil !== "boolean") throw new Error("Foil must be true or false.");
      entry.foil = c.foil;
    }
    if ("notes" in c) {
      if (c.notes !== null && typeof c.notes !== "string") throw new Error("Notes must be text.");
      entry.notes = text(c.notes, MAX_NOTES_LENGTH);
    }
    entry.updatedAt = this.now().toISOString();
    this.save();
    return { ...entry };
  }

  remove(id: string): boolean {
    const index = this.cards.findIndex((card) => card.id === id);
    if (index === -1) return false;
    this.cards.splice(index, 1);
    this.save();
    return true;
  }

  /** Newest first. */
  list(filter: CollectionFilter = {}): CollectionCard[] {
    const needle = filter.text?.trim().toLowerCase() ?? "";
    return this.cards
      .filter((card) => !filter.game || card.game === filter.game)
      .filter((card) => !filter.status || card.status === filter.status)
      .filter(
        (card) =>
          !needle ||
          [card.name, card.setName ?? "", card.setCode ?? "", card.number ?? ""].some((field) =>
            field.toLowerCase().includes(needle)
          )
      )
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .map((card) => ({ ...card }));
  }

  stats(): CollectionStats {
    const byGame = Object.fromEntries(
      TCG_GAMES.map((game) => [game.id, { ownedCopies: 0, wishlistEntries: 0 }])
    ) as Record<TcgGame, { ownedCopies: number; wishlistEntries: number }>;
    let ownedCopies = 0;
    let ownedEntries = 0;
    let wishlistEntries = 0;
    for (const card of this.cards) {
      if (card.status === "owned") {
        ownedCopies += card.quantity;
        ownedEntries++;
        byGame[card.game].ownedCopies += card.quantity;
      } else {
        wishlistEntries++;
        byGame[card.game].wishlistEntries++;
      }
    }
    return { ownedCopies, ownedEntries, wishlistEntries, byGame };
  }

  private save(): void {
    const state: CollectionState = { version: 1, cards: this.cards };
    try {
      this.store?.save(state);
    } catch (err) {
      logger.warn("Could not save the collection", { error: String(err) });
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A collection listener threw", { error: String(err) });
      }
    }
  }
}
