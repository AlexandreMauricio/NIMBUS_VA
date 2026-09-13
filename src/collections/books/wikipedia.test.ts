import { test } from "node:test";
import assert from "node:assert/strict";
import { WikipediaCollections, findContentsByIsbn, toIsbn13, wikitextToPlain } from "./wikipedia";

// Trimmed from Wikipedia's "Marvel Omnibus" list as fetched while this was built.
const WIKITEXT = [
  "===Doctor Strange===",
  '{| class="wikitable"',
  "|-",
  "|rowspan=2|2",
  "|rowspan=2|'''''Doctor Strange Vol. 2'''''",
  "|rowspan=2|1968-1969",
  "|rowspan=2|''Doctor Strange'' #169–183; ''Avengers'' #61; material from ''Strange Tales'' #147–168; ''[[Marvel Feature]]'' #1 and ''Not Brand Echh'' #13",
  '|rowspan=2 style="text-align: center;"|#147-183',
  '|rowspan=2 style="text-align: center;" |704',
  "|rowspan=2|{{dts|25 Jan 2022}}",
  "|Kevin Nowlan cover: {{nowrap|{{isbnt|978-1302926632}}}}",
  "|-",
  "|Dan Adkins DM cover: {{nowrap|{{isbnt|978-1302926649}}}}",
  "|-",
  "|rowspan=2|1",
  "|rowspan=2|'''''Doctor Strange: Master of the Mystic Arts Vol. 1'''''",
  "|rowspan=2|1972-1977",
  "|rowspan=2|''Marvel Premiere'' (1972) #3–14, ''Doctor Strange'' (1974) #1–22, ''Doctor Strange Annual'' (1976) #1, ''Tomb of Dracula'' (1972) #44<ref>{{cite web |title=x}}</ref>",
  '|rowspan=2 style="text-align: center;"|#184-205',
  '|rowspan=2 style="text-align: center;" |768',
  "|rowspan=2|{{dts|11 Mar 2025}}",
  "|Frank Brunner Strange & Clea cover: {{nowrap|{{isbnt|978-1302962173}}}}",
  "|-",
  "|Frank Brunner First Issue DM cover: {{nowrap|{{isbnt|978-1302962180}}}}",
  "|}",
].join("\n");

test("an omnibus's contents by either printing's ISBN, from a list row", () => {
  const first = findContentsByIsbn(WIKITEXT, "978-1-302-96217-3", "Marvel Omnibus")!;
  assert.equal(first.title, "Doctor Strange: Master of the Mystic Arts Vol. 1");
  assert.equal(
    first.contents,
    "Marvel Premiere (1972) #3–14, Doctor Strange (1974) #1–22, Doctor Strange Annual (1976) #1, Tomb of Dracula (1972) #44"
  );
  assert.deepEqual(
    first.runs.map((r) => `${r.series} (${r.year}) #${r.from}-${r.to}`),
    [
      "Marvel Premiere (1972) #3-14",
      "Doctor Strange (1974) #1-22",
      "Doctor Strange Annual (1976) #1-1",
      "Tomb of Dracula (1972) #44-44",
    ]
  );
  const directEdition = findContentsByIsbn(WIKITEXT, "9781302962180", "Marvel Omnibus")!;
  assert.deepEqual(directEdition.runs, first.runs, "the DM printing shares the row's cells");

  const vol2 = findContentsByIsbn(WIKITEXT, "9781302926649", "Marvel Omnibus")!;
  assert.equal(vol2.title, "Doctor Strange Vol. 2");
  assert.ok(vol2.runs.some((r) => r.series === "Marvel Feature" && r.partial));
  assert.equal(findContentsByIsbn(WIKITEXT, "9780141036144", "Marvel Omnibus"), null);
});

test("ISBN-10s match their ISBN-13, and wikitext reads as plain text", () => {
  assert.equal(toIsbn13("0-7851-1234-6"), "9780785112341");
  assert.equal(toIsbn13("978-1-302-96217-3"), "9781302962173");
  assert.equal(toIsbn13("123"), null);
  assert.equal(
    wikitextToPlain(
      "''[[Silver Surfer]]'' (1987) #34; ''[[The Incredible Hulk (comic book)|Incredible Hulk]]'' #383<ref name=a/>"
    ),
    "Silver Surfer (1987) #34; Incredible Hulk #383"
  );
});

test("the lists are downloaded whole — the ISBN itself is never sent", async () => {
  const urls: string[] = [];
  const wiki = new WikipediaCollections(
    async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ parse: { wikitext: WIKITEXT } }), { status: 200 });
    },
    Date.now,
    async () => {}
  );
  const found = await wiki.findByIsbn(["9781302962173"]);
  assert.equal(found?.list, "Marvel Omnibus");
  assert.ok(
    urls.every(
      (url) => !url.includes("9781302962173") && url.startsWith("https://en.wikipedia.org/w/api.php")
    )
  );
  assert.equal(urls.length, 4, "each list once");
  await wiki.findByIsbn(["9781302962180"]);
  await wiki.search("mystic arts");
  assert.equal(urls.length, 4, "the lists are kept, not fetched again");
});

