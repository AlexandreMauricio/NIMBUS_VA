import { randomUUID } from "crypto";
import { logger } from "../../logging/logger";
import { CardDetail, TcgGame, isTcgGame } from "../types";
import {
  DECK_FORMATS,
  Deck,
  DeckCard,
  DeckState,
  DeckStore,
  DeckZone,
  MAX_DECKS,
  MAX_DECK_CARD_QUANTITY,
  MAX_DECK_ENTRIES,
  zonesFor,
} from "./types";

const ZONES: DeckZone[] = ["main", "side", "extra", "leader"];

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

function parseDeckCard(raw: unknown): DeckCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rules = (r.rules ?? {}) as Record<string, unknown>;
  const sourceId = text(r.sourceId, 120);
  const name = text(r.name, 200);
  const copyKey = text(rules.copyKey, 200);
  if (!sourceId || !name || !copyKey || !ZONES.includes(r.zone as DeckZone)) return null;
  if (
    !Number.isInteger(r.quantity) ||
    (r.quantity as number) < 1 ||
    (r.quantity as number) > MAX_DECK_CARD_QUANTITY
  ) {
    return null;
  }
  return {
    sourceId,
    name,
    zone: r.zone as DeckZone,
    quantity: r.quantity as number,
    setCode: text(r.setCode, 50),
    number: text(r.number, 50),
    imageUrl: typeof r.imageUrl === "string" && /^https:\/\//i.test(r.imageUrl) ? r.imageUrl : null,
    typeLine: text(r.typeLine, 200),
    rules: {
      copyKey,
      unlimitedCopies: rules.unlimitedCopies === true,
      zone: rules.zone === "extra" || rules.zone === "leader" ? rules.zone : "main",
      colors: Array.isArray(rules.colors)
        ? rules.colors.filter((c): c is string => typeof c === "string").slice(0, 10)
        : [],
      banLimit: Number.isInteger(rules.banLimit) ? (rules.banLimit as number) : null,
    },
  };
}

