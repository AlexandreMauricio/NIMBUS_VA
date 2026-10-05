import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * Every window runs sandboxed, and a sandboxed preload can require
 * "electron" and nothing else — a runtime import of one of NIMBUS's own
 * modules would compile fine and then break the window on load. Imports
 * used only as types are erased by tsc, so those are fine; this checks
 * what tsc actually emitted, next to this test in dist/preload/.
 */
test("the preloads require only electron", () => {
  const preloads = fs.readdirSync(__dirname).filter((f) => /Preload\.js$|^preload\.js$/.test(f));
  assert.deepEqual(preloads.sort(), ["preload.js", "suggestionPreload.js", "timerPreload.js"]);
  for (const file of preloads) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf-8");
    const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(required)], ["electron"], file);
  }
});
