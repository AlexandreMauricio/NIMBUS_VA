# Weather

NIMBUS's first *external* context provider —
[src/context/providers/weather/](../src/context/providers/weather/) — built
entirely on top of the [Context architecture](context-system.md). Nothing about
`ContextService` or the UI changed to add it.

- **Service**: [Open-Meteo](https://open-meteo.com) — free, **no API key
  required**. If NIMBUS ever needs a keyed provider instead, read the key
  through `config.ts` (env-var backed) the same way
  `weatherManualLocation` is read there, and let a missing key throw a
  descriptive error from the client — `ContextService` already turns that
  into a graceful "unavailable" result, so the "fail gracefully if
  credentials are missing" requirement falls out of the existing
  architecture rather than needing new code.
- **Data returned** ([types.ts](../src/context/providers/weather/types.ts)):
  current temperature, apparent (feels-like) temperature, condition
  (mapped from Open-Meteo's WMO weather code), today's precipitation
  probability, today's high/low, a 3-day forecast, the location used, and
  an `retrievedAt` timestamp of the underlying API call (separate from the
  provider result's own `timestamp`, which reflects when the context
  system asked).
- **Location** — configurable, not hard-coded
  ([locationResolver.ts](../src/context/providers/weather/locationResolver.ts)):
  - **Automatic** (default): resolves an approximate location from the
    machine's public IP via [geojs.io](https://www.geojs.io/) (also free,
    no key), cached for 1 hour since location rarely changes.
  - **Manual**: a fixed latitude/longitude/label, set from the Settings
    tab (**Weather location**) — where **Find a place** searches
    Open-Meteo's free geocoding API
    ([geocoding.ts](../src/context/providers/weather/geocoding.ts); only
    the typed name is sent) and picking a result saves it — or via
    `NIMBUS_WEATHER_LAT` /
    `NIMBUS_WEATHER_LON` / `NIMBUS_WEATHER_LOCATION_LABEL` in `.env` as a
    default for headless/dev use before any UI setting is saved. This is
    the "user can choose automatic vs. manual" system the task asked for;
    the mode itself is persisted in `NimbusSettings.weather.locationMode`.
- **Caching** — two independent layers, both via the generic
  [TtlCache](../src/common/ttlCache.ts):
  1. `WeatherProvider` itself caches a fetched `WeatherContext` for 10
     minutes, so repeated `getSnapshot()` calls (e.g. the UI's Refresh
     button, or a future polling loop) don't hit Open-Meteo unnecessarily.
  2. `LocationResolver` caches an auto-resolved IP location for 1 hour,
     independent of the weather-data cache.
- **Failure behavior**: `WeatherProvider.isAvailable()` is always `true`
  (weather isn't something cheaply pre-checkable, unlike a static OS
  feature flag) — a real failure (no network, geolocation service down,
  manual mode with nothing configured, Open-Meteo erroring) surfaces as a
  thrown error from `getContext()`. `ContextService` catches that exactly
  like any other provider: logs it, and returns `status: "error"` (falling
  back to the last successful weather data, marked `stale: true`, if one
  exists) — `dateTime` and `system` are entirely unaffected. NIMBUS never
  fabricates weather data it doesn't have.

## The Weather tab

In the sidebar's **Admin** group: the current conditions (temperature,
feels-like, today's high and low, rain chance, where and when it was
read) and a card per day for the week ahead, with a day's rain chance
highlighted from 50%. It reads the same weather result in the context
snapshot that the briefing and Attention use, so it costs no extra
request; **Refresh** re-reads the snapshot. The forecast is 7 days
(`FORECAST_DAYS`); everything else only reads today's.

## Tests

Weather-specific tests live alongside the other provider tests, run via
`npm test`: `geocoding.test.ts` (place labels, empty and malformed
results, short queries never sent, HTTP errors),
`openMeteoClient.test.ts` (response mapping, HTTP-failure
error message, unknown weather codes), `locationResolver.test.ts` (manual
mode, manual→env fallback, manual with nothing configured, auto mode,
auto-location caching, geolocation failure propagation),
`weatherProvider.test.ts` (availability, structured output, cache
hit/expiry using an injectable clock, failures propagating for
`ContextService` to catch), and `weatherProvider.integration.test.ts` —
the exact scenario from the task ("if WeatherProvider eventually fails,
NIMBUS should still function normally"), registering a failing
`WeatherProvider` into a real `ContextService` alongside `DateTimeProvider`
and asserting the failure is contained. All network calls are mocked via
an injected `fetch` — no test hits the real APIs.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
