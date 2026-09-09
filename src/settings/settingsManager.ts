import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { Routine } from "../routines/types";

/**
 * Persisted NIMBUS state, split by who owns the data — not just grouped
 * for convenience. This distinction matters for the multi-device
 * direction described in the architecture: `UserPreferences` is data
 * that conceptually belongs to the user, not to this particular
 * installation, and should follow them to a future Android/web client
 * (eventually via a shared backend). `WindowsClientSettings` is state
 * that only makes sense for a Windows desktop window and has no
 * equivalent on another platform.
 *
 * Both still live in one local JSON file today — there is no sync
 * backend yet, and building one is out of scope until it's actually
 * needed. What matters now is that the *type boundary* already exists,
 * so introducing sync later means adding a transport for
 * `UserPreferences`, not re-deciding what counts as "core" data.
 */

/** Windows-desktop-only state: window chrome and this device's launch behavior. */
export interface WindowsClientSettings {
  windowBounds: {
    width: number;
    height: number;
  };
  startup: StartupSettings;
}

export interface StartupSettings {
  /** Register NIMBUS as a Windows login item (Settings > Apps > Startup). */
  launchWithWindows: boolean;
  /** If true, the main window stays hidden on launch — NIMBUS starts in the tray only. */
  startMinimized: boolean;
}

export interface ManualLocation {
  latitude: number;
  longitude: number;
  label: string;
}

export interface WeatherSettings {
  /** "auto" resolves location via IP geolocation; "manual" uses `manualLocation`. */
  locationMode: "auto" | "manual";
  manualLocation: ManualLocation | null;
}

export interface CalendarFeed {
  id: string;
  /** User-facing name, e.g. "Work", "Personal". */
  label: string;
  /**
   * The feed's ICS URL (or local file path). Treated as a credential —
   * never logged, never sent to the renderer/UI beyond what a settings
   * form needs to let the user edit it locally.
   */
  address: string;
  enabled: boolean;
}

export interface CalendarSettings {
  /** Master on/off switch — calendar awareness is opt-in. */
  enabled: boolean;
  feeds: CalendarFeed[];
}

export interface EmailAccount {
  id: string;
  /** User-facing name, e.g. "Work", "Personal". */
  label: string;
  host: string;
  port: number;
  /** Use TLS (IMAPS). */
  secure: boolean;
  username: string;
  /**
   * An app password or account password. Treated as a credential —
   * never logged, and unlike `CalendarFeed.address`, never sent back to
   * the renderer at all (write-only from the Settings form's point of
   * view) — see `nimbus:get-email-settings` in lifecycle.ts.
   */
  password: string;
  /** Per-account override of the recent-messages window, in days. 0 = use the global default. */
  sinceDays: number;
  enabled: boolean;
}

export interface EmailSettings {
  /** Master on/off switch — email awareness is opt-in. */
  enabled: boolean;
  accounts: EmailAccount[];
  /** Default "recent" window in days, used when an account doesn't override it. */
  defaultSinceDays: number;
}

export interface TaskAccount {
  id: string;
  /** User-facing name, e.g. "Personal", "Work". */
  label: string;
  /** Which connector this account uses — only "todoist" exists today, kept explicit so a future provider can be added without changing this shape. */
  provider: "todoist";
  /**
   * A personal API token from the source app. Treated as a credential —
   * never logged, and like `EmailAccount.password`, never sent back to
   * the renderer at all (write-only from the Settings form's point of
   * view) — see `nimbus:get-task-settings` in lifecycle.ts.
   */
  apiToken: string;
  enabled: boolean;
}

export interface TaskSettings {
  /** Master on/off switch — task awareness is opt-in. */
  enabled: boolean;
  accounts: TaskAccount[];
}

export interface SpotifySettings {
  /** Master on/off switch — Spotify awareness/control is opt-in. */
  enabled: boolean;
  /**
   * Optional device id to prefer when starting playback (from Spotify's
   * own device list — see the Context tab's Spotify data). Falls back to
   * the user's currently active device when null. Not a credential.
   */
  preferredDeviceId: string | null;
}

export interface RoutineSettings {
  /**
   * Master on/off switch for context-aware suggestions — gates whether
   * the desktop activity monitor runs at all. Off by default: NIMBUS
   * should not be watching running processes/window titles/open folders
   * unless the user has actually opted into Routines (see "Privacy" in
   * README's Routines section).
   */
  enabled: boolean;
  routines: Routine[];
}

/**
 * User-owned preferences — conceptually part of NIMBUS Core's user data,
 * not tied to any one device. Not yet synced anywhere; see module doc.
 */
export interface UserPreferences {
  weather: WeatherSettings;
  calendar: CalendarSettings;
  email: EmailSettings;
  tasks: TaskSettings;
  spotify: SpotifySettings;
  routines: RoutineSettings;
}

