import { ReferenceDeck } from "../decks/compare";
import { FetchLike, asString, getCatalogJson } from "./http";
import { edhrecSlug } from "./synergy";

/**
 * EDHREC's average Commander decks, from its public JSON pages (the same
 * data its website draws — not an official API, so read defensively).
 *
 *  - pages/commanders/<commander>.json: how many decklists, and the
 *    commander's popular themes ("Goblins", "Tokens", …).
 *  - pages/average-decks/<commander>[/<variant>].json: a 99-card average
 *    deck, cards grouped by type as [name, quantity] — for the commander,
 *    its "budget" and "expensive" builds, and each theme.
 *
 *  - pages/commanders/<colours>.json ("simic") and
 *    pages/tags/<theme>/<colours>.json ("Simic +1/+1 Counters"): the most
 *    played commanders of a colour identity, overall or with a theme — so a
 *    deck can be compared with similar commanders' decks, not only its own
 *    commander's (see similarCommanders and blendDecks).
 *
 * Only commander names, colour names and theme names are sent.
 */

/** EDHREC's name for each colour identity, by its WUBRG letters in that order. */
export const EDHREC_COLOURS: Record<string, { slug: string; name: string }> = {
  "": { slug: "colorless", name: "Colorless" },
  W: { slug: "mono-white", name: "Mono-White" },
  U: { slug: "mono-blue", name: "Mono-Blue" },
  B: { slug: "mono-black", name: "Mono-Black" },
  R: { slug: "mono-red", name: "Mono-Red" },
  G: { slug: "mono-green", name: "Mono-Green" },
  WU: { slug: "azorius", name: "Azorius" },
  UB: { slug: "dimir", name: "Dimir" },
  BR: { slug: "rakdos", name: "Rakdos" },
  RG: { slug: "gruul", name: "Gruul" },
  WG: { slug: "selesnya", name: "Selesnya" },
  WB: { slug: "orzhov", name: "Orzhov" },
  UR: { slug: "izzet", name: "Izzet" },
  BG: { slug: "golgari", name: "Golgari" },
  WR: { slug: "boros", name: "Boros" },
  UG: { slug: "simic", name: "Simic" },
  WUB: { slug: "esper", name: "Esper" },
  UBR: { slug: "grixis", name: "Grixis" },
  BRG: { slug: "jund", name: "Jund" },
  WRG: { slug: "naya", name: "Naya" },
  WUG: { slug: "bant", name: "Bant" },
  WBG: { slug: "abzan", name: "Abzan" },
  WUR: { slug: "jeskai", name: "Jeskai" },
  UBG: { slug: "sultai", name: "Sultai" },
  WBR: { slug: "mardu", name: "Mardu" },
  URG: { slug: "temur", name: "Temur" },
  WUBR: { slug: "yore-tiller", name: "Yore-Tiller" },
  UBRG: { slug: "glint-eye", name: "Glint-Eye" },
  WBRG: { slug: "dune-brood", name: "Dune-Brood" },
  WURG: { slug: "ink-treader", name: "Ink-Treader" },
  WUBG: { slug: "witch-maw", name: "Witch-Maw" },
  WUBRG: { slug: "five-color", name: "Five-Color" },
};

/** "GU", ["u","g"] or "gu" → EDHREC's colour identity entry. */
export function edhrecColours(identity: string[]): { slug: string; name: string } {
  const letters = new Set(identity.map((c) => c.toUpperCase()));
  const key = ["W", "U", "B", "R", "G"].filter((c) => letters.has(c)).join("");
  return EDHREC_COLOURS[key];
}

/** How many similar commanders a "similar" reference deck is averaged from. */
export const SIMILAR_COMMANDERS = 5;

export interface CommanderVariant {
  /**
   * "" for the plain average; "budget", "expensive", or a theme's slug — or
   * "similar" / "similar:<theme>" for similar commanders' decks, blended.
   */
  id: string;
  label: string;
  decks: number | null;
}

export interface CommanderReferences {
  commander: string;
  slug: string;
  decks: number | null;
  /** The commander's colour identity, as EDHREC names it ("Simic"). */
  colours: { slug: string; name: string } | null;
  variants: CommanderVariant[];
}

const MAX_THEMES = 6;

export async function commanderReferences(
  commander: string,
  fetchFn: FetchLike = fetch
): Promise<CommanderReferences> {
  const slug = edhrecSlug(commander);
  const page = (await getCatalogJson(
    `https://json.edhrec.com/pages/commanders/${encodeURIComponent(slug)}.json`,
    fetchFn
  )) as {
    panels?: { taglinks?: Array<{ count?: unknown; slug?: unknown; value?: unknown }> };
    container?: { json_dict?: { card?: { num_decks?: unknown; color_identity?: unknown } } };
  } | null;
  if (!page) throw new Error(`EDHREC has no page for ${commander} — it may be too new, or not a commander.`);
  const decks = Number(page.container?.json_dict?.card?.num_decks);
  const identity = page.container?.json_dict?.card?.color_identity;
  const colours = Array.isArray(identity)
    ? (edhrecColours(identity.filter((c): c is string => typeof c === "string" && /^[wubrg]$/i.test(c))) ??
      null)
    : null;
  const themes = (page.panels?.taglinks ?? [])
    .map((t) => ({ id: asString(t.slug), label: asString(t.value), decks: Number(t.count) }))
    .filter(
      (t): t is { id: string; label: string; decks: number } =>
        !!t.id && !!t.label && /^[a-z0-9-]{1,60}$/.test(t.id)
    )
    .slice(0, MAX_THEMES);
  return {
    commander,
    slug,
    decks: Number.isFinite(decks) ? decks : null,
    colours,
    variants: [
      { id: "", label: "Average deck", decks: Number.isFinite(decks) ? decks : null },
      { id: "budget", label: "Budget average", decks: null },
      { id: "expensive", label: "Expensive average", decks: null },
      ...themes.map((t) => ({
        id: t.id,
        label: `${t.label} average`,
        decks: Number.isFinite(t.decks) ? t.decks : null,
      })),
      ...(colours
        ? [
            {
              id: "similar",
              label: `Similar: top ${SIMILAR_COMMANDERS} ${colours.name} commanders`,
              decks: null,
            },
            ...themes.map((t) => ({
              id: `similar:${t.id}`,
              label: `Similar: top ${SIMILAR_COMMANDERS} ${colours.name} ${t.label} commanders`,
              decks: null,
            })),
          ]
        : []),
    ],
  };
}

