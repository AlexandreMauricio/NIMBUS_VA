import { CardCatalog, CatalogCard, MAX_SEARCH_RESULTS } from "../types";
import { FetchLike, asPrice, asString, getCatalogJson, httpsOrNull } from "./http";

/**
 * One Piece Card Game, from the OPTCG API (optcgapi.com) — a community
 * project, free, no key. Less official than the other catalogs, so treat
 * its data as helpful rather than authoritative.
 *
 * Booster sets and starter decks are separate endpoints; both are
 * searched and merged. Alternate arts are distinct printings with their
 * own image id ("OP01-025_p1"), and that id is what identifies them.
 */
export function mapOptcg(json: unknown): CatalogCard[] {
  if (!Array.isArray(json)) return [];
  const cards: CatalogCard[] = [];
  for (const raw of json) {
    const c = raw as Record<string, unknown>;
    const sourceId = asString(c.card_image_id) ?? asString(c.card_set_id);
    const name = asString(c.card_name);
    if (!sourceId || !name) continue;
    const price = asPrice(c.market_price);
    cards.push({
      game: "onepiece",
      sourceId,
      name,
      setCode: asString(c.set_id),
      setName: asString(c.set_name),
      number: asString(c.card_set_id),
      rarity: asString(c.rarity),
      imageUrl: httpsOrNull(c.card_image),
      price: price ? { value: price, currency: "USD" } : null,
    });
  }
  return cards;
}

export class OptcgCatalog implements CardCatalog {
  readonly game = "onepiece" as const;

  constructor(private readonly fetchFn: FetchLike = fetch) {}

  async search(query: string): Promise<CatalogCard[]> {
    const name = encodeURIComponent(query);
    const [sets, decks] = await Promise.all([
      getCatalogJson(`https://optcgapi.com/api/sets/filtered/?card_name=${name}`, this.fetchFn),
      // Starter decks are optional extras: their failure mustn't lose the sets.
      getCatalogJson(`https://optcgapi.com/api/decks/filtered/?card_name=${name}`, this.fetchFn).catch(
        () => null
      ),
    ]);
    const seen = new Set<string>();
    return [...mapOptcg(sets), ...mapOptcg(decks)]
      .filter((card) => (seen.has(card.sourceId) ? false : (seen.add(card.sourceId), true)))
      .slice(0, MAX_SEARCH_RESULTS);
  }
}
