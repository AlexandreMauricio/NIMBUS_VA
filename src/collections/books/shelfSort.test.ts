import { test } from "node:test";
import assert from "node:assert/strict";
import { BookService, issueReadKey } from "./bookService";
import { canonicalNames, personKey, readingStats } from "./readings";
import { groupShelf, sortBooks } from "./shelf";

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

test("editing credits: replace one issue, add to a stretch, and GCD never overwrites an edit", () => {
  const svc = new BookService(
    undefined,
    () => new Date("2026-09-14T10:00:00"),
    () => "x"
  );
  const ac = (number: number) => ({ series: "Absolute Carnage", year: 2019, number });
  svc.setIssueCredits("Venom", 2018, 16, {
    title: null,
    characters: ["Venom", "Eddie Brock"],
    writers: ["Donny Cates"],
    artists: [],
    pageCount: null,
  });
  assert.equal(
    svc.editIssueCredits([ac(1)], { characters: ["venom", "Carnage"], writers: ["donny cates"] }, "replace"),
    1
  );
  assert.equal(
    svc.editIssueCredits([ac(1), ac(2), ac(3)], { characters: ["Spider-Man", "CARNAGE"] }, "add"),
    3
  );
  const credits = svc.readingLog().credits;
  const one = credits[issueReadKey("Absolute Carnage", 2019, 1)];
  assert.deepEqual(one.characters, ["Venom", "Carnage", "Spider-Man"]);
  assert.deepEqual(one.writers, ["Donny Cates"]);
  assert.equal(one.edited, true);
  assert.deepEqual(credits[issueReadKey("Absolute Carnage", 2019, 3)].characters, ["Spider-Man", "Carnage"]);
  // A later GCD lookup leaves your edit alone.
  svc.setIssueCredits("Absolute Carnage", 2019, 1, {
    title: null,
    characters: ["Someone"],
    writers: [],
    artists: [],
    pageCount: null,
  });
  assert.deepEqual(svc.readingLog().credits[issueReadKey("Absolute Carnage", 2019, 1)].characters, [
    "Venom",
    "Carnage",
    "Spider-Man",
  ]);
  assert.throws(() => svc.editIssueCredits([ac(1)], {}, "delete"), /Replace or add/);
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
