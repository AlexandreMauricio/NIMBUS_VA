import { AssistantSuggestion } from "../common/assistantEvents";
import { ContextSnapshot } from "../context/types";
import { CalendarContext } from "../context/providers/calendar/types";
import { localCalendarDate } from "../context/providers/calendar/icsTimeUtils";
import { EmailContext, EmailMessage } from "../context/providers/email/types";
import { StockContext } from "../context/providers/stocks/types";
import { TaskContext, TaskItem } from "../context/providers/tasks/types";
import { WeatherContext } from "../context/providers/weather/types";
import { AttentionActivity, AttentionFrequentApp, AttentionSignal } from "./types";

/**
 * Signal builders: pure functions from what NIMBUS already knows to
 * AttentionSignals. Each source has its own small, documented rules for
 * importance, urgency and relevance; the engine combines them the same
 * way for everything. A missing or failed provider simply contributes no
 * signals.
 *
 * A new source feeds Attention by adding one builder here (or offering
 * signals to the service) — nothing else changes.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function readOk<T>(snapshot: ContextSnapshot | null, providerId: string): T | null {
  const result = snapshot?.providers[providerId];
  if (!result || result.status !== "ok" || !result.data) return null;
  return result.data as T;
}

function localClock(now: Date, timeZone: string): { hour: number; minute: number; second: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return { hour: get("hour"), minute: get("minute"), second: get("second") };
  } catch {
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes(), second: now.getUTCSeconds() };
  }
}

/** When the local day ends — the natural expiry for "today" items. (Off by an hour on DST days; harmless here.) */
export function endOfLocalDay(now: Date, timeZone: string): Date {
  const { hour, minute, second } = localClock(now, timeZone);
  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsed + 24 * HOUR);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

// ------------------------------------------------------------------ calendar

/** How far ahead an event starts being worth attention, at the least. */
export const CALENDAR_LOOKAHEAD_MINUTES = 60;

/** Reminder lead times: the default, the range allowed, and what the picker offers. */
export const DEFAULT_REMINDER_MINUTES = 60;
export const MIN_REMINDER_MINUTES = 10;
export const MAX_REMINDER_MINUTES = 240;
export const REMINDER_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240];

/** A saved or requested lead time, as whole minutes within range. */
export function normalizeReminderMinutes(value: unknown): number {
  const minutes =
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_REMINDER_MINUTES;
  return Math.min(MAX_REMINDER_MINUTES, Math.max(MIN_REMINDER_MINUTES, minutes));
}

/**
 * Urgency by minutes until the start. Inside the reminder lead time it is
 * 70 — enough to be high priority and pop up, and at the busy-rule
 * threshold, so a reminder isn't silenced because you're gaming or a
 * timer is running. It rises to 85 in the last 15 minutes and 100 in the
 * last 5, when it pops up once more as urgent.
 */
export function calendarUrgency(
  minutesUntilStart: number,
  reminderMinutes: number = DEFAULT_REMINDER_MINUTES
): number {
  if (minutesUntilStart <= 5) return 100;
  if (minutesUntilStart <= 15) return 85;
  if (minutesUntilStart <= reminderMinutes) return 70;
  return 35;
}

/**
 * A timed event starting within the hour (or started in the last five
 * minutes). Importance 70, relevance 70 — it's on the user's own
 * calendar, today. With the urgency table that makes it normal an hour
 * out, high at 15 minutes, urgent at 5.
 */
