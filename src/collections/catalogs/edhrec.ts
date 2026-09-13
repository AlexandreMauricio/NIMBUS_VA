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
 * Only the commander's name is sent.
 */

export interface CommanderVariant {
  /** "" for the plain average; "budget", "expensive", or a theme's slug. */
  id: string;
  label: string;
  decks: number | null;
}

export interface CommanderReferences {
  commander: string;
  slug: string;
  decks: number | null;
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
    container?: { json_dict?: { card?: { num_decks?: unknown } } };
  } | null;
  if (!page) throw new Error(`EDHREC has no page for ${commander} — it may be too new, or not a commander.`);
  const decks = Number(page.container?.json_dict?.card?.num_decks);
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
    variants: [
      { id: "", label: "Average deck", decks: Number.isFinite(decks) ? decks : null },
      { id: "budget", label: "Budget average", decks: null },
      { id: "expensive", label: "Expensive average", decks: null },
      ...themes.map((t) => ({
        id: t.id,
        label: `${t.label} average`,
        decks: Number.isFinite(t.decks) ? t.decks : null,
      })),
    ],
  };
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
