/**
 * The renderer's pure presentation logic — everything that turns a value
 * into the text or shape the UI displays, with no DOM access and no IPC.
 *
 * Split out of renderer.ts so it can actually be tested. renderer.ts is
 * otherwise DOM wiring: `getElementById`, event listeners, and
 * `window.nimbus.*` calls, which need a browser and a live main process
 * to exercise at all. These functions need neither, so they run under
 * plain `node --test` like the rest of Core — and they are where the
 * decisions worth testing live (what counts as overdue, how an address
 * gets masked, how a trigger reads back to the user).
 *
 * Kept deliberately dependency-free in the other direction too: nothing
 * here imports from renderer.ts, so this module can never drag the DOM
 * into a test.
 */

/** Mirrors the subset of the renderer's own types these helpers need, so this module stands alone. */
export interface TriggerConfig {
  type: "applicationOpened" | "websiteOpened" | "folderOpened" | "activityEnded" | "timerCompleted";
  application?: string;
  activity?: string;
  minMinutes?: number;
  timerType?: string;
  matchField?: string;
  pattern?: string;
  path?: string;
  matchMode?: string;
}

export interface TaskItemLike {
  dueAt: string | null;
  dueIsDateOnly?: boolean;
  category?: string;
}

/**
 * Shortens a long calendar feed address for display. Feed URLs are
 * credentials and are often hundreds of characters — showing one in full
 * both breaks the layout and puts the whole secret on screen. The head
 * and tail are kept so a user can still tell two feeds apart.
 */
export function maskAddress(address: string): string {
  if (address.length <= 40) return address;
  return `${address.slice(0, 24)}…${address.slice(-10)}`;
}

/** Milliseconds as `m:ss`, for track position/duration. Negative input clamps to 0:00 rather than rendering a nonsense negative clock. */
export function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** A one-line, human-readable summary of a routine's trigger, for the routine list. */
export function triggerSummary(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case "applicationOpened":
      return `App opened: ${trigger.application}`;
    case "websiteOpened":
      return `Website ${trigger.matchField} contains: ${trigger.pattern}`;
    case "folderOpened":
      return `Folder path contains: ${trigger.path}`;
    case "timerCompleted":
      return trigger.timerType ? `When a "${trigger.timerType}" timer finishes` : "When any timer finishes";
    case "activityEnded": {
      const what = trigger.activity ? `${trigger.activity} ends` : "any activity ends";
      return trigger.minMinutes ? `When ${what} (after ${trigger.minMinutes} min)` : `When ${what}`;
    }
  }
}

/**
 * Adds/removes the "actionsNotAlreadyActive" condition to match the
 * "Skip if already active" checkbox, preserving any other conditions
 * untouched (e.g. ones set outside this UI).
 */
export function withSkipIfActiveCondition<T extends { type: string }>(
  existing: T[],
  shouldInclude: boolean
): T[] {
  const withoutIt = existing.filter((c) => c.type !== "actionsNotAlreadyActive");
  // Generic over the caller's own condition union so the renderer keeps
  // its precise type rather than widening to a loose shape defined here.
  // The cast is the one place that can't be inferred: the literal is a
  // valid member of any union that includes this condition, which the
  // renderer's does.
  return shouldInclude ? [...withoutIt, { type: "actionsNotAlreadyActive" } as unknown as T] : withoutIt;
}

/** A task's due date as display text plus whether it should read as overdue, or null when the task has no due date at all. */
export function formatTaskDue(task: TaskItemLike): { text: string; overdue: boolean } | null {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  const text = task.dueIsDateOnly
    ? due.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : due.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  return { text, overdue: task.category === "overdue" };
}

/** Renders one raw context value for the Context tab's diagnostic table. An em dash stands in for absent values so a row is never blank. */
export function formatContextValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** An event's start time, rendered in the calendar's own timezone rather than the machine's. */
export function formatEventTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** An event's date heading, in the calendar's own timezone (see formatEventTime). */
export function formatEventDateLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}
