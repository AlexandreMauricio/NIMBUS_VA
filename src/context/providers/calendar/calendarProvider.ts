import { ContextProvider } from "../../types";
import { TtlCache } from "../../../common/ttlCache";
import { logger } from "../../../logging/logger";
import { IcsCalendarSource } from "./icsCalendarSource";
import { parseIcs } from "./icsParser";
import { localTimeZone, localCalendarDate, addDaysToDateString, zonedTimeToUtcMs } from "./icsTimeUtils";
import { CalendarContext, CalendarEvent } from "./types";

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes — calendars don't change that often
const NEAR_EVENT_CACHE_TTL_MS = 2 * 60 * 1000; // refresh sooner once something is imminent
const IMMINENT_WINDOW_MS = 60 * 60 * 1000; // "imminent" = within an hour
const LOOKAHEAD_DAYS = 7; // how far ahead "laterEvents" looks
/**
 * How far ahead the Calendar tab's list looks. Separate from
 * LOOKAHEAD_DAYS on purpose: the briefing and Attention reason about the
 * coming week, and must not start counting next month's events, but a
 * calendar you open to look at should show what's actually coming.
 */
const UPCOMING_DAYS = 90;
const MAX_UPCOMING_EVENTS = 100;

export interface CalendarFeedConfig {
  id: string;
  label: string;
  /** URL (http/https) or local file path — treated as a credential, never logged. */
  address: string;
  enabled: boolean;
}

/** What CalendarProvider needs from settings — structurally matches `CalendarSettings` in settingsManager.ts. */
export interface CalendarProviderConfig {
  enabled: boolean;
  feeds: CalendarFeedConfig[];
}

/**
 * Context provider for the user's calendar(s). Implements the same
 * ContextProvider contract as every other provider — ContextService,
 * IPC, and the UI treat it identically, with no calendar-specific
 * handling anywhere outside this module and briefingGenerator.ts.
 *
 * Unlike weather, `isAvailable()` is a real, cheap check here: calendar
 * awareness is opt-in (nothing is fetched, and no feed URL needs to
 * exist, until the user enables it and adds at least one feed). This
 * means "not configured yet" surfaces as `status: "unavailable"` rather
 * than `status: "error"` — a calmer, more accurate signal than pretending
 * a fetch was attempted and failed.
 *
 * Multiple feeds are fetched independently (Promise.allSettled): one bad
 * feed (wrong URL, revoked link, network blip) never blocks the others —
 * only if *every* enabled feed fails does this throw, which
 * ContextService then turns into the standard error/stale-fallback
 * result.
 */
export class CalendarProvider implements ContextProvider<CalendarContext> {
  readonly id = "calendar";
  readonly displayName = "Calendar";

  private readonly cache: TtlCache<CalendarContext>;

  constructor(
    private readonly getSettings: () => CalendarProviderConfig,
    private readonly sourceFactory: (address: string) => IcsCalendarSource = (address) =>
      new IcsCalendarSource(address),
    private readonly now: () => Date = () => new Date(),
    cacheClock: () => number = Date.now,
    /**
     * Optional default feed sourced from the environment (see
     * config.ts's `calendarFeed`), used only when calendar is enabled but
     * no feed has been saved yet — headless/dev convenience, same role
     * as weather's `weatherManualLocation` env fallback.
     */
    private readonly envFallbackFeed: { label: string; address: string } | null = null
  ) {
    this.cache = new TtlCache(DEFAULT_CACHE_TTL_MS, cacheClock);
  }

  /** Convenience constructor for real usage — production wiring only needs `getSettings` + the env fallback. */
  static withDefaults(
    getSettings: () => CalendarProviderConfig,
    envFallbackFeed: { label: string; address: string } | null = null
  ): CalendarProvider {
    return new CalendarProvider(getSettings, undefined, undefined, undefined, envFallbackFeed);
  }

  isAvailable(): boolean {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    return this.effectiveFeeds(settings).length > 0;
  }

