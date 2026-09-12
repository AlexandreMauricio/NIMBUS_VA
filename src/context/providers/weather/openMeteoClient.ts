import { WeatherLocation, DailyForecast, WeatherContext } from "./types";
import { describeWeatherCode } from "./weatherCodes";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
import { httpTimeoutSignal } from "../../../common/timeout";
// A week: the Weather tab shows it; everything else reads only today.
const FORECAST_DAYS = 7;

interface OpenMeteoResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

/**
 * Open-Meteo is a free weather API that requires no API key/credentials —
 * see https://open-meteo.com. If NIMBUS ever needs a different provider
 * that does require one, read it via `config.ts` (env-var backed) the
 * same way `weatherManualLocation` is read there, and fail with a clear
 * "missing credentials" error from `fetchForecast` — the ContextService
 * already turns a thrown error into a graceful "unavailable" result.
 */
export class OpenMeteoClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetchForecast(
    location: Pick<WeatherLocation, "latitude" | "longitude">
  ): Promise<Omit<WeatherContext, "location">> {
    const url = new URL(FORECAST_URL);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code");
    url.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    );
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", String(FORECAST_DAYS));

    const response = await this.fetchFn(url.toString(), { signal: httpTimeoutSignal() });
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed with status ${response.status}`);
    }

    const body = (await response.json()) as OpenMeteoResponse;
    return mapResponse(body);
  }
}

function mapResponse(body: OpenMeteoResponse): Omit<WeatherContext, "location"> {
  const forecast: DailyForecast[] = body.daily.time.map((date, i) => ({
    date,
    highC: body.daily.temperature_2m_max[i],
    lowC: body.daily.temperature_2m_min[i],
    condition: describeWeatherCode(body.daily.weather_code[i]),
    precipitationProbabilityPercent: body.daily.precipitation_probability_max[i] ?? null,
  }));

  const today = forecast[0];

  return {
    temperatureC: body.current.temperature_2m,
    apparentTemperatureC: body.current.apparent_temperature ?? null,
    condition: describeWeatherCode(body.current.weather_code),
    conditionCode: body.current.weather_code,
    precipitationProbabilityPercent: today?.precipitationProbabilityPercent ?? null,
    todayHighC: today?.highC ?? null,
    todayLowC: today?.lowC ?? null,
    forecast,
    retrievedAt: new Date().toISOString(),
  };
}
