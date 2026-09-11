import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemActionProvider, SYSTEM_ACTIONS } from "./systemActionProvider";

test("system.lock is offered only when the host can lock", () => {
  const without = new SystemActionProvider(async () => {});
  const withLock = new SystemActionProvider(
    async () => {},
    undefined,
    async () => {}
  );

  assert.deepEqual(
    without.listActions().map((a) => a.id),
    ["system.openUrl"]
  );
  assert.deepEqual(
    withLock.listActions().map((a) => a.id),
    ["system.openUrl", "system.lock"]
  );
});

test("system.lock locks the computer", async () => {
  let locked = 0;
  const provider = new SystemActionProvider(
    async () => {},
    undefined,
    async () => {
      locked++;
    }
  );

  const result = await provider.execute(SYSTEM_ACTIONS.LOCK, {});

  assert.equal(result.status, "success");
  assert.equal(result.message, "Locked Windows.");
  assert.equal(locked, 1);
});

test("system.lock without an implementation fails as not_available", async () => {
  const provider = new SystemActionProvider(async () => {});

  const result = await provider.execute(SYSTEM_ACTIONS.LOCK, {});

  assert.equal(result.error?.category, "not_available");
});

test("a failed lock is a structured failure", async () => {
  const provider = new SystemActionProvider(
    async () => {},
    undefined,
    async () => {
      throw new Error("denied");
    }
  );

  const result = await provider.execute(SYSTEM_ACTIONS.LOCK, {});

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "unknown");
});

test("system.openUrl is unchanged by lock support", async () => {
  const opened: string[] = [];
  const provider = new SystemActionProvider(
    async (url) => {
      opened.push(url);
    },
    undefined,
    async () => {}
  );

  const result = await provider.execute(SYSTEM_ACTIONS.OPEN_URL, { url: "https://example.com/wiki" });

  assert.equal(result.status, "success");
  assert.deepEqual(opened, ["https://example.com/wiki"]);
  assert.equal(provider.validate(SYSTEM_ACTIONS.OPEN_URL, { url: "file:///C:/x.exe" }).valid, false);
});
