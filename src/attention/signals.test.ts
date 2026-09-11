import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activitySignals,
  calendarSignals,
  calendarUrgency,
  collectSignals,
  emailSignals,
  endOfLocalDay,
  stockSignals,
  suggestionSignal,
  taskDueUrgency,
  taskSignals,
  weatherSignals,
} from "./signals";
import { ContextSnapshot } from "../context/types";
import { CalendarContext, CalendarEvent } from "../context/providers/calendar/types";
import { EmailContext, EmailMessage } from "../context/providers/email/types";
import { StockContext } from "../context/providers/stocks/types";
import { TaskContext, TaskItem } from "../context/providers/tasks/types";
import { WeatherContext } from "../context/providers/weather/types";

const NOW = new Date("2026-09-11T10:00:00Z");
const TZ = "UTC";
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

// ------------------------------------------------------------------ calendar

function calendar(events: Partial<CalendarEvent>[]): CalendarContext {
  return {
    retrievedAt: NOW.toISOString(),
    timezone: TZ,
    todayEvents: events.map((e, i) => ({
      id: `e${i}`,
      title: "Standup",
      startsAt: inMinutes(12),
      endsAt: inMinutes(42),
      isAllDay: false,
      location: null,
      calendarName: null,
      ...e,
    })),
    laterEvents: [],
    nextEvent: null,
  };
}

test("calendar urgency steps up as an event approaches", () => {
  assert.equal(calendarUrgency(60), 35);
  assert.equal(calendarUrgency(30), 55);
  assert.equal(calendarUrgency(15), 85);
  assert.equal(calendarUrgency(5), 100);
  assert.equal(calendarUrgency(-3), 100);
});

test("an event within the hour becomes one signal with a stable key", () => {
  const [signal] = calendarSignals(calendar([{ id: "a" }]), NOW);

  assert.equal(signal.title, "Standup in 12 min");
  assert.equal(signal.urgency, 85);
  assert.equal(signal.key, `calendar:a:${inMinutes(12)}`);
  assert.equal(signal.expiresAt, inMinutes(17));
  assert.deepEqual(signal.reasons, ["Starts in 12 minutes", "Time-sensitive calendar event"]);

  const aMinuteLater = calendarSignals(calendar([{ id: "a" }]), new Date(NOW.getTime() + 60_000))[0];
  assert.equal(aMinuteLater.key, signal.key);
  assert.equal(aMinuteLater.title, "Standup in 11 min");
});

test("all-day, far-off and long-started events are left out; one just started is urgent", () => {
  assert.deepEqual(
    calendarSignals(
      calendar([{ isAllDay: true }, { startsAt: inMinutes(90) }, { startsAt: inMinutes(-10) }]),
      NOW
    ),
    []
  );
  const [started] = calendarSignals(calendar([{ startsAt: inMinutes(-3) }]), NOW);
  assert.equal(started.title, "Standup is starting");
  assert.equal(started.urgency, 100);
});

// --------------------------------------------------------------------- tasks

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "t1",
    title: "Send report",
    description: null,
    dueAt: inMinutes(30),
    dueIsDateOnly: false,
    completed: false,
    completedAt: null,
    priority: "none",
    reminderAt: null,
    source: "todoist",
    listName: null,
    createdAt: null,
    category: "dueToday",
    urgency: "normal",
    signals: {
      isOverdue: false,
      isDueToday: true,
      isDueSoon: false,
      hasHighPriority: false,
      hasReminderApproaching: false,
      isStale: false,
    },
    ...overrides,
  };
}

function tasks(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    retrievedAt: NOW.toISOString(),
    timezone: TZ,
    accounts: [],
    totalActive: 0,
    overdueCount: 0,
    dueTodayCount: 0,
    overdueTasks: [],
    dueTodayTasks: [],
    upcomingTasks: [],
    noDeadlineTasks: [],
    ...overrides,
  };
}

