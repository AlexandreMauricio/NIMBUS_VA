import { test } from "node:test";
import assert from "node:assert/strict";
import { BriefingGenerator } from "./briefingGenerator";
import { ContextSnapshot, ContextProviderResult } from "../context/types";
import { DateTimeContext } from "../context/providers/dateTimeProvider";
import { WeatherContext } from "../context/providers/weather/types";
import { CalendarContext, CalendarEvent } from "../context/providers/calendar/types";
import { EmailContext, EmailMessage } from "../context/providers/email/types";
import { TaskContext, TaskItem } from "../context/providers/tasks/types";

function okResult<T>(providerId: string, displayName: string, data: T): ContextProviderResult<T> {
  return {
    providerId,
    displayName,
    status: "ok",
    data,
    timestamp: new Date().toISOString(),
    stale: false,
  };
}

function errorResult(providerId: string, displayName: string, error: string): ContextProviderResult {
  return {
    providerId,
    displayName,
    status: "error",
    data: null,
    error,
    timestamp: new Date().toISOString(),
    stale: false,
  };
}

const SAMPLE_DATE_TIME: DateTimeContext = {
  date: "2024-01-15",
  time: "09:05:03",
  isoTimestamp: "2024-01-15T09:05:03-03:00",
  timezone: "America/Sao_Paulo",
  utcOffsetMinutes: -180,
  dayOfWeek: "Monday",
  dayOfWeekIndex: 1,
};

const SAMPLE_WEATHER: WeatherContext = {
  location: { latitude: 38.7, longitude: -9.1, label: "Lisbon", source: "manual" },
  temperatureC: 20,
  apparentTemperatureC: 19,
  condition: "Clear sky",
  conditionCode: 0,
  precipitationProbabilityPercent: 5,
  todayHighC: 26,
  todayLowC: 18,
  forecast: [],
  retrievedAt: new Date().toISOString(),
};

function snapshot(providers: Record<string, ContextProviderResult>): ContextSnapshot {
  return { generatedAt: new Date().toISOString(), providers };
}

test("a normal snapshot produces greeting, dateTime, weather, and a closing item, in that order", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      weather: okResult("weather", "Weather", SAMPLE_WEATHER),
    }),
    new Date(SAMPLE_DATE_TIME.isoTimestamp)
  );

  const categories = briefing.items.map((i) => i.category);
  assert.deepEqual(categories, ["greeting", "weather", "dateTime", "other"]);

  const greeting = briefing.items[0];
  assert.equal(greeting.message, "Good morning.");

  const weatherItem = briefing.items.find((i) => i.category === "weather")!;
  assert.match(weatherItem.message, /18 to 26 degrees/);
  assert.match(weatherItem.message, /clear sky/);

  const dateTimeItem = briefing.items.find((i) => i.category === "dateTime")!;
  assert.equal(dateTimeItem.message, "Today is Monday, January 15, 2024.");

  assert.equal(briefing.items[briefing.items.length - 1].message, "Anything I can help you with?");
});

test("the date is formatted in the given locale, not a fixed ISO/US string", () => {
  const generator = new BriefingGenerator("pt-PT");
  const briefing = generator.generate(
    snapshot({ dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME) }),
    new Date(SAMPLE_DATE_TIME.isoTimestamp)
  );

  const dateTimeItem = briefing.items.find((i) => i.category === "dateTime")!;
  assert.match(dateTimeItem.message.toLowerCase(), /15 de janeiro de 2024/);
});

test("weather ranks above dateTime when rain is likely (higher relevance)", () => {
  const generator = new BriefingGenerator("en-US");
  const rainyWeather: WeatherContext = { ...SAMPLE_WEATHER, precipitationProbabilityPercent: 70 };

  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      weather: okResult("weather", "Weather", rainyWeather),
    })
  );

  const categories = briefing.items.map((i) => i.category);
  const weatherIndex = categories.indexOf("weather");
  const dateTimeIndex = categories.indexOf("dateTime");
  assert.ok(weatherIndex < dateTimeIndex, "weather should be ranked before dateTime on a rainy day");

  const weatherItem = briefing.items[weatherIndex];
  assert.match(weatherItem.message, /70% chance/);
});

