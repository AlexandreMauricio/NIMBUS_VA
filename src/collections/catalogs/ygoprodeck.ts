import { CardCatalog, CatalogCard, MAX_SEARCH_RESULTS } from "../types";
import { FetchLike, asPrice, asString, getCatalogJson, httpsOrNull } from "./http";

/**
 * Yu-Gi-Oh!, from YGOPRODeck (db.ygoprodeck.com) — free, no key.
 *
 * YGOPRODeck returns one card with every set it was printed in; a
 * collector holds a particular printing ("CT13-EN003, Ultra Rare"), so
 * each set printing becomes its own result. A card with no printings
 * listed yet is still returned once.
 */
export function mapYgoprodeck(json: unknown): CatalogCard[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const cards: CatalogCard[] = [];
  for (const raw of data) {
    const c = raw as Record<string, unknown>;
    const cardId = asString(c.id);
    const name = asString(c.name);
    if (!cardId || !name) continue;
    const image = httpsOrNull(
      (c.card_images as Array<Record<string, unknown>> | undefined)?.[0]?.image_url_small
    );
    const sets = Array.isArray(c.card_sets) ? (c.card_sets as Array<Record<string, unknown>>) : [];

    if (sets.length === 0) {
      cards.push({
        game: "yugioh",
        sourceId: cardId,
        name,
        setCode: null,
        setName: null,
        number: null,
        rarity: null,
        imageUrl: image,
        price: null,
      });
    }
    for (const set of sets) {
      const setCode = asString(set.set_code);
      const price = asPrice(set.set_price);
      cards.push({
        game: "yugioh",
        sourceId: `${cardId}:${setCode ?? "?"}:${asString(set.set_rarity_code) ?? ""}`,
        name,
        setCode,
        setName: asString(set.set_name),
        number: setCode,
        rarity: asString(set.set_rarity),
        imageUrl: image,
        price: price ? { value: price, currency: "USD" } : null,
      });
      if (cards.length >= MAX_SEARCH_RESULTS) return cards;
    }
    if (cards.length >= MAX_SEARCH_RESULTS) break;
  }
  return cards;
}

export class YgoprodeckCatalog implements CardCatalog {
  readonly game = "yugioh" as const;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  async search(query: string): Promise<CatalogCard[]> {
    const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}`;
    return mapYgoprodeck(await getCatalogJson(url, this.fetchFn));
  }
}
