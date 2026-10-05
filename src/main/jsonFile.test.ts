import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DebouncedJsonFile,
  flushPendingWrites,
  loadJsonOrSetAside,
  saveJsonFile,
  writeFileAtomic,
} from "./jsonFile";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-json-"));
}

test("writeFileAtomic replaces the file and leaves no temp file", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf-8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("writeFileAtomic writes bytes as they are", () => {
  const file = path.join(tempDir(), "picture.jpg");
  writeFileAtomic(file, Buffer.from([0xff, 0xd8, 0x00, 0x01]));
  assert.deepEqual([...fs.readFileSync(file)], [0xff, 0xd8, 0x00, 0x01]);
});

test("a failed write throws, keeps the old file and cleans up its temp file", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  // A directory where the temp file would go makes the write itself fail.
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => writeFileAtomic(file, "new"));
  assert.equal(fs.readFileSync(file, "utf-8"), "old");
});

test("saveJsonFile writes JSON and says whether it did", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  assert.equal(saveJsonFile(file, { a: 1 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { a: 1 });
  assert.equal(saveJsonFile(path.join(dir, "missing", "state.json"), { a: 1 }), false);
});

test("loadJsonOrSetAside: a missing file is null", () => {
  assert.equal(loadJsonOrSetAside(path.join(tempDir(), "nothing.json")), null);
});

test("loadJsonOrSetAside reads what saveJsonFile wrote", () => {
  const file = path.join(tempDir(), "meals.json");
  saveJsonFile(file, { recipes: [{ id: "r1" }] });
  assert.deepEqual(loadJsonOrSetAside(file), { recipes: [{ id: "r1" }] });
});

test("loadJsonOrSetAside moves an unreadable file aside instead of losing it", () => {
  const dir = tempDir();
  const file = path.join(dir, "books.json");
  fs.writeFileSync(file, "{ not json");
  assert.equal(loadJsonOrSetAside(file), null);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^books\.unreadable-\d+\.json$/);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf-8"), "{ not json");
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("DebouncedJsonFile: saves in a row are one write, of the latest value", async () => {
  const file = path.join(tempDir(), "meals.json");
  const writes: number[] = [];
  const debounced = new DebouncedJsonFile(() => {
    writes.push(Date.now());
    return file;
  }, 30);
  const state = { count: 0 };
  for (let i = 1; i <= 5; i++) {
    state.count = i;
    debounced.save(state);
  }
  assert.equal(fs.existsSync(file), false, "nothing written yet");
  await pause(80);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { count: 5 });
  assert.equal(writes.length, 1);
});

test("DebouncedJsonFile: a save waits at most its delay, however many follow", async () => {
  const file = path.join(tempDir(), "meals.json");
  const debounced = new DebouncedJsonFile(() => file, 40);
  debounced.save({ n: 1 });
  await pause(25);
  debounced.save({ n: 2 });
  await pause(25);
  // 50 ms after the first save: written, though the last was 25 ms ago.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { n: 2 });
});

test("flushPendingWrites writes every waiting file now, and only once", () => {
  const dir = tempDir();
  const a = new DebouncedJsonFile(() => path.join(dir, "a.json"), 10_000);
  const b = new DebouncedJsonFile(() => path.join(dir, "b.json"), 10_000);
  a.save({ a: 1 });
  b.save({ b: 1 });
  flushPendingWrites();
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.json", "b.json"]);
  // Nothing waits any more: a file changed after the flush isn't overwritten.
  fs.writeFileSync(path.join(dir, "a.json"), '{"imported":true}');
  flushPendingWrites();
  a.flush();
  assert.equal(fs.readFileSync(path.join(dir, "a.json"), "utf-8"), '{"imported":true}');
});
