import { ContextProvider } from "../../types";
import { TtlCache } from "../../../common/ttlCache";
import { logger } from "../../../logging/logger";
import { localTimeZone, localCalendarDate } from "../calendar/icsTimeUtils";
import { TodoistTaskSource, TodoistAccountConfig, RawTaskItem, TaskWriteInput, TodoistProjectSummary } from "./todoistTaskSource";
import { classifyTaskUrgency } from "./taskRelevance";
import { TaskContext, TaskItem, TaskAccountInfo, TaskCategory, TaskPriority } from "./types";

/** What a caller configures when creating/updating a task through NIMBUS — `priority` uses NIMBUS's own read-side labels (see `TaskPriority`) rather than Todoist's numeric scale, so the create/edit form and the task cards speak the same vocabulary. */
export interface TaskWriteRequest {
  title: string;
  description?: string | null;
  /** Plain "YYYY-MM-DD", or null to clear an existing due date. Omit to leave unchanged on an update. */
  dueDate?: string | null;
  priority?: TaskPriority;
  projectId?: string | null;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — tasks can change about as often as email
const NEAR_DEADLINE_CACHE_TTL_MS = 60 * 1000; // refresh sooner once something is imminent
const IMMINENT_WINDOW_MS = 2 * 60 * 60 * 1000; // matches taskRelevance's DUE_SOON_MINUTES
const MAX_TASKS_PER_CATEGORY_SAMPLE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskAccountConfig {
  id: string;
  label: string;
  /** Which connector this account uses — only "todoist" exists today, kept explicit so a future provider can be added without changing this shape. */
  provider: "todoist";
  /** Treated as a credential — never logged, never returned to the renderer. */
  apiToken: string;
  enabled: boolean;
}

/** What TaskProvider needs from settings — structurally matches `TaskSettings` in settingsManager.ts. */
export interface TaskProviderConfig {
  enabled: boolean;
  accounts: TaskAccountConfig[];
}

/** Minimal shape for an environment-sourced default account — see config.ts's `taskAccount`. */
export interface TaskEnvFallbackAccount {
  label: string;
  apiToken: string;
}

/**
 * Context provider for the user's tasks/reminders. Implements the same
 * ContextProvider contract as every other provider — nothing outside this
 * module (and briefingGenerator.ts) needs to know tasks come from Todoist,
 * or that a deterministic urgency model exists at all.
 *
 * Like Calendar/Email, `isAvailable()` is a real, cheap check: task
 * awareness is opt-in and requires at least one configured account, so
 * "not set up" reads as `status: "unavailable"` rather than a failed
 * fetch attempt.
 *
 * Multiple accounts are read independently (`Promise.allSettled`) — one
 * broken account (bad token, service down) never blocks the others. Only
 * when *every* account fails does this throw, which ContextService turns
 * into the standard error/stale-fallback result. This is also where NIMBUS
 * stays multi-provider-ready without over-building it: today only
 * `provider: "todoist"` exists, but the account shape and this fan-out
 * already support a second connector type showing up later.
 */
export class TaskProvider implements ContextProvider<TaskContext> {
  readonly id = "tasks";
  readonly displayName = "Tasks";

  private readonly cache: TtlCache<TaskContext>;

  constructor(
    private readonly getSettings: () => TaskProviderConfig,
    private readonly sourceFactory: (account: TaskAccountConfig) => TodoistTaskSource = (account) =>
      new TodoistTaskSource(toTodoistConfig(account)),
    private readonly now: () => Date = () => new Date(),
    cacheClock: () => number = Date.now,
    /** Optional default account sourced from the environment — same role as calendar/email's env fallbacks. */
    private readonly envFallbackAccount: TaskEnvFallbackAccount | null = null
  ) {
    this.cache = new TtlCache(DEFAULT_CACHE_TTL_MS, cacheClock);
  }

