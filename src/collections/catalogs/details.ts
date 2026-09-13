import { CardDetail, CardStat, TcgGame } from "../types";
import {
  CATALOG_HEADERS,
  FetchLike,
  asPrice,
  asString,
  fetchWithRetry,
  getCatalogJson,
  httpsOrNull,
} from "./http";

/**
 * A card's full page, per game: rules text, stats, legality, the large
 * image — and the few facts deck rules need (see decks/rules.ts): what
 * copies are counted by, whether copies are unlimited (basic lands, basic
 * energy), which zone it belongs in (Yu-Gi-Oh!'s extra deck, a One Piece
 * leader), its colours or inks, and a Yu-Gi-Oh! ban limit.
 *
 * Every shape below was read from the live API while this was built.
 * Mappers are pure; fetchers take only a catalog id, validated here.
 */

const SAFE_ID = /^[A-Za-z0-9_.:()-]{1,120}$/;

const stat = (label: string, value: unknown): CardStat | null => {
  const text = asString(value);
  return text ? { label, value: text } : null;
};
const stats = (...items: Array<CardStat | null>): CardStat[] =>
  items.filter((s): s is CardStat => s !== null);

// ------------------------------------------------------------------ Magic

const MTG_FORMATS = ["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper"];

export function mapScryfallDetail(json: unknown): CardDetail | null {
  const c = (json ?? {}) as Record<string, unknown>;
  const sourceId = asString(c.id);
  const name = asString(c.name);
  if (!sourceId || !name) return null;
  const faces = Array.isArray(c.card_faces) ? (c.card_faces as Array<Record<string, unknown>>) : [];
  const images = (c.image_uris ?? faces[0]?.image_uris ?? {}) as Record<string, unknown>;
  const text =
    asString(c.oracle_text) ??
    (faces.length
      ? faces.map((f) => `${asString(f.name) ?? ""}\n${asString(f.oracle_text) ?? ""}`.trim()).join("\n\n")
      : null);
  const typeLine = asString(c.type_line);
  const prices = (c.prices ?? {}) as Record<string, unknown>;
  const eur = asPrice(prices.eur);
  const usd = asPrice(prices.usd);
  const legal = (c.legalities ?? {}) as Record<string, unknown>;
  const colors = Array.isArray(c.colors)
    ? (c.colors as string[])
    : [...new Set(faces.flatMap((f) => (Array.isArray(f.colors) ? (f.colors as string[]) : [])))];
  return {
    game: "mtg",
    sourceId,
    name,
    setCode: asString(c.set)?.toUpperCase() ?? null,
    setName: asString(c.set_name),
    number: asString(c.collector_number),
    rarity: asString(c.rarity),
    imageUrl: httpsOrNull(images.small),
    largeImageUrl: httpsOrNull(images.normal) ?? httpsOrNull(images.large),
    price: eur ? { value: eur, currency: "EUR" } : usd ? { value: usd, currency: "USD" } : null,
    typeLine,
    text,
    flavor: asString(c.flavor_text),
    stats: stats(
      stat(
        "Mana cost",
        c.mana_cost ??
          faces
            .map((f) => asString(f.mana_cost))
            .filter(Boolean)
            .join(" // ")
      ),
      c.power !== undefined ? stat("Power / Toughness", `${c.power}/${c.toughness}`) : null,
      stat("Loyalty", c.loyalty)
    ),
    legalities: MTG_FORMATS.filter((format) => typeof legal[format] === "string").map((format) => ({
      format: format.charAt(0).toUpperCase() + format.slice(1),
      status: String(legal[format]).replace("_", " "),
    })),
    artist: asString(c.artist),
    rules: {
      copyKey: name,
      unlimitedCopies:
        /\bbasic\b.*\bland\b/i.test(typeLine ?? "") ||
        /a deck can have any number of cards named/i.test(text ?? ""),
      zone: "main",
      colors,
      banLimit: null,
      cost: typeof c.cmc === "number" && Number.isFinite(c.cmc) ? c.cmc : null,
      kind: mtgKind(typeLine),
      traits: /\bbasic\b.*\bland\b/i.test(typeLine ?? "") ? ["basic"] : [],
    },
  };
}

