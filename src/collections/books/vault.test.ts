import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookFromVault,
  cartsByMonth,
  matchVault,
  parseFrontmatter,
  parsePlannerTables,
  unlink,
  vaultBook,
} from "./vault";

// Shaped like the vault's own notes (Books/Iron Man/IM Epic 01 - The Golden Avenger.md).
const EPIC = `---
line: "Iron Man"
type: "Epic Collection"
number: 1
title: "The Golden Avenger"
status: "owned"
read: true
issues: "Tales of Suspense #39–72"
isbn: ["978-0785188636", "978-1302924287"]
tier: "S+"
covered_by: ["[[The Invincible Iron Man Omnibus Vol 1]]"]
goodreads_rating: 3.61
goodreads_votes: 177
seq: 1
verified: true
tags: ["comics", "line/iron-man"]
---

# IM Epic 01 - The Golden Avenger
`;

const OMNI = `---
line: Thor
type: Omnibus
status: planned
price_seen: 85
store: "Walt's"
cart: "2026-10"
budget: monthly
urgency: high
urgency_reason: "Only 1 copy in stock at Walt's"
covers:
  - "[[Thor Epic 06 - Into the Dark Nebula]]"
  - "[[Thor Epic 07 - Ulik Unchained|Epic 7]]"
---
Notes.
`;

test("vault: a note's properties — quoted, bare, numbers, flags, flow and block lists, links unwrapped", () => {
  const epic = vaultBook("Books/Iron Man/IM Epic 01 - The Golden Avenger.md", parseFrontmatter(EPIC));
  assert.equal(epic.name, "IM Epic 01 - The Golden Avenger");
  assert.equal(epic.line, "Iron Man");
  assert.equal(epic.number, 1);
  assert.equal(epic.status, "owned");
  assert.equal(epic.read, true);
  assert.deepEqual(epic.isbns, ["978-0785188636", "978-1302924287"]);
  assert.deepEqual(epic.coveredBy, ["The Invincible Iron Man Omnibus Vol 1"]);
  assert.deepEqual(epic.goodreads, { rating: 3.61, votes: 177 });
  assert.equal(epic.issues, "Tales of Suspense #39–72");

  const omni = vaultBook(
    "Books/Thor/The Mighty Thor Omnibus Vol 4.md",
    parseFrontmatter(OMNI.replace(/\n/g, "\r\n"))
  );
  assert.equal(omni.line, "Thor");
  assert.equal(omni.status, "planned");
  assert.equal(omni.priceSeen, 85);
  assert.equal(omni.cart, "2026-10");
  assert.deepEqual(omni.covers, ["Thor Epic 06 - Into the Dark Nebula", "Thor Epic 07 - Ulik Unchained"]);
  assert.deepEqual(parseFrontmatter("# no properties"), {});
  assert.equal(unlink("see [[A|alias]] and [[B#part]]"), "see A and B");
});

test("vault: matched to NIMBUS books by ISBN, then Epic number, then name — each book once", () => {
  const notes = [
    vaultBook("Books/Iron Man/IM Epic 01 - The Golden Avenger.md", parseFrontmatter(EPIC)),
    vaultBook("Books/Thor/The Mighty Thor Omnibus Vol 4.md", parseFrontmatter(OMNI)),
    vaultBook(
      "Books/Iron Man/IM Epic 02 - By Force of Arms.md",
      parseFrontmatter('---\nline: "Iron Man"\ntype: "Epic Collection"\nnumber: 2\n---\n')
    ),
    vaultBook("Books/Other/Nothing Like It.md", parseFrontmatter('---\ntype: "TPB"\n---\n')),
  ];
  const books = [
    {
      id: "a",
      title: "Iron Man Epic Collection",
      volume: "1 - The Golden Avenger",
      format: "Epic Collection" as const,
      isbn: "9781302924287",
    },
    {
      id: "b",
      title: "Iron Man Epic Collection",
      volume: "2 - By Force of Arms",
      format: "Epic Collection" as const,
      isbn: null,
    },
    { id: "c", title: "The Mighty Thor Omnibus", volume: "Vol. 4", format: "Omnibus" as const, isbn: null },
  ];
  const matched = matchVault(notes, books);
  assert.equal(matched.get(notes[0].path), "a", "by ISBN, any printing");
  assert.equal(matched.get(notes[2].path), "b", "by Epic number");
  assert.equal(matched.get(notes[1].path), "c", "by name");
  assert.equal(matched.has(notes[3].path), false);
});

test("vault: what adding a note to NIMBUS fills in, and the carts by month", () => {
  const epic = vaultBook("Books/Iron Man/IM Epic 01 - The Golden Avenger.md", parseFrontmatter(EPIC));
  assert.deepEqual(bookFromVault(epic), {
    title: "Iron Man Epic Collection",
    volume: "1 - The Golden Avenger",
    format: "Epic Collection",
    isbn: "9781302924287",
    status: "owned",
  });
  const omni = vaultBook("Books/Thor/The Mighty Thor Omnibus Vol 4.md", parseFrontmatter(OMNI));
  assert.equal(bookFromVault(omni).title, "The Mighty Thor Omnibus Vol 4");
  assert.equal(bookFromVault(omni).status, "wishlist");
  const carts = cartsByMonth([epic, omni]);
  assert.deepEqual(
    carts.map((c) => [c.month, c.total, c.unpriced]),
    [["2026-10", 85, 0]]
  );
});

test("vault: the Cart Planner's tables, as refresh.py writes them", () => {
  const tables = parsePlannerTables(`# Cart Planner

## 1. Reading runway (the one-or-two-Epics-a-month rule)

| Line | Reading position | Epics ready to read (contiguous) | First gap | Ways to fill the gap |
|---|---|---|---|---|
| Thor | Epic 5 | 1 | Epic 6 | [[The Mighty Thor Omnibus Vol 4]] (85 Walt's) - planned |

A line whose runway is under 2 needs its next contiguous book in the cart.
`);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].heading, "1. Reading runway (the one-or-two-Epics-a-month rule)");
  assert.deepEqual(tables[0].columns.slice(0, 2), ["Line", "Reading position"]);
  assert.deepEqual(tables[0].rows[0], [
    "Thor",
    "Epic 5",
    "1",
    "Epic 6",
    "The Mighty Thor Omnibus Vol 4 (85 Walt's) - planned",
  ]);
});
