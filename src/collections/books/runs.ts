import { IssueRun, MAX_ISSUE_NUMBER, MAX_RUNS_PER_BOOK } from "./types";

/**
 * Reads "what a book collects" out of text — both the notes a database
 * keeps ("Collects Journey Into Mystery (1952) #110-125, Annual #1, Thor
 * (1966) #126-130, and material from Not Brand Echh #3") and what you type
 * yourself in the same shape ("Thor (1966) #1-45; Thor Annual #1").
 *
 * Deterministic and forgiving: parts it can't read are skipped and
 * reported, never guessed at, so a half-understood note fills in what it
 * can and you complete the rest.
 */
export interface ParsedRuns {
  runs: IssueRun[];
  /** Pieces that looked like contents but couldn't be read. */
  unread: string[];
}

/**
 * Splits on separators that are outside parentheses: "(Marvel, 1966 series)"
 * stays whole. Each part remembers whether " and " or "," joined it to the
 * one before — "material from A #1 and B #2" is material from both.
 */
function splitTopLevel(text: string): Array<{ text: string; continues: boolean }> {
  const parts: Array<{ text: string; continues: boolean }> = [];
  let depth = 0;
  let current = "";
  let continues = false;
  const push = (next: boolean) => {
    if (current.trim()) parts.push({ text: current.trim(), continues });
    current = "";
    continues = next;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ";" || ch === ",")) {
      push(ch === ",");
      continue;
    }
    // "Journey into Mystery #83-109 and Tales of Asgard #1" is two runs, but
    // "Iron Man and Sub-Mariner #1", "Ant-Man and the Wasp #1" and "Cloak and
    // Dagger #1" are series names: " and " only splits after an issue number.
    if (depth === 0 && text.slice(i, i + 5).toLowerCase() === " and " && /\d\s*$/.test(current)) {
      push(true);
      i += 4;
      continue;
    }
    current += ch;
  }
  push(false);
  return parts;
}

/** "#1-17", "#15", "#1–3", "#83 - 100" → [from, to]. */
function readNumbers(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/(\d+)\s*(?:[-–—]\s*(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] !== undefined ? Number(match[2]) : from;
    if (from >= 0 && to >= from && to <= MAX_ISSUE_NUMBER) ranges.push([from, to]);
  }
  return ranges;
}

/**
 * "The Amazing Spider-Man (Marvel, 1963 series)" → name and year; "Thor
 * (1966)" too. "Doctor Strange (vol. 2)" keeps its volume in the name —
 * it's a different series from the first.
 */
function readSeries(raw: string): { series: string; year: number | null } {
  let year: number | null = null;
  const withoutParens = raw.replace(/\(([^)]*)\)/g, (_all, inside: string) => {
    const found = inside.match(/\b(1[89]\d\d|20\d\d)\b/);
    if (found && year === null) year = Number(found[1]);
    const volume = inside.match(/\bvol(?:ume)?\.?\s*(\d+)\b/i);
    return volume ? ` vol. ${volume[1]} ` : " ";
  });
  const series = withoutParens.replace(/\s+/g, " ").trim();
  return { series, year };
}

/** Just the contents part of a note: from "Collects"/"Reprints", to the end of that sentence. */
function contentsOf(text: string): string {
  const match = text.match(/\b(?:collects|collecting|reprints|reprinting|contains)\b[:\s]*([\s\S]*)/i);
  let body = match ? match[1] : text;
  // Stop at the end of the sentence that holds the contents: a period
  // followed by a line break or a capitalised word that isn't a series name.
  const lineEnd = body.search(/\r?\n/);
  if (lineEnd !== -1) body = body.slice(0, lineEnd);
  return body.replace(/\.\s*$/, "").trim();
}

export function parseRuns(text: string): ParsedRuns {
  const runs: IssueRun[] = [];
  const unread: string[] = [];
  if (typeof text !== "string" || !text.trim()) return { runs, unread };

  let previous: { series: string; year: number | null } | null = null;
  let previousPartial = false;

  for (const piece of splitTopLevel(contentsOf(text))) {
    let part = piece.text;
    // "…; material from A #1; B #2 and C #3": lists put partial reprints
    // last, so everything after "material from" is material too.
    let partial: boolean = previousPartial;
    part = part.replace(/^and\s+/i, "");
    if (/^(?:some\s+)?material\s+from\s+/i.test(part)) {
      partial = true;
      part = part.replace(/^(?:some\s+)?material\s+from\s+/i, "");
    }
    previousPartial = partial;

    const hash = part.indexOf("#");
    // "Strange Tales #110–111, 114–146": bare numbers continue the series before.
    if (hash === -1 && previous && piece.continues && /^\d+\s*(?:[-–—]\s*\d+)?$/.test(part)) {
      for (const [from, to] of readNumbers(part)) {
        runs.push({ series: previous.series, year: previous.year, from, to, partial });
        if (runs.length >= MAX_RUNS_PER_BOOK) return { runs, unread };
      }
      continue;
    }
    if (hash === -1) {
      // "(1966-1968)" left over after the numbers, and similar, isn't contents.
      if (/\d/.test(part) && !/^\(?\s*\d{4}\s*[-–]\s*\d{4}\s*\)?$/.test(part)) unread.push(part);
      continue;
    }

    const namePart = part.slice(0, hash).trim();
    const numbers = readNumbers(part.slice(hash + 1).replace(/\(\s*\d{4}\s*[-–]\s*\d{4}\s*\)/g, ""));
    if (numbers.length === 0) {
      unread.push(part);
      continue;
    }

    let series: { series: string; year: number | null };
    if (!namePart) {
      // "#5-8" after "Thor #1-4": the same series again.
      if (!previous) {
        unread.push(part);
        continue;
      }
      series = previous;
    } else if (/^annual$/i.test(namePart) && previous) {
      // "Annual #1" after "Thor (1966) #126-130": that series' annual.
      series = { series: `${previous.series.replace(/\s+Annual$/i, "")} Annual`, year: previous.year };
    } else {
      series = readSeries(namePart);
      if (!series.series) {
        unread.push(part);
        continue;
      }
    }
    // The series exactly as named, so "#140-145" continues "Thor Annual";
    // "Annual #2" strips a trailing "Annual" itself before adding one.
    previous = { series: series.series, year: series.year };

    for (const [from, to] of numbers) {
      runs.push({ series: series.series, year: series.year, from, to, partial });
      if (runs.length >= MAX_RUNS_PER_BOOK) return { runs, unread };
    }
  }
  return { runs, unread };
}

/** How a run is written back for editing — and it parses back to itself. */
export function formatRun(run: IssueRun): string {
  const name = run.year ? `${run.series} (${run.year})` : run.series;
  const numbers = run.from === run.to ? `#${run.from}` : `#${run.from}-${run.to}`;
  return `${run.partial ? "material from " : ""}${name} ${numbers}`;
}

export function formatRuns(runs: IssueRun[]): string {
  return runs.map(formatRun).join("; ");
}

/** The identity two runs are compared by: the name, loosely, and the year when known. */
export function seriesKey(series: string, year: number | null): string {
  const name = series
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return year ? `${name} (${year})` : name;
}
