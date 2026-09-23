import { logger } from "../../logging/logger";
import {
  DECK_FORMATS,
  DeckZone,
  MTG_BASIC_LANDS,
  POKEMON_BASIC_ENERGY,
  TCG_GAMES,
  averageDeck,
  balanceColours,
  blendDecks,
  checkDeck,
  commanderReferences,
  compareWithCollection,
  compareWithReferences,
  deckStats,
  formatDecklist,
  isTcgGame,
  nameKey,
  parseDecklist,
  similarCommanders,
  ygoArchetypes,
  zoneLabel,
  zonesFor,
} from "../../collections";
import { handle } from "./handle";
import type { IpcContext } from "./context";

/** Collections: cards, card pages, decks, the deck builder and comparison. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerCollectionsIpc(ctx: IpcContext): void {
  // Collections (src/collections/). A search sends only a game id and the
  // text typed. Adding takes a game and a catalog id: the card's data comes
  // from a result the main process fetched itself, never from the renderer.
  handle("nimbus:get-collection", (_event, filter: unknown) => {
    const f = filter && typeof filter === "object" ? (filter as Record<string, unknown>) : {};
    return {
      games: ctx.catalogService.games(),
      cards: ctx.collectionService.list({
        game: isTcgGame(f.game) ? f.game : undefined,
        status: f.status === "owned" || f.status === "wishlist" ? f.status : undefined,
        text: typeof f.text === "string" ? f.text.slice(0, 100) : undefined,
      }),
      stats: ctx.collectionService.stats(),
    };
  });
  handle("nimbus:search-card-catalog", (_event, game: unknown, query: unknown) =>
    ctx.catalogService.search(game, query)
  );
  handle("nimbus:add-to-collection", (_event, game: unknown, sourceId: unknown, options: unknown) => {
    const card = ctx.catalogService.resolve(game, sourceId);
    if (!card) throw new Error("Search for the card again, then add it.");
    const o = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
    return ctx.collectionService.add(card, {
      status: o.status === "wishlist" ? "wishlist" : "owned",
      foil: o.foil === true,
    });
  });
  handle("nimbus:update-collection-card", (_event, id: unknown, changes: unknown) =>
    ctx.collectionService.update(String(id ?? ""), changes)
  );
  handle("nimbus:remove-collection-card", (_event, id: unknown) =>
    ctx.collectionService.remove(String(id ?? ""))
  );

  // Card pages and decks (src/collections/). Cards are named by game and
  // catalog id only; their data comes from the main process's own lookup.
  const zoneOf = (value: unknown): DeckZone | null =>
    value === "main" || value === "side" || value === "extra" || value === "leader" ? value : null;
  const ownedCopies = (game: string, name: string, number: string | null): number =>
    ctx.collectionService
      .list({ status: "owned" })
      .filter((card) => card.game === game)
      .filter((card) =>
        game === "onepiece" ? card.number === number : card.name.toLowerCase() === name.toLowerCase()
      )
      .reduce((sum, card) => sum + card.quantity, 0);

  handle("nimbus:get-card-detail", async (_event, game: unknown, sourceId: unknown) => {
    const detail = await ctx.catalogService.getDetail(game, sourceId);
    const decks = ctx.deckService.list().filter((deck) => deck.game === detail.game);
    return {
      detail,
      owned: ownedCopies(detail.game, detail.name, detail.number),
      inDecks: decks
        .map((deck) => ({
          deckId: deck.id,
          name: deck.name,
          quantity: deck.cards
            .filter((card) => card.rules.copyKey === detail.rules.copyKey)
            .reduce((sum, card) => sum + card.quantity, 0),
        }))
        .filter((entry) => entry.quantity > 0),
      decks: decks.map((deck) => ({ id: deck.id, name: deck.name })),
    };
  });
  handle("nimbus:get-decks", () => ({
    decks: ctx.deckService.list().map((deck) => {
      const check = checkDeck(deck);
      return {
        id: deck.id,
        name: deck.name,
        game: deck.game,
        format: deck.format,
        total: check.total,
        legal: check.legal,
      };
    }),
    formats: DECK_FORMATS,
    games: TCG_GAMES.map((game) => ({ id: game.id, name: game.name })),
  }));
  // Cards saved before a version kept what the deck page now shows: kinds and
  // costs (0.5.16), and for Magic the mana symbols and land colours (0.5.18).
  const needsCardData =
    (game: string) =>
    (card: { rules: { kind: string | null; pips?: unknown } }): boolean =>
      card.rules.kind === null || (game === "mtg" && card.rules.pips === undefined);
  // A Magic deck's colour balance: the colours its spells' symbols ask for,
  // with every land in it (basics included) counted as a source.
  const deckColours = (deck: ReturnType<typeof ctx.deckService.get>) => {
    const inPlay = deck.cards.filter((card) => card.zone === "main" || card.zone === "leader");
    const order = ["W", "U", "B", "R", "G"];
    const identity = order.filter((colour) => inPlay.some((card) => (card.rules.pips?.[colour] ?? 0) > 0));
    if (!identity.length) return null;
    const size = deck.format === "commander" ? 100 : 60;
    return balanceColours(
      identity,
      inPlay.map((card) => ({
        name: card.name,
        quantity: card.quantity,
        kind: card.rules.kind,
        cost: card.rules.cost,
        pips: card.rules.pips,
        produces: card.rules.produces,
      })),
      0,
      size
    ).lines;
  };
  handle("nimbus:get-deck", (_event, id: unknown) => {
    const deck = ctx.deckService.get(String(id ?? ""));
    return {
      deck,
      check: checkDeck(deck),
      zones: zonesFor(deck.game, deck.format).map((zone) => ({ zone, label: zoneLabel(deck.game, zone) })),
      collection: compareWithCollection(deck, ctx.collectionService.list()),
      decklist: formatDecklist(deck, deck.game),
      stats: deckStats(deck.game, deck.cards, ["main", "leader"]),
      colours: deck.game === "mtg" ? deckColours(deck) : null,
      staleCards: deck.cards.filter(needsCardData(deck.game)).reduce((sum, card) => sum + card.quantity, 0),
    };
  });
  // The deck builder (src/collections/decks/builder.ts runs in the page).
  // Browsing makes each shown card resolvable; creating the deck names cards
  // by id only, and their data comes from what this process fetched.
  handle("nimbus:builder-browse", async (_event, game: unknown, filter: unknown) => {
    const page = await ctx.catalogService.browse(game, filter);
    return {
      ...page,
      cards: page.cards.map((card) => ({
        sourceId: card.sourceId,
        name: card.name,
        imageUrl: card.imageUrl,
        setName: card.setName,
        typeLine: card.typeLine,
        text: card.text ? card.text.slice(0, 400) : null,
        rules: card.rules,
        owned: ownedCopies(card.game, card.name, card.number),
      })),
    };
  });
  handle("nimbus:card-synergy", async (_event, game: unknown, sourceId: unknown, context: unknown) => {
    const result = await ctx.catalogService.synergy(game, sourceId, context);
    return {
      source: result.source,
      cards: result.cards.map(({ detail, reason }) => ({
        sourceId: detail.sourceId,
        name: detail.name,
        imageUrl: detail.imageUrl,
        setName: detail.setName,
        typeLine: detail.typeLine,
        text: detail.text ? detail.text.slice(0, 400) : null,
        rules: detail.rules,
        owned: ownedCopies(detail.game, detail.name, detail.number),
        reason,
      })),
    };
  });
  // Comparing a Commander deck with EDHREC's average decks for its commander
  // (src/collections/catalogs/edhrec.ts, decks/compare.ts). Pages are kept
  // six hours; only the commander's name goes to EDHREC.
  const edhrecCache = new Map<string, { at: number; value: Promise<unknown> }>();
  const edhrec = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = edhrecCache.get(key);
    if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.value as Promise<T>;
    const value = load().catch((err) => {
      edhrecCache.delete(key);
      throw err;
    });
    edhrecCache.set(key, { at: Date.now(), value });
    return value;
  };
  const commanderOf = (id: unknown) => {
    const deck = ctx.deckService.get(String(id ?? ""));
    if (deck.game !== "mtg" || deck.format !== "commander") {
      throw new Error("Comparing with average decks works for Magic Commander decks.");
    }
    const commander = deck.cards.find((card) => card.zone === "leader");
    if (!commander) throw new Error("Put the deck's commander in the Commander zone first.");
    return { deck, commander };
  };
  handle("nimbus:deck-compare-options", async (_event, id: unknown) => {
    const { commander } = commanderOf(id);
    const name = commander.name.split(" // ")[0];
    return edhrec(`refs|${name}`, () => commanderReferences(name));
  });
  handle("nimbus:deck-compare", async (_event, id: unknown, variantIds: unknown) => {
    const { deck, commander } = commanderOf(id);
    const name = commander.name.split(" // ")[0];
    const refs = await edhrec(`refs|${name}`, () => commanderReferences(name));
    const wanted = Array.isArray(variantIds)
      ? variantIds.filter((v): v is string => typeof v === "string")
      : [];
    const chosen = refs.variants.filter((v) => wanted.includes(v.id)).slice(0, 5);
    if (!chosen.length) chosen.push(refs.variants[0]);
    const references = [];
    const similarNames: Record<string, string[]> = {};
    for (const variant of chosen) {
      if (!variant.id.startsWith("similar") || !refs.colours) {
        references.push(
          await edhrec(`deck|${refs.slug}|${variant.id}`, () => averageDeck(refs.slug, variant))
        );
        continue;
      }
      // Similar commanders: the top ones of this colour identity (with the
      // theme, when one is chosen), each one's average deck (its theme
      // build), blended into one.
      const theme = variant.id.startsWith("similar:") ? variant.id.slice("similar:".length) : null;
      const colours = refs.colours;
      const others = await edhrec(`similar|${colours.slug}|${theme ?? ""}|${refs.slug}`, () =>
        similarCommanders(colours.slug, theme, refs.slug)
      );
      const decks = [];
      for (const other of others) {
        try {
          decks.push(
            await edhrec(`deck|${other.slug}|${theme ?? ""}`, () =>
              averageDeck(other.slug, { id: theme ?? "", label: other.name, decks: other.decks })
            )
          );
        } catch (err) {
          // That commander has no average for the theme: leave it out.
          logger.info("No EDHREC average deck for a similar commander", { commander: other.slug, theme });
        }
      }
      if (!decks.length)
        throw new Error(`EDHREC has no decks for ${variant.label.replace(/^Similar: /, "")}.`);
      similarNames[variant.id] = decks.map((d) => d.label);
      references.push(blendDecks(variant.id, variant.label, decks));
    }
    const mine = deck.cards
      .filter((card) => card.zone === "main")
      .map((card) => ({ name: card.name, quantity: card.quantity }));
    // Every card's text and type, through the catalog service (Scryfall, 75 names a request).
    const names = [...new Set([...mine, ...references.flatMap((r) => r.cards)].map((c) => c.name))];
    const info = new Map<
      string,
      {
        sourceId: string;
        name: string;
        kind: string | null;
        cost: number | null;
        text: string | null;
        imageUrl: string | null;
      }
    >();
    for (let start = 0; start < names.length; start += 250) {
      const lookup = await ctx.catalogService.lookupByNames("mtg", names.slice(start, start + 250));
      for (const detail of lookup.found.values()) {
        info.set(nameKey(detail.name), {
          sourceId: detail.sourceId,
          name: detail.name,
          kind: detail.rules.kind,
          cost: detail.rules.cost,
          text: detail.text,
          imageUrl: detail.imageUrl,
        });
      }
    }
    return {
      commander: refs.commander,
      totalDecks: refs.decks,
      references: references.map((r) => ({
        id: r.id,
        label: r.label,
        decks: r.decks,
        builtFrom: similarNames[r.id] ?? null,
      })),
      comparison: compareWithReferences(mine, references, info),
    };
  });
  let archetypes: { at: number; names: Promise<string[]> } | null = null;
  handle("nimbus:builder-archetypes", () => {
    if (!archetypes || Date.now() - archetypes.at > 24 * 60 * 60_000) {
      const names = ygoArchetypes().catch((err) => {
        archetypes = null;
        logger.warn("Could not load Yu-Gi-Oh! archetypes", { error: String(err) });
        return [] as string[];
      });
      archetypes = { at: Date.now(), names };
    }
    return archetypes.names;
  });
  handle("nimbus:builder-create-deck", async (_event, input: unknown) => {
    const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const deck = ctx.deckService.create({ name: i.name, game: i.game, format: i.format });
    const failed: string[] = [];
    for (const raw of Array.isArray(i.cards) ? i.cards.slice(0, 250) : []) {
      const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const quantity = Number(c.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) continue;
      try {
        const detail = await ctx.catalogService.getDetail(deck.game, c.sourceId);
        ctx.deckService.addCard(deck.id, detail, zoneOf(c.zone) ?? undefined, quantity);
      } catch {
        failed.push(typeof c.name === "string" ? c.name.slice(0, 100) : "a card");
      }
    }
    // Basic lands and energy by name — only real basics, in the counts asked.
    const allowed = new Set<string>(
      Object.values(
        deck.game === "mtg" ? MTG_BASIC_LANDS : deck.game === "pokemon" ? POKEMON_BASIC_ENERGY : {}
      )
    );
    const basics = Object.entries(i.basics && typeof i.basics === "object" ? i.basics : {}).filter(
      ([name, n]) => allowed.has(name) && Number.isInteger(n) && (n as number) > 0 && (n as number) <= 60
    ) as Array<[string, number]>;
    if (basics.length) {
      const lookup = await ctx.catalogService.lookupByNames(
        deck.game,
        basics.map(([name]) => name)
      );
      for (const [name, n] of basics) {
        const detail = lookup.found.get(name.toLowerCase());
        if (detail) ctx.deckService.addCard(deck.id, detail, "main", n);
        else failed.push(name);
      }
    }
    return { id: deck.id, failed };
  });
  // Cards saved before costs and kinds were kept get fresh card data, one
  // paced lookup per card — only for cards already in the deck.
  handle("nimbus:refresh-deck-cards", async (_event, id: unknown) => {
    const deck = ctx.deckService.get(String(id ?? ""));
    const stale = [...new Set(deck.cards.filter(needsCardData(deck.game)).map((card) => card.sourceId))];
    const details = [];
    let failed = 0;
    for (const sourceId of stale) {
      try {
        details.push(await ctx.catalogService.getDetail(deck.game, sourceId));
      } catch {
        failed++;
      }
    }
    ctx.deckService.refreshCards(deck.id, details);
    return { updated: details.length, failed };
  });
  handle("nimbus:create-deck", (_event, input: unknown) => ctx.deckService.create(input));
  handle("nimbus:update-deck", (_event, id: unknown, changes: unknown) =>
    ctx.deckService.update(String(id ?? ""), changes)
  );
  handle("nimbus:remove-deck", (_event, id: unknown) => ctx.deckService.remove(String(id ?? "")));
  handle("nimbus:add-deck-card", async (_event, id: unknown, sourceId: unknown, zone: unknown) => {
    const deck = ctx.deckService.get(String(id ?? ""));
    const detail = await ctx.catalogService.getDetail(deck.game, sourceId);
    return ctx.deckService.addCard(deck.id, detail, zoneOf(zone) ?? undefined);
  });
  handle(
    "nimbus:set-deck-card-quantity",
    (_event, id: unknown, sourceId: unknown, zone: unknown, quantity: unknown) => {
      const z = zoneOf(zone);
      if (!z) throw new Error("That isn't a deck zone.");
      return ctx.deckService.setQuantity(String(id ?? ""), String(sourceId ?? ""), z, Number(quantity));
    }
  );
  handle("nimbus:move-deck-card", (_event, id: unknown, sourceId: unknown, from: unknown, to: unknown) => {
    const f = zoneOf(from);
    const t = zoneOf(to);
    if (!f || !t) throw new Error("That isn't a deck zone.");
    return ctx.deckService.moveCard(String(id ?? ""), String(sourceId ?? ""), f, t);
  });
  // A pasted decklist: each name is searched in the deck's game and the first
  // printing with exactly that name is added. Capped, and paced by the
  // catalog service like any search.
  handle("nimbus:import-decklist", async (_event, id: unknown, text: unknown) => {
    const deck = ctx.deckService.get(String(id ?? ""));
    const { lines, unread } = parseDecklist(typeof text === "string" ? text.slice(0, 20_000) : "");
    const kept = lines.slice(0, 250);
    const lookup = await ctx.catalogService.lookupByNames(
      deck.game,
      kept.map((line) => line.name)
    );
    const zones = zonesFor(deck.game, deck.format);
    let added = 0;
    // Lines that didn't make it, as decklist text — put back in the import
    // box so "Import" again retries just those.
    const retry: string[] = [];
    for (const line of kept) {
      const detail = lookup.found.get(line.name.toLowerCase());
      if (!detail) {
        if (lookup.failed.some((name) => name.toLowerCase() === line.name.toLowerCase())) {
          retry.push(`${line.quantity} ${line.name}`);
        }
        continue;
      }
      try {
        ctx.deckService.addCard(
          deck.id,
          detail,
          zones.includes(line.zone) ? line.zone : undefined,
          Math.min(line.quantity, 99)
        );
        added += line.quantity;
      } catch (err) {
        retry.push(`${line.quantity} ${line.name}`);
        logger.warn("Could not add an imported card", { error: String(err) });
      }
    }
    return { added, notFound: lookup.notFound, failed: lookup.failed, retry: retry.join("\n"), unread };
  });
}
