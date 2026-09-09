/**
 * Generic NIMBUS Timer data model — deliberately not Spotify- or
 * Routine-specific. The first use case is a Routine starting a focus
 * timer alongside playing music, but a timer can be started from
 * anywhere (a future Settings control, a future Intelligence layer)
 * through the same `timer.start` Action (see
 * src/actions/providers/timerActionProvider.ts).
 */

export type TimerStatus = "running" | "paused" | "completed" | "cancelled";

/**
 * Extensible on purpose. "break" is a rest phase between two "focus"
 * phases of an automatic Pomodoro cycle (see `TimerService.startPlan`) —
 * distinguishing it from "focus" lets a future Routine trigger
 * differently on "a study session finished" vs. "a break finished"
 * (both are just `TimerCompleted` events with a different `timerType`).
 */
export type TimerType = "focus" | "pomodoro" | "break" | "custom";

export interface TimerState {
  id: string;
  title: string;
  type: TimerType;
  durationMs: number;
  remainingMs: number;
  status: TimerStatus;
  createdAt: string;
  completedAt: string | null;
}
