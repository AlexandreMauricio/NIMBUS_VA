import { test } from "node:test";
import assert from "node:assert/strict";
import { LocationResolver } from "./locationResolver";
import { IpGeolocationClient } from "./ipGeolocation";

function fakeIpClient(result: { latitude: number; longitude: number; label: string }): IpGeolocationClient {
  return { locate: async () => result } as unknown as IpGeolocationClient;
}

function throwingIpClient(message: string): IpGeolocationClient {
  return {
    locate: async () => {
      throw new Error(message);
    },
  } as unknown as IpGeolocationClient;
}

test("manual mode uses the configured manual location", async () => {
  const resolver = new LocationResolver(
    () => ({
      locationMode: "manual",
      manualLocation: { latitude: 38.7, longitude: -9.1, label: "Lisbon" },
    }),
    null
  );

  const location = await resolver.resolve();

  assert.deepEqual(location, {
    latitude: 38.7,
    longitude: -9.1,
    label: "Lisbon",
    source: "manual",
  });
});

test("manual mode falls back to the env-configured location when none is saved", async () => {
  const resolver = new LocationResolver(() => ({ locationMode: "manual", manualLocation: null }), {
    latitude: 1,
    longitude: 2,
    label: "Fallback",
  });

  const location = await resolver.resolve();

  assert.equal(location.label, "Fallback");
  assert.equal(location.source, "manual");
});

test("manual mode with no saved location and no env fallback throws a clear error", async () => {
  const resolver = new LocationResolver(() => ({ locationMode: "manual", manualLocation: null }), null);

  await assert.rejects(() => resolver.resolve(), /no location is configured/);
});

test("auto mode resolves via IP geolocation", async () => {
  const resolver = new LocationResolver(
    () => ({ locationMode: "auto", manualLocation: null }),
    null,
    fakeIpClient({ latitude: 40.28, longitude: -7.5, label: "Covilhã, Portugal" })
  );

  const location = await resolver.resolve();

  assert.equal(location.source, "auto");
  assert.equal(location.label, "Covilhã, Portugal");
});

test("auto mode caches the resolved location instead of re-locating every call", async () => {
  let calls = 0;
  const ipClient = {
    locate: async () => {
      calls++;
      return { latitude: 1, longitude: 1, label: "Somewhere" };
    },
  } as unknown as IpGeolocationClient;

  const resolver = new LocationResolver(
    () => ({ locationMode: "auto", manualLocation: null }),
    null,
    ipClient
  );

  await resolver.resolve();
  await resolver.resolve();
  await resolver.resolve();

  assert.equal(calls, 1);
});

test("auto mode propagates a geolocation failure as a rejected promise", async () => {
  const resolver = new LocationResolver(
    () => ({ locationMode: "auto", manualLocation: null }),
    null,
    throwingIpClient("network unreachable")
  );

  await assert.rejects(() => resolver.resolve(), /network unreachable/);
});
