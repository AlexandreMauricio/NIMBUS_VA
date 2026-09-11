import { localCalendarDate, localTimeZone } from "../context/providers/calendar/icsTimeUtils";
import { logger } from "../logging/logger";
import { detectActivity } from "./activityDetector";
import { ActivityMapping } from "./types";

/**
 * Which programs the user keeps using that aren't an activity yet — the
 * basis for "You use Halo a lot. Make it an activity?".
 *
 * Opt-in (`ActivitySettings.suggestFrequentApps`, off by default), and
 * deliberately coarse: per program, only its name, the Windows description
 * ("Halo Infinite"), minutes with a window open per day for the last two
 * weeks, and when it was last opened. Never window titles, never anything
 * inside the program. Programs without a window (background processes) are
 * never seen at all — the monitor only reports windowed ones here.
 *
 * It suggests nothing by itself: the Attention engine reads `candidates()`
 * and decides whether and how to ask. Saying "Not now" once snoozes an app
 * for a week; twice, and NIMBUS never asks about it again.
 */

/** A program worth asking about. */
export interface FrequentApp {
  /** Lowercased executable name, e.g. "haloinfinite.exe". */
  executable: string;
  /** What to call it: its Windows description, or the executable without ".exe". */
  name: string;
  /** Days in the last week it had a window open. */
  daysUsed: number;
  /** Minutes with a window open in the last week. */
  minutesUsed: number;
  /** It opened a moment ago and is still open — the natural moment to ask. */
  justOpened: boolean;
}

interface AppRecord {
  name: string | null;
  /** "YYYY-MM-DD" → minutes with a window open that day. */
  dayMinutes: Record<string, number>;
  lastOpenedAt: string | null;
  declines: number;
  snoozedUntil: string | null;
  never: boolean;
}

export interface AppUsageState {
  apps: Record<string, AppRecord>;
}

export interface AppUsageStateStore {
  load(): AppUsageState;
  save(state: AppUsageState): void;
}

/** Opened on at least this many of the last seven days… */
export const FREQUENT_DAYS = 3;
/** …or used for at least this long in them. */
export const FREQUENT_MINUTES = 5 * 60;
const WINDOW_DAYS = 7;
/** Day-by-day usage is kept this long, then dropped. */
const KEEP_DAYS = 14;
export const SNOOZE_DAYS = 7;
/** Declines after which an app is never suggested again. */
export const MAX_DECLINES = 2;
/** "Just opened" means within this long, and still open. */
const JUST_OPENED_MS = 2 * 60_000;
/** A gap between two polls longer than this (sleep, the monitor paused) counts only this much. */
const MAX_POLL_GAP_MS = 60_000;
const MAX_APPS = 200;
const SAVE_EVERY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Windows' own shell windows, NIMBUS itself, and browsers (which are
 * better matched by the site they show — see website activities).
 */
export const IGNORED_APPS: ReadonlySet<string> = new Set([
  "explorer.exe",
  "electron.exe",
  "nimbus.exe",
  "applicationframehost.exe",
  "textinputhost.exe",
  "systemsettings.exe",
  "shellexperiencehost.exe",
  "startmenuexperiencehost.exe",
  "searchhost.exe",
  "searchapp.exe",
  "lockapp.exe",
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
]);

function emptyRecord(): AppRecord {
  return { name: null, dayMinutes: {}, lastOpenedAt: null, declines: 0, snoozedUntil: null, never: false };
}

