import { randomUUID } from "crypto";
import { ContextSnapshot } from "../context/types";
import { DateTimeContext } from "../context/providers/dateTimeProvider";
import { WeatherContext } from "../context/providers/weather/types";
import { CalendarContext } from "../context/providers/calendar/types";
import { localCalendarDate, localTime, addDaysToDateString } from "../context/providers/calendar/icsTimeUtils";
import { EmailContext } from "../context/providers/email/types";
import { TaskContext, TaskItem } from "../context/providers/tasks/types";
import { Briefing, BriefingItem } from "./types";
import { resolveLocale } from "../common/locale";

/** Cap on how many *content* items (excluding the fixed greeting/closing) appear — keeps NIMBUS concise. */
const MAX_CONTENT_ITEMS = 5;

/** Precipitation probability, in percent, at or above which weather is worth calling out more prominently. */
const NOTABLE_RAIN_THRESHOLD = 40;

/**
 * Turns a ContextSnapshot into a Briefing. This is pure, synchronous, and
 * has no Electron/IPC/UI dependency — it only knows how to read
 * ContextProviderResults and produce BriefingItems, which keeps it easy
 * to unit test and easy to extend (a future provider's category just
 * needs one more `buildXItem` function called from `generate`).
 *
 * Design choice: a provider that's missing, unavailable, or errored is
 * simply omitted — never represented as an "error" item. A briefing is
 * meant to be a calm, curated summary, not a status dashboard; provider
 * failures are already visible (and diagnosable via logs) through the
 * Context tab. This is what keeps "weather failed" from turning into
 * clutter in what should otherwise just be "Good morning."
 */
export class BriefingGenerator {
  /**
   * `localeOverride` controls how dates are written out (e.g. "8 de
   * setembro de 2026" vs "September 8, 2026"). Production omits it, so
   * the locale a host configured via `common/locale.ts` is resolved
   * lazily at generation time; tests pin it for deterministic assertions.
   */
  constructor(private readonly localeOverride?: string) {}

  /** `now` is injectable (tests only) so time-relative items like calendar proximity are deterministic. */
  generate(snapshot: ContextSnapshot, now: Date = new Date()): Briefing {
    const locale = this.localeOverride ?? resolveLocale();
    const dateTime = readOkData<DateTimeContext>(snapshot, "dateTime");
    const weather = readOkData<WeatherContext>(snapshot, "weather");
    const calendar = readOkData<CalendarContext>(snapshot, "calendar");
    const email = readOkData<EmailContext>(snapshot, "email");
    const tasks = readOkData<TaskContext>(snapshot, "tasks");

    const contentItems: BriefingItem[] = [
      buildDateTimeItem(dateTime, now, locale),
      buildWeatherItem(weather, now),
      buildCalendarItem(calendar, now),
      buildEmailItem(email, now),
      buildTasksItem(tasks, now),
      // Future: buildMealsItem — reads its own provider from `snapshot`
      // and returns null when absent, exactly like the ones above.
    ].filter((item): item is BriefingItem => item !== null);

    const prioritized = contentItems
      .slice()
      .sort((a, b) => priority(b) - priority(a))
      .slice(0, MAX_CONTENT_ITEMS);

    const items: BriefingItem[] = [
      buildGreetingItem(dateTime, now),
      ...prioritized,
      buildClosingItem(now),
    ];

    return {
      id: randomUUID(),
      generatedAt: now.toISOString(),
      items,
    };
  }
}

function priority(item: BriefingItem): number {
  return item.importance * item.relevance;
}

function readOkData<T>(snapshot: ContextSnapshot, providerId: string): T | null {
  const result = snapshot.providers[providerId];
  if (!result || result.status !== "ok" || !result.data) return null;
  return result.data as T;
}

