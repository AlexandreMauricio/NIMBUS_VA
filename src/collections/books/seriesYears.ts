import { GcdSeries, descriptorNumber } from "./gcd";
import type { IssueRun } from "./types";

/**
 * Which series a run without a year means.
 *
 * "Amazing Spider-Man #29–31" is three different comics depending on the
 * volume: 1963, 1999, 2014, 2015, 2018, 2022. Contents copied from Wikipedia
 * or GCD's notes usually leave the year out, and guessing the one volume
 * the shelf already knows mixed a 2019 event into a 1960s Epic Collection.
 *
 * So each yearless run is matched against GCD's series of that name: kept
 * are English series (not collected editions) from the book's publisher
 * that actually have those issue numbers. One left is the answer. Several
 * are narrowed by the book's era — the years of its other runs, dated or
 * worked out here — to the volume running then. Anything still open is
 * handed back for the reader to choose. Pure; the main process fetches.
 */

export interface YearCandidate {
  year: number;
  yearEnded: number | null;
  /** How many issues GCD lists for it — a hint when two look alike. */
  issues: number;
  publisher: string | null;
}

export interface AmbiguousRun {
  /** The run's position in the book's runs. */
  index: number;
  series: string;
  from: number;
  to: number;
  choices: YearCandidate[];
}

export interface YearResolution {
  /** Run index → the year worked out for it. */
  years: Map<number, number>;
  ambiguous: AmbiguousRun[];
  /** Runs no GCD series of that name has the issues for. */
  unknown: number[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "Marvel" and "Marvel Comics" are the same publisher. */
const samePublisher = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));

/** GCD's series that could be this run: same name, English, a comic (not a collection), with its first and last issue. */
export function yearCandidates(
  series: GcdSeries[],
  run: Pick<IssueRun, "series" | "from" | "to">,
  publisher: string | null
): YearCandidate[] {
  const byYear = new Map<number, YearCandidate>();
  for (const s of series) {
    if (norm(s.name) !== norm(run.series) || s.yearBegan === null) continue;
    if (s.language && s.language !== "en") continue;
    if (/collected edition|trade paperback|graphic novel/i.test(s.publishingFormat ?? "")) continue;
    const numbers = new Set(s.volumes.map((v) => descriptorNumber(v.descriptor)));
    if (!numbers.has(run.from) || !numbers.has(run.to)) continue;
    // A publisher we can name must match the book's; an unnamed one can't rule anything out.
    if (publisher && s.publisher && !samePublisher(publisher, s.publisher)) continue;
    const kept = byYear.get(s.yearBegan);
    if (!kept || s.volumes.length > kept.issues) {
      byYear.set(s.yearBegan, {
        year: s.yearBegan,
        yearEnded: s.yearEnded,
        issues: s.volumes.length,
        publisher: s.publisher,
      });
    }
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The candidate running in `era`, else the latest to start before it. */
export function pickForEra(choices: YearCandidate[], era: number): YearCandidate | null {
  const running = choices.filter((c) => c.year <= era && (c.yearEnded ?? Infinity) >= era);
  if (running.length === 1) return running[0];
  const before = (running.length ? running : choices).filter((c) => c.year <= era);
  return before.length ? before[before.length - 1] : null;
}

/**
 * Years for a book's yearless runs, given each run's candidates (by run
 * index). Dated runs, and runs with a single candidate, set the era the
 * rest are placed in.
 */
export interface SeriesSource {
  seriesFirstPage(name: string): Promise<{ series: GcdSeries[]; complete: boolean }>;
  seriesByYear(name: string, year: number): Promise<GcdSeries[]>;
}

export interface WorkedOutYears extends YearResolution {
  /** Set when GCD asked for a pause part way; what was worked out is kept. */
  paused: string | null;
}

/** How many years before the era a crowded series name is looked for. */
const PROBE_YEARS = 6;

/**
 * Works out the years of a book's yearless runs from GCD, as economically
 * as GCD's rate limit needs: one page per series name; names with more
 * series than a page are looked up only by the years just before the era
 * (the book's dated runs and the names settled from one page — or, failing
 * those, the year the book was published). A crowded name with no era is
 * left for the reader, with what the first page offered.
 */
export async function workOutRunYears(
  runs: IssueRun[],
  publisher: string | null,
  source: SeriesSource,
  publicationYear: number | null = null
): Promise<WorkedOutYears> {
  // Names whose series all fit on one page are settled from it; the rest are "crowded".
  const complete = new Map<number, YearCandidate[]>();
  const crowded = new Map<number, YearCandidate[]>();
  let paused: string | null = null;
  try {
    const pages = new Map<string, { series: GcdSeries[]; complete: boolean }>();
    for (const [index, run] of runs.entries()) {
      if (run.year !== null) continue;
      const key = norm(run.series);
      if (!pages.has(key)) pages.set(key, await source.seriesFirstPage(run.series));
      const page = pages.get(key)!;
      (page.complete ? complete : crowded).set(index, yearCandidates(page.series, run, publisher));
    }
  } catch (err) {
    paused = String(err).replace(/^.*Error: /, "");
  }

  const result = resolveRunYears(runs, complete);
  const known = [...runs.map((r) => r.year).filter((y): y is number => y !== null), ...result.years.values()];
  const era = median(known) ?? publicationYear;

  const probed = new Map<string, GcdSeries[]>();
  for (const [index, firstPage] of crowded) {
    const run = runs[index];
    let choices = firstPage;
    if (era !== null && !paused) {
      try {
        const key = norm(run.series);
        if (!probed.has(key)) {
          const series: GcdSeries[] = [];
          for (let year = era; year >= era - PROBE_YEARS; year--) {
            series.push(...(await source.seriesByYear(run.series, year)));
            // GCD's rate limit is tight: stop once a volume running in the era has the issues.
            const running = yearCandidates(series, run, publisher).filter(
              (c) => c.year <= era && (c.yearEnded ?? Infinity) >= era
            );
            if (running.length) break;
          }
          probed.set(key, series);
        }
        const found = yearCandidates(probed.get(key)!, run, publisher);
        choices = [...new Map([...firstPage, ...found].map((c) => [c.year, c])).values()].sort(
          (a, b) => a.year - b.year
        );
      } catch (err) {
        paused = String(err).replace(/^.*Error: /, "");
      }
    }
    // Only a series actually running around the era counts; a partial list never settles a name alone.
    const picked = era !== null ? pickForEra(choices, era) : null;
    if (picked && (picked.yearEnded ?? Infinity) >= era! - 2) result.years.set(index, picked.year);
    else result.ambiguous.push({ index, series: run.series, from: run.from, to: run.to, choices });
  }
  return { ...result, paused };
}

export function resolveRunYears(runs: IssueRun[], candidates: Map<number, YearCandidate[]>): YearResolution {
  const years = new Map<number, number>();
  const unknown: number[] = [];
  for (const [index, choices] of candidates) {
    if (choices.length === 0) unknown.push(index);
    if (choices.length === 1) years.set(index, choices[0].year);
  }
  const era = median([...runs.map((r) => r.year).filter((y): y is number => y !== null), ...years.values()]);
  const ambiguous: AmbiguousRun[] = [];
  for (const [index, choices] of candidates) {
    if (choices.length < 2) continue;
    const picked = era !== null ? pickForEra(choices, era) : null;
    if (picked) years.set(index, picked.year);
    else
      ambiguous.push({
        index,
        series: runs[index].series,
        from: runs[index].from,
        to: runs[index].to,
        choices,
      });
  }
  return { years, ambiguous, unknown };
}
