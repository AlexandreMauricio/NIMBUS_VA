import { TaskUrgency, TaskUrgencySignals } from "./types";

/**
 * Deterministic task urgency scoring — no LLM/AI involved. Mirrors
 * emailImportance.ts's approach: a small point-based scorer over cheap,
 * inspectable signals, mapped to a tier. The goal is to produce useful
 * structured signals (both the tier and the raw `signals` that produced
 * it) that a future NIMBUS Intelligence layer can reason over — not to
 * make a final "smart" judgment call itself.
 */

/** A due time within this many minutes counts as "due soon" (imminent). */
const DUE_SOON_MINUTES = 120;
/** A reminder within this many minutes counts as "approaching". */
const REMINDER_APPROACHING_MINUTES = 60;
/** A still-open task created this long ago is nudged as "stale". */
const STALE_AGE_DAYS = 14;

export interface UrgencyInput {
  isOverdue: boolean;
  isDueToday: boolean;
  /** Minutes from `now` until `dueAt`, or null if there's no specific due time. */
  minutesUntilDue: number | null;
  /** Minutes from `now` until `reminderAt`, or null if there's no reminder. */
  minutesUntilReminder: number | null;
  /** True when the source's own priority marking is at (or near) its highest level. */
  sourceHighPriority: boolean;
  /** Days since the task was created, or null if unknown. */
  ageDays: number | null;
  completed: boolean;
}

export function classifyTaskUrgency(input: UrgencyInput): { urgency: TaskUrgency; signals: TaskUrgencySignals } {
  const isDueSoon =
    input.minutesUntilDue !== null && input.minutesUntilDue >= 0 && input.minutesUntilDue <= DUE_SOON_MINUTES;
  const hasReminderApproaching =
    input.minutesUntilReminder !== null &&
    input.minutesUntilReminder >= 0 &&
    input.minutesUntilReminder <= REMINDER_APPROACHING_MINUTES;
  const isStale = !input.completed && input.ageDays !== null && input.ageDays >= STALE_AGE_DAYS;

  const signals: TaskUrgencySignals = {
    isOverdue: input.isOverdue,
    isDueToday: input.isDueToday,
    isDueSoon,
    hasHighPriority: input.sourceHighPriority,
    hasReminderApproaching,
    isStale,
  };

  if (input.completed) {
    return { urgency: "low", signals };
  }

  // Weighted so that, on their own, an overdue task and a task due very
  // soon each already reach "high" — matching the task's own examples
  // ("an overdue task should have high relevance", "a task due in 30
  // minutes should have very high relevance") without needing another
  // signal stacked on top.
  let score = 0;
  if (signals.isOverdue) score += 6;
  if (signals.isDueToday) score += 2;
  if (signals.isDueSoon) score += 4;
  if (signals.hasHighPriority) score += 2;
  if (signals.hasReminderApproaching) score += 2;
  if (signals.isStale) score += 1;

  let urgency: TaskUrgency;
  if (score <= 0) urgency = "low";
  else if (score <= 2) urgency = "normal";
  else if (score <= 5) urgency = "important";
  else urgency = "high";

  return { urgency, signals };
}
