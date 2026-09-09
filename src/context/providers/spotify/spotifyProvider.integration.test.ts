import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../contextService";
import { SpotifyContextProvider } from "./spotifyContextProvider";
import { SpotifyApiClient } from "./spotifyApiClient";
import { DateTimeProvider } from "../dateTimeProvider";
import { SystemInfoProvider } from "../systemInfoProvider";
import { WeatherProvider } from "../weather/weatherProvider";
import { LocationResolver } from "../weather/locationResolver";
import { OpenMeteoClient } from "../weather/openMeteoClient";
import { CalendarProvider } from "../calendar/calendarProvider";
import { EmailProvider } from "../email/emailProvider";
import { TaskProvider } from "../tasks/taskProvider";
import { BriefingGenerator } from "../../../briefing/briefingGenerator";
import { ActionService } from "../../../actions/actionService";
import { SpotifyActionProvider } from "../../../actions/providers/spotifyActionProvider";

/**
 * End-to-end check of the exact scenario the task calls out: a Spotify
 * failure (not authenticated, API down, whatever) must never affect
 * DateTimeProvider, WeatherProvider, CalendarProvider, EmailProvider,
 * TaskProvider, SystemInfoProvider, or briefing generation — and, new for
 * this task, executing a Spotify action while unavailable must degrade to
 * a structured ActionResult rather than throwing, exactly like a broken
 * Context provider degrades to an "error" snapshot entry.
 */
test("a failing/unavailable Spotify integration degrades gracefully without affecting any other provider, action execution, or briefing generation", async () => {
  const contextService = new ContextService();

  contextService.register(new DateTimeProvider(() => new Date(2026, 8, 9, 8, 0, 0), "en-US"));
  contextService.register(new SystemInfoProvider());

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
  contextService.register(new WeatherProvider(stubLocationResolver, stubWeatherClient));

  // Calendar, Email, and Tasks left disabled — legitimate "unavailable"
  // states, distinct from broken, that should also be unaffected by
  // Spotify failing.
  contextService.register(new CalendarProvider(() => ({ enabled: false, feeds: [] })));
  contextService.register(new EmailProvider(() => ({ enabled: false, accounts: [], defaultSinceDays: 2 })));
  contextService.register(new TaskProvider(() => ({ enabled: false, accounts: [] })));

  // A Spotify context provider that's "enabled" but whose API calls always
  // fail (simulating an expired/broken connection) — must never touch the
  // real network.
  const brokenSpotifyClient = {
    getCurrentPlayback: async () => {
      throw new Error("Authentication expired (simulated)");
    },
    play: async () => {
      throw new Error("Authentication expired (simulated)");
    },
    pause: async () => undefined,
    next: async () => undefined,
    previous: async () => undefined,
    setVolume: async () => undefined,
    search: async () => ({}),
  } as unknown as SpotifyApiClient;

  contextService.register(
    new SpotifyContextProvider(
      () => ({ enabled: true }),
      brokenSpotifyClient,
      () => true
    )
  );

  const snapshot = await contextService.getSnapshot();

  assert.equal(snapshot.providers.spotify.status, "error");
  assert.equal(snapshot.providers.spotify.data, null);

  assert.equal(snapshot.providers.dateTime.status, "ok");
  assert.equal(snapshot.providers.system.status, "ok");
  assert.equal(snapshot.providers.weather.status, "ok");
  assert.equal(snapshot.providers.calendar.status, "unavailable");
  assert.equal(snapshot.providers.email.status, "unavailable");
  assert.equal(snapshot.providers.tasks.status, "unavailable");

  // The briefing itself still generates cleanly — Spotify was never part
  // of the briefing to begin with (Context-vs-Action/Briefing scope), but
  // this proves its failure doesn't take the whole snapshot down either.
  const briefing = new BriefingGenerator("en-US").generate(snapshot, new Date(2026, 8, 9, 8, 0, 0));
  assert.ok(briefing.items.length > 0);
  assert.equal(briefing.items[0].category, "greeting");

  // And executing a Spotify action against the same broken client degrades
  // to a structured ActionResult instead of throwing or crashing anything.
  const actionService = new ActionService();
  actionService.register(
    new SpotifyActionProvider(
      brokenSpotifyClient,
      () => ({ enabled: true }),
      () => true
    )
  );

  const actionResult = await actionService.executeAction("spotify.play", {});
  assert.equal(actionResult.status, "failure");
  assert.ok(actionResult.error);
});
