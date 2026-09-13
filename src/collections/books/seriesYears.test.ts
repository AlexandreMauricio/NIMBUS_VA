import { test } from "node:test";
import assert from "node:assert/strict";
import { GcdSeries, descriptorNumber, pickIssue } from "./gcd";
import { SeriesSource, workOutRunYears, yearCandidates } from "./seriesYears";
import { parseRuns } from "./runs";
import { BookService, issueReadKey } from "./bookService";
import { readingStats } from "./readings";

const series = (
  name: string,
  yearBegan: number,
  yearEnded: number | null,
  issues: string[],
  extra: Partial<GcdSeries> = {}
): GcdSeries => ({
  id: yearBegan,
  name,
  yearBegan,
  yearEnded,
  publisher: "Marvel",
  binding: null,
  publishingFormat: "was ongoing series",
  language: "en",
  dimensions: null,
  volumes: issues.map((descriptor, i) => ({ issueId: yearBegan * 1000 + i, descriptor })),
  ...extra,
});

const range = (from: number, to: number, suffix = "") =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}${suffix}`);

const ASM_1963 = series("The Amazing Spider-Man", 1963, 1998, range(1, 441));
const ASM_2018 = series("Amazing Spider-Man", 2018, 2022, [
  ...range(1, 93).map((n) => `${n} (${801 + Number(n)})`),
  "29 (830) [Variant Edition - Mark Bagley Cover]",
]);
const ASM_2022 = series(
  "The Amazing Spider-Man",
  2022,
  2025,
  range(1, 70).map((n) => `${n} (${894 + Number(n)})`)
);

test("GCD descriptors: plain, variant and modern legacy-numbered issues are all found", () => {
  assert.equal(descriptorNumber("29"), 29);
  assert.equal(descriptorNumber("29 [Direct]"), 29);
  assert.equal(descriptorNumber("29 (830)"), 29);
  assert.equal(descriptorNumber("1.1 - Learning to Crawl"), null);
  assert.equal(descriptorNumber("[1] - The Parker Luck"), null);
  // An issue page for a 2019 issue: the plain printing, not a variant.
  assert.equal(pickIssue([ASM_2018], "Amazing Spider-Man", 2018, 29)?.issueId, 2018 * 1000 + 28);
});

test("candidates: same name, English, not a collection, with the issues, from the book's publisher", () => {
  const all = [
    ASM_1963,
    ASM_2018,
    ASM_2022,
    series("The Amazing Spider-Man", 1990, 1998, range(1, 102), { language: "pl" }),
    series("Amazing Spider-Man", 2014, 2015, range(1, 6), { publishingFormat: "collected edition" }),
    series("Amazing Spider-Man", 2021, null, range(1, 72), { publisher: "Panini" }),
    series("Amazing Spider-Man: Renew Your Vows", 2015, 2015, range(1, 40)),
  ];
  const years = yearCandidates(all, { series: "Amazing Spider-Man", from: 29, to: 31 }, "Marvel Comics").map(
    (c) => c.year
  );
  assert.deepEqual(years, [1963, 2018, 2022]);
});

function fakeGcd(
  pages: Record<string, GcdSeries[]>,
  byYear: Record<string, GcdSeries[]>,
  crowded: string[] = []
) {
  const calls: string[] = [];
  const source: SeriesSource = {
    seriesFirstPage: async (name) => {
      calls.push(`page:${name}`);
      return { series: pages[name] ?? [], complete: !crowded.includes(name) };
    },
    seriesByYear: async (name, year) => {
      calls.push(`year:${name}:${year}`);
      return byYear[`${name}:${year}`] ?? [];
    },
  };
  return { source, calls };
}

test("Absolute Carnage: the event settles on 2019 alone, which places Spider-Man #29-31 in the 2018 volume", async () => {
  const { runs } = parseRuns("Absolute Carnage #1-5; Amazing Spider-Man #29-31");
  const { source, calls } = fakeGcd(
    {
      "Absolute Carnage": [series("Absolute Carnage", 2019, 2020, range(1, 5))],
      // Page one of a crowded name only reaches the 1960s.
      "Amazing Spider-Man": [ASM_1963],
    },
    { "Amazing Spider-Man:2018": [ASM_2018] },
    ["Amazing Spider-Man"]
  );
  const result = await workOutRunYears(runs, "Marvel", source);
  assert.deepEqual(
    [...result.years],
    [
      [0, 2019],
      [1, 2018],
    ]
  );
  assert.deepEqual(result.ambiguous, []);
  // 2019 first, then 2018 — where it stops.
  assert.deepEqual(calls, [
    "page:Absolute Carnage",
    "page:Amazing Spider-Man",
    "year:Amazing Spider-Man:2019",
    "year:Amazing Spider-Man:2018",
  ]);
});

test("a crowded name with nothing to date it by is asked about, not guessed", async () => {
  const { runs } = parseRuns("Amazing Spider-Man #29-31");
  const { source } = fakeGcd({ "Amazing Spider-Man": [ASM_1963] }, {}, ["Amazing Spider-Man"]);
  const result = await workOutRunYears(runs, "Marvel", source);
  assert.equal(result.years.size, 0);
  assert.deepEqual(
    result.ambiguous.map((a) => [a.series, a.choices.map((c) => c.year)]),
    [["Amazing Spider-Man", [1963]]]
  );
});

test("dated runs in the book set the era; a pause from GCD keeps what was worked out", async () => {
  const { runs } = parseRuns("Venom (2018) #16-20; Amazing Spider-Man #29-31; Web of Venom #1");
  const { source } = fakeGcd({ "Amazing Spider-Man": [ASM_1963, ASM_2018, ASM_2022] }, {});
  const failing: SeriesSource = {
    ...source,
    seriesFirstPage: async (name) => {
      if (name === "Web of Venom") throw new Error("Error: The Grand Comics Database is asking for a pause.");
      return source.seriesFirstPage(name);
    },
  };
  const result = await workOutRunYears(runs, "Marvel", failing);
  assert.deepEqual([...result.years], [[1, 2018]]);
  assert.match(result.paused ?? "", /asking for a pause/);
});

test("setting run years only touches the runs asked for, and moves the issues to their own series", () => {
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => "b1"
  );
  const { book } = svc.add({
    kind: "comic",
    title: "Absolute Carnage Omnibus",
    runs: "Amazing Spider-Man #29-31",
  });
  svc.add({
    kind: "comic",
    title: "Amazing Spider-Man Epic Collection",
    runs: "Amazing Spider-Man (1963) #29-31",
  });
  assert.equal(svc.setRunYears(book.id, [{ index: 0, series: "Wrong name", year: 2018 }]), 0);
  assert.equal(svc.setRunYears(book.id, [{ index: 0, series: "Amazing Spider-Man", year: 2018 }]), 1);
  assert.equal(svc.get(book.id).runs[0].year, 2018);
  const coverage = svc.coverage();
  assert.deepEqual(
    coverage.map((c) => [c.series, c.year, c.ownedIssues]).sort(),
    [
      ["Amazing Spider-Man", 1963, 3],
      ["Amazing Spider-Man", 2018, 3],
    ].sort()
  );
});

test("issues ticked read with no reading count once at the estimate, not this month", () => {
  let n = 0;
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => `id${++n}`
  );
  svc.add({ kind: "comic", title: "Iron Man Epic Collection", runs: "Iron Man (1968) #1-10" });
  svc.setIssuesRead(
    Array.from({ length: 10 }, (_, i) => ({ series: "Iron Man", year: 1968, number: i + 1 })),
    true
  );
  svc.logReadings([{ series: "Iron Man", year: 1968, number: 1 }], "2026-09-10");
  const log = svc.readingLog();
  assert.equal(log.undated.length, 9, "issue #1 has a dated reading");
  assert.equal(svc.issuesWithoutCredits(100).length, 10);
  const key = issueReadKey("Iron Man", 1968, 2);
  const stats = readingStats(
    log.readings,
    { [key]: { title: null, characters: ["Iron Man"], writers: [], artists: [], pageCount: null } },
    "2026-09-14",
    10,
    log.undated,
    12
  );
  assert.equal(stats.totalMinutes, 120);
  assert.equal(stats.thisMonthMinutes, 12);
  assert.equal(stats.undated, 9);
  assert.equal(stats.issues, 10);
  assert.deepEqual(stats.byCharacter[0], { name: "Iron Man", minutes: 12, readings: 1 });
});

test("when a run gets its year, its read marks, readings and names move to the dated issues", () => {
  let n = 0;
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => `id${++n}`
  );
  const { book } = svc.add({
    kind: "comic",
    title: "Absolute Carnage Omnibus",
    runs: "Absolute Carnage #1-2",
  });
  svc.setIssuesRead([{ series: "Absolute Carnage", year: null, number: 1 }], true);
  svc.logReadings([{ series: "Absolute Carnage", year: null, number: 2 }], "2026-09-10");
  svc.editIssueCredits(
    [{ series: "Absolute Carnage", year: null, number: 1 }],
    { characters: ["Venom"] },
    "add"
  );
  svc.setRunYears(book.id, [{ index: 0, series: "Absolute Carnage", year: 2019 }]);
  const dated = (number: number) => issueReadKey("Absolute Carnage", 2019, number);
  assert.deepEqual(svc.readIssueKeys().sort(), [dated(1), dated(2)].sort());
  const log = svc.readingLog();
  assert.deepEqual(
    log.readings.map((r) => [r.key, r.year]),
    [[dated(2), 2019]]
  );
  assert.deepEqual(log.credits[dated(1)].characters, ["Venom"]);
  assert.equal(log.credits[issueReadKey("Absolute Carnage", null, 1)], undefined);
});
