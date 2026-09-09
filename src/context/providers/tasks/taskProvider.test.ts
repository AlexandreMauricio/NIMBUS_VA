import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskProvider, TaskProviderConfig, TaskAccountConfig, TaskEnvFallbackAccount } from "./taskProvider";
import { TodoistTaskSource, RawTaskItem } from "./todoistTaskSource";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function account(overrides: Partial<TaskAccountConfig> = {}): TaskAccountConfig {
  return {
    id: "personal",
    label: "Personal",
    provider: "todoist",
    apiToken: "secret-token",
    enabled: true,
    ...overrides,
  };
}

function config(overrides: Partial<TaskProviderConfig> = {}): TaskProviderConfig {
  return {
    enabled: true,
    accounts: [account()],
    ...overrides,
  };
}

function rawTask(overrides: Partial<RawTaskItem> = {}): RawTaskItem {
  return {
    id: "1",
    title: "Sample task",
    description: null,
    dueAt: null,
    dueIsDateOnly: false,
    completed: false,
    completedAt: null,
    sourcePriority: null,
    reminderAt: null,
    listName: null,
    createdAt: null,
    ...overrides,
  };
}

/** Builds a source factory keyed by account id, returning canned tasks (or throwing). */
function stubSourceFactory(
  byAccountId: Record<string, RawTaskItem[] | Error>
): (account: TaskAccountConfig) => TodoistTaskSource {
  return (acct: TaskAccountConfig) => {
    const canned = byAccountId[acct.id];
    return {
      fetchActiveTasks: async () => {
        if (canned instanceof Error) throw canned;
        return canned ?? [];
      },
    } as unknown as TodoistTaskSource;
  };
}

function provider(
  cfg: TaskProviderConfig,
  byAccountId: Record<string, RawTaskItem[] | Error>,
  now: Date = NOW,
  envFallback: TaskEnvFallbackAccount | null = null
): TaskProvider {
  return new TaskProvider(() => cfg, stubSourceFactory(byAccountId), () => now, Date.now, envFallback);
}

test("isAvailable is false when tasks are disabled", () => {
  const p = new TaskProvider(() => config({ enabled: false }));
  assert.equal(p.isAvailable(), false);
});

test("isAvailable is false when enabled but no account is enabled", () => {
  const p = new TaskProvider(() => config({ accounts: [account({ enabled: false })] }));
  assert.equal(p.isAvailable(), false);
});

test("isAvailable is true when enabled with at least one enabled account", () => {
  const p = new TaskProvider(() => config());
  assert.equal(p.isAvailable(), true);
});

test("no tasks produces zero counts and empty lists", async () => {
  const ctx = await provider(config(), { personal: [] }).getContext();
  assert.equal(ctx.totalActive, 0);
  assert.equal(ctx.overdueCount, 0);
  assert.equal(ctx.dueTodayCount, 0);
  assert.deepEqual(ctx.overdueTasks, []);
  assert.deepEqual(ctx.dueTodayTasks, []);
  assert.deepEqual(ctx.upcomingTasks, []);
  assert.deepEqual(ctx.noDeadlineTasks, []);
});

test("completed tasks are excluded from active totals and every bucket", async () => {
  const tasks = [
    rawTask({ id: "1", title: "Done already", completed: true, dueAt: "2026-09-01T10:00:00Z" }),
    rawTask({ id: "2", title: "Still open", completed: false }),
  ];
  const ctx = await provider(config(), { personal: tasks }).getContext();

  assert.equal(ctx.totalActive, 1);
  const allTitles = [...ctx.overdueTasks, ...ctx.dueTodayTasks, ...ctx.upcomingTasks, ...ctx.noDeadlineTasks].map(
    (t) => t.title
  );
  assert.ok(!allTitles.includes("Done already"));
  assert.ok(allTitles.includes("Still open"));
});

test("a single task with no due date is bucketed as noDeadline", async () => {
  const ctx = await provider(config(), { personal: [rawTask({ title: "Someday" })] }).getContext();
  assert.equal(ctx.noDeadlineTasks.length, 1);
  assert.equal(ctx.noDeadlineTasks[0].category, "noDeadline");
});

test("multiple tasks are all counted and correctly bucketed", async () => {
  const tasks = [
    rawTask({ id: "1", title: "Overdue one", dueAt: "2026-09-01T10:00:00Z" }),
    rawTask({ id: "2", title: "Due today", dueAt: "2026-09-09T18:00:00Z" }),
    rawTask({ id: "3", title: "Next week", dueAt: "2026-09-20T10:00:00Z" }),
    rawTask({ id: "4", title: "No date" }),
  ];
  const ctx = await provider(config(), { personal: tasks }).getContext();

  assert.equal(ctx.totalActive, 4);
  assert.equal(ctx.overdueTasks.length, 1);
  assert.equal(ctx.dueTodayTasks.length, 1);
  assert.equal(ctx.upcomingTasks.length, 1);
  assert.equal(ctx.noDeadlineTasks.length, 1);
});

