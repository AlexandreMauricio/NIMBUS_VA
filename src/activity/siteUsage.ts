import { localCalendarDate, localTimeZone } from "../context/providers/calendar/icsTimeUtils";
import { logger } from "../logging/logger";
import { detectActivity } from "./activityDetector";
import { ActivityMapping } from "./types";
import type { UsageEntry } from "./appUsage";

/**
 * The website counterpart of appUsage.ts — "You use YouTube a lot. Make it
 * an activity?". Browsers are left out of the app tally (every site would
 * be "Chrome"), so sites are counted here, from the browser window titles
 * the desktop monitor already reads.
 *
 * NIMBUS never sees addresses, only titles, so a site is known by the name
 * it puts in its title — by convention the last part: "Inbox (3) - … -
 * Gmail", "Pull requests · user/repo · GitHub", "(12) Some video -
 * YouTube". Only that last part is kept, never the whole title; parts that
 * look like an email address, a number or a blank tab are ignored.
 *
 * Same rules as apps: opt-in (the same switch), minutes per day for two
 * weeks, suggests nothing by itself — Attention reads `candidates()` —
 * and "Not now" twice means never again.
 */

/** A site worth asking about — the same shape Attention reads for apps. */
export interface FrequentSite {
  /** Lowercased site name: the key it is counted under. */
  executable: string;
  /** The site name as it appears in titles, e.g. "YouTube". */
  name: string;
  daysUsed: number;
  minutesUsed: number;
  justOpened: boolean;
  source: "website";
}

interface SiteRecord {
  name: string;
  dayMinutes: Record<string, number>;
  lastOpenedAt: string | null;
  declines: number;
  snoozedUntil: string | null;
  never: boolean;
}

export interface SiteUsageState {
  sites: Record<string, SiteRecord>;
}

export interface SiteUsageStateStore {
  load(): unknown;
  save(state: SiteUsageState): void;
}

export const SITE_FREQUENT_DAYS = 3;
export const SITE_FREQUENT_MINUTES = 5 * 60;
const WINDOW_DAYS = 7;
const KEEP_DAYS = 14;
const SNOOZE_DAYS = 7;
const MAX_DECLINES = 2;
const JUST_OPENED_MS = 2 * 60_000;
const MAX_POLL_GAP_MS = 60_000;
const MAX_SITES = 300;
const MAX_NAME_LENGTH = 40;
const SAVE_EVERY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The browser's own name, which browsers append to every title. */
const BROWSER_SUFFIX = /\s[-–—]\s(?:google chrome|microsoft\S?\s?edge|mozilla firefox|firefox|brave|opera)$/i;
/** Edge's extra title parts: "… and 3 more pages - Personal - Microsoft Edge". */
// Default profile names in the languages NIMBUS is used in (Portuguese
// Windows titles them "Pessoal" and "Perfil 1").
const EDGE_PROFILE =
  /\s[-–—]\s(?:personal|work|profile \d+|pessoal|trabalho|perfil \d+|trabajo|personnel|travail|profil \d+|persönlich|arbeit)$/i;
const EDGE_MORE_PAGES = /\s+and \d+ more pages?$/i;
/** Where sites separate the page from their name. Deliberately not ":" — too common inside names. */
const SEPARATOR = /\s[-|–—·•]\s/;
/** Titles that are the browser itself, not a site. */
const NOT_A_SITE = new Set([
  "new tab",
  "nova guia",
  "nova aba",
  "novo separador",
  "nueva pestaña",
  "nouvel onglet",
  "neuer tab",
  "nuova scheda",
  // Search results pages are a search engine, not something you do.
  "google search",
  "pesquisa google",
  "pesquisa do google",
  "búsqueda de google",
  "bing",
  "duckduckgo",
  // NIMBUS never suggests itself.
  "nimbus",
  "new private tab",
  "inprivate",
  "private browsing",
  "start",
  "home",
  "untitled",
  "blank page",
  "about:blank",
  "settings",
  "downloads",
  "history",
  "extensions",
]);

/**
 * The site name in a browser window title, or null. Pure — see the module
 * comment for the convention it relies on. A heuristic: a site that puts
 * its name first, or not at all, is counted under whatever comes last.
 */
