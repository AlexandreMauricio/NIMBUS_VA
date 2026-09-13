import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage } from "./coverage";
import { parseRuns } from "./runs";
import { Book, BookFormat } from "./types";

let n = 0;
function book(
  title: string,
  volume: string,
  format: BookFormat,
  runs: string,
  status: Book["status"] = "owned"
): Book {
  return {
    id: `b${++n}`,
    kind: "comic",
    title,
    volume,
    format,
    publisher: "Marvel",
    isbn: null,
    status,
    runs: parseRuns(runs).runs,
    notes: null,
    source: null,
    author: null,
    shelf: null,
    progress: null,
    coverUrl: null,
    addedAt: "2026-09-13T10:00:00Z",
    updatedAt: "2026-09-13T10:00:00Z",
  };
}

const describe = (segment: { from: number; to: number; books: Array<{ label: string }> }) =>
  `#${segment.from}-${segment.to}: ${segment.books.map((b) => b.label).join(" + ")}`;

test("THE THOR SHELF: Epic 1 and Omnibus 1 overlap, and the omnibuses close every gap", () => {
  const shelf = [
    book("Thor Epic Collection", "1", "Epic Collection", "Journey Into Mystery (1952) #83-109"),
    book(
      "The Mighty Thor Omnibus",
      "1",
      "Omnibus",
      "Journey Into Mystery (1952) #83-120; Journey Into Mystery Annual (1965) #1"
    ),
    book(
      "The Mighty Thor Omnibus",
      "2",
      "Omnibus",
      "Journey Into Mystery (1952) #121-125; Thor (1966) #126-152"
    ),
    book("The Mighty Thor Omnibus", "3", "Omnibus", "Thor (1966) #153-180"),
  ];

  const coverage = computeCoverage(shelf);
  const jim = coverage.find((c) => c.series === "Journey Into Mystery")!;
  assert.deepEqual(jim.segments.map(describe), [
    "#83-109: The Mighty Thor Omnibus 1 + Thor Epic Collection 1",
    "#110-120: The Mighty Thor Omnibus 1",
    "#121-125: The Mighty Thor Omnibus 2",
  ]);
  assert.equal(jim.duplicatedIssues, 27, "#83-109 are held twice");
  assert.deepEqual(jim.gaps, [], "Journey Into Mystery is complete from #83 to #125");

  const thor = coverage.find((c) => c.series === "Thor")!;
  assert.equal(thor.ownedIssues, 55);
  assert.deepEqual(thor.gaps, []);
  assert.equal(thor.duplicatedIssues, 0);
});

test("a gap is reported, with the wishlist books that would fill it", () => {
  const coverage = computeCoverage([
    book("Thor Epic Collection", "1", "Epic Collection", "Journey Into Mystery (1952) #83-109"),
    book(
      "Thor Epic Collection",
      "3",
      "Epic Collection",
      "Thor (1966) #131-153; Journey Into Mystery (1952) #126"
    ),
    book(
      "Thor Epic Collection",
      "2",
      "Epic Collection",
      "Journey Into Mystery (1952) #110-125; Thor (1966) #126-130",
      "wishlist"
    ),
  ]);
  const jim = coverage.find((c) => c.series === "Journey Into Mystery")!;
  assert.deepEqual(
    jim.gaps.map((g) => ({ from: g.from, to: g.to, fill: g.wishlist.map((w) => w.label) })),
    [{ from: 110, to: 125, fill: ["Thor Epic Collection 2"] }]
  );
});

test("a run with no year joins the one series of that name the shelf knows a year for", () => {
  const coverage = computeCoverage([
    book("Epic", "3", "Epic Collection", "Thor #131-153"),
    book("Epic", "2", "Epic Collection", "Thor (1966) #126-130"),
  ]);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].year, 1966);
  assert.deepEqual(coverage[0].gaps, []);
});

test("the same name with two different years is two series", () => {
  const coverage = computeCoverage([
    book("Old", "1", "Omnibus", "Thor (1966) #1-10"),
    book("New", "1", "Omnibus", "Thor (1998) #1-10"),
  ]);
  assert.equal(coverage.length, 2);
  assert.ok(coverage.every((c) => c.duplicatedIssues === 0));
});

test("'material from' is flagged, so a Masterworks' partial reprint doesn't look like the whole issue", () => {
  const [jim] = computeCoverage([
    book(
      "Marvel Masterworks: The Mighty Thor",
      "1",
      "Masterworks",
      "Reprints material from Journey Into Mystery (1952) #83-100"
    ),
  ]);
  assert.equal(jim.segments[0].partial, true);
});

test("manga: volumes owned, and the next one to buy is the first gap", () => {
  const [onePiece] = computeCoverage([
    { ...book("One Piece", "1-45", "Manga volume", "One Piece #1-45"), kind: "manga" },
    { ...book("One Piece", "47", "Manga volume", "One Piece #47"), kind: "manga" },
  ]);
  assert.deepEqual(
    onePiece.gaps.map((g) => [g.from, g.to]),
    [[46, 46]]
  );
});
