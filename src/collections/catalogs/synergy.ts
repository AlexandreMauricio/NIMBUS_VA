import { CardDetail, TcgGame } from "../types";
import { CardSources } from "./browse";
import { FetchLike, asString, getCatalogJson } from "./http";
import {
  mapLorcastDetail,
  mapScryfallDetail,
  mapTcgdexDetail,
  mapYgoprodeckDetail,
  scryfallCardsByName,
} from "./details";

/**
 * "Works well with" for a card page: cards with real synergy, and a short
 * reason for each — not just cards of the same colour.
 *
 *  - Magic: EDHREC's "High Lift" list for the card first — cards that
 *    appear in decks with it far more often than their popularity alone
 *    explains, measured over hundreds of thousands of Commander decklists.
 *    Then Scryfall searches for the themes in its own text and type (tokens,
 *    +1/+1 counters, sacrifice, graveyard, spells, its creature type…), most
 *    played first.
 *  - Lorcana: cards that name the character or its classifications
 *    ("Princess"), the character's other versions to Shift onto, singers
 *    for songs and songs for singers.
 *  - One Piece: cards that search or reward the card's types ("Straw Hat
 *    Crew" type), cards of the types it names, and cards that name it.
 *  - Pokémon: its evolution line, Standard-legal.
 *  - Yu-Gi-Oh!: cards that mention it by name, then its archetype.
 *
 * In the deck builder the results keep to the plan's colours (and Magic
 * legality). Only card names and themes are sent.
 */

export interface SynergyContext {
  /** Colours, inks or types the deck uses; empty for "any". */
  identity: string[];
  /** Magic only: standard, pioneer, modern, commander or any. */
  legality: string;
}

export interface SynergyCard {
  detail: CardDetail;
  reason: string;
}

export interface SynergyResult {
  cards: SynergyCard[];
  /** Where the suggestions come from, in a sentence, for the page to show. */
  source: string;
}

export type SynergyFinder = (card: CardDetail, context: SynergyContext) => Promise<SynergyResult>;

const MAX_CARDS = 12;

