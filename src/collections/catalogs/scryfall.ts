import { CardCatalog, CatalogCard, MAX_SEARCH_RESULTS } from "../types";
import { FetchLike, asPrice, asString, getCatalogJson, httpsOrNull } from "./http";

/**
 * Magic: The Gathering, from Scryfall (api.scryfall.com) — free, no key.
 * Every printing is its own result (`unique=prints`), since a collection
 * is about the copy you hold, not the card in the abstract. Prices prefer
 * Cardmarket's EUR, then TCGplayer's USD.
 */
export function mapScryfall(json: unknown): CatalogCard[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const cards: CatalogCard[] = [];
  for (const raw of data) {
    const c = raw as Record<string, unknown>;
    const sourceId = asString(c.id);
    const name = asString(c.name);
    if (!sourceId || !name) continue;
    const images = (c.image_uris ??
      (c.card_faces as Array<Record<string, unknown>> | undefined)?.[0]?.image_uris) as
      Record<string, unknown> | undefined;
    const prices = (c.prices ?? {}) as Record<string, unknown>;
    const eur = asPrice(prices.eur);
    const usd = asPrice(prices.usd);
    cards.push({
      game: "mtg",
      sourceId,
      name,
      setCode: asString(c.set)?.toUpperCase() ?? null,
      setName: asString(c.set_name),
      number: asString(c.collector_number),
      rarity: asString(c.rarity),
      imageUrl: httpsOrNull(images?.small),
      price: eur ? { value: eur, currency: "EUR" } : usd ? { value: usd, currency: "USD" } : null,
    });
    if (cards.length >= MAX_SEARCH_RESULTS) break;
  }
  return cards;
}

export class ScryfallCatalog implements CardCatalog {
  readonly game = "mtg" as const;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  async search(query: string): Promise<CatalogCard[]> {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released`;
    return mapScryfall(await getCatalogJson(url, this.fetchFn));
  }
}
