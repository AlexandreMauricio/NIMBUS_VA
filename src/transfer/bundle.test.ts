import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedPath, backupsToPrune, mergeImportedSettings, portableSettings, readBundle } from "./bundle";

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
  assert.equal(allowedPath("settings", "settings.json"), true);
  assert.equal(allowedPath("settings", "secrets.json"), false);
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
  assert.throws(() => readBundle(bundle({ secrets: [] })), /doesn't know/);
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

const onDisk = JSON.stringify({
  windowsClient: { windowBounds: { width: 1400, height: 900 }, startup: { launchWithWindows: true } },
  userPreferences: {
    email: { enabled: true, accounts: [{ id: "e1", user: "me@example.com", password: "inline-old" }] },
    tasks: { enabled: true, accounts: [{ id: "t1", apiToken: "tok" }] },
    routines: { enabled: true, routines: [{ id: "r1" }, { id: "r2" }] },
    stocks: { positions: [{ symbol: "AAPL" }] },
  },
});

test("transfer: settings export only preferences, never a credential or this PC's window", () => {
  const exported = JSON.parse(portableSettings(onDisk));
  assert.deepEqual(Object.keys(exported), ["userPreferences"]);
  assert.equal(exported.userPreferences.email.accounts[0].password, "");
  assert.equal(exported.userPreferences.email.accounts[0].user, "me@example.com");
  assert.equal(exported.userPreferences.tasks.accounts[0].apiToken, "");
  assert.equal(exported.userPreferences.routines.routines.length, 2);
  assert.doesNotMatch(portableSettings(onDisk), /inline-old|tok"/);
  assert.throws(() => portableSettings(JSON.stringify({ windowsClient: {} })), /no preferences/);
});

test("transfer: imported settings keep this PC's window and startup, and take nothing else", () => {
  const local = JSON.stringify({
    windowsClient: { windowBounds: { width: 800, height: 600 }, zoomPercent: 110 },
    userPreferences: { routines: { routines: [] } },
  });
  const imported = JSON.stringify({
    windowsClient: { zoomPercent: 300 },
    userPreferences: {
      routines: { routines: [{ id: "r1" }] },
      tasks: { accounts: [{ id: "t", apiToken: "x" }] },
    },
  });
  const merged = JSON.parse(mergeImportedSettings(local, imported));
  assert.deepEqual(merged.windowsClient, { windowBounds: { width: 800, height: 600 }, zoomPercent: 110 });
  assert.deepEqual(merged.userPreferences.routines.routines, [{ id: "r1" }]);
  assert.equal(merged.userPreferences.tasks.accounts[0].apiToken, "");
  // A PC without settings yet, or with a broken file, just takes the preferences.
  assert.deepEqual(Object.keys(JSON.parse(mergeImportedSettings(null, imported))), ["userPreferences"]);
  assert.deepEqual(Object.keys(JSON.parse(mergeImportedSettings("{oops", imported))), ["userPreferences"]);
});

test("transfer: a settings part is summarised, and refused when it holds no preferences", () => {
  const { summary } = readBundle(
    bundle({ settings: [{ path: "settings.json", encoding: "utf8", data: portableSettings(onDisk) }] })
  );
  assert.deepEqual(
    summary.map((s) => s.detail),
    ["routines 2 · positions 1 · email accounts 1 · task accounts 1"]
  );
  assert.throws(
    () => readBundle(bundle({ settings: [{ path: "settings.json", encoding: "utf8", data: "[]" }] })),
    /damaged/
  );
});

test("transfer: only the newest import backups are kept, and nothing else is touched", () => {
  const names = [
    "before-import-2026-10-01T10-00-00-000Z",
    "before-import-2026-10-03T10-00-00-000Z",
    "before-import-2026-10-02T10-00-00-000Z",
    "my-own-folder",
  ];
  assert.deepEqual(backupsToPrune(names, 2), ["before-import-2026-10-01T10-00-00-000Z"]);
  assert.deepEqual(backupsToPrune(names, 10), []);
});
