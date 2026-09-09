import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../contextService";
import { TaskProvider } from "./taskProvider";
import { DateTimeProvider } from "../dateTimeProvider";
import { SystemInfoProvider } from "../systemInfoProvider";
import { WeatherProvider } from "../weather/weatherProvider";
import { LocationResolver } from "../weather/locationResolver";
import { OpenMeteoClient } from "../weather/openMeteoClient";
import { CalendarProvider } from "../calendar/calendarProvider";
import { EmailProvider } from "../email/emailProvider";
import { BriefingGenerator } from "../../../briefing/briefingGenerator";

/**
 * End-to-end check of the exact scenario the task calls out: a Tasks
 * failure (bad token, service down, rate-limited, whatever) must never
 * affect DateTimeProvider, WeatherProvider, CalendarProvider,
 * EmailProvider, SystemInfoProvider, or briefing generation. Registers a
 * real ContextService with all of them, including a deliberately broken
 * TaskProvider, and asserts the failure is fully contained.
 */
test("a failing TaskProvider degrades to an error result without affecting any other provider or briefing generation", async () => {
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

  // Calendar and Email both left disabled — legitimate "unavailable"
  // states, distinct from broken, that should also be unaffected by tasks
  // failing.
  service.register(new CalendarProvider(() => ({ enabled: false, feeds: [] })));
  service.register(new EmailProvider(() => ({ enabled: false, accounts: [], defaultSinceDays: 2 })));

  const brokenTasks = new TaskProvider(
    () => ({
      enabled: true,
      accounts: [{ id: "broken", label: "Broken", provider: "todoist", apiToken: "secret-token", enabled: true }],
    }),
    // A stub source that fails immediately — this test is about failure
    // containment, not real Todoist API behavior (that's
    // todoistTaskSource.test.ts), and must never touch the network.
    () =>
      ({
        fetchActiveTasks: async () => {
          throw new Error("Invalid token (simulated)");
        },
      }) as never
  );
  service.register(brokenTasks);

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.providers.tasks.status, "error");
  assert.equal(snapshot.providers.tasks.data, null);

  assert.equal(snapshot.providers.dateTime.status, "ok");
  assert.equal(snapshot.providers.system.status, "ok");
  assert.equal(snapshot.providers.weather.status, "ok");
  assert.equal(snapshot.providers.calendar.status, "unavailable");
  assert.equal(snapshot.providers.email.status, "unavailable");

  // And the briefing itself still generates cleanly — tasks simply omitted.
  const briefing = new BriefingGenerator("en-US").generate(snapshot, new Date(2026, 8, 9, 8, 0, 0));
  assert.ok(briefing.items.length > 0);
  assert.equal(briefing.items[0].category, "greeting");
  assert.ok(!briefing.items.some((item) => item.category === "tasks"));
});