test("a task due within two hours is its own signal, more urgent the closer it is", () => {
  const dueSoon = (t: TaskItem) =>
    taskSignals(tasks({ dueTodayTasks: [t] }), NOW, TZ).filter((s) => s.kind === "taskDueSoon");

  const [soon] = dueSoon(task());
  assert.equal(soon.title, '"Send report" is due in 30 min');
  assert.equal(soon.urgency, 70);
  assert.equal(soon.importance, 60);

  const [important] = dueSoon(task({ priority: "high" }));
  assert.equal(important.importance, 70);
  assert.ok(important.reasons.includes("Marked high priority"));

  assert.equal(taskDueUrgency(10), 90);
  assert.equal(taskDueUrgency(90), 55);
  assert.deepEqual(dueSoon(task({ dueIsDateOnly: true })), [], "no time, no countdown");
  assert.deepEqual(dueSoon(task({ dueAt: inMinutes(180) })), []);
  assert.deepEqual(dueSoon(task({ completed: true })), []);
});

test("overdue and due-today tasks are one summary each, for the day", () => {
  const signals = taskSignals(
    tasks({
      overdueCount: 2,
      overdueTasks: [
        task({ id: "o1", title: "A", dueAt: inMinutes(-600) }),
        task({ id: "o2", title: "B", dueAt: inMinutes(-900) }),
      ],
      dueTodayCount: 1,
      dueTodayTasks: [task({ id: "d1", title: "C", dueIsDateOnly: true, dueAt: "2026-09-11" })],
    }),
    NOW,
    TZ
  );

  assert.deepEqual(
    signals.map((s) => [s.key, s.title]),
    [
      ["tasks:overdue:2026-09-11", "2 overdue tasks"],
      ["tasks:dueToday:2026-09-11", "1 task due today"],
    ]
  );
  assert.equal(signals[0].expiresAt, "2026-09-12T00:00:00.000Z");
  assert.equal(endOfLocalDay(NOW, TZ).toISOString(), "2026-09-12T00:00:00.000Z");
});

// ------------------------------------------------------------------- weather

function weather(chance: number | null): WeatherContext {
  return {
    location: { latitude: 38.7, longitude: -9.1, label: "Lisbon", source: "manual" },
    temperatureC: 18,
    apparentTemperatureC: null,
    condition: "Light rain",
    conditionCode: 61,
    precipitationProbabilityPercent: chance,
    todayHighC: null,
    todayLowC: null,
    forecast: [],
    retrievedAt: NOW.toISOString(),
  };
}

test("rain is mentioned from a 50% chance, and not late in the evening", () => {
  assert.deepEqual(weatherSignals(weather(40), NOW, TZ), []);
  assert.deepEqual(weatherSignals(weather(null), NOW, TZ), []);
  const [rain] = weatherSignals(weather(80), NOW, TZ);
  assert.equal(rain.key, "weather:rain:2026-09-11");
  assert.equal(rain.relevance, 80);
  assert.equal(rain.urgency, 40);
  assert.deepEqual(weatherSignals(weather(80), new Date("2026-09-11T22:00:00Z"), TZ), []);
});

// --------------------------------------------------------------------- email

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "m1",
    threadId: null,
    senderName: "Ana",
    senderAddress: "ana@example.test",
    subject: "Contract",
    receivedAt: inMinutes(-60),
    isUnread: true,
    isFlagged: false,
    labels: [],
    snippet: null,
    accountId: "acc",
    importance: "high",
    signals: { isUnread: true, isFlagged: false, looksAutomated: false, matchedKeyword: null },
    ...overrides,
  };
}

function email(messages: EmailMessage[]): EmailContext {
  return {
    retrievedAt: NOW.toISOString(),
    windowDays: 3,
    accounts: [],
    totalRecent: messages.length,
    unreadCount: messages.length,
    importantMessages: messages,
    recentMessages: messages,
  };
}

