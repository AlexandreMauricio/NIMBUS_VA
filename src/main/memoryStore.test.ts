import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileMemoryStore } from "./memoryStore";
import { MemoryService } from "../memory/memoryService";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-memory-"));
}

test("each tier is its own file, and everything comes back after a restart", () => {
  const dir = path.join(tempDir(), "memory");
  const clock = () => new Date("2026-09-11T10:00:00Z");
  const first = new MemoryService(new FileMemoryStore(dir), clock);
  first.remember({ kind: "preference", title: "Preferred volume", value: 40 });
  first.observe({ key: "k", kind: "history", title: "Seen", value: 1, source: "network" });

  assert.deepEqual(fs.readdirSync(dir).sort(), ["explicit.json", "observed.json"]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "explicit.json"), "utf-8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items[0].title, "Preferred volume");

  const restarted = new MemoryService(new FileMemoryStore(dir), clock);
  assert.deepEqual(
    restarted.list().map((i) => i.title),
    ["Preferred volume", "Seen"]
  );
});

test("a missing folder is simply empty memory", () => {
  const store = new FileMemoryStore(path.join(tempDir(), "does-not-exist"));
  assert.deepEqual(store.load("explicit"), []);
});

test("an unreadable file is set aside, not overwritten", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "explicit.json"), "{ not json");
  const memory = new MemoryService(new FileMemoryStore(dir), () => new Date("2026-09-11T10:00:00Z"));

  assert.deepEqual(memory.list(), []);
  const files = fs.readdirSync(dir);
  assert.ok(
    files.some((f) => /^explicit\.unreadable-\d+\.json$/.test(f)),
    files.join(", ")
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        dir,
        files.find((f) => f.includes("unreadable"))!
      ),
      "utf-8"
    ),
    "{ not json"
  );
});