export function parseDeck(raw: unknown): Deck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || !isTcgGame(r.game)) return null;
  const name = text(r.name, 100);
  if (!name) return null;
  const format = DECK_FORMATS[r.game].some((f) => f.id === r.format)
    ? (r.format as string)
    : DECK_FORMATS[r.game][0].id;
  const cards = Array.isArray(r.cards)
    ? r.cards
        .map(parseDeckCard)
        .filter((c): c is DeckCard => c !== null)
        .slice(0, MAX_DECK_ENTRIES)
    : [];
  return {
    id: r.id,
    game: r.game,
    name,
    format,
    notes: text(r.notes, 1000),
    cards,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Your decks. Core only — cards come in as CardDetail the main process
 * fetched itself, and the injected store persists the decks.
 */
export class DeckService {
  private decks: Deck[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store?: DeckStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {
    let raw: unknown = null;
    try {
      raw = store?.load() ?? null;
    } catch (err) {
      logger.warn("Could not read decks — starting empty", { error: String(err) });
    }
    const list = raw && typeof raw === "object" ? (raw as { decks?: unknown }).decks : null;
    if (Array.isArray(list)) {
      const seen = new Set<string>();
      for (const entry of list.slice(0, MAX_DECKS)) {
        const deck = parseDeck(entry);
        if (deck && !seen.has(deck.id)) {
          seen.add(deck.id);
          this.decks.push(deck);
        }
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Deck[] {
    return this.decks
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((deck) => this.copy(deck));
  }

  get(id: string): Deck {
    return this.copy(this.find(id));
  }

  create(input: unknown): Deck {
    if (this.decks.length >= MAX_DECKS) throw new Error(`At most ${MAX_DECKS} decks.`);
    const i = (input ?? {}) as Record<string, unknown>;
    if (!isTcgGame(i.game)) throw new Error("Choose a game for the deck.");
    const name = text(i.name, 100);
    if (!name) throw new Error("A deck needs a name.");
    const format = DECK_FORMATS[i.game].some((f) => f.id === i.format)
      ? (i.format as string)
      : DECK_FORMATS[i.game][0].id;
    const at = this.now().toISOString();
    const deck: Deck = {
      id: this.newId(),
      game: i.game,
      name,
      format,
      notes: null,
      cards: [],
      createdAt: at,
      updatedAt: at,
    };
    this.decks.push(deck);
    this.save();
    return this.copy(deck);
  }

  update(id: string, changes: unknown): Deck {
    const deck = this.find(id);
    const c = (changes ?? {}) as Record<string, unknown>;
    if ("name" in c) {
      const name = text(c.name, 100);
      if (!name) throw new Error("A deck needs a name.");
      deck.name = name;
    }
    if ("format" in c) {
      if (!DECK_FORMATS[deck.game].some((f) => f.id === c.format))
        throw new Error("That format isn't available for this game.");
      deck.format = c.format as string;
      // Cards in a zone the new format doesn't use move to the main deck.
      const zones = zonesFor(deck.game, deck.format);
      for (const card of deck.cards) if (!zones.includes(card.zone)) card.zone = "main";
      this.mergeDuplicates(deck);
    }
    if ("notes" in c) deck.notes = text(c.notes, 1000);
    return this.touch(deck);
  }

  remove(id: string): boolean {
    const index = this.decks.findIndex((deck) => deck.id === id);
    if (index === -1) return false;
    this.decks.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * Adds copies of a card. With no zone given, it goes where it belongs —
   * a leader to the leader slot, an extra-deck monster to the extra deck.
   */
  addCard(id: string, card: CardDetail, zone?: DeckZone, quantity = 1): Deck {
    const deck = this.find(id);
    if (card.game !== deck.game) throw new Error("That card is from a different game.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_DECK_CARD_QUANTITY) {
      throw new Error(`Quantity must be 1 to ${MAX_DECK_CARD_QUANTITY}.`);
    }
    const zones = zonesFor(deck.game, deck.format);
    const target = zone ?? (zones.includes(card.rules.zone) ? card.rules.zone : "main");
    if (!zones.includes(target)) throw new Error("This deck doesn't have that zone.");
    const existing = deck.cards.find((c) => c.sourceId === card.sourceId && c.zone === target);
    if (existing) {
      existing.quantity = Math.min(MAX_DECK_CARD_QUANTITY, existing.quantity + quantity);
    } else {
      if (deck.cards.length >= MAX_DECK_ENTRIES) throw new Error("This deck has too many different cards.");
      deck.cards.push({
        sourceId: card.sourceId,
        name: card.name,
        zone: target,
        quantity,
        setCode: card.setCode,
        number: card.number,
        imageUrl: card.imageUrl,
        typeLine: card.typeLine,
        rules: { ...card.rules, colors: [...card.rules.colors] },
      });
    }
    return this.touch(deck);
  }

  /** Sets how many copies are in a zone; 0 takes the card out. */
  setQuantity(id: string, sourceId: string, zone: DeckZone, quantity: number): Deck {
    const deck = this.find(id);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_DECK_CARD_QUANTITY) {
      throw new Error(`Quantity must be 0 to ${MAX_DECK_CARD_QUANTITY}.`);
    }
    const index = deck.cards.findIndex((c) => c.sourceId === sourceId && c.zone === zone);
    if (index === -1) throw new Error("That card isn't in the deck.");
    if (quantity === 0) deck.cards.splice(index, 1);
    else deck.cards[index].quantity = quantity;
    return this.touch(deck);
  }

  moveCard(id: string, sourceId: string, from: DeckZone, to: DeckZone): Deck {
    const deck = this.find(id);
    if (!zonesFor(deck.game, deck.format).includes(to)) throw new Error("This deck doesn't have that zone.");
    const card = deck.cards.find((c) => c.sourceId === sourceId && c.zone === from);
    if (!card) throw new Error("That card isn't in the deck.");
    card.zone = to;
    this.mergeDuplicates(deck);
    return this.touch(deck);
  }

  private mergeDuplicates(deck: Deck): void {
    const merged: DeckCard[] = [];
    for (const card of deck.cards) {
      const same = merged.find((c) => c.sourceId === card.sourceId && c.zone === card.zone);
      if (same) same.quantity = Math.min(MAX_DECK_CARD_QUANTITY, same.quantity + card.quantity);
      else merged.push(card);
    }
    deck.cards = merged;
  }

  private find(id: string): Deck {
    const deck = this.decks.find((d) => d.id === id);
    if (!deck) throw new Error("That deck no longer exists.");
    return deck;
  }

  private copy(deck: Deck): Deck {
    return {
      ...deck,
      cards: deck.cards.map((c) => ({ ...c, rules: { ...c.rules, colors: [...c.rules.colors] } })),
    };
  }

  private touch(deck: Deck): Deck {
    deck.updatedAt = this.now().toISOString();
    this.save();
    return this.copy(deck);
  }

  private save(): void {
    const state: DeckState = { version: 1, decks: this.decks };
    try {
      this.store?.save(state);
    } catch (err) {
      logger.warn("Could not save decks", { error: String(err) });
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A decks listener threw", { error: String(err) });
      }
    }
  }
}

export type { TcgGame };
