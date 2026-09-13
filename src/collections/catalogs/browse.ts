import { CardDetail, TcgGame } from "../types";
import {
  mapLorcastDetail,
  mapOptcgDetail,
  mapScryfallDetail,
  mapTcgdexDetail,
  mapYgoprodeckDetail,
} from "./details";
import { FetchLike, asString, getCatalogJson } from "./http";

/**
 * Browsing each game's card database for the deck builder: cards in the
 * chosen colours (inks, a leader's colours, energy types, an archetype),
 * of a role or kind, within a cost range, optionally matching a name.
 *
 * Each game's database is asked the way it can answer — every shape here
 * was checked against the live API while this was built:
 *  - Scryfall's search syntax does the filtering and orders by EDHREC
 *    popularity (`id<=rg f:standard otag:removal mv<=2`), 175 a page.
 *  - Lorcast is asked by ink and type, and the cost, song/action split and
 *    "only these inks" are filtered here (its `(i:a or i:b)` also returns
 *    cards whose second ink is something else).
 *  - The OPTCG API's full booster and starter-deck lists (about 4,300 cards)
 *    are downloaded once a day and filtered here.
 *  - TCGdex lists Standard-legal cards by type or category (names only);
 *    each shown page's cards are then looked up for their details.
 *  - YGOPRODeck lists an archetype, its staples, or a name search.
 *
 * Only the filters — colours, a type, a name — are sent; nothing about you.
 */

export interface BrowseFilter {
  /** Colours, inks, energy types; a One Piece leader's colours; a Yu-Gi-Oh! archetype as the one entry. */
  identity: string[];
  /** "any", a kind ("creature", "song"…), a Magic role ("removal"…), "leader", "commander" or "staple". */
  role: string;
  costMin: number | null;
  costMax: number | null;
  text: string;
  /** Magic only: standard, pioneer, modern, commander or any. */
  legality: string;
  page: number;
}

export interface BrowsePage {
  cards: CardDetail[];
  hasMore: boolean;
  /** How many matched in all, when the database says. */
  total: number | null;
}

export type Browser = (filter: BrowseFilter) => Promise<BrowsePage>;

const LEGALITIES = ["standard", "pioneer", "modern", "commander", "any"];
const LOCAL_PAGE = 60;
const POKEMON_PAGE = 24;
const DAY_MS = 24 * 60 * 60_000;
const LIST_CACHE_MS = 10 * 60_000;

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}' .,!&-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const wholeOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 20 ? value : null;

/** A filter from the page, checked: anything unexpected falls back to "no filter". */
export function parseBrowseFilter(raw: unknown): BrowseFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const identity = Array.isArray(r.identity)
    ? r.identity
        .map((v) => cleanText(v, 60))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const role = typeof r.role === "string" && /^[a-z0-9-]{1,20}$/.test(r.role) ? r.role : "any";
  const legality = typeof r.legality === "string" && LEGALITIES.includes(r.legality) ? r.legality : "any";
  const page =
    typeof r.page === "number" && Number.isInteger(r.page) && r.page >= 0 && r.page <= 50 ? r.page : 0;
  return {
    identity,
    role,
    costMin: wholeOrNull(r.costMin),
    costMax: wholeOrNull(r.costMax),
    text: cleanText(r.text, 60),
    legality,
    page,
  };
}

const inCost = (card: CardDetail, f: BrowseFilter): boolean => {
  if (f.costMin === null && f.costMax === null) return true;
  const cost = card.rules.cost;
  if (cost === null) return false;
  return (f.costMin === null || cost >= f.costMin) && (f.costMax === null || cost <= f.costMax);
};

const nameHas = (card: CardDetail, text: string): boolean =>
  !text || card.name.toLowerCase().includes(text.toLowerCase());

const byCostThenName = (a: CardDetail, b: CardDetail): number =>
  (a.rules.cost ?? 99) - (b.rules.cost ?? 99) || a.name.localeCompare(b.name);

function localPage(cards: CardDetail[], page: number, size = LOCAL_PAGE): BrowsePage {
  const start = page * size;
  return {
    cards: cards.slice(start, start + size),
    hasMore: cards.length > start + size,
    total: cards.length,
  };
}

/** Remembers fetched lists for a while, so paging through them doesn't ask again. */
function memo<T>(ttl: number, now: () => number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = load().catch((err) => {
      entries.delete(key);
      throw err;
    });
    entries.set(key, { at: now(), value });
    return value;
  };
}