/** The kind a Magic card counts as, from its (front face's) type line. A land creature is a creature. */
export function mtgKind(typeLine: string | null): string | null {
  const front = (typeLine ?? "").split("//")[0].toLowerCase();
  for (const kind of [
    "creature",
    "planeswalker",
    "battle",
    "land",
    "instant",
    "sorcery",
    "artifact",
    "enchantment",
  ]) {
    if (new RegExp(`\\b${kind}\\b`).test(front)) return kind;
  }
  return null;
}

// -------------------------------------------------------------- Yu-Gi-Oh!

const YGO_BAN_LIMIT: Record<string, number> = { Forbidden: 0, Banned: 0, Limited: 1, "Semi-Limited": 2 };

export function mapYgoprodeckDetail(json: unknown, sourceId: string): CardDetail | null {
  const c = ((json as { data?: unknown[] })?.data?.[0] ?? null) as Record<string, unknown> | null;
  if (!c) return null;
  const name = asString(c.name);
  if (!name) return null;
  const [, setCode, rarityCode] = sourceId.split(":");
  const sets = Array.isArray(c.card_sets) ? (c.card_sets as Array<Record<string, unknown>>) : [];
  const printing =
    sets.find(
      (s) => asString(s.set_code) === setCode && (asString(s.set_rarity_code) ?? "") === (rarityCode ?? "")
    ) ??
    sets.find((s) => asString(s.set_code) === setCode) ??
    null;
  const image = (c.card_images as Array<Record<string, unknown>> | undefined)?.[0];
  const frame = asString(c.frameType) ?? "";
  const type = asString(c.type);
  const banTcg = asString((c.banlist_info as Record<string, unknown> | undefined)?.ban_tcg);
  const price = printing ? asPrice(printing.set_price) : null;
  return {
    game: "yugioh",
    sourceId,
    name,
    setCode: printing ? asString(printing.set_code) : null,
    setName: printing ? asString(printing.set_name) : null,
    number: printing ? asString(printing.set_code) : null,
    rarity: printing ? asString(printing.set_rarity) : null,
    imageUrl: httpsOrNull(image?.image_url_small),
    largeImageUrl: httpsOrNull(image?.image_url),
    price: price ? { value: price, currency: "USD" } : null,
    typeLine: [type, asString(c.race), asString(c.attribute)].filter(Boolean).join(" · ") || null,
    text: asString(c.desc),
    flavor: null,
    stats: stats(
      c.linkval !== undefined
        ? stat("Link", c.linkval)
        : stat(/xyz/i.test(frame) ? "Rank" : "Level", c.level),
      stat("ATK", c.atk),
      c.linkval === undefined ? stat("DEF", c.def) : null,
      stat("Archetype", c.archetype)
    ),
    legalities: [{ format: "TCG", status: banTcg ?? "Unlimited" }],
    artist: null,
    rules: {
      copyKey: name,
      unlimitedCopies: false,
      zone: /fusion|synchro|xyz|link/i.test(frame) ? "extra" : "main",
      colors: [],
      banLimit: banTcg ? (YGO_BAN_LIMIT[banTcg] ?? null) : null,
      cost: typeof c.level === "number" && Number.isInteger(c.level) ? c.level : null,
      kind: /spell/i.test(type ?? "") ? "spell" : /trap/i.test(type ?? "") ? "trap" : type ? "monster" : null,
      traits: [],
    },
  };
}

// ---------------------------------------------------------------- Pokémon