  /** Convenience constructor for real usage — production wiring only needs `getSettings` + the env fallback. */
  static withDefaults(
    getSettings: () => TaskProviderConfig,
    envFallbackAccount: TaskEnvFallbackAccount | null = null
  ): TaskProvider {
    return new TaskProvider(getSettings, undefined, undefined, undefined, envFallbackAccount);
  }

  isAvailable(): boolean {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    return this.effectiveAccounts(settings).length > 0;
  }

  async getContext(): Promise<TaskContext> {
    const cached = this.cache.get();
    if (cached) return cached;

    const settings = this.getSettings();
    const enabledAccounts = this.effectiveAccounts(settings);
    if (enabledAccounts.length === 0) {
      throw new Error("Tasks are enabled but no accounts are configured");
    }

    const timezone = localTimeZone();
    const now = this.now();

    const results = await Promise.allSettled(
      enabledAccounts.map((account) => this.fetchAccountTasks(account, timezone, now))
    );

    const allTasks: TaskItem[] = [];
    const accounts: TaskAccountInfo[] = [];
    let successCount = 0;

    results.forEach((result, i) => {
      const account = enabledAccounts[i];
      accounts.push({ id: account.id, label: account.label, provider: account.provider });
      if (result.status === "fulfilled") {
        successCount++;
        allTasks.push(...result.value);
      } else {
        // Never log the API token — label/id only.
        logger.warn(`Task account "${account.label}" failed`, {
          accountId: account.id,
          error: String(result.reason),
        });
      }
    });

    if (successCount === 0) {
      throw new Error("All configured task accounts failed to load");
    }

    const context = buildContext(allTasks, accounts, timezone, now);

    const ttl = hasImminentDeadline(context, now) ? NEAR_DEADLINE_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
    this.cache.set(context, ttl);

    return context;
  }

  /**
   * The full active task list, unbucketed and uncapped — unlike
   * `getContext()` (briefing-focused: bucketed by deadline, capped at
   * `MAX_TASKS_PER_CATEGORY_SAMPLE` each), this is what the Tasks tab's
   * list/grid view reads. Deliberately a separate method rather than a
   * "give me everything" flag on `getContext()` — the briefing shape and
   * the management-view shape have different callers and different
   * freshness needs (this always re-fetches; `getContext()` is cached
   * for the briefing's sake).
   */
  async listAllTasks(): Promise<{ tasks: TaskItem[]; accounts: TaskAccountInfo[] }> {
    const settings = this.getSettings();
    const enabledAccounts = this.effectiveAccounts(settings);
    if (enabledAccounts.length === 0) return { tasks: [], accounts: [] };

    const timezone = localTimeZone();
    const now = this.now();
    const results = await Promise.allSettled(
      enabledAccounts.map((account) => this.fetchAccountTasks(account, timezone, now))
    );

    const tasks: TaskItem[] = [];
    const accounts: TaskAccountInfo[] = [];
    results.forEach((result, i) => {
      const account = enabledAccounts[i];
      accounts.push({ id: account.id, label: account.label, provider: account.provider });
      if (result.status === "fulfilled") {
        tasks.push(...result.value);
      } else {
        logger.warn(`Task account "${account.label}" failed`, { accountId: account.id, error: String(result.reason) });
      }
    });

    return { tasks: tasks.filter((t) => !t.completed), accounts };
  }

  /** Project/list options for the create/edit task form — from the first configured account, since NIMBUS's task form doesn't expose an account picker (see this file's own note on why: most setups have exactly one). */
  async listProjects(): Promise<TodoistProjectSummary[]> {
    const account = this.defaultAccount();
    if (!account) return [];
    return this.sourceFactory(account).fetchProjects();
  }

  async createTask(request: TaskWriteRequest): Promise<TaskItem> {
    const account = this.defaultAccount();
    if (!account) throw new Error("No task account is configured.");
    const raw = await this.sourceFactory(account).createTask(toWriteInput(request) as TaskWriteInput);
    this.cache.clear();
    return toTaskItem(raw, account.id, account.provider, localTimeZone(), this.now());
  }

