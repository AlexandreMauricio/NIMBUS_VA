import { CardCatalog, CatalogCard, MAX_SEARCH_RESULTS } from "../types";
import { FetchLike, asPrice, asString, getCatalogJson, httpsOrNull } from "./http";

/**
 * Disney Lorcana, from Lorcast (api.lorcast.com) — free, no key. A
 * Lorcana card is named by character and version ("Elsa — Concerned
 * Sister"); both are kept in the name, since many characters share one.
 */
export function mapLorcast(json: unknown): CatalogCard[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const cards: CatalogCard[] = [];
  for (const raw of results) {
    const c = raw as Record<string, unknown>;
    const sourceId = asString(c.id);
    const character = asString(c.name);
    if (!sourceId || !character) continue;
    const version = asString(c.version);
    const set = (c.set ?? {}) as Record<string, unknown>;
    const digital = ((c.image_uris ?? {}) as Record<string, Record<string, unknown>>).digital ?? {};
    const usd = asPrice(((c.prices ?? {}) as Record<string, unknown>).usd);
    cards.push({
      game: "lorcana",
      sourceId,
      name: version ? `${character} — ${version}` : character,
      setCode: asString(set.code),
      setName: asString(set.name),
      number: asString(c.collector_number),
      rarity: asString(c.rarity),
      imageUrl: httpsOrNull(digital.small),
      price: usd ? { value: usd, currency: "USD" } : null,
    });
    if (cards.length >= MAX_SEARCH_RESULTS) break;
  }
  return cards;
}

export class LorcastCatalog implements CardCatalog {
  readonly game = "lorcana" as const;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  async search(query: string): Promise<CatalogCard[]> {
    const url = `https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(query)}`;
    return mapLorcast(await getCatalogJson(url, this.fetchFn));
  }
}