export function parseSynergyContext(raw: unknown): SynergyContext {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const identity = Array.isArray(r.identity)
    ? r.identity
        .filter((v): v is string => typeof v === "string" && /^[\p{L} '&-]{1,40}$/u.test(v))
        .slice(0, 5)
    : [];
  const legality =
    typeof r.legality === "string" &&
    ["standard", "pioneer", "modern", "commander", "any"].includes(r.legality)
      ? r.legality
      : "any";
  return { identity, legality };
}

/** Adds cards in score order, one per name, never the card itself. */
function collect(
  card: CardDetail,
  scored: Array<{ detail: CardDetail; score: number; reason: string }>
): SynergyCard[] {
  // Printings write names differently ("Ariel — \"Spectacular Singer\"" and without quotes).
  const key = (name: string) =>
    name
      .toLowerCase()
      .replace(/["'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const seen = new Set([key(card.name)]);
  const out: SynergyCard[] = [];
  for (const entry of scored.sort((a, b) => b.score - a.score)) {
    const name = key(entry.detail.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ detail: entry.detail, reason: entry.reason });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

// ---------------------------------------------------------------- Magic

/** EDHREC's page name for a card: "Urza's Saga" → "urzas-saga". Front face only. */
export function edhrecSlug(name: string): string {
  return name
    .split(" // ")[0]
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

/** Text patterns → a Scryfall query (its community oracle tags where they fit) → the reason shown. */
const MTG_THEMES: Array<[RegExp, string, string]> = [
  [
    /\bwhen (this creature|[^.]{1,40}) dies\b/i,
    "otag:sacrifice-outlet",
    "sacrificing creatures, which sets off its death trigger",
  ],
  [
    /\bwhen (this creature|this permanent|[^.]{1,40}) enters\b/i,
    "otag:blink",
    "flickering, to use its enters ability again",
  ],
  [/\bsearch your library for (a|up to \w+) basic land/i, "otag:ramp", "ramp"],
  [/\+1\/\+1 counter/i, 'o:"+1/+1 counter"', "+1/+1 counters"],
  [/\btokens?\b/i, "o:token", "tokens"],
  [/\bsacrifice/i, "o:sacrifice", "sacrifice"],
  [/\bgraveyard/i, "o:graveyard", "the graveyard"],
  [/\bgain(s)? .{0,12}life|\blifelink\b/i, 'o:"gain life"', "lifegain"],
  [/\binstant or sorcery|\bnoncreature spell/i, 'o:"instant or sorcery"', "casting spells"],
  [/\blandfall\b|\ba land enters/i, "o:landfall", "landfall"],
  [/\bequip(ment|ped)?\b/i, "t:equipment", "equipment"],
  [/\bartifacts?\b/i, "o:artifact", "artifacts"],
  [/\benchantments?\b/i, "o:enchantment", "enchantments"],
  [/\bdiscards?\b/i, "o:discard", "discard"],
  [/\bmill/i, "o:mill", "milling"],
  [/\btreasure/i, "o:treasure", "Treasure"],
  [/\bproliferate|\bpoison|\btoxic|\binfect/i, "o:proliferate", "proliferate and poison"],
  [/\bdraw (a|two|three|your second) cards?\b/i, 'o:"draw your second card"', "drawing cards"],
];

const GENERIC_TYPES = new Set(["Human"]);

/** A Magic card's themes, as Scryfall queries with the reason to show, at most three. */
export function mtgThemes(card: CardDetail): Array<{ query: string; label: string }> {
  const text = card.text ?? "";
  const themes: Array<{ query: string; label: string }> = [];
  const add = (query: string, label: string) => {
    if (themes.length < 3 && !themes.some((t) => t.query === query)) themes.push({ query, label });
  };
  // What its creature type is, and whether its own text cares about a type.
  const subtype =
    card.rules.kind === "creature" ? (card.typeLine ?? "").split("—")[1]?.trim().split(/\s+/)[0] : undefined;
  if (subtype && /^[A-Z][a-z]+$/.test(subtype) && new RegExp(`\\b${subtype}s?\\b`).test(text)) {
    add(`t:${subtype.toLowerCase()}`, `More ${subtype}s for it`);
  }
  for (const [pattern, query, label] of MTG_THEMES) if (pattern.test(text)) add(query, `Also about ${label}`);
  // What rewards a card like this one.
  // Humans are everywhere: a card that mentions them isn't a Human synergy.
  if (subtype && /^[A-Z][a-z]+$/.test(subtype) && !GENERIC_TYPES.has(subtype))
    add(`o:"${subtype}" -t:${subtype.toLowerCase()}`, `Rewards ${subtype}s`);
  if (card.rules.kind === "instant" || card.rules.kind === "sorcery")
    add('o:"instant or sorcery"', "Rewards casting spells");
  if (card.rules.kind === "artifact") add("o:artifact", "Rewards artifacts");
  if (card.rules.kind === "enchantment") add("o:enchantment", "Rewards enchantments");
  if (card.rules.kind === "land") add("o:landfall", "Rewards playing lands");
  return themes;
}

function fitsContext(detail: CardDetail, context: SynergyContext): boolean {
  if (context.legality !== "any") {
    const legal = detail.legalities.find((l) => l.format.toLowerCase() === context.legality);
    if (!legal || legal.status !== "legal") return false;
  }
  if (!context.identity.length) return true;
  const needs = new Set([...detail.rules.colors, ...Object.keys(detail.rules.pips ?? {})]);
  return [...needs].every((colour) => context.identity.includes(colour));
}

function mtgFinder(fetchFn: FetchLike): SynergyFinder {
  return async (card, context) => {
    const scored: Array<{ detail: CardDetail; score: number; reason: string }> = [];
    let usedEdhrec = false;
    try {
      const page = (await getCatalogJson(
        `https://json.edhrec.com/pages/cards/${encodeURIComponent(edhrecSlug(card.name))}.json`,
        fetchFn
      )) as {
        container?: { json_dict?: { cardlists?: Array<{ header?: string; cardviews?: unknown[] }> } };
      } | null;
      const lists = page?.container?.json_dict?.cardlists ?? [];
      const lift = lists.find((l) => /lift|synergy/i.test(l.header ?? ""));
      const names = (lift?.cardviews ?? [])
        .map((v) => asString((v as Record<string, unknown>).name))
        .filter((n): n is string => !!n)
        .slice(0, 20);
      if (names.length) {
        const { found } = await scryfallCardsByName(names, fetchFn);
        found.forEach((detail, i) => {
          if (fitsContext(detail, context)) {
            scored.push({ detail, score: 100 - i, reason: "Played with it far more often than usual" });
          }
        });
        usedEdhrec = scored.length > 0;
      }
    } catch {
      // EDHREC is an extra: the themes below still work without it.
    }

    const colours = context.identity.filter((c) => /^[WUBRG]$/.test(c)).join("");
    for (const theme of mtgThemes(card)) {
      if (scored.length >= MAX_CARDS * 2) break;
      const parts = [
        theme.query,
        colours ? `id<=${colours}` : "",
        context.legality !== "any" ? `f:${context.legality}` : "",
        `-!"${card.name.split(" // ")[0].replace(/"/g, "")}"`,
      ].filter(Boolean);
      try {
        const json = (await getCatalogJson(
          `https://api.scryfall.com/cards/search?q=${encodeURIComponent(parts.join(" "))}&order=edhrec`,
          fetchFn
        )) as { data?: unknown[] } | null;
        (json?.data ?? []).slice(0, 8).forEach((raw, i) => {
          const detail = mapScryfallDetail(raw);
          if (detail) scored.push({ detail, score: 50 - i, reason: theme.label });
        });
      } catch {
        // One theme failing leaves the others.
      }
    }
    return {
      cards: collect(card, scored),
      source: usedEdhrec
        ? "From EDHREC (cards played together far more than usual) and cards sharing its themes, most played first."
        : "Cards sharing its themes, most played first.",
    };
  };
}

// -------------------------------------------------------------- Lorcana

const lorcanaCharacter = (name: string) => name.split(" — ")[0].trim();
const lorcanaClasses = (card: CardDetail) =>
  (card.typeLine ?? "")
    .split(" — ")[1]
    ?.split(" · ")
    .map((c) => c.trim())
    .filter(Boolean) ?? [];

function lorcanaFinder(sources: CardSources): SynergyFinder {
  return async (card, context) => {
    const inks = context.identity.length ? context.identity : card.rules.colors;
    const query =
      `${inks.length > 1 ? `(${inks.map((i) => `i:${i.toLowerCase()}`).join(" or ")})` : inks[0] ? `i:${inks[0].toLowerCase()}` : ""} format:core`.trim();
    const json = (await sources.json(
      `https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(query)}`
    )) as {
      results?: unknown[];
    } | null;
    const pool = (json?.results ?? [])
      .map(mapLorcastDetail)
      .filter((c): c is CardDetail => c !== null)
      .filter((c) => !inks.length || c.rules.colors.every((ink) => inks.includes(ink)));

    const name = lorcanaCharacter(card.name);
    const text = card.text ?? "";
    const classes = lorcanaClasses(card);
    const scored: Array<{ detail: CardDetail; score: number; reason: string }> = [];
    for (const other of pool) {
      const otherName = lorcanaCharacter(other.name);
      const otherText = other.text ?? "";
      const reasons: Array<[number, string]> = [];
      if (
        otherName === name &&
        other.name !== card.name &&
        (/\bShift\b/.test(text) || /\bShift\b/.test(otherText))
      ) {
        reasons.push([6, `Another ${name} to Shift onto`]);
      }
      if (otherName !== name && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(otherText)) {
        reasons.push([5, `Names ${name}`]);
      }
      if (otherName !== name && new RegExp(`\\b${escapeRegExp(otherName)}\\b`).test(text)) {
        reasons.push([5, `${card.name} names ${otherName}`]);
      }
      const rewarded = classes.find((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`).test(otherText));
      if (rewarded) reasons.push([4, `Rewards ${rewarded} characters`]);
      const wanted = lorcanaClasses(other).find((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`).test(text));
      if (wanted && other.rules.kind === "character") reasons.push([4, `A ${wanted} for its ability`]);
      if (card.rules.kind === "song" && /\bSinger\b/.test(otherText))
        reasons.push([3, "A Singer that can sing it"]);
      if (/\bSinger\b/.test(text) && other.rules.kind === "song") reasons.push([3, "A song it can sing"]);
      if (reasons.length) {
        const best = reasons.sort((a, b) => b[0] - a[0])[0];
        scored.push({ detail: other, score: best[0] + reasons.length * 0.1, reason: best[1] });
      }
    }
    return {
      cards: collect(card, scored),
      source: "Cards that name it, share its classifications, or sing its songs.",
    };
  };
}

// ------------------------------------------------------------ One Piece

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The types a One Piece card is ("Straw Hat Crew/Supernovas" → both), from its type line. */
const onePieceTypes = (card: CardDetail): string[] => {
  const parts = (card.typeLine ?? "").split(" · ");
  return parts.length >= 3
    ? parts[parts.length - 1]
        .split("/")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
};

/** The types a card's text names: `"Straw Hat Crew" type` or `{Straw Hat Crew}`. */
const namedTypes = (text: string): string[] =>
  [...text.matchAll(/"([^"]+)" type|\{([^}]+)\}/g)]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter((t) => !/^\d|DON/i.test(t));

function onePieceFinder(sources: CardSources): SynergyFinder {
  return async (card, context) => {
    const colours = new Set(
      (context.identity.length ? context.identity : card.rules.colors).map((c) => c.toLowerCase())
    );
    const pool = (await sources.onePieceCards()).filter(
      (c) => c.rules.kind !== "leader" && c.rules.colors.some((colour) => colours.has(colour.toLowerCase()))
    );
    const text = card.text ?? "";
    const types = onePieceTypes(card);
    const wanted = namedTypes(text);
    const scored: Array<{ detail: CardDetail; score: number; reason: string }> = [];
    for (const other of pool) {
      const otherText = other.text ?? "";
      const reasons: Array<[number, string]> = [];
      const isWanted = onePieceTypes(other).find((t) => wanted.includes(t));
      if (isWanted) reasons.push([5, `A ${isWanted} card it looks for`]);
      const supports = namedTypes(otherText).find((t) => types.includes(t));
      if (supports) reasons.push([4, `Rewards ${supports} cards`]);
      if (otherText.includes(`[${card.name}]`)) reasons.push([5, `Names ${card.name}`]);
      if (text.includes(`[${other.name}]`)) reasons.push([5, `${card.name} names it`]);
      if (reasons.length) {
        const best = reasons.sort((a, b) => b[0] - a[0])[0];
        scored.push({ detail: other, score: best[0] + reasons.length * 0.1, reason: best[1] });
      }
    }
    return { cards: collect(card, scored), source: "Cards that search for or reward its types, or name it." };
  };
}

// -------------------------------------------------------------- Pokémon

function pokemonFinder(sources: CardSources): SynergyFinder {
  return async (card) => {
    const raw = (await sources.json(
      `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(card.sourceId)}`
    )) as Record<string, unknown> | null;
    const list = async (params: string) => {
      const json = await sources.json(`https://api.tcgdex.net/v2/en/cards?${params}&legal.standard=true`);
      return (Array.isArray(json) ? json : [])
        .map((b) => ({
          id: asString((b as Record<string, unknown>).id),
          name: asString((b as Record<string, unknown>).name),
        }))
        .filter((b): b is { id: string; name: string } => !!b.id && !!b.name);
    };
    const found: Array<{ id: string; name: string; reason: string; score: number }> = [];
    const from = asString(raw?.evolveFrom);
    if (from) {
      for (const b of await list(`name=${encodeURIComponent(from)}`)) {
        if (b.name === from) found.push({ ...b, reason: `${card.name} evolves from it`, score: 5 });
      }
      // And what that one evolves from, for a Stage 2.
      const parent = found[0]
        ? ((await sources.json(
            `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(found[0].id)}`
          )) as Record<string, unknown> | null)
        : null;
      const grandparent = asString(parent?.evolveFrom);
      if (grandparent) {
        for (const b of await list(`name=${encodeURIComponent(grandparent)}`)) {
          if (b.name === grandparent) found.push({ ...b, reason: "The Basic of its line", score: 4 });
        }
      }
    }
    const base = card.name.replace(/\s+ex$/i, "");
    for (const b of await list(`evolveFrom=${encodeURIComponent(base)}`)) {
      found.push({ ...b, reason: `Evolves from ${base}`, score: 5 });
    }
    const unique = [...new Map(found.map((f) => [f.name, f])).values()].slice(0, 8);
    const details = await Promise.all(
      unique.map((f) =>
        sources
          .json(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(f.id)}`)
          .then(mapTcgdexDetail, () => null)
          .then((detail) => (detail ? { detail, score: f.score, reason: f.reason } : null))
      )
    );
    return {
      cards: collect(
        card,
        details.filter((d): d is NonNullable<typeof d> => d !== null)
      ),
      source: "Its evolution line, from Standard-legal cards.",
    };
  };
}

// ------------------------------------------------------------ Yu-Gi-Oh!

function yugiohFinder(sources: CardSources): SynergyFinder {
  return async (card) => {
    const cards = async (url: string) => {
      const json = (await sources.json(url).catch(() => null)) as { data?: unknown[] } | null;
      return (json?.data ?? [])
        .map((c) => mapYgoprodeckDetail({ data: [c] }, String((c as Record<string, unknown>).id ?? "")))
        .filter((c): c is CardDetail => c !== null && /^\d+$/.test(c.sourceId));
    };
    const scored: Array<{ detail: CardDetail; score: number; reason: string }> = [];
    for (const detail of await cards(
      `https://db.ygoprodeck.com/api/v7/cardinfo.php?desc=${encodeURIComponent(card.name)}`
    )) {
      scored.push({ detail, score: 5, reason: `Mentions ${card.name}` });
    }
    const archetype = card.stats.find((s) => s.label === "Archetype")?.value;
    if (archetype) {
      for (const detail of await cards(
        `https://db.ygoprodeck.com/api/v7/cardinfo.php?archetype=${encodeURIComponent(archetype)}`
      )) {
        scored.push({ detail, score: 3, reason: `${archetype} archetype` });
      }
    }
    return { cards: collect(card, scored), source: "Cards that mention it by name, then its archetype." };
  };
}

export function synergyFinders(fetchFn: FetchLike, sources: CardSources): Record<TcgGame, SynergyFinder> {
  return {
    mtg: mtgFinder(fetchFn),
    lorcana: lorcanaFinder(sources),
    onepiece: onePieceFinder(sources),
    pokemon: pokemonFinder(sources),
    yugioh: yugiohFinder(sources),
  };
}
