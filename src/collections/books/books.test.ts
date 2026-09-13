import { test } from "node:test";
import assert from "node:assert/strict";
import { BookService } from "./bookService";
import { bookProgress } from "./shelf";
import { GcdCatalog, guessFormat, mapGcdIssue, mapGcdSeriesSearch } from "./gcd";
import { BookState, BookStore } from "./types";

// GCD shapes trimmed from real responses fetched while this was built.

test("GCD series search: volumes pair each descriptor with its issue id", () => {
  const [series] = mapGcdSeriesSearch({
    count: 1,
    results: [
      {
        api_url: "https://www.comics.org/api/series/74601/?format=json",
        name: "Thor Epic Collection",
        year_began: 2013,
        publisher: "https://www.comics.org/api/publisher/78/?format=json",
        active_issues: [
          "https://www.comics.org/api/issue/1205407/?format=json",
          "https://www.comics.org/api/issue/1643051/?format=json",
        ],
        issue_descriptors: ["1 - The God of Thunder", "2 - When Titans Clash"],
      },
    ],
  });
  assert.deepEqual(series, {
    id: 74601,
    name: "Thor Epic Collection",
    yearBegan: 2013,
    yearEnded: null,
    publisher: "Marvel",
    binding: null,
    publishingFormat: null,
    language: null,
    dimensions: null,
    volumes: [
      { issueId: 1205407, descriptor: "1 - The God of Thunder" },
      { issueId: 1643051, descriptor: "2 - When Titans Clash" },
    ],
  });
});

test("a GCD volume with a 'Collects' note arrives with its runs; one without arrives empty", () => {
  const withContents = mapGcdIssue(
    {
      series_name: "Thor Epic Collection (2013 series)",
      descriptor: "2 - When Titans Clash",
      title: "When Titans Clash",
      isbn: "978-0-7851-9283-1",
      publication_date: "2015",
      notes:
        "Collects Journey Into Mystery (1952) #110-125, Annual #1, Thor (1966) #126-130, and material from Not Brand Echh #3",
    },
    1643051
  );
  assert.equal(
    withContents.seriesName,
    "Thor Epic Collection",
    "GCD's '(2013 series)' isn't part of the title"
  );
  assert.equal(withContents.format, "Epic Collection");
  assert.equal(withContents.isbn, "9780785192831");
  assert.equal(withContents.runs.length, 4);

  const omnibus = mapGcdIssue(
    {
      series_name: "The Mighty Thor Omnibus",
      descriptor: "1 [Direct Market Variant]",
      notes: "Art reconstruction by Michael Kelleher and Pacific Rim Graphics.",
    },
    42
  );
  assert.equal(omnibus.format, "Omnibus");
  assert.deepEqual(omnibus.runs, [], "no contents listed, so none are invented");
});

test("formats are guessed from the series name, and anything else is Other", () => {
  assert.equal(guessFormat("Amazing Spider-Man Epic Collection"), "Epic Collection");
  assert.equal(guessFormat("Marvel Masterworks: The Mighty Thor"), "Masterworks");
  assert.equal(guessFormat("Savage Sword of Conan"), "Other");
});

