import { test } from "node:test";
import assert from "node:assert/strict";
import { bookIssues, bookOverlap, groupShelf, shelfName, shelfStats } from "./shelf";
import { creditNames, mapGcdIssueDetail, pickIssue } from "./gcd";
import { coverUrlForIsbn, isCoverUrl } from "./bookService";
import { parseRuns } from "./runs";
import { Book } from "./types";

let n = 0;
function book(title: string, volume: string | null, runs: string, extra: Partial<Book> = {}): Book {
  return {
    id: `b${++n}`,
    kind: "comic",
    title,
    volume,
    format: "Other",
    publisher: "Marvel",
    isbn: null,
    status: "owned",
    runs: parseRuns(runs).runs,
    notes: null,
    source: null,
    author: null,
    shelf: null,
    progress: null,
    coverUrl: null,
    addedAt: "2026-09-13T10:00:00Z",
    updatedAt: "2026-09-13T10:00:00Z",
    ...extra,
  };
}

test("shelf names drop edition words, and a book's own shelf name wins", () => {
  assert.equal(shelfName({ title: "Thor Epic Collection", shelf: null }), "Thor");
  assert.equal(shelfName({ title: "Thor by Jason Aaron Omnibus", shelf: null }), "Thor");
  assert.equal(shelfName({ title: "Mighty Marvel Masterworks: Thor", shelf: null }), "Thor");
  assert.equal(shelfName({ title: "Marvel Masterworks: The Mighty Thor", shelf: null }), "Thor");
  assert.equal(shelfName({ title: "Thor Epic Collection: Ragnarok", shelf: null }), "Thor");
  assert.equal(shelfName({ title: "One Piece", shelf: null }), "One Piece");
  assert.equal(shelfName({ title: "Mighty Marvel Masterworks: Thor", shelf: "Thor" }), "Thor");
});

test("Thor's Epic, Omnibus and a wishlisted Masterworks sit in one group", () => {
  const epic = book("Thor Epic Collection", "1 - The God of Thunder", "Journey Into Mystery (1952) #83-109", {
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780785188353-M.jpg",
    progress: 60,
  });
  const omni = book("Thor Omnibus", "1", "Journey Into Mystery (1952) #83-120");
  const wish = book("Thor Masterworks", "3", "Journey Into Mystery (1952) #121-125", { status: "wishlist" });
  const manga = book("One Piece", "1", "One Piece #1", { kind: "manga", author: "Eiichiro Oda" });
  const groups = groupShelf([wish, omni, epic, manga]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.books.length, g.owned, g.wishlist]),
    [
      ["One Piece", 1, 1, 0],
      ["Thor", 3, 2, 1],
    ]
  );
  assert.equal(groups[1].coverUrl, epic.coverUrl);
  assert.equal(groups[1].progress, 60);
  assert.equal(groups[0].kind, "manga");

  const { issues } = bookIssues(epic, [epic, omni, wish, manga]);
  assert.equal(issues.length, 27);
  assert.equal(issues[0].copies, 2, "#83 is in the Epic and the Omnibus");
  assert.deepEqual(
    issues[0].elsewhere.map((b) => b.label),
    ["Thor Omnibus 1"]
  );
  const omniIssues = bookIssues(omni, [epic, omni, wish]).issues;
  assert.equal(omniIssues.find((i) => i.number === 115)?.copies, 1, "#115 only in the Omnibus");
  assert.deepEqual(bookOverlap(wish, [epic, omni, wish]), { issues: 5, ownedElsewhere: 0 });
  assert.deepEqual(bookOverlap(omni, [epic, omni, wish]), { issues: 38, ownedElsewhere: 27 });

  const stats = shelfStats([epic, omni, wish, manga]);
  assert.deepEqual(stats, {
    owned: 3,
    reading: 1,
    finished: 0,
    wishlist: 1,
    byKind: { comic: 2, manga: 1, novel: 0 },
  });
});