  async getContext(): Promise<CalendarContext> {
    const cached = this.cache.get();
    if (cached) return cached;

    const settings = this.getSettings();
    const enabledFeeds = this.effectiveFeeds(settings);
    if (enabledFeeds.length === 0) {
      // isAvailable() should have prevented this, but guard anyway —
      // ContextService treats a thrown getContext() as a normal failure.
      throw new Error("Calendar is enabled but no feeds are configured");
    }

    const timezone = localTimeZone();
    const now = this.now();

    const results = await Promise.allSettled(
      enabledFeeds.map((feed) => this.fetchFeedEvents(feed, timezone))
    );

    const allEvents: CalendarEvent[] = [];
    let successCount = 0;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        successCount++;
        allEvents.push(...result.value);
      } else {
        // Never log the feed address (it's a credential) — label/id only.
        logger.warn(`Calendar feed "${enabledFeeds[i].label}" failed`, {
          feedId: enabledFeeds[i].id,
          error: String(result.reason),
        });
      }
    });

    if (successCount === 0) {
      throw new Error("All configured calendar feeds failed to load");
    }

    const context = buildContext(allEvents, timezone, now);

    const ttl = isImminent(context.nextEvent, now) ? NEAR_EVENT_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
    this.cache.set(context, ttl);

    return context;
  }

  private effectiveFeeds(settings: CalendarProviderConfig): CalendarFeedConfig[] {
    const enabledFeeds = settings.feeds.filter((feed) => feed.enabled);
    if (enabledFeeds.length > 0 || !this.envFallbackFeed) return enabledFeeds;
    return [
      {
        id: "env-default",
        label: this.envFallbackFeed.label,
        address: this.envFallbackFeed.address,
        enabled: true,
      },
    ];
  }

  private async fetchFeedEvents(feed: CalendarFeedConfig, timezone: string): Promise<CalendarEvent[]> {
    const source = this.sourceFactory(feed.address);
    const raw = await source.fetchRaw();
    const parsed = parseIcs(raw, timezone);

    if (parsed.skippedCount > 0) {
      logger.debug(`Calendar feed "${feed.label}" had unparseable events`, {
        feedId: feed.id,
        skippedCount: parsed.skippedCount,
      });
    }

    const calendarName = feed.label || parsed.calendarName;
    return parsed.events.map((event) => ({
      id: event.uid,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      isAllDay: event.isAllDay,
      location: event.location,
      calendarName,
    }));
  }
}

function isImminent(nextEvent: CalendarEvent | null, now: Date): boolean {
  if (!nextEvent) return false;
  const msUntil = new Date(nextEvent.startsAt).getTime() - now.getTime();
  return msUntil >= 0 && msUntil <= IMMINENT_WINDOW_MS;
}

function buildContext(events: CalendarEvent[], timezone: string, now: Date): CalendarContext {
  const todayDate = localCalendarDate(now.toISOString(), timezone);
  const lookaheadEndDate = addDaysToDateString(todayDate, LOOKAHEAD_DAYS);

  const todayEvents = events
    .filter((event) => overlapsLocalDate(event, todayDate, timezone))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const laterEvents = events
    .filter((event) => {
      const eventDate = localCalendarDate(event.startsAt, timezone);
      return eventDate > todayDate && eventDate <= lookaheadEndDate;
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const upcomingEndDate = addDaysToDateString(todayDate, UPCOMING_DAYS);
  const upcomingEvents = events
    .filter((event) => {
      const eventDate = localCalendarDate(event.startsAt, timezone);
      return eventDate > todayDate && eventDate <= upcomingEndDate;
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, MAX_UPCOMING_EVENTS);

  const nowMs = now.getTime();
  const nextEvent =
    [...todayEvents, ...laterEvents]
      .filter((event) => new Date(event.startsAt).getTime() > nowMs)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;

  return {
    retrievedAt: now.toISOString(),
    timezone,
    todayEvents,
    laterEvents,
    upcomingEvents,
    nextEvent,
  };
}

function overlapsLocalDate(event: CalendarEvent, dateStr: string, timezone: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayStartMs = zonedTimeToUtcMs({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timezone);
  const nextDateStr = addDaysToDateString(dateStr, 1);
  const [ny, nm, nd] = nextDateStr.split("-").map(Number);
  const dayEndMs = zonedTimeToUtcMs(
    { year: ny, month: nm, day: nd, hour: 0, minute: 0, second: 0 },
    timezone
  );

  const eventStartMs = new Date(event.startsAt).getTime();
  const eventEndMs = new Date(event.endsAt).getTime();
  return eventStartMs < dayEndMs && eventEndMs > dayStartMs;
}