  async updateTask(taskId: string, request: Partial<TaskWriteRequest>): Promise<TaskItem> {
    const { account, rawId } = this.resolveAccount(taskId);
    const raw = await this.sourceFactory(account).updateTask(rawId, toWriteInput(request));
    this.cache.clear();
    return toTaskItem(raw, account.id, account.provider, localTimeZone(), this.now());
  }

  async completeTask(taskId: string): Promise<void> {
    const { account, rawId } = this.resolveAccount(taskId);
    await this.sourceFactory(account).completeTask(rawId);
    this.cache.clear();
  }

  async reopenTask(taskId: string): Promise<void> {
    const { account, rawId } = this.resolveAccount(taskId);
    await this.sourceFactory(account).reopenTask(rawId);
    this.cache.clear();
  }

  async deleteTask(taskId: string): Promise<void> {
    const { account, rawId } = this.resolveAccount(taskId);
    await this.sourceFactory(account).deleteTask(rawId);
    this.cache.clear();
  }

  private defaultAccount(): TaskAccountConfig | null {
    const accounts = this.effectiveAccounts(this.getSettings());
    return accounts[0] ?? null;
  }

  /** A TaskItem's `id` is `${accountId}:${rawId}` (see `toTaskItem`) — this is the one place that splits it back apart to route a write to the right account's source. */
  private resolveAccount(taskId: string): { account: TaskAccountConfig; rawId: string } {
    const separatorIndex = taskId.indexOf(":");
    if (separatorIndex === -1) throw new Error(`Malformed task id "${taskId}".`);
    const accountId = taskId.slice(0, separatorIndex);
    const rawId = taskId.slice(separatorIndex + 1);
    const account = this.effectiveAccounts(this.getSettings()).find((a) => a.id === accountId);
    if (!account) throw new Error(`Unknown task account "${accountId}".`);
    return { account, rawId };
  }

  private effectiveAccounts(settings: TaskProviderConfig): TaskAccountConfig[] {
    const enabled = settings.accounts.filter((account) => account.enabled);
    if (enabled.length > 0 || !this.envFallbackAccount) return enabled;
    return [{ id: "env-default", provider: "todoist", enabled: true, ...this.envFallbackAccount }];
  }

