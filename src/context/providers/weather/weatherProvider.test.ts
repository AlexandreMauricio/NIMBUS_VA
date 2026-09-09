import { test } from "node:test";
import assert from "node:assert/strict";
import { WeatherProvider } from "./weatherProvider";
import { LocationResolver } from "./locationResolver";
import { OpenMeteoClient } from "./openMeteoClient";
import { WeatherContext } from "./types";

const SAMPLE_LOCATION = { latitude: 38.7, longitude: -9.1, label: "Lisbon", source: "manual" as const };

function stubLocationResolver(): LocationResolver {
  return { resolve: async () => SAMPLE_LOCATION } as unknown as LocationResolver;
}

function stubWeatherClient(callCounter: { count: number }): OpenMeteoClient {
  return {
    fetchForecast: async () => {
      callCounter.count++;
      return {
        temperatureC: 20,
        apparentTemperatureC: 19,
        condition: "Clear sky",
        conditionCode: 0,
        precipitationProbabilityPercent: 0,
        todayHighC: 25,
        todayLowC: 15,
        forecast: [],
        retrievedAt: new Date().toISOString(),
      } satisfies Omit<WeatherContext, "location">;
    },
  } as unknown as OpenMeteoClient;
}

test("is always available", () => {
  const provider = new WeatherProvider(stubLocationResolver());
  assert.equal(provider.isAvailable(), true);
});

test("getContext returns structured data including the resolved location", async () => {
  const provider = new WeatherProvider(stubLocationResolver(), stubWeatherClient({ count: 0 }));
  const ctx = await provider.getContext();

  assert.equal(ctx.location.label, "Lisbon");
  assert.equal(ctx.temperatureC, 20);
  assert.equal(ctx.condition, "Clear sky");
});

test("caches results within the TTL instead of re-fetching", async () => {
  const counter = { count: 0 };
  let now = 0;
  const provider = new WeatherProvider(
    stubLocationResolver(),
    stubWeatherClient(counter),
    10_000, // 10s TTL
    () => now
  );

  await provider.getContext();
  now += 5_000; // still within TTL
  await provider.getContext();

  assert.equal(counter.count, 1);
});

test("re-fetches once the cache TTL has elapsed", async () => {
  const counter = { count: 0 };
  let now = 0;
  const provider = new WeatherProvider(stubLocationResolver(), stubWeatherClient(counter), 10_000, () => now);

  await provider.getContext();
  now += 20_000; // past TTL
  await provider.getContext();

  assert.equal(counter.count, 2);
});

test("a location resolution failure rejects getContext (for ContextService to catch)", async () => {
  const failingResolver = {
    resolve: async () => {
      throw new Error("no location configured");
    },
  } as unknown as LocationResolver;
  const provider = new WeatherProvider(failingResolver, stubWeatherClient({ count: 0 }));

  await assert.rejects(() => provider.getContext(), /no location configured/);
});

test("a weather API failure rejects getContext (for ContextService to catch)", async () => {
  const failingClient = {
    fetchForecast: async () => {
      throw new Error("API unreachable");
    },
  } as unknown as OpenMeteoClient;
  const provider = new WeatherProvider(stubLocationResolver(), failingClient);

  await assert.rejects(() => provider.getContext(), /API unreachable/);
});