function buildGreetingItem(dateTime: DateTimeContext | null, now: Date): BriefingItem {
  const hour = dateTime ? Number(dateTime.time.split(":")[0]) : now.getHours();
  const text = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";

  return {
    id: randomUUID(),
    category: "greeting",
    message: text,
    importance: 100,
    relevance: 100,
    timestamp: now.toISOString(),
  };
}

function buildDateTimeItem(
  dateTime: DateTimeContext | null,
  now: Date,
  locale: string | undefined
): BriefingItem | null {
  if (!dateTime) return null;

  // Formatted from `now` (not by re-parsing dateTime.date, which is a bare
  // YYYY-MM-DD and would shift a day in some timezones if parsed as UTC).
  // Locale-aware: e.g. "8 de setembro de 2026" under pt-PT, not a fixed
  // ISO/US string regardless of the user's actual locale.
  const formattedDate = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  return {
    id: randomUUID(),
    category: "dateTime",
    message: `Today is ${dateTime.dayOfWeek}, ${formattedDate}.`,
    importance: 20,
    relevance: 100,
    timestamp: now.toISOString(),
  };
}

function buildWeatherItem(weather: WeatherContext | null, now: Date): BriefingItem | null {
  if (!weather) return null;

  const low = weather.todayLowC ?? weather.temperatureC;
  const high = weather.todayHighC ?? weather.temperatureC;
  const rainLikely =
    weather.precipitationProbabilityPercent !== null &&
    weather.precipitationProbabilityPercent >= NOTABLE_RAIN_THRESHOLD;

  const message = rainLikely
    ? `Today's weather will be around ${Math.round(low)} to ${Math.round(high)} degrees, ` +
      `with a ${weather.precipitationProbabilityPercent}% chance of ${weather.condition.toLowerCase()}.`
    : `Today's weather will be around ${Math.round(low)} to ${Math.round(high)} degrees, ${weather.condition.toLowerCase()}.`;

  return {
    id: randomUUID(),
    category: "weather",
    message,
    importance: 60,
    // Rain (or otherwise notable conditions) makes weather more worth mentioning today specifically.
    relevance: rainLikely ? 90 : 60,
    timestamp: now.toISOString(),
    action: { label: "View forecast", actionId: "view-context" },
  };
}

/** Minutes-until-start at or below which an upcoming event is called out by name ("starts in N minutes"). */
const IMMINENT_EVENT_MINUTES = 45;

