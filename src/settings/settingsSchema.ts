import { migrateRoutineActivities } from "./activityMigration";
import { Routine } from "../routines/types";
import { ActivityMapping, DEFAULT_ACTIVITY_GRACE_MINUTES } from "../activity/types";
import { StockPosition } from "../context/providers/stocks/types";
import type { AttentionSettings } from "../attention/types";
import type { DividendTaxSetting } from "../context/providers/stocks/dividends";
import type { ClosedPosition } from "../context/providers/stocks/closed";
import type { IrsSettings } from "../context/providers/stocks/irs";

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
   * docs/routines.md).
   */
  enabled: boolean;
  routines: Routine[];
}

/**
 * Activity detection: what counts as which activity, and how forgiving
 * NIMBUS is about an application closing. Off by default — like
 * Routines, NIMBUS should not be interpreting what the user is doing
 * until they ask it to.
 */
export interface ActivityPreferences {
  enabled: boolean;
  mappings: ActivityMapping[];
  graceMinutes: number;
  /** Opt-in "make it an activity?" suggestions for programs used often (see src/activity/appUsage.ts). */
  suggestFrequentApps?: boolean;
}

/**
 * Stock tracking: positions the user entered by hand. Plain user data —
 * no credential is involved (the market-data source needs no key), and
 * nothing here connects to a brokerage.
 */
export interface StockPreferences {
  enabled: boolean;
  /** Whether headlines are fetched for a position when it is opened. */
  newsEnabled: boolean;
  /** Currency every position is converted into for the single portfolio total. Three-letter code. */
  baseCurrency: string;
  /** Whether dividend history is fetched and shown. */
  dividendsEnabled: boolean;
  /** Per-symbol tax country choices; a symbol not listed uses the country guessed from its listing. */
  dividendTax: Record<string, DividendTaxSetting>;
  /** Sales already made at the broker, recorded by the user. */
  closedPositions: ClosedPosition[];
  /** Codes the IRS helper uses for closed positions. */
  irs: IrsSettings;
  positions: StockPosition[];
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
  activity: ActivityPreferences;
  stocks: StockPreferences;
  /** The Attention engine's two switches (see src/attention/). */
  attention: AttentionSettings;
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
    activity: {
      enabled: false,
      mappings: [],
      graceMinutes: DEFAULT_ACTIVITY_GRACE_MINUTES,
      suggestFrequentApps: false,
    },
    attention: { enabled: true, popups: true },
    stocks: {
      enabled: true,
      newsEnabled: true,
      baseCurrency: "EUR",
      dividendsEnabled: true,
      dividendTax: {},
      closedPositions: [],
      irs: { gainsCode: "G30", counterpartyCountry: "196" },
      positions: [],
    },
  },
};

/**
 * Settings files written before this module split `NimbusSettings` into
 * `windowsClient`/`userPreferences` have `windowBounds`/`startup`/`weather`
 * at the top level instead. Without this, an existing install's saved
 * preferences (e.g. "launch with Windows") would silently reset to
 * defaults the first time it loads under the new shape.
 */
