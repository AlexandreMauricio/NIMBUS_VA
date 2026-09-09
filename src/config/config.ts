import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

/**
 * Environment-driven configuration.
 * Values come from process environment variables (optionally loaded from a
 * ".env" file at the project root). This is for deployment/runtime concerns
 * (log level, environment name, etc.) — NOT for user-facing preferences,
 * which live in the settings module instead.
 */

const envPath = path.resolve(__dirname, "..", "..", ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

export type LogLevel = "error" | "warn" | "info" | "debug";
export type AppEnv = "development" | "production";

export interface ManualLocationConfig {
  latitude: number;
  longitude: number;
  label: string;
}

export interface CalendarFeedConfig {
  label: string;
  address: string;
}

export interface EmailAccountConfig {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface TaskAccountConfig {
  label: string;
  apiToken: string;
}

export interface SpotifyConfig {
  /**
   * The Client ID of a Spotify Developer app the user has registered
   * themselves (https://developer.spotify.com/dashboard) — not a secret
   * (Spotify's Authorization Code + PKCE flow, which NIMBUS uses, never
   * needs a client secret at all), but still not something to hardcode: a
   * shared NIMBUS-wide app would let every install collide on the same
   * rate limits/quota and would need its redirect URI to match every
   * user's machine. See README's "Spotify" section for setup steps.
   */
  clientId: string | null;
  /** Loopback port the local OAuth redirect listener binds during the auth flow — must match the redirect URI registered in the user's Spotify app. */
  redirectPort: number;
}

export interface NimbusConfig {
  logLevel: LogLevel;
  appEnv: AppEnv;
  /**
   * Optional manual location sourced from the environment, e.g. for
   * headless/dev use without going through Settings. Only used when
   * weather's location mode is "manual" and no location has been saved
   * in settings yet — see src/context/providers/weather/locationResolver.ts.
   */
  weatherManualLocation: ManualLocationConfig | null;
  /**
   * Optional default calendar feed sourced from the environment, e.g. for
   * headless/dev use without going through Settings. Only used when no
   * feeds have been saved in settings yet — see
   * src/context/providers/calendar/calendarProvider.ts and
   * src/main/lifecycle.ts.
   */
  calendarFeed: CalendarFeedConfig | null;
  /**
   * Optional default email account sourced from the environment, e.g. for
   * headless/dev use without going through Settings. Only used when
   * email is enabled but no account has been saved in settings yet — see
   * src/context/providers/email/emailProvider.ts and src/main/lifecycle.ts.
   * The password is read from the environment the same way — never
   * written to source, never logged.
   */
  emailAccount: EmailAccountConfig | null;
  /**
   * Optional default task account sourced from the environment, e.g. for
   * headless/dev use without going through Settings. Only used when tasks
   * are enabled but no account has been saved in settings yet — see
   * src/context/providers/tasks/taskProvider.ts and src/main/lifecycle.ts.
   * The API token is read from the environment the same way — never
   * written to source, never logged.
   */
  taskAccount: TaskAccountConfig | null;
  /** Spotify app registration info — see SpotifyConfig's own doc comment. Never a secret; the client ID alone is not sensitive, but is still kept out of source. */
  spotify: SpotifyConfig;
}

function readLogLevel(): LogLevel {
  const value = (process.env.NIMBUS_LOG_LEVEL || "info").toLowerCase();
  if (value === "error" || value === "warn" || value === "info" || value === "debug") {
    return value;
  }
  return "info";
}

function readAppEnv(): AppEnv {
  return process.env.NIMBUS_ENV === "production" ? "production" : "development";
}

function readWeatherManualLocation(): ManualLocationConfig | null {
  const lat = process.env.NIMBUS_WEATHER_LAT;
  const lon = process.env.NIMBUS_WEATHER_LON;
  if (!lat || !lon) return null;

  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    latitude,
    longitude,
    label: process.env.NIMBUS_WEATHER_LOCATION_LABEL || `${latitude}, ${longitude}`,
  };
}

function readCalendarFeed(): CalendarFeedConfig | null {
  const address = process.env.NIMBUS_CALENDAR_ICS_URL;
  if (!address) return null;

  return {
    address,
    label: process.env.NIMBUS_CALENDAR_LABEL || "Calendar",
  };
}

function readEmailAccount(): EmailAccountConfig | null {
  const host = process.env.NIMBUS_EMAIL_HOST;
  const username = process.env.NIMBUS_EMAIL_USERNAME;
  const password = process.env.NIMBUS_EMAIL_PASSWORD;
  if (!host || !username || !password) return null;

  const port = Number(process.env.NIMBUS_EMAIL_PORT || "993");
  const secure = (process.env.NIMBUS_EMAIL_SECURE ?? "true").toLowerCase() !== "false";

  return {
    label: process.env.NIMBUS_EMAIL_LABEL || "Email",
    host,
    port: Number.isFinite(port) ? port : 993,
    secure,
    username,
    password,
  };
}

function readTaskAccount(): TaskAccountConfig | null {
  const apiToken = process.env.NIMBUS_TASKS_TODOIST_TOKEN;
  if (!apiToken) return null;

  return {
    apiToken,
    label: process.env.NIMBUS_TASKS_LABEL || "Tasks",
  };
}

function readSpotifyConfig(): SpotifyConfig {
  const port = Number(process.env.NIMBUS_SPOTIFY_REDIRECT_PORT || "8888");
  return {
    clientId: process.env.NIMBUS_SPOTIFY_CLIENT_ID || null,
    redirectPort: Number.isFinite(port) ? port : 8888,
  };
}

export const config: NimbusConfig = {
  logLevel: readLogLevel(),
  appEnv: readAppEnv(),
  weatherManualLocation: readWeatherManualLocation(),
  calendarFeed: readCalendarFeed(),
  emailAccount: readEmailAccount(),
  taskAccount: readTaskAccount(),
  spotify: readSpotifyConfig(),
};