function buildCalendarItem(calendar: CalendarContext | null, now: Date): BriefingItem | null {
  if (!calendar) return null;

  const { timezone, todayEvents, nextEvent } = calendar;

  // An imminent, not-yet-started event is the single most useful thing to
  // say, regardless of how many other events exist today.
  if (nextEvent) {
    const minutesUntil = (new Date(nextEvent.startsAt).getTime() - now.getTime()) / 60000;
    if (minutesUntil >= 0 && minutesUntil <= IMMINENT_EVENT_MINUTES) {
      const message =
        minutesUntil < 1
          ? `"${nextEvent.title}" is starting now.`
          : `"${nextEvent.title}" starts in ${Math.round(minutesUntil)} minutes.`;
      return {
        id: randomUUID(),
        category: "calendar",
        message,
        importance: 55,
        relevance: 95, // "event happening soon → very high relevance"
        timestamp: now.toISOString(),
        action: { label: "View schedule", actionId: "view-calendar" },
      };
    }
  }

  if (todayEvents.length > 0) {
    const timedEvents = todayEvents.filter((e) => !e.isAllDay);
    const allDayCount = todayEvents.length - timedEvents.length;
    const allDayOnly = timedEvents.length === 0;

    let message: string;
    let relevance: number;

    if (allDayOnly) {
      const allDayEvents = todayEvents; // allDayOnly implies every today-event is all-day
      message =
        allDayCount === 1
          ? `You have an all-day event today: "${allDayEvents[0].title}".`
          : `You have ${spellNumber(allDayCount)} all-day events today.`;
      relevance = 50;
    } else if (todayEvents.length === 1) {
      message = `You have one event today at ${localTime(timedEvents[0].startsAt, timezone)}: "${timedEvents[0].title}".`;
      relevance = 50;
    } else {
      const first = timedEvents[0] ?? todayEvents[0];
      message =
        `You have ${spellNumber(todayEvents.length)} events today. ` +
        `Your first is "${first.title}" at ${localTime(first.startsAt, timezone)}.`;
      relevance = 65; // "several events today → higher relevance"
    }

    return {
      id: randomUUID(),
      category: "calendar",
      message,
      importance: 55,
      relevance,
      timestamp: now.toISOString(),
      action: { label: "View schedule", actionId: "view-calendar" },
    };
  }

  if (nextEvent) {
    const todayDate = localCalendarDate(now.toISOString(), timezone);
    const eventDate = localCalendarDate(nextEvent.startsAt, timezone);
    const dayLabel = eventDate === addDaysToDateString(todayDate, 1) ? "tomorrow" : "soon";
    return {
      id: randomUUID(),
      category: "calendar",
      message: `Your next event, "${nextEvent.title}", is ${dayLabel} at ${localTime(nextEvent.startsAt, timezone)}.`,
      importance: 55,
      relevance: 55, // "important/upcoming event → high relevance"
      timestamp: now.toISOString(),
      action: { label: "View schedule", actionId: "view-calendar" },
    };
  }

  return {
    id: randomUUID(),
    category: "calendar",
    message: "You have nothing scheduled today.",
    importance: 55,
    relevance: 20, // "no events → low relevance"
    timestamp: now.toISOString(),
  };
}