export function migrateLegacyShape(parsed: any): any {
  if (parsed.windowsClient || parsed.userPreferences) {
    return parsed; // already current shape
  }
  if (!parsed.windowBounds && !parsed.startup && !parsed.weather) {
    return parsed; // not a recognizable legacy shape either — let defaults apply
  }

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

/** True when `migrateLegacyShape` would actually rewrite this object, so the caller can log it once. */
export function isLegacyShape(parsed: any): boolean {
  if (parsed.windowsClient || parsed.userPreferences) return false;
  return Boolean(parsed.windowBounds || parsed.startup || parsed.weather);
}

/**
 * Fills a parsed settings object out with defaults, one group at a time.
 * Per-group merging (rather than a single top-level spread) is what lets
 * a settings file written by an older NIMBUS — one that predates, say,
 * the `tasks` group entirely — pick up the new group's defaults instead
 * of ending up with `undefined` where code expects an object.
 *
 * Defaults are deep-cloned first. Spreading `DEFAULT_SETTINGS` directly
 * copies its *references* — so a group the saved file didn't override
 * (e.g. `email.accounts: []`) handed the caller the very array hanging
 * off the module-level default. Pushing an account onto loaded settings
 * then mutated the defaults themselves for the rest of the process, and
 * the next load inherited it.
 */
export function applyDefaults(parsed: any): NimbusSettings {
  const defaults = structuredClone(DEFAULT_SETTINGS);
  // Before the merge, so a file written by a NIMBUS that kept activities
  // on routines is read as though it had always kept them separately.
  migrateRoutineActivities(parsed);
  return {
    windowsClient: {
      ...defaults.windowsClient,
      ...parsed.windowsClient,
      windowBounds: {
        ...defaults.windowsClient.windowBounds,
        ...parsed.windowsClient?.windowBounds,
      },
      startup: {
        ...defaults.windowsClient.startup,
        ...parsed.windowsClient?.startup,
      },
    },
    userPreferences: {
      ...defaults.userPreferences,
      ...parsed.userPreferences,
      weather: {
        ...defaults.userPreferences.weather,
        ...parsed.userPreferences?.weather,
      },
      calendar: {
        ...defaults.userPreferences.calendar,
        ...parsed.userPreferences?.calendar,
      },
      email: {
        ...defaults.userPreferences.email,
        ...parsed.userPreferences?.email,
      },
      tasks: {
        ...defaults.userPreferences.tasks,
        ...parsed.userPreferences?.tasks,
      },
      spotify: {
        ...defaults.userPreferences.spotify,
        ...parsed.userPreferences?.spotify,
      },
      routines: {
        ...defaults.userPreferences.routines,
        ...parsed.userPreferences?.routines,
      },
      activity: {
        ...defaults.userPreferences.activity,
        ...parsed.userPreferences?.activity,
      },
      attention: {
        ...defaults.userPreferences.attention,
        ...parsed.userPreferences?.attention,
      },
      stocks: {
        ...defaults.userPreferences.stocks,
        ...parsed.userPreferences?.stocks,
        dividendTax: { ...parsed.userPreferences?.stocks?.dividendTax },
        closedPositions: [...(parsed.userPreferences?.stocks?.closedPositions ?? [])],
        irs: { ...defaults.userPreferences.stocks.irs, ...parsed.userPreferences?.stocks?.irs },
      },
    },
  };
}

/**
 * Credentials live in an encrypted store (see src/main/secretStore.ts),
 * not in settings.json — but every consumer above this module (providers,
 * IPC handlers, the Settings UI) still wants a plain `NimbusSettings`
 * with the real values in place. These two functions are the seam: a
 * credential is stripped out on the way to disk and put back on the way
 * in, so nothing else in NIMBUS has to know the split exists.
 *
 * Keys are derived from the account id, which is stable for an account's
 * lifetime, so renaming or reconfiguring an account never orphans its
 * credential.
 */
export function emailPasswordKey(accountId: string): string {
  return `email.${accountId}.password`;
}

export function taskApiTokenKey(accountId: string): string {
  return `tasks.${accountId}.apiToken`;
}

/**
 * Splits settings into the plaintext part that goes to settings.json and
 * the credentials that go to the encrypted store. The returned settings
 * object is a deep-enough copy that blanking credentials never mutates
 * the live in-memory settings the rest of the app is still holding.
 */
export function extractSecrets(settings: NimbusSettings): {
  sanitized: NimbusSettings;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};

  // Every account gets a key, even one with no value. An empty value
  // says "this account still exists, it just has no readable credential"
  // — which is how the store tells a value it failed to decrypt (keep it)
  // from an account that was removed (delete it). See SecretStore.writeAll.
  const emailAccounts = settings.userPreferences.email.accounts.map((account) => {
    secrets[emailPasswordKey(account.id)] = account.password ?? "";
    return { ...account, password: "" };
  });

  const taskAccounts = settings.userPreferences.tasks.accounts.map((account) => {
    secrets[taskApiTokenKey(account.id)] = account.apiToken ?? "";
    return { ...account, apiToken: "" };
  });

  return {
    sanitized: {
      ...settings,
      userPreferences: {
        ...settings.userPreferences,
        email: { ...settings.userPreferences.email, accounts: emailAccounts },
        tasks: { ...settings.userPreferences.tasks, accounts: taskAccounts },
      },
    },
    secrets,
  };
}

/**
 * Puts stored credentials back into a settings object read from disk.
 *
 * A settings.json written by an older NIMBUS still has its credentials
 * inline; those are kept as-is when the store has nothing for that
 * account, which is what makes the migration automatic — the value
 * survives this load, and the next save moves it into the encrypted
 * store and strips it from settings.json. An account with neither ends
 * up with an empty string, exactly as if it were never configured.
 */
export function restoreSecrets(settings: NimbusSettings, secrets: Record<string, string>): NimbusSettings {
  return {
    ...settings,
    userPreferences: {
      ...settings.userPreferences,
      email: {
        ...settings.userPreferences.email,
        accounts: settings.userPreferences.email.accounts.map((account) => ({
          ...account,
          password: secrets[emailPasswordKey(account.id)] ?? account.password ?? "",
        })),
      },
      tasks: {
        ...settings.userPreferences.tasks,
        accounts: settings.userPreferences.tasks.accounts.map((account) => ({
          ...account,
          apiToken: secrets[taskApiTokenKey(account.id)] ?? account.apiToken ?? "",
        })),
      },
    },
  };
}

/** True when a settings object read from disk still carries plaintext credentials from a pre-SecretStore install. */
export function hasInlineCredentials(settings: NimbusSettings): boolean {
  return (
    settings.userPreferences.email.accounts.some((a) => Boolean(a.password)) ||
    settings.userPreferences.tasks.accounts.some((a) => Boolean(a.apiToken))
  );
}