export interface NimbusSettings {
  windowsClient: WindowsClientSettings;
  userPreferences: UserPreferences;
}

export const DEFAULT_SETTINGS: NimbusSettings = {
  windowsClient: {
    windowBounds: {
      width: 1000,
      height: 700,
    },
    startup: {
      launchWithWindows: false,
      startMinimized: false,
    },
  },
  userPreferences: {
    weather: {
      locationMode: "auto",
      manualLocation: null,
    },
    calendar: {
      enabled: false,
      feeds: [],
    },
    email: {
      enabled: false,
      accounts: [],
      defaultSinceDays: 2,
    },
    tasks: {
      enabled: false,
      accounts: [],
    },
    spotify: {
      enabled: false,
      preferredDeviceId: null,
    },
    routines: {
      enabled: false,
      routines: [],
    },
  },
};

function getSettingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/**
 * Settings files written before this module split `NimbusSettings` into
 * `windowsClient`/`userPreferences` have `windowBounds`/`startup`/`weather`
 * at the top level instead. Without this, an existing install's saved
 * preferences (e.g. "launch with Windows") would silently reset to
 * defaults the first time it loads under the new shape.
 */
function migrateLegacyShape(parsed: any): any {
  if (parsed.windowsClient || parsed.userPreferences) {
    return parsed; // already current shape
  }
  if (!parsed.windowBounds && !parsed.startup && !parsed.weather) {
    return parsed; // not a recognizable legacy shape either — let defaults apply
  }

  logger.info("Migrating settings.json from pre-split legacy shape");
  return {
    windowsClient: {
      windowBounds: parsed.windowBounds,
      startup: parsed.startup,
    },
    userPreferences: {
      weather: parsed.weather,
    },
  };
}

export function loadSettings(): NimbusSettings {
  const filePath = getSettingsFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = migrateLegacyShape(JSON.parse(raw));
      return {
        windowsClient: {
          ...DEFAULT_SETTINGS.windowsClient,
          ...parsed.windowsClient,
          windowBounds: {
            ...DEFAULT_SETTINGS.windowsClient.windowBounds,
            ...parsed.windowsClient?.windowBounds,
          },
          startup: {
            ...DEFAULT_SETTINGS.windowsClient.startup,
            ...parsed.windowsClient?.startup,
          },
        },
        userPreferences: {
          ...DEFAULT_SETTINGS.userPreferences,
          ...parsed.userPreferences,
          weather: {
            ...DEFAULT_SETTINGS.userPreferences.weather,
            ...parsed.userPreferences?.weather,
          },
          calendar: {
            ...DEFAULT_SETTINGS.userPreferences.calendar,
            ...parsed.userPreferences?.calendar,
          },
          email: {
            ...DEFAULT_SETTINGS.userPreferences.email,
            ...parsed.userPreferences?.email,
          },
          tasks: {
            ...DEFAULT_SETTINGS.userPreferences.tasks,
            ...parsed.userPreferences?.tasks,
          },
          spotify: {
            ...DEFAULT_SETTINGS.userPreferences.spotify,
            ...parsed.userPreferences?.spotify,
          },
          routines: {
            ...DEFAULT_SETTINGS.userPreferences.routines,
            ...parsed.userPreferences?.routines,
          },
        },
      };
    }
  } catch (err) {
    logger.warn("Failed to read settings.json, falling back to defaults", {
      error: String(err),
    });
  }
  return structuredClone(DEFAULT_SETTINGS);
}

/**
 * Writes settings atomically: serialize to a temp file in the same
 * directory, flush it to disk, then `rename` over the real one (an
 * atomic replace on NTFS as long as both paths share a volume, which a
 * sibling temp file always does).
 *
 * A plain `writeFileSync` to the real path truncates it first, so a
 * crash or power loss mid-write leaves a half-written file. `loadSettings`
 * cannot tell that from corruption — it catches the parse error and
 * falls back to defaults, silently discarding every routine, account and
 * credential the user had configured. The rename dance means the real
 * file is only ever the old complete version or the new complete one.
 */
export function saveSettings(settings: NimbusSettings): void {
  const filePath = getSettingsFilePath();
  const tempPath = `${filePath}.tmp`;
  try {
    const serialized = JSON.stringify(settings, null, 2);
    // Written through an explicit fd so the contents can be fsync'd before
    // the rename — without that, the rename can land ahead of the data on
    // a crash, which produces exactly the empty/truncated file this is
    // meant to prevent.
    const fd = fs.openSync(tempPath, "w");
    try {
      fs.writeFileSync(fd, serialized, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    logger.error("Failed to write settings.json", { error: String(err) });
    // Never leave a stray temp file behind to be mistaken for real state.
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best effort — the write already failed and was logged above.
    }
  }
}