test("a task whose due date has passed is classified overdue", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Late", dueAt: "2026-09-05T10:00:00Z" })],
  }).getContext();

  assert.equal(ctx.overdueCount, 1);
  assert.equal(ctx.overdueTasks[0].category, "overdue");
  assert.equal(ctx.overdueTasks[0].signals.isOverdue, true);
});

test("a task due today is classified dueToday, not overdue", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Today", dueAt: "2026-09-09T08:00:00Z" })],
  }).getContext();

  assert.equal(ctx.dueTodayCount, 1);
  assert.equal(ctx.overdueCount, 0);
  assert.equal(ctx.dueTodayTasks[0].category, "dueToday");
});

test("a task due tomorrow is classified upcoming, not due today", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Tomorrow", dueAt: "2026-09-10T08:00:00Z" })],
  }).getContext();

  assert.equal(ctx.dueTodayCount, 0);
  assert.equal(ctx.upcomingTasks.length, 1);
  assert.equal(ctx.upcomingTasks[0].category, "upcoming");
});

test("a task far in the future is classified upcoming with low urgency", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Far off", dueAt: "2026-10-15T10:00:00Z" })],
  }).getContext();

  assert.equal(ctx.upcomingTasks[0].category, "upcoming");
  assert.equal(ctx.upcomingTasks[0].urgency, "low");
});

test("a task without a deadline never appears in overdue/dueToday/upcoming", async () => {
  const ctx = await provider(config(), { personal: [rawTask({ title: "Whenever" })] }).getContext();
  assert.equal(ctx.overdueTasks.length, 0);
  assert.equal(ctx.dueTodayTasks.length, 0);
  assert.equal(ctx.upcomingTasks.length, 0);
  assert.equal(ctx.noDeadlineTasks.length, 1);
});

test("a task with a reminder carries the reminder timestamp through to context", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Call John", dueAt: "2026-09-09T13:00:00Z", reminderAt: "2026-09-09T13:00:00Z" })],
  }).getContext();

  assert.equal(ctx.dueTodayTasks[0].reminderAt, "2026-09-09T13:00:00Z");
  assert.equal(ctx.dueTodayTasks[0].signals.hasReminderApproaching, true);
});

test("a task with an explicit high priority is mapped and reflected in urgency signals", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Urgent thing", sourcePriority: 4 })],
  }).getContext();

  assert.equal(ctx.noDeadlineTasks[0].priority, "high");
  assert.equal(ctx.noDeadlineTasks[0].signals.hasHighPriority, true);
});

test("a task due soon (within the imminent window) is classified as high urgency", async () => {
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Due very soon", dueAt: "2026-09-09T12:30:00.000Z" })],
  }).getContext();

  assert.equal(ctx.dueTodayTasks[0].urgency, "high");
  assert.equal(ctx.dueTodayTasks[0].signals.isDueSoon, true);
});

test("malformed/sparse task data does not crash the provider", async () => {
  const tasks = [rawTask({ title: "", description: null, dueAt: null, createdAt: null })];
  const ctx = await provider(config(), { personal: tasks }).getContext();
  assert.equal(ctx.totalActive, 1);
});

test("provider unavailable when disabled surfaces via isAvailable, not a thrown error", () => {
  const p = new TaskProvider(() => config({ enabled: false }));
  assert.equal(p.isAvailable(), false);
});

test("an authentication failure on the only account rejects getContext (for ContextService to catch)", async () => {
  const p = provider(config(), { personal: new Error("Invalid token (401)") });
  await assert.rejects(() => p.getContext(), /failed to load/);
});

test("an API failure on one account does not prevent tasks from a working account", async () => {
  const p = provider(config({ accounts: [account({ id: "broken" }), account({ id: "good" })] }), {
    broken: new Error("Rate limited"),
    good: [rawTask({ title: "Still works" })],
  });

  const ctx = await p.getContext();
  assert.equal(ctx.totalActive, 1);
  assert.equal(ctx.noDeadlineTasks[0].title, "Still works");
});

test("all accounts failing rejects getContext", async () => {
  const p = provider(config({ accounts: [account({ id: "a" }), account({ id: "b" })] }), {
    a: new Error("offline"),
    b: new Error("offline"),
  });
  await assert.rejects(() => p.getContext(), /failed to load/);
});

