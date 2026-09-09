import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { ContextEventBus } from "../events/eventBus";
import { TimerState, TimerStatus, TimerType } from "./types";

const DEFAULT_TICK_MS = 1000;

/** One phase of a multi-phase plan (see `startPlan`) — e.g. one Pomodoro study or break period. */
export interface TimerPlanPhase {
  title: string;
  durationMs: number;
  type: TimerType;
}

/**
 * Tracks a single NIMBUS-owned countdown timer and publishes a
 * `timerCompleted` Context Event when it finishes — the generic engine
 * behind the `timer.start` Action (src/actions/providers/timerActionProvider.ts)
 * and the timer popup window (src/main/timerWindow.ts). Deliberately
 * knows nothing about Routines, Spotify, or any UI — it only tracks time
 * and reports state.
 *
 * Only ever tracks one active timer at a time — starting a new one while
 * one is running/paused cancels the previous one first. Supporting
 * multiple concurrent timers would need a second popup-stacking UI this
 * task doesn't ask for; this keeps the surface area small (see the
 * task's own "do not over-engineer" guidance) while leaving the internal
 * shape (a `TimerState` keyed by id) ready to lift that restriction
 * later without a rewrite.
 *
 * `startPlan` adds automatic phase-chaining (e.g. a Pomodoro's
 * study/break/study cycle) on top of that same single-timer engine: it's
 * still exactly one `TimerState` running at a time, just one that
 * automatically replaces itself with the next queued phase on
 * completion instead of stopping. `TimerService` doesn't know the word
 * "Pomodoro" — it only knows "a queue of phases to run in order";
 * building that queue from a study/break/cycle-count shape lives in
 * `TimerActionProvider`, which is the part that's actually
 * Pomodoro-specific.
 */
export class TimerService {
  private current: TimerState | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private queuedPhases: TimerPlanPhase[] = [];

  constructor(
    private readonly eventBus: ContextEventBus,
    private readonly now: () => Date = () => new Date(),
    private readonly setIntervalFn: typeof setInterval = setInterval,
    private readonly clearIntervalFn: typeof clearInterval = clearInterval,
    private readonly tickMs: number = DEFAULT_TICK_MS
  ) {}

  start(title: string, durationMs: number, type: TimerType = "focus"): TimerState {
    this.queuedPhases = []; // a plain start() always replaces any pending plan phases, not just the current one
    return this.beginPhase({ title, durationMs, type });
  }

  /**
   * Starts the first phase of `phases` and automatically starts each
   * next one as soon as the previous phase completes, until the queue is
   * empty — e.g. Study 1 → Break → Study 2, with no user interaction
   * between phases. Each phase transition still publishes its own
   * `timerCompleted` Context Event (see `tick`), so the Event/Trigger
   * system sees every phase boundary exactly like any other timer
   * completion; nothing here is a special case for Routines/Triggers.
   */
  startPlan(phases: TimerPlanPhase[]): TimerState {
    if (phases.length === 0) {
      throw new Error("startPlan needs at least one phase");
    }
    this.queuedPhases = phases.slice(1);
    return this.beginPhase(phases[0]);
  }

  private beginPhase(phase: TimerPlanPhase): TimerState {
    this.stopInterval();

    const state: TimerState = {
      id: randomUUID(),
      title: phase.title,
      type: phase.type,
      durationMs: phase.durationMs,
      remainingMs: phase.durationMs,
      status: "running",
      createdAt: this.now().toISOString(),
      completedAt: null,
    };
    this.current = state;
    this.startInterval();
    logger.info(`Timer "${phase.title}" started`, { timerId: state.id, durationMs: phase.durationMs, type: phase.type });
    return { ...state };
  }

  pause(id: string): TimerState | null {
    if (!this.current || this.current.id !== id || this.current.status !== "running") return this.getState();
    this.current.status = "paused";
    this.stopInterval();
    return { ...this.current };
  }

  resume(id: string): TimerState | null {
    if (!this.current || this.current.id !== id || this.current.status !== "paused") return this.getState();
    this.current.status = "running";
    this.startInterval();
    return { ...this.current };
  }

  cancel(id: string): TimerState | null {
    if (!this.current || this.current.id !== id) return null;
    this.stopInterval();
    this.current.status = "cancelled";
    const result = { ...this.current };
    this.current = null;
    this.queuedPhases = []; // cancelling stops the whole plan, not just the phase in progress
    return result;
  }

  getState(id?: string): TimerState | null {
    if (!this.current) return null;
    if (id !== undefined && this.current.id !== id) return null;
    return { ...this.current };
  }

  private startInterval(): void {
    this.stopInterval();
    this.intervalHandle = this.setIntervalFn(() => this.tick(), this.tickMs);
    if (typeof (this.intervalHandle as unknown as { unref?: () => void })?.unref === "function") {
      (this.intervalHandle as unknown as { unref: () => void }).unref();
    }
  }

  private stopInterval(): void {
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private tick(): void {
    if (!this.current || this.current.status !== "running") return;

    this.current.remainingMs = Math.max(0, this.current.remainingMs - this.tickMs);
    if (this.current.remainingMs > 0) return;

    this.current.status = "completed";
    this.current.completedAt = this.now().toISOString();
    this.stopInterval();

    logger.info(`Timer "${this.current.title}" completed`, { timerId: this.current.id });
    this.eventBus.publish({
      id: randomUUID(),
      type: "timerCompleted",
      occurredAt: this.current.completedAt,
      source: "timerService",
      timerId: this.current.id,
      title: this.current.title,
      timerType: this.current.type,
    });

    // Auto-advance to the next queued plan phase, if any — this is what
    // turns a Pomodoro's Study/Break/Study sequence into something that
    // runs without the user re-starting each phase by hand.
    if (this.queuedPhases.length > 0) {
      const nextPhase = this.queuedPhases.shift()!;
      this.beginPhase(nextPhase);
    }
  }
}

export type { TimerState, TimerStatus, TimerType };
