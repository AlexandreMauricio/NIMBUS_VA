import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../contextService";
import { WeatherProvider } from "./weatherProvider";
import { LocationResolver } from "./locationResolver";
import { DateTimeProvider } from "../dateTimeProvider";

/**
 * End-to-end check of the exact scenario the task calls out: "if
 * WeatherProvider eventually fails, NIMBUS should still function
 * normally." Registers WeatherProvider into a real ContextService
 * alongside another provider and asserts the failure is contained.
 */
test("a failing WeatherProvider degrades to an error result without affecting other providers or throwing", async () => {
  const service = new ContextService();
  service.register(new DateTimeProvider(() => new Date(2024, 0, 1)));

  const brokenResolver = {
    resolve: async () => {
      throw new Error("weather service unreachable");
    },
  } as unknown as LocationResolver;
  service.register(new WeatherProvider(brokenResolver));

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.weather.status, "error");
  assert.equal(snapshot.providers.weather.data, null);
  assert.match(snapshot.providers.weather.error ?? "", /weather service unreachable/);

  assert.equal(snapshot.providers.dateTime.status, "ok");
});
