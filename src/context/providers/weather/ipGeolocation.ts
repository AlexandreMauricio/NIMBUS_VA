import { httpTimeoutSignal } from "../../../common/timeout";
import { WeatherLocation } from "./types";

const GEOLOCATION_URL = "https://get.geojs.io/v1/ip/geo.json";

interface GeoJsResponse {
  latitude: string;
  longitude: string;
  city?: string;
  country?: string;
}

/**
 * Resolves an approximate location from the machine's public IP address.
 * Free, no API key. This is the "automatic location" strategy — coarse
 * (city-level) accuracy, which is appropriate for weather.
 */
export class IpGeolocationClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async locate(): Promise<Omit<WeatherLocation, "source">> {
    const response = await this.fetchFn(GEOLOCATION_URL, { signal: httpTimeoutSignal() });
    if (!response.ok) {
      throw new Error(`IP geolocation request failed with status ${response.status}`);
    }

    const body = (await response.json()) as GeoJsResponse;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("IP geolocation response did not contain valid coordinates");
    }

    const label = [body.city, body.country].filter(Boolean).join(", ") || "Current location";

    return { latitude, longitude, label };
  }
}