test("unread important email from the last 12 hours — at most three, the most important first", () => {
  const signals = emailSignals(
    email([
      message({ id: "a", importance: "important" }),
      message({ id: "b" }),
      message({ id: "c", isUnread: false }),
      message({ id: "d", receivedAt: inMinutes(-13 * 60) }),
      message({ id: "e", importance: "normal" }),
      message({ id: "f" }),
      message({ id: "g" }),
    ]),
    NOW
  );

  assert.deepEqual(
    signals.map((s) => s.key),
    ["email:acc:b", "email:acc:f", "email:acc:g"]
  );
  assert.equal(signals[0].title, "Email from Ana");
  assert.equal(signals[0].description, "Contract");
});

// -------------------------------------------------------------------- stocks

function stocks(dayChangePercent: number | null): StockContext {
  return {
    retrievedAt: NOW.toISOString(),
    positions: [],
    holdings: [],
    totals: [],
    unpricedCount: 0,
    outdatedCount: 0,
    anyStale: false,
    source: "Test",
    baseCurrency: "EUR",
    baseTotals:
      dayChangePercent === null
        ? null
        : {
            currency: "EUR",
            positions: 1,
            invested: 100,
            marketValue: 103,
            unrealizedGain: 3,
            unrealizedGainPercent: 3,
            dayChange: 3,
            dayChangePercent,
          },
    fxRates: [],
    unconvertedCurrencies: [],
  };
}

test("a portfolio move of 3% or more is worth a mention", () => {
  assert.deepEqual(stockSignals(stocks(2), NOW, TZ), []);
  assert.deepEqual(stockSignals(stocks(null), NOW, TZ), []);
  const [move] = stockSignals(stocks(-3.4), NOW, TZ);
  assert.equal(move.title, "Portfolio down 3.4% today");
  assert.equal(move.key, "stocks:move:2026-09-11:down");
  assert.equal(move.relevance, 57);
});

// ------------------------------------------------------------------ activity

test("a long session is a gentle signal about that activity", () => {
  const [long] = activitySignals(
    { name: "Gaming", startedAt: inMinutes(-190), durationMs: 190 * 60_000 },
    NOW
  );
  assert.equal(long.title, "3 h of Gaming");
  assert.equal(long.relatedActivity, "Gaming");
  assert.equal(long.urgency, 40);
  assert.deepEqual(long.reasons, ["Gaming for 3 h 10 min"]);
  assert.deepEqual(
    activitySignals({ name: "Gaming", startedAt: inMinutes(-120), durationMs: 120 * 60_000 }, NOW),
    []
  );
  assert.deepEqual(activitySignals(null, NOW), []);
});

// ------------------------------------------------------------------ routines

test("a routine's suggestion becomes a signal that points back to it", () => {
  const signal = suggestionSignal({
    id: "s1",
    type: "suggestion",
    source: "routines",
    createdAt: NOW.toISOString(),
    routineId: "r1",
    title: "Study mode?",
    message: "Play your study playlist?",
    primaryLabel: "Yes",
    secondaryLabel: "Not now",
    expiresAt: inMinutes(1),
    actionSummary: [],
  });
  assert.equal(signal.key, "suggestion:s1");
  assert.equal(signal.source, "routines");
  assert.equal(signal.suggestionId, "s1");
  assert.equal(signal.urgency, 80);
  assert.equal(signal.expiresAt, inMinutes(1));
});

test("only providers that answered ok contribute", () => {
  const snapshot: ContextSnapshot = {
    generatedAt: NOW.toISOString(),
    providers: {
      calendar: {
        providerId: "calendar",
        displayName: "Calendar",
        status: "ok",
        data: calendar([{ id: "a" }]),
        timestamp: NOW.toISOString(),
        stale: false,
      },
      tasks: {
        providerId: "tasks",
        displayName: "Tasks",
        status: "error",
        data: null,
        error: "down",
        timestamp: NOW.toISOString(),
        stale: false,
      },
    },
  };
  assert.deepEqual(
    collectSignals(snapshot, null, NOW, TZ).map((s) => s.source),
    ["calendar"]
  );
  assert.deepEqual(collectSignals(null, null, NOW, TZ), []);
});
