import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * The safety boundary, checked structurally: nothing in Attention can
 * reach the Action system (so it can never run an action), Electron (so
 * it stays Core), or call anything that executes.
 */
test("Attention can't reach the Action system or Electron", () => {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  assert.ok(files.length >= 5, "the compiled Attention module was found");
  for (const file of files) {
    const source = readFileSync(join(__dirname, file), "utf8");
    assert.doesNotMatch(source, /require\("\.\.\/actions/, file);
    assert.doesNotMatch(source, /require\("electron"\)/, file);
    assert.doesNotMatch(source, /\.executeAction\(/, file);
  }
});
