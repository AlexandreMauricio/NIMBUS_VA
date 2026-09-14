import { test } from "node:test";
import assert from "node:assert/strict";
import { BookService, issueReadKey } from "./bookService";
import { canonicalNames, personKey, readingStats } from "./readings";
import { groupShelf, readingStatus, shelfStats, sortBooks } from "./shelf";

function shelf() {
  let n = 0;
  let clock = Date.parse("2026-09-01T10:00:00Z");
  const svc = new BookService(
    undefined,
    () => new Date((clock += 60_000)),
    () => `b${++n}`
  );
  const add = (title: string, volume: string | null, runs: string) =>
    svc.add({ kind: "comic", title, volume, runs, shelf: "Spider-Man" }).book;
  // Added out of order, and the omnibus sorts first by title.
  const omni = add(
    "Absolute Carnage Omnibus",
    null,
    "Absolute Carnage (2019) #1-5; Amazing Spider-Man (2018) #29-31"
  );
  const epic2 = add("Amazing Spider-Man Epic Collection", "2", "Amazing Spider-Man (1963) #18-38");
  const epic1 = add(
    "Amazing Spider-Man Epic Collection",
    "1",
    "Amazing Fantasy (1962) #15; Amazing Spider-Man (1963) #1-17"
  );
  return { svc, omni, epic1, epic2 };
}

test("books sort by the comics they collect: earliest series year, then issue", () => {
  const { svc, omni, epic1, epic2 } = shelf();
  const books = svc.list();
  const titles = (order: Parameters<typeof sortBooks>[1]) =>
    sortBooks(books, order).map((b) =>
      b.id === omni.id ? "omni" : b.id === epic1.id ? "epic1" : b.id === epic2.id ? "epic2" : "?"
    );
  assert.deepEqual(titles("volume"), ["omni", "epic1", "epic2"]);
  assert.deepEqual(titles("collected"), ["epic1", "epic2", "omni"]);
  assert.deepEqual(titles("added"), ["epic1", "epic2", "omni"]);
});

test("the shelf's groups and a group's books take their orders", () => {
  const { svc } = shelf();
  svc.add({ kind: "comic", title: "Avengers Epic Collection", volume: "1", runs: "Avengers (1963) #1-20" });
  const books = svc.list();
  const byName = groupShelf(books, books, new Set(), "collected", "name");
  assert.deepEqual(
    byName.map((g) => g.name),
    ["Avengers", "Spider-Man"]
  );
  assert.equal(byName[1].books[2].title, "Absolute Carnage Omnibus");
  const byStart = groupShelf(books, books, new Set(), "volume", "collected");
  assert.deepEqual(
    byStart.map((g) => g.name),
    ["Spider-Man", "Avengers"],
    "Amazing Fantasy (1962) is before Avengers (1963)"
  );
});

test("names match regardless of capitals, accents and punctuation, and take the known spelling", () => {
  assert.equal(personKey("Spider-Man"), personKey("spider man"));
  assert.equal(personKey("Namor"), personKey("NAMOR"));
  const known = new Map([[personKey("Venom"), "Venom"]]);
  assert.deepEqual(canonicalNames(["venom", " Carnage ", "VENOM", "", 3], known), ["Venom", "Carnage"]);
});

test("your own names: off by default, a checkbox switches stats between GCD's and yours", () => {
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => "x"
  );
  const ac1 = { series: "Absolute Carnage", year: 2019, number: 1 };
  const key = issueReadKey("Absolute Carnage", 2019, 1);
  svc.setIssueCredits("Venom", 2018, 16, {
    title: null,
    characters: ["Venom", "Eddie Brock"],
    writers: ["Donny Cates"],
    artists: [],
    pageCount: null,
  });
  svc.setIssueCredits("Absolute Carnage", 2019, 1, {
    title: "Part 1",
    characters: ["Carnage"],
    writers: [],
    artists: [],
    pageCount: 40,
  });
  // Off by default: GCD's.
  assert.deepEqual(svc.readingLog().credits[key].characters, ["Carnage"]);
  // Turning it on starts from GCD's names.
  svc.setUseCustomCredits(ac1, true);
  assert.deepEqual(svc.readingLog().customCredits[key].characters, ["Carnage"]);
  // Saving yours: names take the known spelling.
  svc.setCustomCredits(ac1, { characters: ["venom", "Carnage", "VENOM"], writers: ["donny cates"] });
  let log = svc.readingLog();
  assert.deepEqual(log.credits[key].characters, ["Venom", "Carnage"]);
  assert.deepEqual(log.credits[key].writers, ["Donny Cates"]);
  assert.equal(log.credits[key].title, "Part 1");
  // A GCD lookup changes GCD's, not yours.
  svc.setIssueCredits("Absolute Carnage", 2019, 1, {
    title: null,
    characters: ["Someone"],
    writers: [],
    artists: [],
    pageCount: null,
  });
  assert.deepEqual(svc.readingLog().credits[key].characters, ["Venom", "Carnage"]);
  // Off again: GCD's, and yours are kept for next time.
  svc.setUseCustomCredits(ac1, false);
  log = svc.readingLog();
  assert.deepEqual(log.credits[key].characters, ["Someone"]);
  assert.deepEqual(log.customCredits[key].characters, ["Venom", "Carnage"]);
});

test("names edited in 0.6.0 become your own, in use", () => {
  const key = issueReadKey("Absolute Carnage", 2019, 1);
  const svc = new BookService({
    load: () => ({
      books: [],
      issueCredits: {
        [key]: {
          title: null,
          characters: ["Venom"],
          writers: [],
          artists: [],
          pageCount: null,
          edited: true,
        },
      },
    }),
    save: () => undefined,
  });
  const log = svc.readingLog();
  assert.deepEqual(log.useCustom, [key]);
  assert.deepEqual(log.credits[key].characters, ["Venom"]);
  assert.equal(log.gcdCredits[key], undefined);
});

test("reading stats count a name typed differently as the same person", () => {
  const reading = (key: string, number: number) => ({
    id: key,
    key,
    series: "X",
    year: 2019,
    number,
    readOn: "2026-09-01",
    minutes: 12,
    bookId: null,
    loggedAt: "",
  });
  const k1 = "x (2019)#1";
  const k2 = "x (2019)#2";
  const stats = readingStats(
    [reading(k1, 1), reading(k2, 2)],
    {
      [k1]: { title: null, characters: ["Venom"], writers: [], artists: [], pageCount: null },
      [k2]: { title: null, characters: ["venom", "VENOM"], writers: [], artists: [], pageCount: null },
    },
    "2026-09-14"
  );
  assert.deepEqual(stats.byCharacter, [{ name: "Venom", minutes: 24, readings: 2 }]);
});

test("a retired book is off Reading, keeps its progress, and un-retires; a finished one stays Read", () => {
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => "ant"
  );
  const { book } = svc.add({ kind: "novel", title: "Ant-Man", progress: 40 });
  assert.equal(readingStatus(40, book.retired), "Reading");
  const retired = svc.update(book.id, { retired: true }).book;
  assert.equal(readingStatus(40, retired.retired), "Retired");
  assert.equal(retired.progress, 40);
  assert.deepEqual([shelfStats(svc.list()).reading, shelfStats(svc.list()).retired], [0, 1]);
  assert.equal(
    svc.update(book.id, { title: "Ant-Man Epic" }).book.retired,
    true,
    "other edits keep it retired"
  );
  assert.equal(svc.update(book.id, { retired: false }).book.retired, false);
  assert.equal(readingStatus(100, true), "Read");
});
