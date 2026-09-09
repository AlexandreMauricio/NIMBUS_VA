import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemActionProvider, SYSTEM_ACTIONS } from "./systemActionProvider";

function provider(openUrl: (url: string) => Promise<void> = async () => {}): SystemActionProvider {
  return new SystemActionProvider(openUrl);
}

test("isAvailable is always true — opening a URL needs no auth/config", () => {
  assert.equal(provider().isAvailable(), true);
});

test("validate accepts a plain http/https URL", () => {
  const p = provider();
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "https://terraria.wiki.gg/" }).valid, true);
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "http://example.com" }).valid, true);
});

test("validate rejects a missing/empty url", () => {
  const p = provider();
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, {}).valid, false);
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "" }).valid, false);
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "   " }).valid, false);
});

test("validate rejects a non-http(s) scheme — never treats a URL as an executable command", () => {
  const p = provider();
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "file:///C:/secrets.txt" }).valid, false);
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "javascript:alert(1)" }).valid, false);
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "custom-app://do-something" }).valid, false);
});

test("validate rejects a malformed URL", () => {
  const p = provider();
  assert.equal(p.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "not a url" }).valid, false);
});

test("execute calls the injected openUrl with the parsed/normalized URL and returns success", async () => {
  const calls: string[] = [];
  const p = provider(async (url) => {
    calls.push(url);
  });
  const result = await p.execute(SYSTEM_ACTIONS.OPEN_URL, { url: "https://terraria.wiki.gg/wiki/Guide" });
  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["https://terraria.wiki.gg/wiki/Guide"]);
});

test("execute fails gracefully (not throwing) when openUrl rejects", async () => {
  const p = provider(async () => {
    throw new Error("no default browser configured");
  });
  const result = await p.execute(SYSTEM_ACTIONS.OPEN_URL, { url: "https://example.com" });
  assert.equal(result.status, "failure");
});

test("execute rejects a non-http(s) URL even if validate was somehow bypassed", async () => {
  const calls: string[] = [];
  const p = provider(async (url) => {
    calls.push(url);
  });
  const result = await p.execute(SYSTEM_ACTIONS.OPEN_URL, { url: "file:///etc/passwd" });
  assert.equal(result.status, "failure");
  assert.deepEqual(calls, []); // openUrl must never be called with a rejected scheme
});

test("listActions declares system.openUrl with no confirmation required", () => {
  const p = provider();
  const actions = p.listActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, SYSTEM_ACTIONS.OPEN_URL);
  assert.equal(actions[0].requiresConfirmation, false);
  assert.equal(actions[0].affectsService, "system");
});