export class AppUsageTracker {
  private state: AppUsageState = { apps: {} };
  /** Programs with a window on the latest poll. */
  private present = new Set<string>();
  private lastObservedAtMs: number | null = null;
  private lastSavedAtMs = -Infinity;
  private dirty = false;

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly getMappings: () => ActivityMapping[],
    private readonly now: () => Date = () => new Date(),
    private readonly store?: AppUsageStateStore,
    private readonly timeZone: () => string = localTimeZone
  ) {
    if (!store) return;
    try {
      const loaded = store.load();
      if (loaded && typeof loaded.apps === "object" && loaded.apps) this.state = loaded;
    } catch (err) {
      logger.warn("Could not read app usage — starting fresh", { error: String(err) });
    }
  }

  /**
   * One poll's windowed programs. Called by the desktop monitor every few
   * seconds; records nothing while the feature is off.
   */
  observe(windowed: Array<{ executable: string; description: string | null }>): void {
    if (!this.isEnabled()) {
      this.present.clear();
      this.lastObservedAtMs = null;
      return;
    }
    const now = this.now();
    const nowMs = now.getTime();
    const today = localCalendarDate(now.toISOString(), this.timeZone());
    const gapMs =
      this.lastObservedAtMs === null
        ? 0
        : Math.min(Math.max(0, nowMs - this.lastObservedAtMs), MAX_POLL_GAP_MS);

    const current = new Set<string>();
    for (const app of windowed) {
      const executable = app.executable.toLowerCase();
      if (!executable || IGNORED_APPS.has(executable) || current.has(executable)) continue;
      current.add(executable);
      let record = this.state.apps[executable];
      if (!record) {
        if (Object.keys(this.state.apps).length >= MAX_APPS) continue;
        record = emptyRecord();
        this.state.apps[executable] = record;
      }
      if (app.description) record.name = app.description;
      record.dayMinutes[today] =
        (record.dayMinutes[today] ?? 0) + (this.present.has(executable) ? gapMs / 60_000 : 0);
      if (!this.present.has(executable)) record.lastOpenedAt = now.toISOString();
      this.dirty = true;
    }
    this.present = current;
    this.lastObservedAtMs = nowMs;
    this.prune(nowMs);
    if (this.dirty && nowMs - this.lastSavedAtMs >= SAVE_EVERY_MS) this.save(nowMs);
  }

  /** Programs used often enough to ask about, that aren't an activity, snoozed or declined for good. */
  candidates(): FrequentApp[] {
    if (!this.isEnabled()) return [];
    const now = this.now();
    const nowMs = now.getTime();
    const since = this.dayKey(nowMs - (WINDOW_DAYS - 1) * DAY_MS);
    const mappings = this.getMappings().map((m) => ({ ...m, enabled: true }));
    const result: FrequentApp[] = [];
    for (const [executable, record] of Object.entries(this.state.apps)) {
      if (record.never) continue;
      if (record.snoozedUntil && Date.parse(record.snoozedUntil) > nowMs) continue;
      if (this.isAlreadyAnActivity(executable, mappings)) continue;
      const recent = Object.entries(record.dayMinutes).filter(([day]) => day >= since);
      const daysUsed = recent.length;
      const minutesUsed = Math.round(recent.reduce((sum, [, minutes]) => sum + minutes, 0));
      if (daysUsed < FREQUENT_DAYS && minutesUsed < FREQUENT_MINUTES) continue;
      const justOpened =
        this.present.has(executable) &&
        record.lastOpenedAt !== null &&
        nowMs - Date.parse(record.lastOpenedAt) <= JUST_OPENED_MS;
      result.push({
        executable,
        name: record.name ?? executable.replace(/\.exe$/, ""),
        daysUsed,
        minutesUsed,
        justOpened,
      });
    }
    return result.sort((a, b) => b.daysUsed - a.daysUsed || b.minutesUsed - a.minutesUsed);
  }

  /** "Not now": a week's rest the first time; never again the second. */
  decline(executable: string): void {
    const record = this.state.apps[executable.toLowerCase()];
    if (!record) return;
    record.declines += 1;
    if (record.declines >= MAX_DECLINES) record.never = true;
    else record.snoozedUntil = new Date(this.now().getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
    this.save(this.now().getTime());
  }

  /** "Yes": the editor opens; if no activity is saved after all, it may be offered again in a week. */
  accept(executable: string): void {
    const record = this.state.apps[executable.toLowerCase()];
    if (!record) return;
    record.snoozedUntil = new Date(this.now().getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
    this.save(this.now().getTime());
  }

  /** Writes anything not yet saved — called on shutdown. */
  flush(): void {
    if (this.dirty) this.save(this.now().getTime());
  }

  private isAlreadyAnActivity(executable: string, mappings: ActivityMapping[]): boolean {
    return (
      detectActivity(
        {
          id: "app-usage-check",
          type: "applicationOpened",
          occurredAt: this.now().toISOString(),
          source: "appUsage",
          executableName: executable,
          windowTitle: null,
          activation: "launched",
        },
        mappings
      ) !== null
    );
  }

  private dayKey(ms: number): string {
    return localCalendarDate(new Date(ms).toISOString(), this.timeZone());
  }

  private prune(nowMs: number): void {
    const oldest = this.dayKey(nowMs - (KEEP_DAYS - 1) * DAY_MS);
    for (const [executable, record] of Object.entries(this.state.apps)) {
      for (const day of Object.keys(record.dayMinutes)) {
        if (day < oldest) {
          delete record.dayMinutes[day];
          this.dirty = true;
        }
      }
      // Nothing left to remember about it, and no answer to keep.
      if (
        Object.keys(record.dayMinutes).length === 0 &&
        record.declines === 0 &&
        !this.present.has(executable)
      ) {
        delete this.state.apps[executable];
        this.dirty = true;
      }
    }
  }

  private save(nowMs: number): void {
    this.lastSavedAtMs = nowMs;
    this.dirty = false;
    if (!this.store) return;
    try {
      this.store.save(this.state);
    } catch (err) {
      logger.warn("Could not save app usage", { error: String(err) });
    }
  }
}