export function siteFromTitle(title: string): string | null {
  // Edge puts a zero-width space inside "Microsoft Edge".
  let text = title.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  text = text.replace(BROWSER_SUFFIX, "");
  text = text.replace(EDGE_PROFILE, "").replace(EDGE_MORE_PAGES, "");
  const parts = text.split(SEPARATOR);
  const last = (parts[parts.length - 1] ?? "").replace(/^\(\d+\+?\)\s*/, "").trim();
  if (last.length < 2 || last.length > MAX_NAME_LENGTH) return null;
  if (last.includes("@")) return null;
  // A tab still loading is titled with its address ("youtube.com/watch?v=…"):
  // that is a URL, and NIMBUS keeps no addresses.
  if (/^[a-z]+:\/\//i.test(last) || /^[\w-]+(\.[\w-]+)+\//.test(last)) return null;
  if (/^[\d\s.,:%()+-]+$/.test(last)) return null;
  if (NOT_A_SITE.has(last.toLowerCase())) return null;
  return last;
}

function emptyRecord(name: string): SiteRecord {
  return { name, dayMinutes: {}, lastOpenedAt: null, declines: 0, snoozedUntil: null, never: false };
}

/** A persisted state, checked record by record — anything malformed is dropped. */
function parseState(raw: unknown): SiteUsageState {
  const sites: SiteUsageState["sites"] = {};
  const input = raw && typeof raw === "object" ? (raw as { sites?: unknown }).sites : null;
  if (!input || typeof input !== "object") return { sites };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const r = value as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.dayMinutes || typeof r.dayMinutes !== "object") continue;
    const dayMinutes: Record<string, number> = {};
    for (const [day, minutes] of Object.entries(r.dayMinutes as Record<string, unknown>)) {
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        typeof minutes === "number" &&
        Number.isFinite(minutes) &&
        minutes >= 0
      ) {
        dayMinutes[day] = minutes;
      }
    }
    sites[key] = {
      name: r.name.slice(0, MAX_NAME_LENGTH),
      dayMinutes,
      lastOpenedAt: typeof r.lastOpenedAt === "string" ? r.lastOpenedAt : null,
      declines: typeof r.declines === "number" ? r.declines : 0,
      snoozedUntil: typeof r.snoozedUntil === "string" ? r.snoozedUntil : null,
      never: r.never === true,
    };
  }
  return { sites };
}