export function mapTcgdexDetail(json: unknown): CardDetail | null {
  const c = (json ?? {}) as Record<string, unknown>;
  const sourceId = asString(c.id);
  const name = asString(c.name);
  if (!sourceId || !name) return null;
  const set = (c.set ?? {}) as Record<string, unknown>;
  const imageBase = httpsOrNull(c.image);
  const category = asString(c.category);
  const types = Array.isArray(c.types) ? (c.types as string[]) : [];
  const lines: string[] = [];
  for (const ability of (c.abilities as Array<Record<string, unknown>> | undefined) ?? []) {
    lines.push(
      `${asString(ability.type) ?? "Ability"}: ${asString(ability.name) ?? ""} — ${asString(ability.effect) ?? ""}`
    );
  }
  for (const attack of (c.attacks as Array<Record<string, unknown>> | undefined) ?? []) {
    const cost = Array.isArray(attack.cost) ? `[${(attack.cost as string[]).join(" ")}] ` : "";
    const damage = asString(attack.damage) ? ` ${asString(attack.damage)}` : "";
    const effect = asString(attack.effect) ? ` — ${asString(attack.effect)}` : "";
    lines.push(`${cost}${asString(attack.name) ?? ""}${damage}${effect}`);
  }
  if (asString(c.effect)) lines.push(asString(c.effect)!);
  const weakness = (c.weaknesses as Array<Record<string, unknown>> | undefined)?.[0];
  const legal = (c.legal ?? {}) as Record<string, unknown>;
  return {
    game: "pokemon",
    sourceId,
    name,
    setCode: asString(set.id),
    setName: asString(set.name),
    number: asString(c.localId),
    rarity: asString(c.rarity),
    imageUrl: imageBase ? `${imageBase}/low.webp` : null,
    largeImageUrl: imageBase ? `${imageBase}/high.webp` : null,
    price: null,
    typeLine:
      [category, asString(c.stage) ?? asString(c.trainerType) ?? asString(c.energyType), types.join("/")]
        .filter(Boolean)
        .join(" · ") || null,
    text: lines.join("\n") || null,
    flavor: asString(c.description),
    stats: stats(
      stat("HP", c.hp),
      stat("Retreat", c.retreat),
      weakness
        ? stat("Weakness", `${asString(weakness.type) ?? ""} ${asString(weakness.value) ?? ""}`)
        : null,
      stat("Regulation mark", c.regulationMark)
    ),
    legalities: ["standard", "expanded"]
      .filter((format) => typeof legal[format] === "boolean")
      .map((format) => ({
        format: format.charAt(0).toUpperCase() + format.slice(1),
        status: legal[format] ? "legal" : "not legal",
      })),
    artist: asString(c.illustrator),
    rules: {
      copyKey: name,
      // Basic energy: any number. TCGdex marks it as an Energy of type "Normal".
      unlimitedCopies: category === "Energy" && asString(c.energyType) === "Normal",
      zone: "main",
      colors: types,
      banLimit: null,
      cost: null,
      kind: category ? category.toLowerCase().replace("é", "e") : null,
      traits: pokemonTraits(c, name, category),
    },
  };
}

function pokemonTraits(c: Record<string, unknown>, name: string, category: string | null): string[] {
  const traits: string[] = [];
  const stage = asString(c.stage)?.toLowerCase().replace(/\s+/g, "");
  if (stage) traits.push(stage);
  const trainerType = asString(c.trainerType)?.toLowerCase();
  if (trainerType) traits.push(trainerType);
  if (category === "Energy" && asString(c.energyType) === "Normal") traits.push("basic");
  if (/\bex$/i.test(name)) traits.push("ex");
  return traits;
}

// ---------------------------------------------------------------- Lorcana

