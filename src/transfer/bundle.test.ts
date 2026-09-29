import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedPath, readBundle } from "./bundle";

const bundle = (sections: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "nimbus-data",
    version: 1,
    appVersion: "0.6.33",
    exportedAt: "2026-09-29T20:00:00Z",
    sections,
    ...over,
  });

test("transfer: only each part's own files, by name — nothing else can be written", () => {
  assert.equal(allowedPath("meals", "meals.json"), true);
  assert.equal(allowedPath("meals", "recipe-photos/abc-123.jpg"), true);
  assert.equal(allowedPath("meals", "books.json"), false, "another part's file");
  assert.equal(allowedPath("meals", "recipe-photos/../settings.json"), false);
  assert.equal(allowedPath("meals", "recipe-photos/x.exe"), false);
  assert.equal(allowedPath("memory", "memory/learned.json"), true);
  assert.equal(allowedPath("memory", "memory/secrets.json"), false);
  assert.equal(allowedPath("cards", "settings.json"), false);
});

test("transfer: an export is checked and summarised before anything is written", () => {
  const { summary, bundle: read } = readBundle(
    bundle({
      meals: [
        {
          path: "meals.json",
          encoding: "utf8",
          data: JSON.stringify({ recipes: [1, 2], pantry: [1], plan: [] }),
        },
        { path: "recipe-photos/r1.jpg", encoding: "base64", data: "AAEC" },
      ],
      books: [
        { path: "books.json", encoding: "utf8", data: JSON.stringify({ version: 1, books: [1, 2, 3] }) },
      ],
    })
  );
  assert.deepEqual(
    summary.map((s) => [s.id, s.detail]),
    [
      ["meals", "recipes 2 · pantry 1 · 1 picture"],
      ["books", "books 3"],
    ]
  );
  assert.equal(read.appVersion, "0.6.33");
});

test("transfer: what isn't a NIMBUS export, or smuggles in a file, is refused whole", () => {
  assert.throws(() => readBundle("not json"), /isn't a NIMBUS export/);
  assert.throws(() => readBundle(JSON.stringify({ format: "other" })), /isn't a NIMBUS export/);
  assert.throws(() => readBundle(bundle({}, { version: 99 })), /newer NIMBUS/);
  assert.throws(() => readBundle(bundle({ settings: [] })), /doesn't know/);
  assert.throws(
    () => readBundle(bundle({ meals: [{ path: "../secrets.json", encoding: "utf8", data: "{}" }] })),
    /doesn't belong/
  );
  assert.throws(
    () => readBundle(bundle({ decks: [{ path: "decks.json", encoding: "utf8", data: "{broken" }] })),
    /damaged/
  );
  assert.throws(() => readBundle(bundle({})), /nothing in it/);
});
