import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "./contextService";
import { ContextProvider } from "./types";

function okProvider(id: string, data: unknown): ContextProvider {
  return {
    id,
    displayName: id,
    isAvailable: () => true,
    getContext: () => data,
  };
}

function throwingProvider(id: string): ContextProvider {
  return {
    id,
    displayName: id,
    isAvailable: () => true,
    getContext: () => {
      throw new Error(`${id} boom`);
    },
  };
}

function unavailableProvider(id: string): ContextProvider {
  return {
    id,
    displayName: id,
    isAvailable: () => false,
    getContext: () => {
      throw new Error("should never be called when unavailable");
    },
  };
}

test("getSnapshot returns ok status with data for a healthy provider", async () => {
  const service = new ContextService();
  service.register(okProvider("greeting", { hello: "world" }));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.greeting.status, "ok");
  assert.deepEqual(snapshot.providers.greeting.data, { hello: "world" });
  assert.equal(snapshot.providers.greeting.stale, false);
  assert.ok(snapshot.generatedAt);
});

test("a throwing provider produces an error result instead of throwing", async () => {
  const service = new ContextService();
  service.register(throwingProvider("broken"));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.broken.status, "error");
  assert.equal(snapshot.providers.broken.data, null);
  assert.match(snapshot.providers.broken.error ?? "", /boom/);
});

test("one provider failing does not affect other providers' results", async () => {
  const service = new ContextService();
  service.register(okProvider("healthy", { ok: true }));
  service.register(throwingProvider("broken"));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.healthy.status, "ok");
  assert.deepEqual(snapshot.providers.healthy.data, { ok: true });
  assert.equal(snapshot.providers.broken.status, "error");
});

test("an unavailable provider reports status 'unavailable' without calling getContext", async () => {
  const service = new ContextService();
  service.register(unavailableProvider("offline"));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.offline.status, "unavailable");
  assert.equal(snapshot.providers.offline.data, null);
});

test("isAvailable() throwing is treated as unavailable, not a crash", async () => {
  const service = new ContextService();
  service.register({
    id: "flaky",
    displayName: "flaky",
    isAvailable: () => {
      throw new Error("cannot tell");
    },
    getContext: () => ({ never: true }),
  });

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.flaky.status, "unavailable");
});

test("a later failure falls back to the last successful result, marked stale", async () => {
  const service = new ContextService();
  let shouldFail = false;
  service.register({
    id: "intermittent",
    displayName: "intermittent",
    isAvailable: () => true,
    getContext: () => {
      if (shouldFail) throw new Error("temporary outage");
      return { count: 1 };
    },
  });

  const first = await service.getSnapshot();
  assert.equal(first.providers.intermittent.status, "ok");
  assert.equal(first.providers.intermittent.stale, false);

  shouldFail = true;
  const second = await service.getSnapshot();
  assert.equal(second.providers.intermittent.status, "error");
  assert.equal(second.providers.intermittent.stale, true);
  assert.deepEqual(second.providers.intermittent.data, { count: 1 });
  assert.match(second.providers.intermittent.error ?? "", /temporary outage/);
});

test("registering two providers with the same id throws", () => {
  const service = new ContextService();
  service.register(okProvider("dup", {}));
  assert.throws(() => service.register(okProvider("dup", {})));
});

test("listProviderIds reflects registered providers", () => {
  const service = new ContextService();
  service.register(okProvider("a", {}));
  service.register(okProvider("b", {}));
  assert.deepEqual(service.listProviderIds().sort(), ["a", "b"]);
});

/** Never settles — stands in for a provider hung on a stalled socket or an await that never returns. */
function hangingProvider(id: string, hangIn: "isAvailable" | "getContext"): ContextProvider {
  const forever = new Promise<never>(() => {});
  return {
    id,
    displayName: id,
    isAvailable: () => (hangIn === "isAvailable" ? forever : true),
    getContext: () => (hangIn === "getContext" ? forever : {}),
  };
}

test("a provider hanging in getContext degrades to an error result instead of hanging the snapshot", async () => {
  const service = new ContextService(20);
  service.register(hangingProvider("stalled", "getContext"));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.stalled.status, "error");
  assert.match(String(snapshot.providers.stalled.error), /timed out/);
});

test("a provider hanging in isAvailable is treated as unavailable", async () => {
  const service = new ContextService(20);
  service.register(hangingProvider("stalled", "isAvailable"));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.stalled.status, "unavailable");
});

test("one hanging provider does not delay or degrade the others", async () => {
  const service = new ContextService(20);
  service.register(hangingProvider("stalled", "getContext"));
  service.register(okProvider("greeting", { hello: "world" }));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.stalled.status, "error");
  assert.equal(snapshot.providers.greeting.status, "ok");
  assert.deepEqual(snapshot.providers.greeting.data, { hello: "world" });
});

test("a provider that hangs after a good result falls back to the stale last-known-good value", async () => {
  const service = new ContextService(20);
  let hang = false;
  const forever = new Promise<never>(() => {});
  service.register({
    id: "flaky",
    displayName: "Flaky",
    isAvailable: () => true,
    getContext: () => (hang ? forever : { reading: 1 }),
  });

  await service.getSnapshot();
  hang = true;
  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.flaky.status, "error");
  assert.equal(snapshot.providers.flaky.stale, true);
  assert.deepEqual(snapshot.providers.flaky.data, { reading: 1 });
});