test("covers are only kept from Open Library, by ISBN", () => {
  assert.equal(
    coverUrlForIsbn("978-0-7851-8835-3"),
    "https://covers.openlibrary.org/b/isbn/9780785188353-M.jpg"
  );
  assert.equal(coverUrlForIsbn("078518835x"), "https://covers.openlibrary.org/b/isbn/078518835X-M.jpg");
  assert.equal(coverUrlForIsbn("12345"), null);
  assert.equal(coverUrlForIsbn(null), null);
  assert.ok(isCoverUrl("https://covers.openlibrary.org/b/isbn/9780785188353-M.jpg"));
  assert.ok(!isCoverUrl("https://files1.comics.org//img/gcd/covers_by_id/29/w400/29881.jpg"));
  assert.ok(!isCoverUrl("https://covers.openlibrary.org.evil.example/b/isbn/9780785188353-M.jpg"));
  assert.ok(!isCoverUrl("https://covers.openlibrary.org/b/isbn/9780785188353-M.jpg?x=https://evil"));
});

test("GCD issue: credits merged per person, ads left out, the plain printing picked", () => {
  assert.deepEqual(creditNames("Walter Simonson (signed as Simonson (brontosaurus))"), ["Walter Simonson"]);
  assert.deepEqual(creditNames("Jim Shooter (signed as Shooter); ?"), ["Jim Shooter"]);
  assert.deepEqual(creditNames("None"), []);

  const detail = mapGcdIssueDetail(
    {
      series_name: "Thor (1966 series)",
      number: "337",
      title: "",
      publication_date: "November 1983",
      page_count: "36.000",
      indicia_publisher: "Marvel Comics Group",
      editing: "Mark Gruenwald (editor)",
      cover: "https://files1.comics.org//img/gcd/covers_by_id/29/w400/29881.jpg",
      story_set: [
        {
          type: "cover",
          pencils: "Walter Simonson (signed as Simonson (brontosaurus))",
          inks: "Walter Simonson",
          colors: "Paul Becton",
          script: "None",
          letters: "None",
        },
        {
          type: "comic story",
          title: "Doom!",
          script: "Walter Simonson",
          pencils: "Walter Simonson",
          inks: "Walter Simonson",
          colors: "George Roussos",
          letters: "John Workman",
          characters: "Beta Ray Bill (antagonist)",
          synopsis: "Bill bests Thor.",
        },
        { type: "comics-form advertising", title: "Star Frontiers", pencils: "Larry Elmore (signed)" },
      ],
    },
    37974
  );
  assert.equal(detail.seriesName, "Thor (1966)");
  assert.equal(detail.pageCount, 36);
  assert.deepEqual(
    detail.stories.map((s) => s.title),
    ["Doom!"]
  );
  const simonson = detail.credits.find((c) => c.name === "Walter Simonson")!;
  assert.deepEqual(simonson.roles, ["Cover penciler", "Cover inker", "Writer", "Penciler", "Inker"]);
  assert.ok(!detail.credits.some((c) => c.name === "Larry Elmore"), "the ad's artist isn't credited");
  assert.ok(detail.credits.some((c) => c.name === "Mark Gruenwald" && c.roles.includes("Editor")));

  const series = [
    {
      id: 1,
      name: "Thor Annual",
      yearBegan: 1966,
      publisher: "Marvel",
      volumes: [{ issueId: 9, descriptor: "337" }],
    },
    {
      id: 2,
      name: "Thor",
      yearBegan: 1966,
      publisher: "Marvel",
      volumes: [
        { issueId: 10, descriptor: "337 [British]" },
        { issueId: 11, descriptor: "337 [Direct]" },
        { issueId: 12, descriptor: "338" },
      ],
    },
  ];
  assert.deepEqual(pickIssue(series, "Thor", 1966, 337), { seriesId: 2, issueId: 11 });
  assert.equal(pickIssue(series, "Thor", 1998, 337), null);
  assert.equal(pickIssue(series, "Thor", 1966, 999), null);
});
