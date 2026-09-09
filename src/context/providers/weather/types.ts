/** A resolved geographic location a forecast was fetched for. */
export interface WeatherLocation {
  latitude: number;
  longitude: number;
  /** Human-readable label, e.g. "Covilhã, Portugal" or a manual "lat, lon" pair. */
  label: string;
  /** How this location was determined. */
  source: "auto" | "manual";
}

/** One day of forecast, e.g. today or tomorrow. */
export interface DailyForecast {
  /** ISO calendar date, e.g. "2026-09-08". */
  date: string;
  highC: number;
  lowC: number;
  condition: string;
  precipitationProbabilityPercent: number | null;
}

/** Structured weather data as exposed through the Context system. */
export interface WeatherContext {
  location: WeatherLocation;
  temperatureC: number;
  apparentTemperatureC: number | null;
  condition: string;
  conditionCode: number;
  precipitationProbabilityPercent: number | null;
  todayHighC: number | null;
  todayLowC: number | null;
  /** Upcoming days including today, ordered chronologically. */
  forecast: DailyForecast[];
  /** ISO timestamp of when this data was fetched from the weather service. */
  retrievedAt: string;
}
