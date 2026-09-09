import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../contextService";
import { EmailProvider } from "./emailProvider";
import { DateTimeProvider } from "../dateTimeProvider";
import { SystemInfoProvider } from "../systemInfoProvider";
import { WeatherProvider } from "../weather/weatherProvider";
import { LocationResolver } from "../weather/locationResolver";
import { OpenMeteoClient } from "../weather/openMeteoClient";
import { CalendarProvider } from "../calendar/calendarProvider";
import { BriefingGenerator } from "../../../briefing/briefingGenerator";

/**
 * End-to-end check of the exact scenario the task calls out: an Email
 * failure (bad credentials, server down, rate-limited, whatever) must
 * never affect DateTimeProvider, WeatherProvider, CalendarProvider,
 * SystemInfoProvider, or briefing generation. Registers a real
 * ContextService with all of them, including a deliberately broken
 * EmailProvider, and asserts the failure is fully contained.
 */
test("a failing EmailProvider degrades to an error result without affecting any other provider or briefing generation", async () => {
  const service = new ContextService();

  service.register(new DateTimeProvider(() => new Date(2026, 8, 9, 8, 0, 0), "en-US"));
  service.register(new SystemInfoProvider());

  const stubLocationResolver = {
    resolve: async () => ({ latitude: 38.7, longitude: -9.1, label: "Lisbon", source: "manual" as const }),
  } as unknown as LocationResolver;
  const stubWeatherClient = {
    fetchForecast: async () => ({
      temperatureC: 20,
      apparentTemperatureC: 19,
      condition: "Clear sky",
      conditionCode: 0,
      precipitationProbabilityPercent: 0,
      todayHighC: 25,
      todayLowC: 15,
      forecast: [],
      retrievedAt: new Date().toISOString(),
    }),
  } as unknown as OpenMeteoClient;
  service.register(new WeatherProvider(stubLocationResolver, stubWeatherClient));

  // Calendar left disabled — a legitimate "unavailable" state, distinct
  // from broken, that should also be unaffected by email failing.
  service.register(new CalendarProvider(() => ({ enabled: false, feeds: [] })));

  const brokenEmail = new EmailProvider(
    () => ({
      enabled: true,
      accounts: [
        {
          id: "broken",
          label: "Broken",
          host: "imap.example.com",
          port: 993,
          secure: true,
          username: "me@example.com",
          password: "secret",
          sinceDays: 0,
          enabled: true,
        },
      ],
      defaultSinceDays: 2,
    }),
    // A stub source that fails immediately — this test is about failure
    // containment, not real IMAP behavior (that's imapEmailSource.test.ts),
    // and must never touch the network.
    () =>
      ({
        fetchRecentMessages: async () => {
          throw new Error("Authentication failed (simulated)");
        },
      }) as never
  );
  service.register(brokenEmail);

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.email.status, "error");
  assert.equal(snapshot.providers.email.data, null);

  assert.equal(snapshot.providers.dateTime.status, "ok");
  assert.equal(snapshot.providers.system.status, "ok");
  assert.equal(snapshot.providers.weather.status, "ok");
  assert.equal(snapshot.providers.calendar.status, "unavailable");

  // And the briefing itself still generates cleanly — email simply omitted.
  const briefing = new BriefingGenerator("en-US").generate(snapshot, new Date(2026, 8, 9, 8, 0, 0));
  assert.ok(briefing.items.length > 0);
  assert.equal(briefing.items[0].category, "greeting");
  assert.ok(!briefing.items.some((item) => item.category === "email"));
});