export function mapLorcastDetail(json: unknown): CardDetail | null {
  const c = (json ?? {}) as Record<string, unknown>;
  const sourceId = asString(c.id);
  const character = asString(c.name);
  if (!sourceId || !character) return null;
  const version = asString(c.version);
  const fullName = version ? `${character} — ${version}` : character;
  const set = (c.set ?? {}) as Record<string, unknown>;
  const digital = ((c.image_uris ?? {}) as Record<string, Record<string, unknown>>).digital ?? {};
  const inks = Array.isArray(c.inks) ? (c.inks as string[]) : asString(c.ink) ? [asString(c.ink)!] : [];
  const usd = asPrice(((c.prices ?? {}) as Record<string, unknown>).usd);
  const legal = (c.legalities ?? {}) as Record<string, unknown>;
  const classifications = Array.isArray(c.classifications) ? (c.classifications as string[]).join(" · ") : "";
  return {
    game: "lorcana",
    sourceId,
    name: fullName,
    setCode: asString(set.code),
    setName: asString(set.name),
    number: asString(c.collector_number),
    rarity: asString(c.rarity),
    imageUrl: httpsOrNull(digital.small),
    largeImageUrl: httpsOrNull(digital.normal) ?? httpsOrNull(digital.large),
    price: usd ? { value: usd, currency: "USD" } : null,
    typeLine:
      [Array.isArray(c.type) ? (c.type as string[]).join(" · ") : null, classifications || null]
        .filter(Boolean)
        .join(" — ") || null,
    text: asString(c.text),
    flavor: asString(c.flavor_text),
    stats: stats(
      c.cost !== undefined ? stat("Cost", `${c.cost}${c.inkwell ? " (inkable)" : ""}`) : null,
      stat("Ink", inks.join(" / ")),
      stat("Strength", c.strength),
      stat("Willpower", c.willpower),
      stat("Lore", c.lore),
      stat("Move cost", c.move_cost)
    ),
    legalities: Object.entries(legal).map(([format, status]) => ({
      format: format.charAt(0).toUpperCase() + format.slice(1),
      status: String(status).replace("_", " "),
    })),
    artist: Array.isArray(c.illustrators) ? (c.illustrators as string[]).join(", ") : null,
    rules: {
      copyKey: fullName,
      unlimitedCopies: false,
      zone: "main",
      colors: inks,
      banLimit: null,
      cost: typeof c.cost === "number" && Number.isFinite(c.cost) ? c.cost : null,
      kind: lorcanaKind(c.type),
      traits: c.inkwell === true ? ["inkable"] : [],
    },
  };
}

/** A song is an action that characters can sing; it counts as its own kind. */
function lorcanaKind(type: unknown): string | null {
  const types = Array.isArray(type) ? (type as unknown[]).map((t) => String(t).toLowerCase()) : [];
  if (types.includes("song")) return "song";
  return types[0] ?? null;
}

// -------------------------------------------------------------- One Piece

export function mapOptcgDetail(json: unknown, sourceId: string): CardDetail | null {
  if (!Array.isArray(json)) return null;
  const entries = json as Array<Record<string, unknown>>;
  const c = entries.find((e) => asString(e.card_image_id) === sourceId) ?? entries[0];
  if (!c) return null;
  const name = asString(c.card_name);
  if (!name) return null;
  const cardNumber = asString(c.card_set_id) ?? sourceId.replace(/_.*$/, "");
  const colors = (asString(c.card_color) ?? "").split(/[\s/]+/).filter(Boolean);
  const type = asString(c.card_type);
  const price = asPrice(c.market_price);
  return {
    game: "onepiece",
    sourceId: asString(c.card_image_id) ?? sourceId,
    name,
    setCode: asString(c.set_id),
    setName: asString(c.set_name),
    number: cardNumber,
    rarity: asString(c.rarity),
    imageUrl: httpsOrNull(c.card_image),
    largeImageUrl: httpsOrNull(c.card_image),
    price: price ? { value: price, currency: "USD" } : null,
    typeLine: [type, colors.join(" / "), asString(c.sub_types)].filter(Boolean).join(" · ") || null,
    text: asString(c.card_text),
    flavor: null,
    stats: stats(
      stat("Cost", c.card_cost),
      stat("Power", c.card_power),
      stat("Counter", c.counter_amount),
      stat("Life", c.life),
      stat("Attribute", c.attribute)
    ),
    legalities: [],
    artist: null,
    rules: {
      // Alternate arts share a card number, and copies are counted by it.
      copyKey: cardNumber,
      unlimitedCopies: false,
      zone: type === "Leader" ? "leader" : "main",
      colors,
      banLimit: null,
      cost: type === "Leader" ? null : wholeNumber(c.card_cost),
      kind: type ? type.toLowerCase() : null,
      traits: [
        ...((wholeNumber(c.counter_amount) ?? 0) > 0 ? ["counter"] : []),
        ...(/\[Trigger\]/i.test(asString(c.card_text) ?? "") ? ["trigger"] : []),
      ],
    },
  };
}

