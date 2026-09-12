import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRuns, parseRuns, seriesKey } from "./runs";

// Every note below is copied from the Grand Comics Database as returned by
// its API while this was built.

const brief = (text: string) =>
  parseRuns(text).runs.map((r) => `${r.partial ? "~" : ""}${r.series}|${r.year ?? "-"}|${r.from}-${r.to}`);

test("Epic Collection: several series, an annual that means the previous one, and 'material from'", () => {
  assert.deepEqual(
    brief(
      "Collects Journey Into Mystery (1952) #110-125, Annual #1, Thor (1966) #126-130, and material from Not Brand Echh #3"
    ),
    [
      "Journey Into Mystery|1952|110-125",
      "Journey Into Mystery Annual|1952|1-1",
      "Thor|1966|126-130",
      "~Not Brand Echh|-|3-3",
    ]
  );
});

test("the publisher-and-year form in parentheses, with semicolons and 'and'", () => {
  assert.deepEqual(
    brief(
      "Collects Amazing Fantasy (Marvel, 1962 series) #15; The Amazing Spider-Man (Marvel, 1963 series) #1-17, and The Amazing Spider-Man Annual (Marvel, 1964 series) #1."
    ),
    [
      "Amazing Fantasy|1962|15-15",
      "The Amazing Spider-Man|1963|1-17",
      "The Amazing Spider-Man Annual|1964|1-1",
    ]
  );
});

test("a trailing year range isn't read as issues", () => {
  assert.deepEqual(brief("Collects Thor #131-153 and Annual #2 (1966-1968)."), [
    "Thor|-|131-153",
    "Thor Annual|-|2-2",
  ]);
});

test("Masterworks: 'Reprints material from' marks the run as partial", () => {
  assert.deepEqual(brief("Reprints material from Journey Into Mystery (Marvel, 1952 Series) #83-100."), [
    "~Journey Into Mystery|1952|83-100",
  ]);
});

test("notes that say nothing about contents give nothing — and nothing is guessed", () => {
  const parsed = parseRuns(
    "Art reconstruction by Michael Kelleher and Pacific Rim Graphics.\r\nColor reconstruction by Michael Kelleher and Kellustration."
  );
  assert.deepEqual(parsed.runs, []);
  assert.deepEqual(parseRuns("").runs, []);
});

test("what you type yourself reads the same way, and round-trips through formatting", () => {
  const typed = "Thor (1966) #126-130; Thor Annual (1966) #2; #140-145; material from Not Brand Echh #3";
  const { runs, unread } = parseRuns(typed);
  assert.deepEqual(unread, []);
  assert.deepEqual(
    runs.map((r) => `${r.series}|${r.from}-${r.to}`),
    ["Thor|126-130", "Thor Annual|2-2", "Thor Annual|140-145", "Not Brand Echh|3-3"]
  );
  assert.deepEqual(parseRuns(formatRuns(runs)).runs, runs, "formatting then parsing gives the same runs");
});

test("manga volumes are runs too", () => {
  assert.deepEqual(brief("One Piece #1-45; #47"), ["One Piece|-|1-45", "One Piece|-|47-47"]);
});

test("pieces that look like contents but can't be read are reported, not dropped silently", () => {
  const { runs, unread } = parseRuns("Collects Thor #1-3 and 12 pages of sketches");
  assert.equal(runs.length, 1);
  assert.deepEqual(unread, ["12 pages of sketches"]);
});

test("series keys ignore case, punctuation and a leading 'The', but keep the year", () => {
  assert.equal(seriesKey("The Amazing Spider-Man", 1963), seriesKey("amazing spider man", 1963));
  assert.notEqual(seriesKey("Thor", 1966), seriesKey("Thor", 1998));
});