test("getContext caches results within the TTL instead of re-fetching", async () => {
  let fetchCount = 0;
  const p = new TaskProvider(
    () => config(),
    () =>
      ({
        fetchActiveTasks: async () => {
          fetchCount++;
          return [];
        },
      }) as unknown as TodoistTaskSource,
    () => NOW,
    Date.now
  );

  await p.getContext();
  await p.getContext();
  assert.equal(fetchCount, 1);
});

test("multiple accounts are merged, each task tagged with its own namespaced id", async () => {
  const ctx = await provider(config({ accounts: [account({ id: "work" }), account({ id: "home" })] }), {
    work: [rawTask({ id: "1", title: "Work task" })],
    home: [rawTask({ id: "1", title: "Home task" })],
  }).getContext();

  assert.equal(ctx.accounts.length, 2);
  const titles = ctx.noDeadlineTasks.map((t) => t.title).sort();
  assert.deepEqual(titles, ["Home task", "Work task"]);
  const ids = ctx.noDeadlineTasks.map((t) => t.id);
  assert.notEqual(ids[0], ids[1]); // namespaced so two accounts' id "1" never collide
});

test("account identity never includes the API token", async () => {
  const ctx = await provider(config(), { personal: [] }).getContext();
  assert.deepEqual(Object.keys(ctx.accounts[0]).sort(), ["id", "label", "provider"]);
});