test("each list's layout: an Epic's reprint row, Masterworks' sort titles, DC's collapsible contents", async () => {
  const { parseRows, searchRows, editionFromRow } = await import("./wikipedia");
  const epic = [
    "===Thor===",
    '{|class="wikitable sortable"',
    "|-",
    "! Subtitle",
    "|-",
    "|rowspan=2|1",
    "|rowspan=2|'''''The God of Thunder'''''",
    "|rowspan=2|{{nowrap|1962-1964}}",
    "|rowspan=2|''[[Journey into Mystery]]'' #83–109",
    "|rowspan=2|Stan Lee",
    '|style="text-align: center;" rowspan=2|480',
    "|''Journey into Mystery'' #105 cover: {{ISBNT|978-0785188353}}",
    "|-",
    "|{{dts|5 Apr 2022|format=mdy}}",
    "|''Journey into Mystery'' #105 cover: {{ISBNT|978-1302933982}}",
    "|}",
  ].join("\n");
  const epicRows = parseRows(epic, "Marvel Epic Collection");
  assert.equal(epicRows.length, 1, "the 2022 printing joins its row");
  assert.deepEqual(epicRows[0].isbns, ["9780785188353", "9781302933982"]);
  assert.equal(
    findContentsByIsbn(epic, "978-1302933982", "Marvel Epic Collection")?.contents,
    "Journey into Mystery #83–109"
  );
  const edition = editionFromRow(epicRows[0])!;
  assert.deepEqual(
    [edition.bookTitle, edition.volume, edition.format],
    ["Thor Epic Collection", "1 - The God of Thunder", "Epic Collection"]
  );

  const masterworks = [
    "{|",
    "|-",
    "|'''35'''",
    "|Silver",
    "|{{Sort|X-Men 04|''The X-Men Vol. 4''}}",
    "|''[[Uncanny X-Men|The X-Men]]'' #32-42",
    "|240",
    "|{{ISBNT|978-0-7851-1607-3}}",
    "|}",
  ].join("\n");
  const mw = editionFromRow(parseRows(masterworks, "Marvel Masterworks")[0])!;
  assert.deepEqual(
    [mw.bookTitle, mw.volume, mw.contents],
    ["The X-Men Masterworks", "4", "The X-Men #32-42"]
  );

  const dc = [
    "{|",
    "|-",
    "| rowspan=\"6\" |''[[Batman: Knightfall]]''",
    '| rowspan="2" |1',
    '| rowspan="2" |1993',
    '| rowspan="2" |{{Collapsible list',
    "|titlestyle=font-weight:normal",
    "|title=''Batman'' (vol. 1) #484–500, and more",
    "|",
    "* ''Batman: Vengeance of Bane'' #1",
    "* ''Detective Comics'' #654–666",
    "}}",
    '| rowspan="2" |960',
    "|{{ISBNT|978-1401270421}}",
    "|-",
    '| rowspan="2" |2',
    '| rowspan="2" |{{Collapsible list',
    "|title=''Batman'' (vol. 1) #501–508, and more",
    "|",
    "* ''Detective Comics'' #667–675",
    "}}",
    '| rowspan="2" |976',
    "|{{ISBNT|978-1401274368}}",
    "|}",
  ].join("\n");
  const dcRows = parseRows(dc, "DC Omnibus");
  assert.deepEqual(
    dcRows.map((r) => [r.title, r.number, r.contents]),
    [
      [
        "Batman: Knightfall",
        "1",
        "Batman (vol. 1) #484–500; Batman: Vengeance of Bane #1; Detective Comics #654–666",
      ],
      ["Batman: Knightfall", "2", "Batman (vol. 1) #501–508; Detective Comics #667–675"],
    ]
  );
  const found = searchRows(dcRows, "knightfall omnibus 2");
  assert.deepEqual(
    found.map((e) => [e.bookTitle, e.volume, e.isbn]),
    [["Batman: Knightfall Omnibus", "2", "9781401274368"]]
  );
});

test("title search: every word must match, a number must be the volume", async () => {
  const { parseRows, searchRows } = await import("./wikipedia");
  const rows = parseRows(WIKITEXT, "Marvel Omnibus");
  const mystic = searchRows(rows, "Master of the Mystic Arts Omnibus Vol 1");
  assert.deepEqual(
    mystic.map((e) => [e.bookTitle, e.volume, e.isbn]),
    [["Doctor Strange: Master of the Mystic Arts Omnibus", "1", "9781302962173"]]
  );
  assert.equal(searchRows(rows, "Master of the Mystic Arts Omnibus 2").length, 0);
  assert.equal(searchRows(rows, "Sorcerer Supreme").length, 0);
  assert.equal(searchRows(rows, "doctor strange omnibus").length, 2);
});