  private async fetchAccountTasks(account: TaskAccountConfig, timezone: string, now: Date): Promise<TaskItem[]> {
    const source = this.sourceFactory(account);
    const raw = await source.fetchActiveTasks();
    return raw.map((task) => toTaskItem(task, account.id, account.provider, timezone, now));
  }
}

function hasImminentDeadline(context: TaskContext, now: Date): boolean {
  const nowMs = now.getTime();
  return [...context.overdueTasks, ...context.dueTodayTasks, ...context.upcomingTasks].some((task) => {
    if (!task.dueAt || task.dueIsDateOnly) return false;
    const msUntil = new Date(task.dueAt).getTime() - nowMs;
    return msUntil >= 0 && msUntil <= IMMINENT_WINDOW_MS;
  });
}

function mapPriority(sourcePriority: number | null): TaskPriority {
  if (sourcePriority === null) return "none";
  if (sourcePriority >= 4) return "high";
  if (sourcePriority === 3) return "medium";
  return "low"; // Todoist's default/lowest priority is 1
}

function toTaskItem(raw: RawTaskItem, accountId: string, source: string, timezone: string, now: Date): TaskItem {
  const todayDate = localCalendarDate(now.toISOString(), timezone);

  const category: TaskCategory = raw.completed
    ? "noDeadline" // never surfaced — buildContext filters completed tasks out of every bucket
    : !raw.dueAt
      ? "noDeadline"
      : localCalendarDate(raw.dueAt, timezone) < todayDate
        ? "overdue"
        : localCalendarDate(raw.dueAt, timezone) === todayDate
          ? "dueToday"
          : "upcoming";

  const minutesUntilDue =
    raw.dueAt && !raw.dueIsDateOnly ? (new Date(raw.dueAt).getTime() - now.getTime()) / 60000 : null;
  const minutesUntilReminder = raw.reminderAt ? (new Date(raw.reminderAt).getTime() - now.getTime()) / 60000 : null;
  const ageDays = raw.createdAt ? (now.getTime() - new Date(raw.createdAt).getTime()) / DAY_MS : null;

  const { urgency, signals } = classifyTaskUrgency({
    isOverdue: category === "overdue",
    isDueToday: category === "dueToday",
    minutesUntilDue,
    minutesUntilReminder,
    sourceHighPriority: (raw.sourcePriority ?? 0) >= 3,
    ageDays,
    completed: raw.completed,
  });

  return {
    id: `${accountId}:${raw.id}`,
    title: raw.title,
    description: raw.description,
    dueAt: raw.dueAt,
    dueIsDateOnly: raw.dueIsDateOnly,
    completed: raw.completed,
    completedAt: raw.completedAt,
    priority: mapPriority(raw.sourcePriority),
    reminderAt: raw.reminderAt,
    source,
    listName: raw.listName,
    createdAt: raw.createdAt,
    category,
    urgency,
    signals,
  };
}

function buildContext(tasks: TaskItem[], accounts: TaskAccountInfo[], timezone: string, now: Date): TaskContext {
  // Completed tasks should not normally appear in the active briefing/context.
  // Todoist's REST API never returns them in the first place; this filter
  // is what makes that true for any future provider too, even one that does
  // return them.
  const items = tasks.filter((task) => !task.completed);

  const byDueThenTitle = (a: TaskItem, b: TaskItem) =>
    (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.title.localeCompare(b.title);

  const overdueTasks = items.filter((t) => t.category === "overdue").sort(byDueThenTitle);
  const dueTodayTasks = items.filter((t) => t.category === "dueToday").sort(byDueThenTitle);
  const upcomingTasks = items.filter((t) => t.category === "upcoming").sort(byDueThenTitle);
  const noDeadlineTasks = items.filter((t) => t.category === "noDeadline");

  return {
    retrievedAt: now.toISOString(),
    timezone,
    accounts,
    totalActive: items.length,
    overdueCount: overdueTasks.length,
    dueTodayCount: dueTodayTasks.length,
    overdueTasks: overdueTasks.slice(0, MAX_TASKS_PER_CATEGORY_SAMPLE),
    dueTodayTasks: dueTodayTasks.slice(0, MAX_TASKS_PER_CATEGORY_SAMPLE),
    upcomingTasks: upcomingTasks.slice(0, MAX_TASKS_PER_CATEGORY_SAMPLE),
    noDeadlineTasks: noDeadlineTasks.slice(0, MAX_TASKS_PER_CATEGORY_SAMPLE),
  };
}

function toTodoistConfig(account: TaskAccountConfig): TodoistAccountConfig {
  return { apiToken: account.apiToken };
}

/**
 * Translates NIMBUS's read-side priority labels into Todoist's own
 * numeric scale for a write — the reverse of `mapPriority` above.
 * Deliberately simple/lossy in the same direction `mapPriority` already
 * is (both "low" and Todoist's literal absence of a priority collapse
 * together): "none" and "low" both write `1` (Todoist's own default,
 * unflagged priority — there's no separate "explicitly no priority"
 * value on the wire), "medium" writes `3`, "high" writes `4`.
 */
const PRIORITY_LABEL_TO_TODOIST: Record<TaskPriority, number> = { none: 1, low: 1, medium: 3, high: 4 };

function toWriteInput(request: Partial<TaskWriteRequest>): Partial<TaskWriteInput> {
  const input: Partial<TaskWriteInput> = {};
  if (request.title !== undefined) input.title = request.title;
  if (request.description !== undefined) input.description = request.description;
  if (request.dueDate !== undefined) input.dueDate = request.dueDate;
  if (request.priority !== undefined) input.priority = PRIORITY_LABEL_TO_TODOIST[request.priority];
  if (request.projectId !== undefined) input.projectId = request.projectId;
  return input;
}
