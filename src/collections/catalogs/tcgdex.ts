import { CardCatalog, CatalogCard, MAX_SEARCH_RESULTS } from "../types";
import { FetchLike, asString, getCatalogJson, httpsOrNull } from "./http";

/**
 * Pokémon TCG, from TCGdex (api.tcgdex.net) — free, no key, and
 * multilingual. Chosen over pokemontcg.io, which failed with a 502 when
 * checked and answered only on a retry.
 *
 * A search result names the card and its image base but not its set, so
 * set names come from TCGdex's set list, fetched once and kept. The set
 * code is the card id without its number ("swsh3-136" → "swsh3").
 * Images need a size and format appended to their base address.
 */
export function mapTcgdex(json: unknown, setNames: ReadonlyMap<string, string> = new Map()): CatalogCard[] {
  if (!Array.isArray(json)) return [];
  const cards: CatalogCard[] = [];
  for (const raw of json) {
    const c = raw as Record<string, unknown>;
    const sourceId = asString(c.id);
    const name = asString(c.name);
    if (!sourceId || !name) continue;
    const dash = sourceId.lastIndexOf("-");
    const setCode = dash > 0 ? sourceId.slice(0, dash) : null;
    const imageBase = httpsOrNull(c.image);
    cards.push({
      game: "pokemon",
      sourceId,
      name,
      setCode,
      setName: setCode ? (setNames.get(setCode) ?? null) : null,
      number: asString(c.localId),
      rarity: null,
      imageUrl: imageBase ? `${imageBase}/low.webp` : null,
      price: null,
    });
    if (cards.length >= MAX_SEARCH_RESULTS) break;
  }
  return cards;
}

export class TcgdexCatalog implements CardCatalog {
  readonly game = "pokemon" as const;
  private setNames: Map<string, string> | null = null;

  /** `language` is TCGdex's code: "en", or "pt" for Portuguese card names. */
  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly language = "en"
  ) {}

  async search(query: string): Promise<CatalogCard[]> {
    const url =
      `https://api.tcgdex.net/v2/${this.language}/cards?name=${encodeURIComponent(query)}` +
      `&pagination:itemsPerPage=${MAX_SEARCH_RESULTS}`;
    const [json, setNames] = await Promise.all([getCatalogJson(url, this.fetchFn), this.loadSetNames()]);
    return mapTcgdex(json, setNames);
  }

  /** The set list, once. A failure here costs set names, never the search. */
  private async loadSetNames(): Promise<Map<string, string>> {
    if (this.setNames) return this.setNames;
    try {
      const json = await getCatalogJson(`https://api.tcgdex.net/v2/${this.language}/sets`, this.fetchFn);
      const names = new Map<string, string>();
      if (Array.isArray(json)) {
        for (const set of json as Array<Record<string, unknown>>) {
          const id = asString(set.id);
          const name = asString(set.name);
          if (id && name) names.set(id, name);
        }
      }
      this.setNames = names;
      return names;
    } catch {
      return new Map();
    }
  }
}