export class SiteUsageTracker {
  private state: SiteUsageState = { sites: {} };
  private present = new Set<string>();
  private lastObservedAtMs: number | null = null;
  private lastSavedAtMs = -Infinity;
  private dirty = false;

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly getMappings: () => ActivityMapping[],
    private readonly now: () => Date = () => new Date(),
    private readonly store?: SiteUsageStateStore,
    private readonly timeZone: () => string = localTimeZone
  ) {
    if (!store) return;
    try {
      this.state = parseState(store.load());
    } catch (err) {
      logger.warn("Could not read site usage — starting fresh", { error: String(err) });
    }
  }

  /** One poll's browser windows. Records nothing while the feature is off. */
  observe(browserWindows: Array<{ executable: string; title: string }>): void {
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
    for (const window of browserWindows) {
      const name = siteFromTitle(window.title ?? "");
      if (!name) continue;
      const key = name.toLowerCase();
      if (current.has(key)) continue;
      current.add(key);
      let record = this.state.sites[key];
      if (!record) {
        if (Object.keys(this.state.sites).length >= MAX_SITES) continue;
        record = emptyRecord(name);
        this.state.sites[key] = record;
      }
      record.name = name;
      record.dayMinutes[today] =
        (record.dayMinutes[today] ?? 0) + (this.present.has(key) ? gapMs / 60_000 : 0);
      if (!this.present.has(key)) record.lastOpenedAt = now.toISOString();
      this.dirty = true;
    }
    this.present = current;
    this.lastObservedAtMs = nowMs;
    this.prune(nowMs);
    if (this.dirty && nowMs - this.lastSavedAtMs >= SAVE_EVERY_MS) this.save(nowMs);
  }

  /** Sites used often enough to ask about, that aren't an activity, snoozed or declined for good. */
  candidates(): FrequentSite[] {
    if (!this.isEnabled()) return [];
    const nowMs = this.now().getTime();
    const since = this.dayKey(nowMs - (WINDOW_DAYS - 1) * DAY_MS);
    const mappings = this.getMappings().map((m) => ({ ...m, enabled: true }));
    const result: FrequentSite[] = [];
    for (const [key, record] of Object.entries(this.state.sites)) {
      if (record.never) continue;
      if (record.snoozedUntil && Date.parse(record.snoozedUntil) > nowMs) continue;
      if (this.isAlreadyAnActivity(record.name, mappings)) continue;
      const recent = Object.entries(record.dayMinutes).filter(([day]) => day >= since);
      const daysUsed = recent.length;
      const minutesUsed = Math.round(recent.reduce((sum, [, minutes]) => sum + minutes, 0));
      if (daysUsed < SITE_FREQUENT_DAYS && minutesUsed < SITE_FREQUENT_MINUTES) continue;
      const justOpened =
        this.present.has(key) &&
        record.lastOpenedAt !== null &&
        nowMs - Date.parse(record.lastOpenedAt) <= JUST_OPENED_MS;
      result.push({
        executable: key,
        name: record.name,
        daysUsed,
        minutesUsed,
        justOpened,
        source: "website",
      });
    }
    return result.sort((a, b) => b.daysUsed - a.daysUsed || b.minutesUsed - a.minutesUsed);
  }

  /** Everything counted in the last 7 days, whether or not it would be suggested. */
  usage(): UsageEntry[] {
    const nowMs = this.now().getTime();
    const since = this.dayKey(nowMs - (WINDOW_DAYS - 1) * DAY_MS);
    const mappings = this.getMappings().map((m) => ({ ...m, enabled: true }));
    const result: UsageEntry[] = [];
    for (const [key, record] of Object.entries(this.state.sites)) {
      const days = Object.fromEntries(Object.entries(record.dayMinutes).filter(([day]) => day >= since));
      const daysUsed = Object.keys(days).length;
      if (!daysUsed) continue;
      const minutesUsed = Math.round(Object.values(days).reduce((sum, m) => sum + m, 0));
      result.push({
        key,
        name: record.name,
        source: "website",
        days,
        daysUsed,
        minutesUsed,
        status: this.isAlreadyAnActivity(record.name, mappings)
          ? "activity"
          : record.never
            ? "declined"
            : record.snoozedUntil && Date.parse(record.snoozedUntil) > nowMs
              ? "snoozed"
              : daysUsed >= SITE_FREQUENT_DAYS || minutesUsed >= SITE_FREQUENT_MINUTES
                ? "candidate"
                : "counting",
      });
    }
    return result.sort((a, b) => b.minutesUsed - a.minutesUsed);
  }

  /** "Not now": a week's rest the first time; never again the second. */
  decline(key: string): void {
    const record = this.state.sites[key.toLowerCase()];
    if (!record) return;
    record.declines += 1;
    if (record.declines >= MAX_DECLINES) record.never = true;
    else record.snoozedUntil = new Date(this.now().getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
    this.save(this.now().getTime());
  }

  /** "Yes": the editor opens; if no activity is saved after all, it may be offered again in a week. */
  accept(key: string): void {
    const record = this.state.sites[key.toLowerCase()];
    if (!record) return;
    record.snoozedUntil = new Date(this.now().getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
    this.save(this.now().getTime());
  }

  /** Away from the PC: the time until you're back isn't counted (see AppUsageTracker.pause). */
  pause(): void {
    this.lastObservedAtMs = null;
  }

  flush(): void {
    if (this.dirty) this.save(this.now().getTime());
  }

  /** A website activity that would already match a title carrying this site name. */
  private isAlreadyAnActivity(name: string, mappings: ActivityMapping[]): boolean {
    return (
      detectActivity(
        {
          id: "site-usage-check",
          type: "websiteOpened",
          occurredAt: this.now().toISOString(),
          source: "siteUsage",
          browserExecutable: "",
          windowTitle: name,
          url: null,
          domain: null,
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
    for (const [key, record] of Object.entries(this.state.sites)) {
      for (const day of Object.keys(record.dayMinutes)) {
        if (day < oldest) {
          delete record.dayMinutes[day];
          this.dirty = true;
        }
      }
      if (Object.keys(record.dayMinutes).length === 0 && record.declines === 0 && !this.present.has(key)) {
        delete this.state.sites[key];
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
      logger.warn("Could not save site usage", { error: String(err) });
    }
  }
}