test("GCD requests are checked, spaced a second apart, cached, and fail plainly", async () => {
  const urls: string[] = [];
  const slept: number[] = [];
  let clock = 10_000;
  const catalog = new GcdCatalog(
    async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ results: [] }) } as Response;
    },
    () => clock,
    async (ms) => {
      slept.push(ms);
      clock += ms;
    }
  );

  await assert.rejects(() => catalog.searchSeries("x"), /at least 2/);
  await assert.rejects(() => catalog.getVolume("../../admin"), /isn't a GCD volume/);

  await catalog.searchSeries("Thor Epic Collection");
  await catalog.searchSeries("Thor Epic Collection");
  assert.equal(urls.length, 1, "the second search came from the cache");
  assert.match(urls[0], /^https:\/\/www\.comics\.org\/api\/series\/name\/Thor%20Epic%20Collection\//);

  await catalog.searchSeries("Mighty Thor Omnibus");
  assert.deepEqual(slept, [1000], "the next request waited its turn");

  const down = new GcdCatalog(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
  await assert.rejects(() => down.searchSeries("Thor"), /couldn't be reached/);
});

function shelf(saved?: unknown) {
  const saves: BookState[] = [];
  const store: BookStore = {
    load: () => saved ?? null,
    save: (state) => saves.push(JSON.parse(JSON.stringify(state))),
  };
  let id = 0;
  return {
    service: new BookService(
      store,
      () => new Date("2026-09-13T10:00:00Z"),
      () => `k${++id}`
    ),
    saves,
  };
}

test("books are added from a form, contents typed as text; unreadable parts come back", () => {
  const { service } = shelf();
  const { book, unread } = service.add({
    kind: "comic",
    title: "Thor Epic Collection",
    volume: "1",
    format: "Epic Collection",
    publisher: "Marvel",
    runs: "Journey Into Mystery (1952) #83-109; plus sketches #?",
  });
  assert.equal(book.runs.length, 1);
  assert.deepEqual(unread, ["plus sketches #?"]);

  assert.throws(() => service.add({ title: "", format: "Omnibus" }), /needs a title/);
  assert.throws(() => service.add({ title: "X", format: "Paperback-ish" }), /Choose a format/);
  assert.throws(() => service.add({ title: "X", format: "Omnibus", isbn: "not an isbn" }), /ISBN/);
});

test("editing keeps what isn't changed; the shelf reports coverage and survives a restart", () => {
  const first = shelf();
  const { book } = first.service.add({
    title: "Thor Epic Collection",
    volume: "1",
    format: "Epic Collection",
    runs: "Journey Into Mystery (1952) #83-109",
  });
  first.service.add({
    title: "The Mighty Thor Omnibus",
    volume: "1",
    format: "Omnibus",
    runs: "Journey Into Mystery (1952) #83-120",
  });

  const edited = first.service.update(book.id, { notes: "First printing" }).book;
  assert.equal(edited.runs.length, 1, "runs untouched by an edit that didn't mention them");
  assert.equal(edited.notes, "First printing");
  assert.equal(first.service.coverage()[0].duplicatedIssues, 27);

  const restarted = shelf(first.saves.at(-1));
  assert.deepEqual(
    restarted.service.list().map((b) => `${b.title} ${b.volume}`),
    ["The Mighty Thor Omnibus 1", "Thor Epic Collection 1"]
  );
  assert.equal(restarted.service.coverage()[0].duplicatedIssues, 27);
});

test("malformed saved books and runs are dropped, not half-used", () => {
  const { service } = shelf({
    version: 1,
    books: [
      {
        id: "ok",
        kind: "manga",
        title: "One Piece",
        volume: "1",
        format: "Manga volume",
        status: "owned",
        runs: [
          { series: "One Piece", year: null, from: 1, to: 1, partial: false },
          { series: "One Piece", year: null, from: 9, to: 2, partial: false },
          { series: "", year: null, from: 1, to: 1, partial: false },
        ],
      },
      { id: "bad-kind", kind: "scroll", title: "X", format: "Other", status: "owned", runs: [] },
      { id: "bad-format", kind: "comic", title: "X", format: "Scroll", status: "owned", runs: [] },
    ],
  });
  const books = service.list();
  assert.deepEqual(
    books.map((b) => b.id),
    ["ok"]
  );
  assert.equal(books[0].runs.length, 1, "the backwards and nameless runs are dropped");
});

test("a GCD series search drops a trailing volume number — GCD names never include one", async () => {
  const urls: string[] = [];
  const gcd = new GcdCatalog(
    async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ count: 0, results: [] }), { status: 200 });
    },
    Date.now,
    async () => {}
  );
  await gcd.searchSeries("Master of the Mystic Arts Omnibus Vol 1");
  await gcd.searchSeries("Thor Epic Collection #3");
  assert.ok(urls[0].includes("/name/Master%20of%20the%20Mystic%20Arts%20Omnibus/"));
  assert.ok(urls[1].includes("/name/Thor%20Epic%20Collection/"));
});

