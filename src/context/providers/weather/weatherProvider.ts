import { ContextProvider } from "../../types";
import { TtlCache } from "../../../common/ttlCache";
import { LocationResolver } from "./locationResolver";
import { OpenMeteoClient } from "./openMeteoClient";
import { WeatherContext } from "./types";

const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — avoid hammering the API

/**
 * Context provider for current/local weather. Implements the same
 * ContextProvider contract as DateTimeProvider/SystemInfoProvider, so the
 * rest of NIMBUS (ContextService, IPC, UI) treats it identically — nothing
 * downstream needs to know weather involves a network call, a location
 * lookup, or an external service at all.
 *
 * `isAvailable()` is always true: weather is a capability NIMBUS always
 * *attempts*, not one that's cheaply pre-checkable (unlike, say, "is this
 * OS feature present"). A failed attempt (bad network, geolocation down,
 * no location configured) is surfaced as a normal thrown error, which
 * ContextService turns into a structured "error"/stale result — so NIMBUS
 * degrades gracefully rather than pretending it has weather data.
 */
export class WeatherProvider implements ContextProvider<WeatherContext> {
  readonly id = "weather";
  readonly displayName = "Weather";

  private readonly cache: TtlCache<WeatherContext>;

  constructor(
    private readonly locationResolver: LocationResolver,
    private readonly weatherClient: OpenMeteoClient = new OpenMeteoClient(),
    cacheTtlMs: number = WEATHER_CACHE_TTL_MS,
    now: () => number = Date.now
  ) {
    this.cache = new TtlCache(cacheTtlMs, now);
  }

  isAvailable(): boolean {
    return true;
  }

  async getContext(): Promise<WeatherContext> {
    const cached = this.cache.get();
    if (cached) return cached;

    const location = await this.locationResolver.resolve();
    const data = await this.weatherClient.fetchForecast(location);
    const context: WeatherContext = { location, ...data };

    this.cache.set(context);
    return context;
  }
}