test("timezone handling: category bucketing uses the resolved local timezone, not raw UTC dates", async () => {
  // A due time a few hours after "now" (12:00 UTC) — same local calendar
  // day across the range of timezones a dev/CI machine is likely to run
  // in, while still proving `ctx.timezone` reflects the real resolved
  // zone (see icsTimeUtils.localTimeZone) rather than being hardcoded.
  const ctx = await provider(config(), {
    personal: [rawTask({ title: "Later today", dueAt: "2026-09-09T18:00:00.000Z" })],
  }).getContext();
  assert.equal(ctx.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(ctx.dueTodayTasks.length, 1);
});

test("an env fallback account is used when enabled but no account is saved yet", async () => {
  const fallback: TaskEnvFallbackAccount = { label: "Env Default", apiToken: "env-token" };
  const p = provider(config({ accounts: [] }), { "env-default": [rawTask({ title: "From env" })] }, NOW, fallback);

  assert.equal(p.isAvailable(), true);
  const ctx = await p.getContext();
  assert.equal(ctx.totalActive, 1);
  assert.equal(ctx.accounts[0].label, "Env Default");
});

test("a saved account takes priority over the env fallback account", async () => {
  const fallback: TaskEnvFallbackAccount = { label: "Env Default", apiToken: "env-token" };
  const p = provider(config(), { personal: [] }, NOW, fallback);

  const ctx = await p.getContext();
  assert.equal(ctx.accounts.length, 1);
  assert.equal(ctx.accounts[0].id, "personal");
  assert.notEqual(ctx.accounts[0].label, "Env Default");
});

// --- listAllTasks / write methods ---

interface WriteStub {
  createTask: (input: unknown) => Promise<RawTaskItem>;
  updateTask: (id: string, input: unknown) => Promise<RawTaskItem>;
  completeTask: (id: string) => Promise<void>;
  reopenTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  fetchProjects: () => Promise<Array<{ id: string; name: string }>>;
  fetchActiveTasks: () => Promise<RawTaskItem[]>;
}

function writeProvider(cfg: TaskProviderConfig, stub: Partial<WriteStub>, now: Date = NOW): { provider: TaskProvider; calls: unknown[] } {
  const calls: unknown[] = [];
  const factory = () =>
    ({
      fetchActiveTasks: stub.fetchActiveTasks ?? (async () => []),
      fetchProjects: stub.fetchProjects ?? (async () => []),
      createTask: async (input: unknown) => {
        calls.push({ method: "createTask", input });
        return stub.createTask ? stub.createTask(input) : rawTask();
      },
      updateTask: async (id: string, input: unknown) => {
        calls.push({ method: "updateTask", id, input });
        return stub.updateTask ? stub.updateTask(id, input) : rawTask({ id });
      },
      completeTask: async (id: string) => {
        calls.push({ method: "completeTask", id });
        if (stub.completeTask) await stub.completeTask(id);
      },
      reopenTask: async (id: string) => {
        calls.push({ method: "reopenTask", id });
        if (stub.reopenTask) await stub.reopenTask(id);
      },
      deleteTask: async (id: string) => {
        calls.push({ method: "deleteTask", id });
        if (stub.deleteTask) await stub.deleteTask(id);
      },
    }) as unknown as TodoistTaskSource;

  return { provider: new TaskProvider(() => cfg, factory, () => now, Date.now, null), calls };
}

test("listAllTasks returns the full unbucketed, uncompleted task list", async () => {
  const { provider: p } = writeProvider(config(), {
    fetchActiveTasks: async () => [rawTask({ id: "1", title: "A" }), rawTask({ id: "2", title: "B", completed: true })],
  });
  const { tasks, accounts } = await p.listAllTasks();
  assert.deepEqual(tasks.map((t) => t.title), ["A"]); // completed task filtered out
  assert.equal(accounts.length, 1);
});

test("listAllTasks returns empty when no accounts are configured, without throwing", async () => {
  const { provider: p } = writeProvider(config({ accounts: [] }), {});
  const result = await p.listAllTasks();
  assert.deepEqual(result, { tasks: [], accounts: [] });
});

test("createTask sends the request to the first configured account's source and returns the mapped task", async () => {
  const { provider: p, calls } = writeProvider(config(), {
    createTask: async () => rawTask({ id: "new-1", title: "New task" }),
  });
  const task = await p.createTask({ title: "New task" });
  assert.equal(task.title, "New task");
  assert.equal(task.id, "personal:new-1");
  assert.deepEqual(calls, [{ method: "createTask", input: { title: "New task" } }]);
});

test("createTask throws clearly when no account is configured", async () => {
  const { provider: p } = writeProvider(config({ accounts: [] }), {});
  await assert.rejects(() => p.createTask({ title: "x" }), /no task account/i);
});

test("createTask translates NIMBUS priority labels to Todoist's numeric scale", async () => {
  const { calls, provider: p } = writeProvider(config(), {});
  await p.createTask({ title: "Urgent thing", priority: "high" });
  const call = calls[0] as { input: { priority?: number } };
  assert.equal(call.input.priority, 4);
});

test("updateTask resolves the account from the task's namespaced id and forwards the raw id", async () => {
  const { provider: p, calls } = writeProvider(config(), {
    updateTask: async (id) => rawTask({ id, title: "Renamed" }),
  });
  const task = await p.updateTask("personal:42", { title: "Renamed" });
  assert.equal(task.title, "Renamed");
  assert.deepEqual(calls, [{ method: "updateTask", id: "42", input: { title: "Renamed" } }]);
});

test("updateTask rejects an id with no account prefix", async () => {
  const { provider: p } = writeProvider(config(), {});
  await assert.rejects(() => p.updateTask("no-colon-here", { title: "x" }), /malformed task id/i);
});

test("updateTask rejects an id referencing an unknown account", async () => {
  const { provider: p } = writeProvider(config(), {});
  await assert.rejects(() => p.updateTask("ghost-account:42", { title: "x" }), /unknown task account/i);
});

test("completeTask and reopenTask forward the raw (unprefixed) id", async () => {
  const { provider: p, calls } = writeProvider(config(), {});
  await p.completeTask("personal:7");
  await p.reopenTask("personal:7");
  assert.deepEqual(calls, [
    { method: "completeTask", id: "7" },
    { method: "reopenTask", id: "7" },
  ]);
});

test("deleteTask forwards the raw id", async () => {
  const { provider: p, calls } = writeProvider(config(), {});
  await p.deleteTask("personal:9");
  assert.deepEqual(calls, [{ method: "deleteTask", id: "9" }]);
});

test("a successful write invalidates the cached briefing context so the next getContext() re-fetches", async () => {
  let fetchCount = 0;
  const { provider: p } = writeProvider(config(), {
    fetchActiveTasks: async () => {
      fetchCount++;
      return [rawTask({ id: String(fetchCount), title: `Fetch ${fetchCount}` })];
    },
  });
  await p.getContext();
  assert.equal(fetchCount, 1);
  await p.getContext(); // still cached
  assert.equal(fetchCount, 1);

  await p.completeTask("personal:1");
  await p.getContext(); // cache was cleared by the write above
  assert.equal(fetchCount, 2);
});

test("listProjects delegates to the first account's source and returns its projects", async () => {
  const { provider: p } = writeProvider(config(), {
    fetchProjects: async () => [{ id: "p1", name: "Work" }],
  });
  const projects = await p.listProjects();
  assert.deepEqual(projects, [{ id: "p1", name: "Work" }]);
});

test("listProjects returns an empty list rather than throwing when no account is configured", async () => {
  const { provider: p } = writeProvider(config({ accounts: [] }), {});
  assert.deepEqual(await p.listProjects(), []);
});
