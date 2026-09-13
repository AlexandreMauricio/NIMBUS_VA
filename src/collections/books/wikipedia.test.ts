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
  await wiki.findByIsbn(["9781302962180"]);
  assert.equal(urls.length, 1, "the list is kept, not fetched again");
});
