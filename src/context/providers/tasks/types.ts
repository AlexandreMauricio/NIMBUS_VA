/**
 * Data model for NIMBUS's task/reminder awareness — deliberately generic,
 * not shaped around any one task application. `source` identifies which
 * connector produced a given task (only "todoist" exists today, see
 * todoistTaskSource.ts), so a future second provider can contribute to the
 * same `TaskContext` without this shape changing.
 */

/** Deterministic urgency tier — see taskRelevance.ts. Mirrors EmailImportance's low/normal/important/high scale. */
export type TaskUrgency = "low" | "normal" | "important" | "high";

/** The task's own explicit priority marking in its source app, when it has one. Distinct from the computed `urgency` tier below. */
export type TaskPriority = "none" | "low" | "medium" | "high";

/** Which deadline bucket a task falls into "as of now" — completed tasks are never bucketed here. */
export type TaskCategory = "overdue" | "dueToday" | "upcoming" | "noDeadline";

export interface TaskUrgencySignals {
  isOverdue: boolean;
  isDueToday: boolean;
  /** Due at a specific (non-all-day) time within the "imminent" window — see taskRelevance.ts. */
  isDueSoon: boolean;
  hasHighPriority: boolean;
  /** A reminder timestamp exists and falls within the "approaching" window. */
  hasReminderApproaching: boolean;
  /** Created a while ago and still not completed — a small nudge, not a strong signal on its own. */
  isStale: boolean;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  /** ISO instant, or null if the task has no due date at all. */
  dueAt: string | null;
  /** True when the task only has a due *date* (all-day), not a specific time. */
  dueIsDateOnly: boolean;
  completed: boolean;
  completedAt: string | null;
  /** Explicit priority marking from the source app, when available (e.g. Todoist's 1-4 scale, mapped down to this). */
  priority: TaskPriority;
  /**
   * ISO instant of a reminder for this task, or null. Today this mirrors a
   * timed due date (the only reminder-like signal the Todoist REST API
   * exposes without its separate Sync API) — see todoistTaskSource.ts. Kept
   * as its own field so a future provider with real, distinct reminders
   * (independent of the due date) can populate it without a shape change.
   */
  reminderAt: string | null;
  /** Which connector produced this task, e.g. "todoist". */
  source: string;
  /** Project/list name, when the source has one. */
  listName: string | null;
  createdAt: string | null;
  category: TaskCategory;
  urgency: TaskUrgency;
  signals: TaskUrgencySignals;
}

export interface TaskAccountInfo {
  id: string;
  label: string;
  provider: string;
}

export interface TaskContext {
  retrievedAt: string;
  timezone: string;
  accounts: TaskAccountInfo[];
  totalActive: number;
  overdueCount: number;
  dueTodayCount: number;
  overdueTasks: TaskItem[];
  dueTodayTasks: TaskItem[];
  upcomingTasks: TaskItem[];
  noDeadlineTasks: TaskItem[];
}
