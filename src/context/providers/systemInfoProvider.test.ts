import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemInfoProvider } from "./systemInfoProvider";
import { APP_VERSION } from "../../common/appInfo";

test("is always available", () => {
  const provider = new SystemInfoProvider();
  assert.equal(provider.isAvailable(), true);
});

test("reports plausible system information", () => {
  const provider = new SystemInfoProvider();
  const ctx = provider.getContext();

  assert.equal(typeof ctx.hostname, "string");
  assert.ok(ctx.hostname.length > 0);
  assert.equal(ctx.platform, process.platform);
  assert.equal(ctx.arch, process.arch);
  assert.ok(ctx.cpuCount > 0);
  assert.ok(ctx.totalMemoryMB > 0);
  assert.ok(ctx.freeMemoryMB >= 0);
  assert.ok(ctx.uptimeSeconds >= 0);
  assert.equal(ctx.nimbusVersion, APP_VERSION);
});