// ---------------------------------------------------------------- Magic

const MTG_ROLE_QUERY: Record<string, string> = {
  any: "-t:basic",
  creature: "t:creature",
  removal: "otag:removal -t:land",
  draw: "otag:draw -t:land",
  ramp: "otag:ramp -t:basic",
  counterspell: "otag:counterspell",
  wipe: "otag:board-wipe",
  land: "t:land -t:basic",
  commander: "is:commander",
};

/** The Scryfall query for a filter — exported for tests. */
export function scryfallBrowseQuery(f: BrowseFilter): string {
  const colours = f.identity.filter((c) => /^[WUBRG]$/.test(c)).join("") || "C";
  const parts = [`id<=${colours}`];
  if (f.legality !== "any") parts.push(`f:${f.legality}`);
  parts.push(MTG_ROLE_QUERY[f.role] ?? MTG_ROLE_QUERY.any);
  if (f.costMin !== null) parts.push(`mv>=${f.costMin}`);
  if (f.costMax !== null) parts.push(`mv<=${f.costMax}`);
  if (f.text)
    parts.push(
      ...f.text
        .split(" ")
        .map((word) => word.replace(/[^\p{L}\p{N}'-]/gu, ""))
        .filter(Boolean)
    );
  return parts.join(" ");
}

// -------------------------------------------------------------- Lorcana

const LORCANA_INKS = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"];

export function lorcastBrowseQuery(f: BrowseFilter): string {
  const inks = f.identity.map((i) => i.toLowerCase()).filter((i) => LORCANA_INKS.includes(i));
  const parts: string[] = [];
  if (inks.length === 1) parts.push(`i:${inks[0]}`);
  if (inks.length > 1) parts.push(`(${inks.map((i) => `i:${i}`).join(" or ")})`);
  parts.push("format:core");
  const type = f.role === "song" ? "action" : f.role;
  if (["character", "action", "item", "location"].includes(type)) parts.push(`t:${type}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------- browse

export function browsers(fetchFn: FetchLike = fetch, now: () => number = Date.now): Record<TcgGame, Browser> {
  const lists = memo<unknown>(LIST_CACHE_MS, now);
  const daily = memo<unknown>(DAY_MS, now);

  const onePieceCards = async (): Promise<CardDetail[]> => {
    const [sets, starters] = await Promise.all([
      daily("optcg-sets", () => getCatalogJson("https://optcgapi.com/api/allSetCards/", fetchFn)),
      daily("optcg-starters", () =>
        getCatalogJson("https://optcgapi.com/api/allSTCards/", fetchFn).catch(() => [])
      ),
    ]);
    const byNumber = new Map<string, CardDetail>();
    for (const entry of [
      ...(Array.isArray(sets) ? sets : []),
      ...(Array.isArray(starters) ? starters : []),
    ]) {
      const id = asString((entry as Record<string, unknown>).card_image_id);
      if (!id) continue;
      const detail = mapOptcgDetail([entry], id);
      if (!detail) continue;
      const key = detail.number ?? detail.sourceId;
      const kept = byNumber.get(key);
      // One entry per card number, preferring the standard art over "_p1" alternates.
      if (!kept || (kept.sourceId.includes("_") && !detail.sourceId.includes("_"))) byNumber.set(key, detail);
    }
    return [...byNumber.values()];
  };

  return {
    mtg: async (f) => {
      const url =
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(scryfallBrowseQuery(f))}` +
        `&order=edhrec&page=${f.page + 1}`;
      const json = (await getCatalogJson(url, fetchFn)) as {
        data?: unknown[];
        has_more?: boolean;
        total_cards?: number;
      } | null;
      const cards = (json?.data ?? []).map(mapScryfallDetail).filter((c): c is CardDetail => c !== null);
      return { cards, hasMore: json?.has_more === true, total: json?.total_cards ?? cards.length };
    },

    lorcana: async (f) => {
      const query = lorcastBrowseQuery(f);
      const json = (await lists(`lorcana|${query}`, () =>
        getCatalogJson(`https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(query)}`, fetchFn)
      )) as { results?: unknown[] } | null;
      const inks = new Set(f.identity.map((i) => i.toLowerCase()));
      const cards = (json?.results ?? [])
        .map(mapLorcastDetail)
        .filter((c): c is CardDetail => c !== null)
        .filter((c) => !inks.size || c.rules.colors.every((ink) => inks.has(ink.toLowerCase())))
        .filter((c) => f.role === "any" || c.rules.kind === f.role)
        .filter((c) => inCost(c, f) && nameHas(c, f.text));
      // Lorcast repeats a card for each printing (enchanted, promo): one per name.
      const unique = [...new Map(cards.map((c) => [c.name.toLowerCase(), c])).values()].sort(byCostThenName);
      return localPage(unique, f.page);
    },

    onepiece: async (f) => {
      const colours = new Set(f.identity.map((c) => c.toLowerCase()));
      const cards = (await onePieceCards())
        .filter((c) => (f.role === "leader" ? c.rules.kind === "leader" : c.rules.kind !== "leader"))
        .filter((c) => f.role === "any" || f.role === "leader" || c.rules.kind === f.role)
        .filter((c) => !colours.size || c.rules.colors.some((colour) => colours.has(colour.toLowerCase())))
        .filter((c) => inCost(c, f) && nameHas(c, f.text))
        .sort(byCostThenName);
      return localPage(cards, f.page);
    },

    pokemon: async (f) => {
      const urls =
        f.role === "trainer"
          ? ["https://api.tcgdex.net/v2/en/cards?category=Trainer&legal.standard=true"]
          : f.identity.map(
              (type) =>
                `https://api.tcgdex.net/v2/en/cards?types=${encodeURIComponent(type)}&legal.standard=true`
            );
      const briefs: Array<{ id: string; name: string }> = [];
      for (const url of urls) {
        const list = await lists(url, () => getCatalogJson(url, fetchFn));
        for (const raw of Array.isArray(list) ? list : []) {
          const id = asString((raw as Record<string, unknown>).id);
          const name = asString((raw as Record<string, unknown>).name);
          if (id && name) briefs.push({ id, name });
        }
      }
      const unique = [...new Map(briefs.map((b) => [b.name.toLowerCase(), b])).values()]
        // Energy of a type is listed under that type too; the builder adds basic energy itself.
        .filter((b) => f.role === "trainer" || !/\bEnergy$/i.test(b.name))
        .filter((b) => !f.text || b.name.toLowerCase().includes(f.text.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
      const start = f.page * POKEMON_PAGE;
      const slice = unique.slice(start, start + POKEMON_PAGE);
      const cards: CardDetail[] = [];
      // A few at a time: a page is two dozen card lookups.
      for (let i = 0; i < slice.length; i += 6) {
        const batch = await Promise.all(
          slice
            .slice(i, i + 6)
            .map((b) =>
              lists(`tcgdex-card|${b.id}`, () =>
                getCatalogJson(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(b.id)}`, fetchFn)
              ).then(mapTcgdexDetail, () => null)
            )
        );
        cards.push(...batch.filter((c): c is CardDetail => c !== null));
      }
      return { cards, hasMore: unique.length > start + POKEMON_PAGE, total: unique.length };
    },

    yugioh: async (f) => {
      const archetype = f.identity[0] ?? "";
      let url: string;
      if (f.role === "staple") url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?staple=yes";
      else if (archetype)
        url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?archetype=${encodeURIComponent(archetype)}`;
      else if (f.text.length >= 2)
        url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(f.text)}`;
      else url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?staple=yes";
      const json = (await lists(url, () => getCatalogJson(url, fetchFn))) as { data?: unknown[] } | null;
      const cards = (json?.data ?? [])
        .map((c) => mapYgoprodeckDetail({ data: [c] }, String((c as Record<string, unknown>).id ?? "")))
        .filter((c): c is CardDetail => c !== null && /^\d+$/.test(c.sourceId))
        .filter((c) => ["any", "staple"].includes(f.role) || c.rules.kind === f.role)
        .filter((c) => inCost(c, f) && nameHas(c, f.text))
        .sort(
          (a, b) => (a.rules.kind ?? "").localeCompare(b.rules.kind ?? "") || a.name.localeCompare(b.name)
        );
      return localPage(cards, f.page);
    },
  };
}

/** Yu-Gi-Oh! archetype names, for the builder's archetype picker. */
export async function ygoArchetypes(fetchFn: FetchLike = fetch): Promise<string[]> {
  const json = await getCatalogJson("https://db.ygoprodeck.com/api/v7/archetypes.php", fetchFn);
  return (Array.isArray(json) ? json : [])
    .map((a) => asString((a as Record<string, unknown>).archetype_name))
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b));
}