const SMALL_NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function spellNumber(n: number): string {
  return SMALL_NUMBER_WORDS[n] ?? String(n);
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function buildEmailItem(email: EmailContext | null, now: Date): BriefingItem | null {
  if (!email) return null;

  const { totalRecent, unreadCount, importantMessages } = email;

  // A high-importance, still-unread message is the single most useful
  // thing to say — matches the "may require your attention" framing the
  // deterministic classifier is designed to support, without claiming
  // certainty (see emailImportance.ts).
  const spotlight = importantMessages.find((m) => m.importance === "high" && m.isUnread);
  if (spotlight) {
    const sender = spotlight.senderName || spotlight.senderAddress || "someone";
    return {
      id: randomUUID(),
      category: "email",
      message: `You have an unread email from ${sender} that may require your attention.`,
      importance: 50,
      relevance: 90, // "email that may require attention → very high relevance"
      timestamp: now.toISOString(),
      action: { label: "View inbox", actionId: "view-context" },
    };
  }

  if (importantMessages.length > 0) {
    return {
      id: randomUUID(),
      category: "email",
      message:
        `You received ${totalRecent} email${totalRecent === 1 ? "" : "s"} since yesterday. ` +
        `${capitalize(spellNumber(importantMessages.length))} may require your attention.`,
      importance: 50,
      relevance: Math.min(80, 60 + importantMessages.length * 5),
      timestamp: now.toISOString(),
      action: { label: "View inbox", actionId: "view-context" },
    };
  }

  if (unreadCount > 0) {
    return {
      id: randomUUID(),
      category: "email",
      message: `You have ${unreadCount} unread email${unreadCount === 1 ? "" : "s"}.`,
      importance: 50,
      relevance: 45,
      timestamp: now.toISOString(),
      action: { label: "View inbox", actionId: "view-context" },
    };
  }

  return {
    id: randomUUID(),
    category: "email",
    message: "Nothing important came in overnight.",
    importance: 50,
    relevance: 20, // "nothing notable → low relevance"
    timestamp: now.toISOString(),
  };
}

/** Minutes-until-due at or below which an imminent task is called out specifically ("due in one hour"). */
const IMMINENT_TASK_MINUTES = 90;

function findImminentTask(tasks: TaskContext, now: Date): TaskItem | null {
  const candidates = [...tasks.overdueTasks, ...tasks.dueTodayTasks, ...tasks.upcomingTasks];
  const imminent = candidates
    .filter((t) => t.dueAt && !t.dueIsDateOnly)
    .map((t) => ({ task: t, minutesUntil: (new Date(t.dueAt!).getTime() - now.getTime()) / 60000 }))
    .filter((t) => t.minutesUntil >= 0 && t.minutesUntil <= IMMINENT_TASK_MINUTES)
    .sort((a, b) => a.minutesUntil - b.minutesUntil);
  return imminent[0]?.task ?? null;
}

function formatMinutesUntil(minutes: number): string {
  if (minutes < 1) return "any moment now";
  if (minutes < 60) return `${spellNumber(Math.round(minutes))} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${spellNumber(hours)} hour${hours === 1 ? "" : "s"}`;
}

function buildTasksItem(tasks: TaskContext | null, now: Date): BriefingItem | null {
  if (!tasks) return null;

  const { overdueCount, dueTodayCount, overdueTasks, dueTodayTasks } = tasks;

  // A task whose deadline is about to hit is the single most useful thing
  // to say, regardless of how many other tasks exist — same reasoning as
  // calendar's imminent-event branch and email's unread-and-important
  // spotlight.
  const imminentTask = findImminentTask(tasks, now);
  if (imminentTask) {
    const minutesUntil = (new Date(imminentTask.dueAt!).getTime() - now.getTime()) / 60000;
    return {
      id: randomUUID(),
      category: "tasks",
      message: `You have a task due in ${formatMinutesUntil(minutesUntil)}.`,
      importance: 55,
      relevance: 95, // "task due imminently → very high relevance"
      timestamp: now.toISOString(),
      action: { label: "View tasks", actionId: "view-context" },
    };
  }

  if (overdueCount > 0 && dueTodayCount > 0) {
    return {
      id: randomUUID(),
      category: "tasks",
      message:
        `You have ${spellNumber(overdueCount)} overdue task${overdueCount === 1 ? "" : "s"} and ` +
        `${spellNumber(dueTodayCount)} task${dueTodayCount === 1 ? "" : "s"} due today.`,
      importance: 55,
      relevance: Math.min(85, 55 + (overdueCount + dueTodayCount) * 5),
      timestamp: now.toISOString(),
      action: { label: "View tasks", actionId: "view-context" },
    };
  }

  if (overdueCount > 0) {
    return {
      id: randomUUID(),
      category: "tasks",
      message: `You have ${spellNumber(overdueCount)} overdue task${overdueCount === 1 ? "" : "s"}.`,
      importance: 55,
      relevance: Math.min(85, 60 + overdueCount * 5), // "overdue → high relevance"
      timestamp: now.toISOString(),
      action: { label: "View tasks", actionId: "view-context" },
    };
  }

  if (dueTodayCount > 0) {
    const message =
      dueTodayCount === 1
        ? `You have one task due today: "${dueTodayTasks[0].title}".`
        : `You have ${spellNumber(dueTodayCount)} tasks due today, including "${dueTodayTasks[0].title}".`;
    return {
      id: randomUUID(),
      category: "tasks",
      message,
      importance: 55,
      relevance: Math.min(75, 45 + dueTodayCount * 5),
      timestamp: now.toISOString(),
      action: { label: "View tasks", actionId: "view-context" },
    };
  }

  return {
    id: randomUUID(),
    category: "tasks",
    message: "You have no tasks due today.",
    importance: 55,
    relevance: 15, // "nothing pressing → low relevance"
    timestamp: now.toISOString(),
  };
}

function buildClosingItem(now: Date): BriefingItem {
  return {
    id: randomUUID(),
    category: "other",
    message: "Anything I can help you with?",
    importance: 1,
    relevance: 1,
    timestamp: now.toISOString(),
  };
}