export interface SimilarCommander {
  name: string;
  slug: string;
  decks: number | null;
}

/**
 * The most played commanders of a colour identity — with a theme, EDHREC's
 * "Simic +1/+1 Counters" page's top commanders — leaving out `excludeSlug`
 * (your own commander).
 */
export async function similarCommanders(
  coloursSlug: string,
  theme: string | null,
  excludeSlug: string,
  fetchFn: FetchLike = fetch,
  limit = SIMILAR_COMMANDERS
): Promise<SimilarCommander[]> {
  if (!/^[a-z-]{1,30}$/.test(coloursSlug) || (theme !== null && !/^[a-z0-9-]{1,60}$/.test(theme))) {
    throw new Error("That isn't a colour identity.");
  }
  const url = theme
    ? `https://json.edhrec.com/pages/tags/${theme}/${coloursSlug}.json`
    : `https://json.edhrec.com/pages/commanders/${coloursSlug}.json`;
  const page = (await getCatalogJson(url, fetchFn)) as {
    container?: { json_dict?: { cardlists?: Array<{ tag?: unknown; cardviews?: unknown[] }> } };
  } | null;
  const lists = page?.container?.json_dict?.cardlists ?? [];
  // A colour page has one list of commanders; a theme page has "Top Commanders" among its card lists.
  const list = theme ? lists.find((l) => l.tag === "topcommanders") : lists[0];
  const out: SimilarCommander[] = [];
  for (const raw of list?.cardviews ?? []) {
    const view = (raw ?? {}) as Record<string, unknown>;
    const name = asString(view.name);
    const slug = asString(view.sanitized) ?? (name ? edhrecSlug(name) : null);
    if (!name || !slug || !/^[a-z0-9-]{1,120}$/.test(slug) || slug === excludeSlug) continue;
    const decks = Number(view.num_decks);
    out.push({ name, slug, decks: Number.isFinite(decks) ? decks : null });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Several average decks as one: each card scored by its average copies
 * across the decks (a card in 3 of 5 decks scores 0.6; 30 Forests in each
 * score 30), most shared first, until the deck holds `size` cards. What
 * similar commanders' decks agree on rises to the top; a card only one of
 * them plays drops off the end.
 */
export function blendDecks(id: string, label: string, decks: ReferenceDeck[], size = 99): ReferenceDeck {
  const totals = new Map<string, { name: string; quantity: number }>();
  for (const deck of decks) {
    for (const card of deck.cards) {
      const key = card.name.toLowerCase();
      const entry = totals.get(key) ?? { name: card.name, quantity: 0 };
      entry.quantity += card.quantity;
      totals.set(key, entry);
    }
  }
  const n = Math.max(1, decks.length);
  const ranked = [...totals.values()]
    .map((c) => ({ name: c.name, score: c.quantity / n }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const cards: Array<{ name: string; quantity: number }> = [];
  let count = 0;
  for (const card of ranked) {
    if (count >= size) break;
    const quantity = Math.min(size - count, Math.max(1, Math.round(card.score)));
    cards.push({ name: card.name, quantity });
    count += quantity;
  }
  return { id, label, decks: decks.length, cards };
}

/** One average deck: the commander's (variant ""), its budget or expensive build, or a theme's. */
export async function averageDeck(
  slug: string,
  variant: CommanderVariant,
  fetchFn: FetchLike = fetch
): Promise<ReferenceDeck> {
  if (!/^[a-z0-9-]{1,120}$/.test(slug) || !/^[a-z0-9-]{0,60}$/.test(variant.id))
    throw new Error("That isn't a commander.");
  const path = variant.id ? `${slug}/${variant.id}` : slug;
  const json = (await getCatalogJson(
    `https://json.edhrec.com/pages/average-decks/${path}.json`,
    fetchFn
  )) as {
    deck?: { cards?: Record<string, unknown> };
  } | null;
  const groups = json?.deck?.cards;
  if (!groups || typeof groups !== "object")
    throw new Error(`EDHREC has no ${variant.label.toLowerCase()} for this commander.`);
  const cards = new Map<string, { name: string; quantity: number }>();
  for (const list of Object.values(groups)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!Array.isArray(entry)) continue;
      const name = asString(entry[0]);
      const quantity = Number(entry[1]);
      if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) continue;
      const kept = cards.get(name) ?? { name, quantity: 0 };
      kept.quantity += quantity;
      cards.set(name, kept);
    }
  }
  if (!cards.size) throw new Error(`EDHREC's ${variant.label.toLowerCase()} is empty.`);
  return { id: variant.id, label: variant.label, decks: variant.decks, cards: [...cards.values()] };
}