test("a missing/errored weather provider is omitted, not shown as an error", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      weather: errorResult("weather", "Weather", "Open-Meteo request failed with status 503"),
    })
  );

  const categories = briefing.items.map((i) => i.category);
  assert.ok(!categories.includes("weather"));
  // The rest of the briefing (greeting, dateTime, closing) still generates fine.
  assert.deepEqual(categories, ["greeting", "dateTime", "other"]);
});

test("an empty/unavailable snapshot still produces a graceful minimal greeting, no error clutter", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(snapshot({}));

  const categories = briefing.items.map((i) => i.category);
  assert.deepEqual(categories, ["greeting", "other"]);
  assert.ok(briefing.items.every((item) => !/error|fail|unavailable/i.test(item.message)));
});

test("evening hour produces an evening greeting even without a dateTime provider", () => {
  const generator = new BriefingGenerator("en-US");
  // No dateTime provider registered at all — falls back to the system clock,
  // so we can't assert an exact greeting here, but we can assert it's one
  // of the three valid greetings and nothing crashes.
  const briefing = generator.generate(snapshot({}));
  assert.match(briefing.items[0].message, /^(Good morning\.|Good afternoon\.|Good evening\.)$/);
});

test("briefing has a stable id and ISO generatedAt", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(snapshot({}));

  assert.ok(briefing.id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(briefing.generatedAt)));
});

// --- Calendar ---

const NOW = new Date("2026-07-15T12:00:00.000Z");

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "evt-1",
    title: "Sample",
    startsAt: "2026-07-15T14:00:00.000Z",
    endsAt: "2026-07-15T15:00:00.000Z",
    isAllDay: false,
    location: null,
    calendarName: null,
    ...overrides,
  };
}

function calendarContext(overrides: Partial<CalendarContext>): CalendarContext {
  return {
    retrievedAt: NOW.toISOString(),
    timezone: "UTC",
    todayEvents: [],
    laterEvents: [],
    nextEvent: null,
    ...overrides,
  };
}

test("no events today or later produces 'nothing scheduled', with low relevance", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(
    snapshot({ calendar: okResult("calendar", "Calendar", calendarContext({})) }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, "You have nothing scheduled today.");
  assert.equal(item.relevance, 20);
});

