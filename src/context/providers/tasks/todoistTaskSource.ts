import { httpTimeoutSignal } from "../../../common/timeout";
// Todoist retired the old /rest/v2 API (it now returns 410 Gone) in favor
// of a unified /api/v1 API. The underlying data model (task/project/due
// fields) is unchanged — what changed is the base path and that list
// endpoints are now paginated (see fetchTasks/fetchProjectNames below).
const API_BASE = "https://api.todoist.com/api/v1";

export interface TodoistAccountConfig {
  /** Personal API token (Settings > Integrations > Developer in Todoist). Treated as a credential — never logged, never returned to the renderer. */
  apiToken: string;
}

interface TodoistDue {
  date: string;
  datetime?: string;
  timezone?: string | null;
  is_recurring?: boolean;
}

interface TodoistTask {
  id: string;
  content?: string;
  description?: string;
  is_completed?: boolean;
  priority?: number;
  due?: TodoistDue | null;
  project_id?: string;
  created_at?: string;
}

interface TodoistProject {
  id: string;
  name?: string;
}

/**
 * What NIMBUS can actually configure when creating/updating a task —
 * intentionally a small subset of Todoist's own fields (no natural-
 * language recurrence, no labels, no sub-tasks) matching the "don't
 * over-engineer" scope of this feature. `priority` uses Todoist's own
 * wire scale (1 normal .. 4 urgent) directly rather than introducing a
 * second mapping on top of `TaskPriority`'s read-side "none/low/medium/high"
 * labels — see `writePriorityFromLabel` in taskProvider.ts for where the
 * UI's friendlier labels get translated into this scale.
 */
export interface TaskWriteInput {
  title: string;
  description?: string | null;
  /** Plain "YYYY-MM-DD" — a specific time-of-day isn't exposed by NIMBUS's task form (matches the "don't over-engineer" scope). */
  dueDate?: string | null;
  priority?: number | null;
  projectId?: string | null;
}

export interface TodoistProjectSummary {
  id: string;
  name: string;
}

/** A task as read off the wire, before urgency classification or context-shaping. */
export interface RawTaskItem {
  id: string;
  title: string;
  description: string | null;
  /** ISO instant, or null with no due date at all. */
  dueAt: string | null;
  dueIsDateOnly: boolean;
  completed: boolean;
  completedAt: string | null;
  /** 1 (normal) through 4 (urgent) on Todoist's own scale, or null. */
  sourcePriority: number | null;
  reminderAt: string | null;
  listName: string | null;
  createdAt: string | null;
}

/**
 * Reads active tasks from Todoist's REST API v2 — the external-integration
 * layer for tasks, playing the same role `IcsCalendarSource`/
 * `ImapEmailSource` play for calendar/email (see ARCHITECTURE.md).
 * `TaskProvider` (Core) depends only on this class's `fetchActiveTasks()`
 * return shape, not on Todoist or its REST API directly — a future
 * provider (a different task app, or a local list) implements the same
 * method and plugs in without `TaskProvider`/Context/UI changing.
 *
 * Uses a personal API token (Bearer auth) — no OAuth app registration
 * needed, the same reasoning behind Calendar's ICS URL and Email's IMAP
 * app password (see README's "Tasks" section).
 *
 * Only *active* tasks are ever requested — Todoist's `/tasks` endpoint
 * doesn't return completed ones at all, which is exactly the "don't
 * normally surface completed tasks" behavior the task calls for, achieved
 * by simply never fetching them rather than filtering them out after the
 * fact.
 *
 * Write methods (`createTask`/`updateTask`/`completeTask`/`reopenTask`/
 * `deleteTask`) follow Todoist's own REST conventions for mutating a
 * task: `POST /tasks` to create, `POST /tasks/{id}` to update, and
 * `POST /tasks/{id}/close|reopen` / `DELETE /tasks/{id}` for the rest —
 * none of them go through the Sync API or need anything beyond the same
 * Bearer token every read already uses.
 */
