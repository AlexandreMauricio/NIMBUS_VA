import { TtlCache } from "../../../common/ttlCache";
import { IpGeolocationClient } from "./ipGeolocation";
import { WeatherLocation } from "./types";

export interface WeatherLocationSettings {
  locationMode: "auto" | "manual";
  manualLocation: { latitude: number; longitude: number; label: string } | null;
}

const AUTO_LOCATION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — location rarely changes

/**
 * Resolves the location weather should be fetched for, per the
 * "automatic vs manual" configuration described in the settings/config.
 *
 * - "manual": uses the saved manual location; if none is saved yet, falls
 *   back to an environment-configured default (see config.ts /
 *   NIMBUS_WEATHER_LAT/LON) so headless/dev setups work without the UI.
 * - "auto": resolves via IP geolocation, cached for an hour so NIMBUS
 *   doesn't re-locate on every context request.
 *
 * Settings are read through a getter (not a snapshot) so this always sees
 * the latest saved preference, including changes made after startup.
 */
export class LocationResolver {
  private readonly autoCache = new TtlCache<Omit<WeatherLocation, "source">>(
    AUTO_LOCATION_CACHE_TTL_MS
  );

  constructor(
    private readonly getSettings: () => WeatherLocationSettings,
    private readonly envFallback: { latitude: number; longitude: number; label: string } | null,
    private readonly ipClient: IpGeolocationClient = new IpGeolocationClient()
  ) {}

  async resolve(): Promise<WeatherLocation> {
    const settings = this.getSettings();

    if (settings.locationMode === "manual") {
      const manual = settings.manualLocation ?? this.envFallback;
      if (!manual) {
        throw new Error(
          "Manual location mode is selected but no location is configured. " +
            "Set one in Settings, or NIMBUS_WEATHER_LAT/NIMBUS_WEATHER_LON in .env."
        );
      }
      return { ...manual, source: "manual" };
    }

    const cached = this.autoCache.get();
    if (cached) {
      return { ...cached, source: "auto" };
    }

    const located = await this.ipClient.locate();
    this.autoCache.set(located);
    return { ...located, source: "auto" };
  }
}