/** "3", 3 or "3.0" as 3; anything else (null, "-", "") as null. */
function wholeNumber(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ---------------------------------------------------------------- fetchers

export type DetailFetcher = (sourceId: string) => Promise<CardDetail | null>;

export function detailFetchers(fetchFn: FetchLike = fetch): Record<TcgGame, DetailFetcher> {
  const guard = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new Error("That isn't a card id.");
    return encodeURIComponent(id);
  };
  return {
    mtg: async (id) =>
      mapScryfallDetail(await getCatalogJson(`https://api.scryfall.com/cards/${guard(id)}`, fetchFn)),
    yugioh: async (id) => {
      const cardId = id.split(":")[0];
      if (!/^\d{1,12}$/.test(cardId)) throw new Error("That isn't a card id.");
      return mapYgoprodeckDetail(
        await getCatalogJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${cardId}`, fetchFn),
        id
      );
    },
    pokemon: async (id) =>
      mapTcgdexDetail(await getCatalogJson(`https://api.tcgdex.net/v2/en/cards/${guard(id)}`, fetchFn)),
    lorcana: async (id) =>
      mapLorcastDetail(await getCatalogJson(`https://api.lorcast.com/v0/cards/${guard(id)}`, fetchFn)),
    onepiece: async (id) => {
      const number = guard(id.replace(/_.*$/, ""));
      const fromSets = await getCatalogJson(`https://optcgapi.com/api/sets/card/${number}/`, fetchFn);
      if (Array.isArray(fromSets) && fromSets.length) return mapOptcgDetail(fromSets, id);
      return mapOptcgDetail(
        await getCatalogJson(`https://optcgapi.com/api/decks/card/${number}/`, fetchFn),
        id
      );
    },
  };
}

/** Scryfall's /cards/collection takes at most this many identifiers a request. */
export const SCRYFALL_COLLECTION_BATCH = 75;

/**
 * Magic cards by exact name, many at once — one request per 75 names
 * instead of a search and a lookup for each card, which is what a
 * 100-card Commander import needs to stay inside Scryfall's rate limit.
 * Returns each found card (Scryfall's default printing) and the names it
 * doesn't know.
 */
export async function scryfallCardsByName(
  names: string[],
  fetchFn: FetchLike = fetch
): Promise<{ found: CardDetail[]; notFound: string[] }> {
  const found: CardDetail[] = [];
  const notFound: string[] = [];
  for (let i = 0; i < names.length; i += SCRYFALL_COLLECTION_BATCH) {
    const batch = names.slice(i, i + SCRYFALL_COLLECTION_BATCH);
    const response = await fetchWithRetry(fetchFn, "https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    });
    if (!response.ok) throw new Error(`The card database answered ${response.status}.`);
    const json = (await response.json()) as { data?: unknown[]; not_found?: Array<{ name?: unknown }> };
    for (const card of Array.isArray(json.data) ? json.data : []) {
      const detail = mapScryfallDetail(card);
      if (detail) found.push(detail);
    }
    for (const missing of Array.isArray(json.not_found) ? json.not_found : []) {
      if (typeof missing?.name === "string") notFound.push(missing.name);
    }
  }
  return { found, notFound };
}