test('GCD saying "too many requests" is told apart from GCD being down', async () => {
  const { catalogRetry } = await import("../catalogs/http");
  const original = catalogRetry.sleep;
  catalogRetry.sleep = async () => {};
  try {
    const busy = new GcdCatalog(
      async () => new Response("", { status: 429 }),
      Date.now,
      async () => {}
    );
    await assert.rejects(() => busy.searchSeries("Thor"), /asking for a pause/);
  } finally {
    catalogRetry.sleep = original;
  }
});

test("issues read are kept for the shelf, validated, and survive a restart", () => {
  const { service, saves } = shelf();
  const epic = service.add({
    kind: "comic",
    title: "Thor Epic Collection",
    format: "Epic Collection",
    runs: "Journey Into Mystery (1952) #83-86",
  }).book;
  const omni = service.add({
    kind: "comic",
    title: "Thor Omnibus",
    format: "Omnibus",
    runs: "Journey Into Mystery (1952) #83-90",
  }).book;
  assert.equal(
    service.setIssuesRead(
      [
        { series: "Journey Into Mystery", year: 1952, number: 83 },
        { series: "Journey Into Mystery", year: 1952, number: 84 },
        { series: "", year: 1952, number: 85 },
        { series: "Journey Into Mystery", year: 1952, number: -1 },
        "junk",
      ],
      true
    ),
    2,
    "only the two well-formed issues"
  );
  assert.throws(() => service.setIssuesRead("everything", true), /Nothing to mark/);
  const reopened = new BookService({ load: () => saves[saves.length - 1], save: () => {} });
  assert.deepEqual(reopened.readIssueKeys().sort(), [
    "journey into mystery (1952)#83",
    "journey into mystery (1952)#84",
  ]);

  // Read in one book is read in the other.
  const all = reopened.list();
  const read = new Set(reopened.readIssueKeys());
  assert.deepEqual(
    bookProgress(
      all.find((b) => b.id === epic.id)!,
      all,
      read
    ),
    { percent: 50, readIssues: 2, totalIssues: 4, fromIssues: true }
  );
  assert.deepEqual(
    bookProgress(
      all.find((b) => b.id === omni.id)!,
      all,
      read
    ),
    { percent: 25, readIssues: 2, totalIssues: 8, fromIssues: true }
  );

  assert.equal(
    reopened.setIssuesRead([{ series: "Journey Into Mystery", year: 1952, number: 83 }], false),
    1
  );
  assert.deepEqual(reopened.readIssueKeys(), ["journey into mystery (1952)#84"]);
});

test("a chosen cover survives an ISBN change; a found one is looked for again", () => {
  const { service } = shelf();
  const book = service.add({ kind: "comic", title: "Thor", format: "Other", isbn: "9780785188353" }).book;
  service.setCover(book.id, "https://covers.openlibrary.org/b/isbn/9780785188353-M.jpg");
  assert.equal(service.update(book.id, { isbn: "9781302933982" }).book.coverUrl, null);
  service.setCover(book.id, `nimbus-cover://cover/${book.id}.jpg?v=1`);
  assert.equal(
    service.update(book.id, { isbn: "9780785188353" }).book.coverUrl,
    `nimbus-cover://cover/${book.id}.jpg?v=1`
  );
  service.setCover(book.id, "file:///C:/Users/secret.jpg");
  assert.equal(
    service.get(book.id).coverUrl,
    `nimbus-cover://cover/${book.id}.jpg?v=1`,
    "other addresses are ignored"
  );
});