export function calendarSignals(
  calendar: CalendarContext | null,
  now: Date,
  reminderMinutes: number = DEFAULT_REMINDER_MINUTES
): AttentionSignal[] {
  if (!calendar) return [];
  const lookahead = Math.max(CALENDAR_LOOKAHEAD_MINUTES, reminderMinutes);
  const signals: AttentionSignal[] = [];
  const seen = new Set<string>();
  for (const event of [...calendar.todayEvents, ...calendar.laterEvents]) {
    if (event.isAllDay) continue;
    const startMs = Date.parse(event.startsAt);
    if (!Number.isFinite(startMs)) continue;
    const key = `calendar:${event.id}:${event.startsAt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const minutes = (startMs - now.getTime()) / MINUTE;
    if (minutes > lookahead || minutes < -5) continue;
    const whole = Math.max(0, Math.ceil(minutes));
    signals.push({
      key,
      source: "calendar",
      kind: "eventStartingSoon",
      title: minutes <= 0 ? `${event.title} is starting` : `${event.title} in ${whole} min`,
      description: event.location ?? event.calendarName ?? "On your calendar",
      importance: 70,
      urgency: calendarUrgency(minutes, reminderMinutes),
      relevance: 70,
      reasons: [
        minutes <= 0 ? "Started just now" : `Starts in ${plural(whole, "minute")}`,
        minutes > 15 && minutes <= reminderMinutes
          ? `Your reminder: ${reminderMinutes} minutes before`
          : "Time-sensitive calendar event",
      ],
      occursAt: event.startsAt,
      expiresAt: new Date(startMs + 5 * MINUTE).toISOString(),
    });
  }
  return signals;
}

// --------------------------------------------------------------------- tasks

/** A timed task's urgency by minutes until it is due. */
export function taskDueUrgency(minutesUntilDue: number): number {
  if (minutesUntilDue <= 15) return 90;
  if (minutesUntilDue <= 60) return 70;
  return 55;
}

/**
 * - A task with a due *time* in the next two hours, one signal each
 *   (importance 60, 70 if marked high priority).
 * - Overdue tasks, one summary for the day (normal).
 * - Tasks due today, one summary for the day (normal).
 */
export function taskSignals(tasks: TaskContext | null, now: Date, timeZone: string): AttentionSignal[] {
  if (!tasks) return [];
  const signals: AttentionSignal[] = [];
  const today = localCalendarDate(now.toISOString(), timeZone);
  const endOfDay = endOfLocalDay(now, timeZone).toISOString();

  const seen = new Set<string>();
  const timed: TaskItem[] = [...tasks.overdueTasks, ...tasks.dueTodayTasks, ...tasks.upcomingTasks];
  for (const task of timed) {
    if (task.completed || task.dueIsDateOnly || !task.dueAt || seen.has(task.id)) continue;
    seen.add(task.id);
    const minutes = (Date.parse(task.dueAt) - now.getTime()) / MINUTE;
    if (!(minutes > 0 && minutes <= 120)) continue;
    const whole = Math.ceil(minutes);
    const high = task.priority === "high";
    signals.push({
      key: `tasks:dueSoon:${task.id}:${task.dueAt}`,
      source: "tasks",
      kind: "taskDueSoon",
      title: `"${task.title}" is due in ${formatMinutes(whole)}`,
      description: task.listName ? `In ${task.listName}` : "From your tasks",
      importance: high ? 70 : 60,
      urgency: taskDueUrgency(minutes),
      relevance: 60,
      reasons: [`Due in ${formatMinutes(whole)}`, ...(high ? ["Marked high priority"] : [])],
      occursAt: task.dueAt,
      expiresAt: task.dueAt,
    });
  }

  if (tasks.overdueCount > 0) {
    signals.push({
      key: `tasks:overdue:${today}`,
      source: "tasks",
      kind: "tasksOverdue",
      title: `${plural(tasks.overdueCount, "overdue task")}`,
      description: tasks.overdueTasks
        .slice(0, 3)
        .map((t) => t.title)
        .join(", "),
      importance: 55,
      urgency: 60,
      relevance: 60,
      reasons: [`${plural(tasks.overdueCount, "task")} past the due date`],
      expiresAt: endOfDay,
    });
  }

  if (tasks.dueTodayCount > 0) {
    signals.push({
      key: `tasks:dueToday:${today}`,
      source: "tasks",
      kind: "tasksDueToday",
      title: `${plural(tasks.dueTodayCount, "task")} due today`,
      description: tasks.dueTodayTasks
        .slice(0, 3)
        .map((t) => t.title)
        .join(", "),
      importance: 55,
      urgency: 45,
      relevance: 55,
      reasons: [`${plural(tasks.dueTodayCount, "task")} due before the day ends`],
      expiresAt: endOfDay,
    });
  }
  return signals;
}

// ------------------------------------------------------------------- weather

/** Rain chance at or above which the day's weather is worth a mention. */
export const RAIN_NOTICE_PERCENT = 50;
/** After this local hour, "rain today" has little left to be useful for. */
const WEATHER_CUTOFF_HOUR = 21;

/** Rain likely today: importance 35, relevance = the rain chance — low at 50%, normal from about 60%. */
export function weatherSignals(
  weather: WeatherContext | null,
  now: Date,
  timeZone: string
): AttentionSignal[] {
  if (!weather) return [];
  const chance =
    weather.precipitationProbabilityPercent ?? weather.forecast?.[0]?.precipitationProbabilityPercent ?? null;
  if (chance === null || chance < RAIN_NOTICE_PERCENT) return [];
  if (localClock(now, timeZone).hour >= WEATHER_CUTOFF_HOUR) return [];
  return [
    {
      key: `weather:rain:${localCalendarDate(now.toISOString(), timeZone)}`,
      source: "weather",
      kind: "rainLikely",
      title: "Rain likely today",
      description: `${chance}% chance of rain · ${weather.condition}`,
      importance: 35,
      urgency: chance >= 80 ? 40 : 30,
      relevance: Math.min(90, chance),
      reasons: [`${chance}% chance of rain today`],
      expiresAt: endOfLocalDay(now, timeZone).toISOString(),
    },
  ];
}

// --------------------------------------------------------------------- email

/** How long an unread important email stays worth attention. */
export const EMAIL_WINDOW_HOURS = 12;
const MAX_EMAIL_SIGNALS = 3;

/** Unread, important emails from the last twelve hours — at most three, the most important first. */
export function emailSignals(email: EmailContext | null, now: Date): AttentionSignal[] {
  if (!email) return [];
  const rank = (m: EmailMessage) => (m.importance === "high" ? 0 : 1);
  return email.importantMessages
    .filter((m) => {
      const age = now.getTime() - Date.parse(m.receivedAt);
      return (
        m.isUnread &&
        (m.importance === "high" || m.importance === "important") &&
        age >= 0 &&
        age <= EMAIL_WINDOW_HOURS * HOUR
      );
    })
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    .slice(0, MAX_EMAIL_SIGNALS)
    .map((m) => ({
      key: `email:${m.accountId}:${m.id}`,
      source: "email" as const,
      kind: "importantEmail",
      title: `Email from ${m.senderName ?? m.senderAddress ?? "someone"}`,
      description: m.subject,
      importance: m.importance === "high" ? 60 : 45,
      urgency: 45,
      relevance: 60,
      reasons: [
        m.importance === "high" ? "Marked as high importance" : "Looks important",
        ...(m.signals.isFlagged ? ["Flagged"] : []),
        ...(m.signals.matchedKeyword ? [`Mentions "${m.signals.matchedKeyword}"`] : []),
      ],
      occursAt: m.receivedAt,
      expiresAt: new Date(Date.parse(m.receivedAt) + EMAIL_WINDOW_HOURS * HOUR).toISOString(),
    }));
}

// -------------------------------------------------------------------- stocks

/** A day's portfolio move at or beyond this, in percent, is worth a mention. */
export const STOCK_MOVE_PERCENT = 3;

/** A big move in the portfolio today: importance 35, relevance growing with the size of the move. */
export function stockSignals(stocks: StockContext | null, now: Date, timeZone: string): AttentionSignal[] {
  if (!stocks) return [];
  const totals = stocks.baseTotals ?? (stocks.totals.length === 1 ? stocks.totals[0] : null);
  const pct = totals?.dayChangePercent;
  if (pct === null || pct === undefined || Math.abs(pct) < STOCK_MOVE_PERCENT) return [];
  const up = pct > 0;
  const size = Math.abs(pct).toFixed(1);
  return [
    {
      key: `stocks:move:${localCalendarDate(now.toISOString(), timeZone)}:${up ? "up" : "down"}`,
      source: "stocks",
      kind: "portfolioMove",
      title: `Portfolio ${up ? "up" : "down"} ${size}% today`,
      description: stocks.anyStale ? "Some prices may be out of date" : "Across your tracked positions",
      importance: 35,
      urgency: 35,
      relevance: Math.min(90, 40 + Math.round(Math.abs(pct) * 5)),
      reasons: [`A ${size}% move — larger than the ${STOCK_MOVE_PERCENT}% notice threshold`],
      expiresAt: endOfLocalDay(now, timeZone).toISOString(),
    },
  ];
}

// ------------------------------------------------------------------ activity

/** A session this long is worth a gentle mention. */
export const LONG_ACTIVITY_HOURS = 3;

/**
 * A long session of one activity ("3 h of Gaming"). Potentially relevant,
 * never automatically important: importance 40, urgency rising slowly
 * with each extra hour, and — being about the current activity — it
 * earns the activity bonus that offsets the busy penalty. Normal at most.
 */
export function activitySignals(activity: AttentionActivity | null, now: Date): AttentionSignal[] {
  if (!activity || activity.durationMs < LONG_ACTIVITY_HOURS * HOUR) return [];
  const hours = Math.floor(activity.durationMs / HOUR);
  const minutes = Math.floor((activity.durationMs % HOUR) / MINUTE);
  return [
    {
      key: `activity:long:${activity.name}:${activity.startedAt}`,
      source: "activity",
      kind: "longActivity",
      title: `${hours} h of ${activity.name}`,
      description: "Maybe time for a break?",
      importance: 40,
      urgency: Math.min(60, 40 + (hours - LONG_ACTIVITY_HOURS) * 10),
      relevance: 60,
      reasons: [`${activity.name} for ${hours} h ${minutes} min`],
      relatedActivity: activity.name,
      // Rolls forward while the session lasts; lapses soon after it ends.
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
    },
  ];
}

// ------------------------------------------------------------------ routines

/**
 * A routine's suggestion, as a signal. It reacts to something the user
 * just did and lasts only a minute, so it is urgent (80) — which keeps it
 * above the busy rule and in the popup, exactly as before Attention
 * existed. What Attention adds is the queue: it waits, rather than being
 * overwritten, while something more important is on screen.
 */
export function suggestionSignal(suggestion: AssistantSuggestion): AttentionSignal {
  return {
    key: `suggestion:${suggestion.id}`,
    source: "routines",
    kind: "routineSuggestion",
    title: suggestion.title,
    description: suggestion.message,
    importance: 50,
    urgency: 80,
    relevance: 70,
    reasons: ["A routine you set up matched what you just did", "Offered for a short time only"],
    expiresAt: suggestion.expiresAt,
    suggestionId: suggestion.id,
  };
}

// ------------------------------------------------------------ frequent apps

/**
 * "Make it an activity?" for a program used often that isn't one yet (see
 * src/activity/appUsage.ts). Importance 45; relevance grows with how many
 * days and hours it's used; urgency is 70 at the moment it was just opened
 * — the natural time to ask — and 40 otherwise. So a well-used program
 * you just opened can earn a popup; the rest of the time it's a feed line.
 */
export function frequentAppSignals(apps: AttentionFrequentApp[], now: Date): AttentionSignal[] {
  return apps.map((app) => {
    const hours = app.minutesUsed / 60;
    const usage = app.minutesUsed < 60 ? "under an hour" : `about ${Math.round(hours)} h`;
    const website = app.source === "website";
    return {
      // Websites get their own key space: a site called "steam" and
      // steam.exe are different things to ask about.
      key: `frequentApp:${website ? "site:" : ""}${app.executable}`,
      source: "activity" as const,
      kind: "frequentApp",
      title: `Make ${app.name} an activity?`,
      description: `Used on ${app.daysUsed} of the last 7 days, ${usage} in all.`,
      importance: 45,
      urgency: app.justOpened ? 70 : 40,
      relevance: Math.min(90, 30 + app.daysUsed * 10 + Math.min(20, Math.round(hours * 2))),
      reasons: [
        `Opened on ${plural(app.daysUsed, "day")} of the last 7`,
        `${usage.charAt(0).toUpperCase()}${usage.slice(1)} in total`,
        ...(app.justOpened ? ["You just opened it"] : []),
      ],
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
      followUp: {
        type: "createActivity" as const,
        application: app.executable,
        name: app.name,
        ...(website ? { source: "website" as const } : {}),
      },
      labels: { primary: "Make it an activity", secondary: "Not now" },
    };
  });
}

/** Every signal the current context and activity produce. */
export function collectSignals(
  snapshot: ContextSnapshot | null,
  activity: AttentionActivity | null,
  now: Date,
  timeZone: string,
  options: { reminderMinutes?: number } = {}
): AttentionSignal[] {
  return [
    ...calendarSignals(
      readOk<CalendarContext>(snapshot, "calendar"),
      now,
      normalizeReminderMinutes(options.reminderMinutes)
    ),
    ...taskSignals(readOk<TaskContext>(snapshot, "tasks"), now, timeZone),
    ...weatherSignals(readOk<WeatherContext>(snapshot, "weather"), now, timeZone),
    ...emailSignals(readOk<EmailContext>(snapshot, "email"), now),
    ...stockSignals(readOk<StockContext>(snapshot, "stocks"), now, timeZone),
    ...activitySignals(activity, now),
  ];
}
