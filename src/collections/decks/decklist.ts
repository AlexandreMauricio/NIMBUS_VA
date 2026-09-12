import { TcgGame } from "../types";
import { Deck, DeckZone, zoneLabel, zonesFor } from "./types";

/**
 * Decklists as text — the format deck sites and players paste around:
 * a quantity and a name per line, zones as headings.
 *
 *   Main deck
 *   4 Lightning Bolt
 *   20 Mountain
 *
 *   Sideboard
 *   2 Pyroblast
 *
 * Reading is forgiving ("4x Lightning Bolt", "Sideboard:", "SB: 2 Pyroblast",
 * a trailing set code "(M11) 146"); lines it can't read are returned, not
 * dropped.
 */

export interface DecklistLine {
  zone: DeckZone;
  quantity: number;
  name: string;
}

const ZONE_HEADINGS: Array<[RegExp, DeckZone]> = [
  [/^(main\s*(deck)?|deck|maindeck)\s*:?$/i, "main"],
  [/^(side\s*(board|deck)?|sb)\s*:?$/i, "side"],
  [/^(extra\s*(deck)?)\s*:?$/i, "extra"],
  [/^(commander|leader)\s*:?$/i, "leader"],
];

export function parseDecklist(text: string): { lines: DecklistLine[]; unread: string[] } {
  const lines: DecklistLine[] = [];
  const unread: string[] = [];
  let zone: DeckZone = "main";
  for (const raw of (typeof text === "string" ? text : "").split(/\r?\n/).slice(0, 500)) {
    let line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const heading = ZONE_HEADINGS.find(([pattern]) => pattern.test(line.replace(/\s*\(\d+\)\s*$/, "")));
    if (heading) {
      zone = heading[1];
      continue;
    }
    let lineZone = zone;
    const sb = line.match(/^SB:\s*(.*)$/i);
    if (sb) {
      lineZone = "side";
      line = sb[1];
    }
    const match = line.match(/^(\d{1,2})\s*x?\s+(.+?)\s*$/i);
    if (!match) {
      unread.push(raw.trim());
      continue;
    }
    // "(M11) 146" or "[M11]" after the name is a printing, not part of it.
    const name = match[2].replace(/\s*[([][A-Za-z0-9-]{2,8}[)\]](\s+[A-Za-z0-9-]+)?\s*$/, "").trim();
    const quantity = Number(match[1]);
    if (!name || quantity < 1) {
      unread.push(raw.trim());
      continue;
    }
    lines.push({ zone: lineZone, quantity, name });
  }
  return { lines, unread };
}

export function formatDecklist(deck: Pick<Deck, "cards" | "format">, game: TcgGame): string {
  const sections: string[] = [];
  for (const zone of zonesFor(game, deck.format)) {
    const cards = deck.cards.filter((card) => card.zone === zone);
    if (!cards.length) continue;
    const body = cards
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((card) => `${card.quantity} ${card.name}`)
      .join("\n");
    sections.push(`${zoneLabel(game, zone)}\n${body}`);
  }
  return sections.join("\n\n");
}

/** Names compare loosely: case, and a dash typed as "-" versus "—". */
export function sameCardName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s*[-–—]\s*/g, " - ")
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
}