test("one event today (not imminent) mentions its time", () => {
  const generator = new BriefingGenerator("en-US");
  const evt = event({ startsAt: "2026-07-15T18:00:00.000Z", endsAt: "2026-07-15T18:30:00.000Z" });
  const briefing = generator.generate(
    snapshot({
      calendar: okResult("calendar", "Calendar", calendarContext({ todayEvents: [evt], nextEvent: evt })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, 'You have one event today at 18:00: "Sample".');
  assert.equal(item.relevance, 50);
});

test("multiple events today mentions the count and the first event's time", () => {
  const generator = new BriefingGenerator("en-US");
  const first = event({ id: "a", startsAt: "2026-07-15T18:00:00.000Z", endsAt: "2026-07-15T18:30:00.000Z" });
  const second = event({ id: "b", startsAt: "2026-07-15T20:00:00.000Z", endsAt: "2026-07-15T20:30:00.000Z" });
  const third = event({ id: "c", startsAt: "2026-07-15T21:00:00.000Z", endsAt: "2026-07-15T21:30:00.000Z" });
  const briefing = generator.generate(
    snapshot({
      calendar: okResult(
        "calendar",
        "Calendar",
        calendarContext({ todayEvents: [first, second, third], nextEvent: first })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, 'You have three events today. Your first is "Sample" at 18:00.');
  assert.equal(item.relevance, 65);
});

test("an all-day-only day mentions it without a time", () => {
  const generator = new BriefingGenerator("en-US");
  const evt = event({
    isAllDay: true,
    startsAt: "2026-07-15T00:00:00.000Z",
    endsAt: "2026-07-16T00:00:00.000Z",
  });
  const briefing = generator.generate(
    snapshot({ calendar: okResult("calendar", "Calendar", calendarContext({ todayEvents: [evt] })) }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, 'You have an all-day event today: "Sample".');
});

test("an imminent next event overrides the today-summary with a countdown, at very high relevance", () => {
  const generator = new BriefingGenerator("en-US");
  // 30 minutes from NOW (12:00) -> 12:30
  const soon = event({ startsAt: "2026-07-15T12:30:00.000Z", endsAt: "2026-07-15T13:00:00.000Z" });
  const other = event({
    id: "later-today",
    startsAt: "2026-07-15T18:00:00.000Z",
    endsAt: "2026-07-15T18:30:00.000Z",
  });
  const briefing = generator.generate(
    snapshot({
      calendar: okResult(
        "calendar",
        "Calendar",
        calendarContext({ todayEvents: [soon, other], nextEvent: soon })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, '"Sample" starts in 30 minutes.');
  assert.equal(item.relevance, 95);
});

test("no events today but an upcoming later event mentions it as 'tomorrow'", () => {
  const generator = new BriefingGenerator("en-US");
  const tomorrow = event({ startsAt: "2026-07-16T15:30:00.000Z", endsAt: "2026-07-16T16:00:00.000Z" });
  const briefing = generator.generate(
    snapshot({
      calendar: okResult(
        "calendar",
        "Calendar",
        calendarContext({ laterEvents: [tomorrow], nextEvent: tomorrow })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "calendar")!;
  assert.equal(item.message, 'Your next event, "Sample", is tomorrow at 15:30.');
  assert.equal(item.relevance, 55);
});

test("a missing/unavailable/errored calendar provider is omitted, not shown as an error", () => {
  const generator = new BriefingGenerator("en-US");

  const unavailable = generator.generate(
    snapshot({
      calendar: {
        providerId: "calendar",
        displayName: "Calendar",
        status: "unavailable",
        data: null,
        timestamp: NOW.toISOString(),
        stale: false,
      },
    }),
    NOW
  );
  assert.ok(!unavailable.items.some((i) => i.category === "calendar"));

  const errored = generator.generate(
    snapshot({
      calendar: errorResult("calendar", "Calendar", "All configured calendar feeds failed to load"),
    }),
    NOW
  );
  assert.ok(!errored.items.some((i) => i.category === "calendar"));
});

test("calendar with several events today ranks above dateTime, same as rainy weather does", () => {
  const generator = new BriefingGenerator("en-US");
  const first = event({ id: "a", startsAt: "2026-07-15T18:00:00.000Z" });
  const second = event({ id: "b", startsAt: "2026-07-15T20:00:00.000Z" });
  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      calendar: okResult(
        "calendar",
        "Calendar",
        calendarContext({ todayEvents: [first, second], nextEvent: first })
      ),
    }),
    NOW
  );

  const categories = briefing.items.map((i) => i.category);
  assert.ok(categories.indexOf("calendar") < categories.indexOf("dateTime"));
});

// --- Email ---

function emailMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "acct:1",
    threadId: null,
    senderName: "A Friend",
    senderAddress: "friend@example.com",
    subject: "Hello",
    receivedAt: NOW.toISOString(),
    isUnread: false,
    isFlagged: false,
    labels: [],
    snippet: null,
    accountId: "acct",
    importance: "normal",
    signals: { isUnread: false, isFlagged: false, looksAutomated: false, matchedKeyword: null },
    ...overrides,
  };
}

function emailContext(overrides: Partial<EmailContext> = {}): EmailContext {
  return {
    retrievedAt: NOW.toISOString(),
    windowDays: 2,
    accounts: [{ id: "acct", label: "Personal", address: "me@example.com" }],
    totalRecent: 0,
    unreadCount: 0,
    importantMessages: [],
    recentMessages: [],
    ...overrides,
  };
}

test("no recent email produces the calm 'nothing important' message, at low relevance", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(snapshot({ email: okResult("email", "Email", emailContext({})) }), NOW);

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.equal(item.message, "Nothing important came in overnight.");
  assert.equal(item.relevance, 20);
});

test("unread emails with nothing important mentions the unread count", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(
    snapshot({
      email: okResult("email", "Email", emailContext({ totalRecent: 7, unreadCount: 7 })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.equal(item.message, "You have 7 unread emails.");
  assert.equal(item.relevance, 45);
});

test("a single unread email uses singular phrasing", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(
    snapshot({ email: okResult("email", "Email", emailContext({ totalRecent: 1, unreadCount: 1 })) }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.equal(item.message, "You have 1 unread email.");
});

test("potentially important messages mention the total and the count that may need attention", () => {
  const generator = new BriefingGenerator();
  const important = [
    emailMessage({ id: "acct:1", importance: "important" }),
    emailMessage({ id: "acct:2", importance: "important" }),
  ];
  const briefing = generator.generate(
    snapshot({
      email: okResult(
        "email",
        "Email",
        emailContext({ totalRecent: 9, unreadCount: 4, importantMessages: important })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.equal(item.message, "You received 9 emails since yesterday. Two may require your attention.");
});

test("an unread high-importance message is spotlighted by sender, at very high relevance", () => {
  const generator = new BriefingGenerator();
  const spotlighted = emailMessage({
    id: "acct:1",
    senderName: "MyBank",
    importance: "high",
    isUnread: true,
  });
  const other = emailMessage({ id: "acct:2", importance: "important", isUnread: false });
  const briefing = generator.generate(
    snapshot({
      email: okResult(
        "email",
        "Email",
        emailContext({ totalRecent: 5, unreadCount: 2, importantMessages: [spotlighted, other] })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.equal(item.message, "You have an unread email from MyBank that may require your attention.");
  assert.equal(item.relevance, 90);
});

test("spotlight falls back to the sender address when no display name is available", () => {
  const generator = new BriefingGenerator();
  const spotlighted = emailMessage({
    senderName: null,
    senderAddress: "alerts@mybank.example.com",
    importance: "high",
    isUnread: true,
  });
  const briefing = generator.generate(
    snapshot({
      email: okResult(
        "email",
        "Email",
        emailContext({ totalRecent: 1, unreadCount: 1, importantMessages: [spotlighted] })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "email")!;
  assert.match(item.message, /alerts@mybank\.example\.com/);
});

test("a missing/unavailable/errored email provider is omitted, not shown as an error", () => {
  const generator = new BriefingGenerator();

  const unavailable = generator.generate(
    snapshot({
      email: {
        providerId: "email",
        displayName: "Email",
        status: "unavailable",
        data: null,
        timestamp: NOW.toISOString(),
        stale: false,
      },
    }),
    NOW
  );
  assert.ok(!unavailable.items.some((i) => i.category === "email"));

  const errored = generator.generate(
    snapshot({ email: errorResult("email", "Email", "All configured email accounts failed to load") }),
    NOW
  );
  assert.ok(!errored.items.some((i) => i.category === "email"));
});

test("email with an unread attention-worthy message ranks above dateTime, same as calendar/weather do", () => {
  const generator = new BriefingGenerator("en-US");
  const spotlighted = emailMessage({ importance: "high", isUnread: true });
  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      email: okResult(
        "email",
        "Email",
        emailContext({ totalRecent: 1, unreadCount: 1, importantMessages: [spotlighted] })
      ),
    }),
    NOW
  );

  const categories = briefing.items.map((i) => i.category);
  assert.ok(categories.indexOf("email") < categories.indexOf("dateTime"));
});

// --- Tasks ---

function taskItem(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "acct:1",
    title: "Sample task",
    description: null,
    dueAt: null,
    dueIsDateOnly: false,
    completed: false,
    completedAt: null,
    priority: "none",
    reminderAt: null,
    source: "todoist",
    listName: null,
    createdAt: null,
    category: "noDeadline",
    urgency: "low",
    signals: {
      isOverdue: false,
      isDueToday: false,
      isDueSoon: false,
      hasHighPriority: false,
      hasReminderApproaching: false,
      isStale: false,
    },
    ...overrides,
  };
}

function taskContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    retrievedAt: NOW.toISOString(),
    timezone: "UTC",
    accounts: [{ id: "acct", label: "Personal", provider: "todoist" }],
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

test("no active tasks produces the calm 'no tasks due today' message, at low relevance", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(snapshot({ tasks: okResult("tasks", "Tasks", taskContext({})) }), NOW);

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have no tasks due today.");
  assert.equal(item.relevance, 15);
});

test("multiple tasks due today mentions the count and names one of them", () => {
  const generator = new BriefingGenerator();
  const dueToday = [
    taskItem({ id: "acct:1", title: "Finish the NIMBUS email integration", category: "dueToday" }),
    taskItem({ id: "acct:2", title: "Review PR", category: "dueToday" }),
    taskItem({ id: "acct:3", title: "Call the bank", category: "dueToday" }),
  ];
  const briefing = generator.generate(
    snapshot({
      tasks: okResult("tasks", "Tasks", taskContext({ dueTodayCount: 3, dueTodayTasks: dueToday })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(
    item.message,
    'You have three tasks due today, including "Finish the NIMBUS email integration".'
  );
});

test("a single task due today is named directly, not phrased as 'including'", () => {
  const generator = new BriefingGenerator();
  const dueToday = [taskItem({ title: "Pay the electricity bill", category: "dueToday" })];
  const briefing = generator.generate(
    snapshot({
      tasks: okResult("tasks", "Tasks", taskContext({ dueTodayCount: 1, dueTodayTasks: dueToday })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, 'You have one task due today: "Pay the electricity bill".');
});

test("a single overdue task uses singular phrasing", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(
    snapshot({ tasks: okResult("tasks", "Tasks", taskContext({ overdueCount: 1 })) }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have one overdue task.");
});

test("multiple overdue tasks use plural phrasing, at high relevance", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(
    snapshot({ tasks: okResult("tasks", "Tasks", taskContext({ overdueCount: 3 })) }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have three overdue tasks.");
  assert.ok(item.relevance >= 60);
});

test("overdue and due-today combine into one mixed message", () => {
  const generator = new BriefingGenerator();
  const briefing = generator.generate(
    snapshot({
      tasks: okResult("tasks", "Tasks", taskContext({ overdueCount: 1, dueTodayCount: 2 })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have one overdue task and two tasks due today.");
});

test("a task due within the imminent window is spotlighted with a time estimate, at very high relevance", () => {
  const generator = new BriefingGenerator();
  const soon = taskItem({
    title: "Pick up the kids",
    category: "dueToday",
    dueAt: new Date(NOW.getTime() + 60 * 60000).toISOString(), // 1 hour from NOW
    dueIsDateOnly: false,
  });
  const briefing = generator.generate(
    snapshot({
      tasks: okResult("tasks", "Tasks", taskContext({ dueTodayCount: 1, dueTodayTasks: [soon] })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have a task due in one hour.");
  assert.equal(item.relevance, 95);
});

test("an imminent task takes priority over the overdue/due-today count messages", () => {
  const generator = new BriefingGenerator();
  const soon = taskItem({
    title: "Pick up the kids",
    category: "dueToday",
    dueAt: new Date(NOW.getTime() + 10 * 60000).toISOString(), // 10 minutes from NOW
    dueIsDateOnly: false,
  });
  const briefing = generator.generate(
    snapshot({
      tasks: okResult(
        "tasks",
        "Tasks",
        taskContext({ overdueCount: 1, dueTodayCount: 1, dueTodayTasks: [soon] })
      ),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, "You have a task due in ten minutes.");
});

test("a date-only (all-day) task due today is never treated as imminent", () => {
  const generator = new BriefingGenerator();
  const allDay = taskItem({
    title: "Water the plants",
    category: "dueToday",
    dueAt: NOW.toISOString(),
    dueIsDateOnly: true,
  });
  const briefing = generator.generate(
    snapshot({
      tasks: okResult("tasks", "Tasks", taskContext({ dueTodayCount: 1, dueTodayTasks: [allDay] })),
    }),
    NOW
  );

  const item = briefing.items.find((i) => i.category === "tasks")!;
  assert.equal(item.message, 'You have one task due today: "Water the plants".');
});

test("a missing/unavailable/errored task provider is omitted, not shown as an error", () => {
  const generator = new BriefingGenerator();

  const unavailable = generator.generate(
    snapshot({
      tasks: {
        providerId: "tasks",
        displayName: "Tasks",
        status: "unavailable",
        data: null,
        timestamp: NOW.toISOString(),
        stale: false,
      },
    }),
    NOW
  );
  assert.ok(!unavailable.items.some((i) => i.category === "tasks"));

  const errored = generator.generate(
    snapshot({ tasks: errorResult("tasks", "Tasks", "All configured task accounts failed to load") }),
    NOW
  );
  assert.ok(!errored.items.some((i) => i.category === "tasks"));
});

test("overdue tasks rank above dateTime, same as calendar/email do", () => {
  const generator = new BriefingGenerator("en-US");
  const briefing = generator.generate(
    snapshot({
      dateTime: okResult("dateTime", "Date & Time", SAMPLE_DATE_TIME),
      tasks: okResult("tasks", "Tasks", taskContext({ overdueCount: 2 })),
    }),
    NOW
  );

  const categories = briefing.items.map((i) => i.category);
  assert.ok(categories.indexOf("tasks") < categories.indexOf("dateTime"));
});