export class TodoistTaskSource {
  constructor(
    private readonly config: TodoistAccountConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  /**
   * Every Todoist request goes through here rather than calling
   * `fetchFn` directly, so the per-request timeout cannot be forgotten
   * on a call site added later — Node's `fetch` applies none of its own,
   * and a stalled request would otherwise hang the whole task provider.
   */
  private send(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: httpTimeoutSignal() });
  }

  async fetchActiveTasks(): Promise<RawTaskItem[]> {
    const [tasks, projects] = await Promise.all([this.fetchTasks(), this.fetchProjectsSafe()]);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    return tasks.map((task) => mapTask(task, projectNames));
  }

  /** For a project/list picker in the create/edit task UI. Throws on failure (unlike fetchActiveTasks's project lookup, which is best-effort) since a form with no list options is a real problem the caller should know about. */
  async fetchProjects(): Promise<TodoistProjectSummary[]> {
    const projects = await this.fetchProjectsPaged();
    return projects.filter((p) => p && p.id).map((p) => ({ id: p.id, name: p.name ?? "" }));
  }

  async createTask(input: TaskWriteInput): Promise<RawTaskItem> {
    const response = await this.send(`${API_BASE}/tasks`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(toWritePayload(input)),
    });
    if (!response.ok) {
      throw new Error(`Todoist create task failed with status ${response.status}`);
    }
    const task: TodoistTask = await response.json();
    return mapTask(task, new Map()); // a freshly created task's list name isn't needed immediately — the tab re-fetches the full list right after
  }

  async updateTask(taskId: string, input: Partial<TaskWriteInput>): Promise<RawTaskItem> {
    const response = await this.send(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(toWritePayload(input)),
    });
    if (!response.ok) {
      throw new Error(`Todoist update task failed with status ${response.status}`);
    }
    const task: TodoistTask = await response.json();
    return mapTask(task, new Map());
  }

  async completeTask(taskId: string): Promise<void> {
    await this.postAction(taskId, "close", "complete");
  }

  async reopenTask(taskId: string): Promise<void> {
    await this.postAction(taskId, "reopen", "reopen");
  }

  async deleteTask(taskId: string): Promise<void> {
    const response = await this.send(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Todoist delete task failed with status ${response.status}`);
    }
  }

  private async postAction(taskId: string, endpoint: "close" | "reopen", verb: string): Promise<void> {
    const response = await this.send(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/${endpoint}`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Todoist ${verb} task failed with status ${response.status}`);
    }
  }

  private async fetchTasks(): Promise<TodoistTask[]> {
    const tasks: TodoistTask[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await this.send(pagedUrl(`${API_BASE}/tasks`, cursor), { headers: this.authHeaders() });
      if (!response.ok) {
        throw new Error(`Todoist tasks request failed with status ${response.status}`);
      }
      const body = await response.json();
      tasks.push(...extractResults<TodoistTask>(body));
      cursor = nextCursor(body);
      pages++;
    } while (cursor && pages < MAX_PAGES);
    return tasks;
  }

  private async fetchProjectsPaged(): Promise<TodoistProject[]> {
    const projects: TodoistProject[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await this.send(pagedUrl(`${API_BASE}/projects`, cursor), { headers: this.authHeaders() });
      if (!response.ok) {
        throw new Error(`Todoist projects request failed with status ${response.status}`);
      }
      const body = await response.json();
      projects.push(...extractResults<TodoistProject>(body));
      cursor = nextCursor(body);
      pages++;
    } while (cursor && pages < MAX_PAGES);
    return projects;
  }

  /** Best-effort project id -> name map. A failure here still lets tasks through (just without a list name). */
  private async fetchProjectsSafe(): Promise<TodoistProjectSummary[]> {
    try {
      const projects = await this.fetchProjectsPaged();
      return projects.filter((p) => p && p.id).map((p) => ({ id: p.id, name: p.name ?? "" }));
    } catch {
      return [];
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiToken}` };
  }
}

/** Only ever sends fields the caller actually set — `undefined` keys are dropped by JSON.stringify, so a partial update never accidentally clears a field the user didn't touch. */
function toWritePayload(input: Partial<TaskWriteInput>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.content = input.title;
  if (input.description !== undefined) payload.description = input.description ?? "";
  if (input.dueDate !== undefined) payload.due_date = input.dueDate; // Todoist clears the due date when this is explicitly null
  if (input.priority !== undefined) payload.priority = input.priority ?? 1; // 1 is Todoist's own "no priority flag" default
  if (input.projectId !== undefined && input.projectId) payload.project_id = input.projectId;
  return payload;
}

function mapTask(task: TodoistTask, projectNames: Map<string, string>): RawTaskItem {
  const due = task.due?.date || task.due?.datetime ? task.due : null; // guard against a malformed `due: {}` with neither field
  const hasDateTime = !!due?.datetime;
  const dueAt = due ? toIso(hasDateTime ? due.datetime : due.date) : null;
  const dueIsDateOnly = dueAt !== null && !hasDateTime;

  return {
    id: String(task.id ?? ""),
    title: task.content?.trim() || "(Untitled task)",
    description: task.description?.trim() || null,
    dueAt,
    dueIsDateOnly,
    completed: !!task.is_completed,
    completedAt: null, // the REST API never returns completed tasks, so this is never observed today
    sourcePriority: typeof task.priority === "number" ? task.priority : null,
    // Todoist's REST API has no separate "reminder" concept without its
    // Sync API — a specific due time is the closest honest equivalent.
    reminderAt: hasDateTime ? dueAt : null,
    listName: task.project_id ? projectNames.get(task.project_id) || null : null,
    createdAt: task.created_at ? toIso(task.created_at) : null,
  };
}

function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The v1 API paginates every list endpoint (v2 returned a plain array) —
// a bounded page count guards against an unbounded loop if Todoist ever
// returns a cursor that never resolves to null; 20 pages is already far
// more than one person's active task/project list would ever need.
const MAX_PAGES = 20;

function pagedUrl(base: string, cursor: string | null): string {
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

/** Accepts the v1 `{ results: [...], next_cursor }` envelope; falls back to a plain array for resilience against an unexpected shape rather than silently dropping every task. */
function extractResults<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results)) {
    return (body as { results: T[] }).results;
  }
  return [];
}

function nextCursor(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const cursor = (body as { next_cursor?: unknown }).next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}
