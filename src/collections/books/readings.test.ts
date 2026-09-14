import { test } from "node:test";
import assert from "node:assert/strict";
import { BookService, issueReadKey } from "./bookService";
import { BookState } from "./types";
import { characterNames, cleanPersonName, creditsFromGcd, formatReadingTime, readingStats } from "./readings";

function service(saved?: unknown) {
  const saves: BookState[] = [];
  let n = 0;
  const svc = new BookService(
    { load: () => saved ?? null, save: (s) => saves.push(JSON.parse(JSON.stringify(s))) },
    () => new Date("2026-09-13T20:00:00"),
    () => `id${++n}`
  );
  return { svc, saves };
}

const thor = (number: number) => ({ series: "Thor", year: 1966, number });

test("GCD characters lose aliases, notes and group labels", () => {
  assert.deepEqual(
    characterNames(
      "Thor [Donald Blake]; Loki; Villains: Surtur (first appearance); Balder [Balder the Brave]"
    ),
    ["Thor", "Loki", "Surtur", "Balder"]
  );
  assert.deepEqual(characterNames("None"), []);
});

test("credits keep writers and artists apart, skipping the cover story", () => {
  const credits = creditsFromGcd({
    issueId: 1,
    seriesName: "Thor (1966)",
    number: "337",
    title: null,
    publicationDate: null,
    onSaleDate: null,
    price: null,
    pageCount: 36,
    publisher: null,
    coverUrl: null,
    stories: [
      { type: "cover", title: null, feature: null, synopsis: null, characters: "Beta Ray Bill" },
      {
        type: "comic story",
        title: "The Last Viking",
        feature: "Thor",
        synopsis: null,
        characters: "Thor; Beta Ray Bill",
      },
    ],
    credits: [
      { name: "Walter Simonson", roles: ["Writer", "Penciler", "Cover penciler"] },
      { name: "John Workman", roles: ["Letterer"] },
    ],
  });
  assert.deepEqual(credits, {
    title: "The Last Viking",
    characters: ["Thor", "Beta Ray Bill"],
    writers: ["Walter Simonson"],
    artists: ["Walter Simonson"],
    pageCount: 36,
  });
});

test("logging readings marks issues read, keeps each reading, and survives a restart", () => {
  const { svc, saves } = service();
  assert.equal(svc.logReadings([thor(337), thor(338)], "2026-09-01", null, null), 2);
  // The same issue again, another day: a re-read, not a replacement.
  assert.equal(svc.logReadings([thor(337)], "2026-09-12", 20, null), 1);
  assert.ok(svc.readIssueKeys().includes(issueReadKey("Thor", 1966, 337)));
  const log = svc.readingLog();
  assert.deepEqual(
    log.readings.map((r) => [r.number, r.readOn, r.minutes]),
    [
      [337, "2026-09-12", 20],
      [337, "2026-09-01", 12],
      [338, "2026-09-01", 12],
    ]
  );
  const reloaded = service(saves[saves.length - 1]).svc.readingLog();
  assert.equal(reloaded.readings.length, 3);
});

test("a reading needs a real day that isn't in the future, and sane minutes", () => {
  const { svc } = service();
  assert.throws(() => svc.logReadings([thor(1)], "yesterday"), /day you read/);
  assert.throws(() => svc.logReadings([thor(1)], "2026-09-14"), /hasn't happened/);
  assert.equal(svc.logReadings([thor(1)], "2026-09-13"), 1, "today, in local time");
  assert.throws(() => svc.logReadings([thor(1)], "2026-09-13", 0), /1 to 600/);
});

test("removing a reading and changing the estimate", () => {
  const { svc } = service();
  svc.setMinutesPerIssue(15);
  svc.logReadings([thor(1)], "2026-09-10");
  const [reading] = svc.readingLog().readings;
  assert.equal(reading.minutes, 15);
  assert.equal(svc.removeReading(reading.id), true);
  assert.equal(svc.readingLog().readings.length, 0);
  assert.throws(() => svc.setMinutesPerIssue(0), /1 to 240/);
});

test("credits are kept per issue and looked-up issues aren't asked for again", () => {
  const { svc } = service();
  svc.logReadings([thor(1), thor(2)], "2026-09-10");
  assert.equal(svc.issuesWithoutCredits().length, 2);
  svc.setIssueCredits("Thor", 1966, 1, {
    title: null,
    characters: ["Thor"],
    writers: [],
    artists: [],
    pageCount: null,
  });
  assert.deepEqual(svc.issuesWithoutCredits(), [thor(2)]);
});

test("stats add up time per series, character, writer and artist, with re-reads and this month", () => {
  const key = issueReadKey("Thor", 1966, 337);
  const other = issueReadKey("Thor", 1966, 338);
  const reading = (k: string, number: number, readOn: string, minutes: number) => ({
    id: `${k}${readOn}`,
    key: k,
    series: "Thor",
    year: 1966,
    number,
    readOn,
    minutes,
    bookId: null,
    loggedAt: readOn,
  });
  const stats = readingStats(
    [
      reading(key, 337, "2025-01-05", 12),
      reading(key, 337, "2026-09-12", 15),
      reading(other, 338, "2026-08-30", 12),
    ],
    {
      [key]: {
        title: null,
        characters: ["Thor", "Beta Ray Bill"],
        writers: ["Walter Simonson"],
        artists: ["Walter Simonson", "Walter Simonson"],
        pageCount: 36,
      },
    },
    "2026-09-13"
  );
  assert.equal(stats.totalMinutes, 39);
  assert.equal(stats.thisMonthMinutes, 15);
  assert.equal(stats.thisYearMinutes, 27);
  assert.equal(stats.issues, 2);
  assert.equal(stats.reread, 1);
  assert.deepEqual(stats.bySeries, [{ name: "Thor (1966)", minutes: 39, readings: 3 }]);
  assert.deepEqual(stats.byCharacter[0], { name: "Beta Ray Bill", minutes: 27, readings: 2 });
  assert.deepEqual(stats.byArtist, [{ name: "Walter Simonson", minutes: 27, readings: 2 }]);
  assert.equal(stats.withoutCredits, 1);
  assert.equal(stats.recent[0].readOn, "2026-09-12");
});

test("reading time reads as hours and minutes", () => {
  assert.equal(formatReadingTime(45), "45 min");
  assert.equal(formatReadingTime(120), "2 h");
  assert.equal(formatReadingTime(200), "3 h 20 min");
});

test("GCD names lose nested aliases, split notes and the uncertain-credit question mark", () => {
  assert.deepEqual(
    characterNames("Avengers: Thor; Wasp [Janet van Dyne; Pym]; Giant-Man (Hank Pym; scientist); Loki ?"),
    ["Thor", "Wasp", "Giant-Man", "Loki"]
  );
  assert.equal(cleanPersonName("Larry Lieber ?"), "Larry Lieber");
  assert.equal(cleanPersonName("Wasp ]"), "Wasp");
  assert.equal(cleanPersonName("J. P. Mayer"), "J. P. Mayer");
});
