import { httpTimeoutSignal } from "../../../common/timeout";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 100;

/** One place a name search found, ready to become a manual weather location. */
export interface PlaceResult {
  name: string;
  /** State/region, when the geocoder knows one. */
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  /** "Lisbon, Lisbon, Portugal" with repeats and blanks removed — what the Settings list shows and what gets saved as the label. */
  label: string;
}

interface OpenMeteoPlace {
  name?: unknown;
  admin1?: unknown;
  country?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

/**
 * City search for the manual weather location, through Open-Meteo's free
 * geocoding API — the same service as the forecast, no key needed. Only
 * the typed place name is sent.
 */
export class GeocodingClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async searchPlaces(query: unknown): Promise<PlaceResult[]> {
    const name =
      typeof query === "string" ? query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH) : "";
    // The API needs at least two characters to match anything.
    if (name.length < 2) return [];

    const url = new URL(GEOCODING_URL);
    url.searchParams.set("name", name);
    url.searchParams.set("count", String(MAX_RESULTS));
    url.searchParams.set("format", "json");

    const response = await this.fetchFn(url.toString(), { signal: httpTimeoutSignal() });
    if (!response.ok) {
      throw new Error(`Place search failed with status ${response.status}`);
    }
    const body = (await response.json()) as { results?: unknown };
    return Array.isArray(body.results) ? body.results.flatMap((r) => toPlace(r as OpenMeteoPlace)) : [];
  }
}

function toPlace(raw: OpenMeteoPlace): PlaceResult[] {
  const name = text(raw.name);
  const { latitude, longitude } = raw;
  if (!name || typeof latitude !== "number" || typeof longitude !== "number") return [];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const region = text(raw.admin1);
  const country = text(raw.country);
  const label = [name, region, country]
    .filter((part, i, parts): part is string => !!part && parts.indexOf(part) === i)
    .join(", ");
  return [{ name, region, country, latitude, longitude, label }];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
