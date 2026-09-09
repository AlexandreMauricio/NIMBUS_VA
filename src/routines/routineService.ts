import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { ActionService } from "../actions/actionService";
import { ActionResult } from "../actions/types";
import { AssistantSuggestion } from "../common/assistantEvents";
import { ContextEventBus } from "../events/eventBus";
import { ContextEvent } from "../events/types";
import { matchesTrigger } from "./triggerMatcher";
import { evaluateConditions, ConditionContext } from "./conditionEvaluator";
import { DEFAULT_ROUTINE_COOLDOWN_MINUTES, DEFAULT_SUGGESTION_TTL_MS, Routine, RoutineActionStep } from "./types";

/**
 * The Routine orchestrator — subscribes to Context Events, matches them
 * against user-configured Routines, and turns a match into a Suggestion
 * rather than ever executing an action directly. This is the core rule
 * the whole feature is built around: **a trigger never executes an
 * action by itself.** Only `acceptSuggestion` (a suggestion the user
 * actually chose to accept) or `testRoutine` (an explicit, user-initiated
 * "Test" button in Settings) ever calls into `ActionService`.
 *
 * Mirrors ContextService/ActionService's failure-isolation discipline:
 * a routine's own trigger/condition evaluation, or one action step
 * failing, never stops other routines from being evaluated or other
 * action steps from running.
 */
export class RoutineService {
  private readonly lastTriggeredAt = new Map<string, number>();
  private readonly activeSuggestions = new Map<string, AssistantSuggestion>();
  private readonly suggestionListeners = new Set<(suggestion: AssistantSuggestion) => void>();
  private readonly autoRunListeners = new Set<(routine: Routine, results: ActionResult[]) => void>();
  private unsubscribeFromEvents: (() => void) | null = null;

  constructor(
    private readonly getRoutines: () => Routine[],
    private readonly actionService: ActionService,
    private readonly eventBus: ContextEventBus,
    private readonly now: () => Date = () => new Date(),
    /** Injected rather than reached-for directly — keeps this class from needing to know Spotify (or any provider) exists. Used only by the "spotifyNotAlreadyPlaying" condition. */
    private readonly isSpotifyPlaying?: () => boolean | Promise<boolean>,
    private readonly suggestionTtlMs: number = DEFAULT_SUGGESTION_TTL_MS,
    /**
     * Notified with each step's actionId and its ActionResult right
     * after it executes (both via `acceptSuggestion` and `testRoutine`)
     * — lets device-specific wiring react without this class needing to
     * know what any provider is. Exists specifically so a Spotify action
     * run through a Routine invalidates the same "what's playing" cache
     * the direct `nimbus:execute-action` IPC path already does, and so a
     * `timer.start` step opens the timer popup — but only when it
     * actually succeeded (see lifecycle.ts's `onActionExecuted`); a step
     * that failed validation (e.g. a routine saved with no configured
     * timer duration) must not still pop up a window for a timer that
     * was never started.
     */
    private readonly onActionExecuted?: (actionId: string, result: ActionResult) => void,
    /** Injected rather than reached-for directly, same as `isSpotifyPlaying` above — keeps this class from needing to know what Spotify/Timer actually are. Used only by the "actionsNotAlreadyActive" condition. */
    private readonly areActionsAlreadyActive?: (steps: RoutineActionStep[]) => boolean | Promise<boolean>
  ) {}

  /** Starts listening for Context Events. Safe to call more than once — only the first subscribes. */
  start(): void {
    if (this.unsubscribeFromEvents) return;
    this.unsubscribeFromEvents = this.eventBus.subscribe((event) => {
      this.handleEvent(event).catch((err) => {
        logger.warn("Routine event handling failed", { error: String(err) });
      });
    });
  }

  stop(): void {
    this.unsubscribeFromEvents?.();
    this.unsubscribeFromEvents = null;
  }

  /** Notified with every new suggestion — the main process forwards these to assistantBridge/native notifications. Returns an unsubscribe function. */
  onSuggestion(listener: (suggestion: AssistantSuggestion) => void): () => void {
    this.suggestionListeners.add(listener);
    return () => this.suggestionListeners.delete(listener);
  }

  /** Notified whenever an `autoRun` routine's actions just ran without a suggestion ever existing — lets the main process surface a passive "this happened" record (Activity feed) without a popup, since the whole point of `autoRun` is skipping that. Returns an unsubscribe function. */
  onAutoRun(listener: (routine: Routine, results: ActionResult[]) => void): () => void {
    this.autoRunListeners.add(listener);
    return () => this.autoRunListeners.delete(listener);
  }

  /** Active, not-yet-expired suggestions — a pull-based complement to onSuggestion's push, e.g. for a UI that just (re)loaded. */
  getActiveSuggestions(): AssistantSuggestion[] {
    this.pruneExpired();
    return [...this.activeSuggestions.values()];
  }

  /** The user accepted a suggestion — runs its routine's actions and clears it from the active set. */
  async acceptSuggestion(suggestionId: string): Promise<ActionResult[]> {
    const suggestion = this.activeSuggestions.get(suggestionId);
    this.activeSuggestions.delete(suggestionId);
    if (!suggestion) return [];

    const routine = this.getRoutines().find((r) => r.id === suggestion.routineId);
    if (!routine) return [];

    return this.runActions(routine);
  }

  /** The user dismissed a suggestion — just clears it; the routine's cooldown (already started when the suggestion was created) still governs when it can suggest again. */
  dismissSuggestion(suggestionId: string): void {
    this.activeSuggestions.delete(suggestionId);
  }

  /** Runs a routine's actions immediately, bypassing trigger/cooldown/condition checks — backs the Settings UI's "Test" button, not part of the normal suggestion flow. */
  async testRoutine(routineId: string): Promise<ActionResult[]> {
    const routine = this.getRoutines().find((r) => r.id === routineId);
    if (!routine) return [];
    return this.runActions(routine);
  }

  private async handleEvent(event: ContextEvent): Promise<void> {
    for (const routine of this.getRoutines()) {
      if (!routine.enabled) continue;
      if (!matchesTrigger(event, routine.trigger)) continue;
      if (this.isInCooldown(routine)) continue;

      const conditionCtx: ConditionContext = {
        now: this.now(),
        isSpotifyPlaying: this.isSpotifyPlaying,
        routineActions: routine.actions,
        areActionsAlreadyActive: this.areActionsAlreadyActive,
      };
      let conditionsOk: boolean;
      try {
        conditionsOk = await evaluateConditions(routine.conditions, conditionCtx);
      } catch (err) {
        logger.warn(`Routine "${routine.name}" condition evaluation failed`, { routineId: routine.id, error: String(err) });
        continue;
      }
      if (!conditionsOk) continue;

      if (routine.autoRun) {
        await this.runAutoRun(routine);
      } else {
        this.createSuggestion(routine);
      }
    }
  }

  private async runAutoRun(routine: Routine): Promise<void> {
    // Cooldown starts the moment this fires, exactly like a normal
    // suggestion's cooldown starts the moment it's shown — not tied to
    // whether anything "succeeded", so a routine whose action keeps
    // failing still can't fire on every single matching event.
    this.lastTriggeredAt.set(routine.id, this.now().getTime());
    const results = await this.runActions(routine);
    logger.info(`Routine "${routine.name}" auto-ran (no suggestion shown)`, {
      routineId: routine.id,
      failureCount: results.filter((r) => r.status === "failure").length,
    });
    for (const listener of this.autoRunListeners) {
      try {
        listener(routine, results);
      } catch (err) {
        logger.warn("An onAutoRun listener threw", { error: String(err) });
      }
    }
  }

  private isInCooldown(routine: Routine): boolean {
    const last = this.lastTriggeredAt.get(routine.id);
    if (last === undefined) return false;
    const cooldownMs = (routine.cooldownMinutes ?? DEFAULT_ROUTINE_COOLDOWN_MINUTES) * 60_000;
    return this.now().getTime() - last < cooldownMs;
  }

  private createSuggestion(routine: Routine): AssistantSuggestion {
    const now = this.now();
    // Cooldown starts the moment a suggestion is made — not when/if the
    // user acts on it — so a dismissed-then-re-triggered routine still
    // can't spam (see the task's own "user dismisses, switches tabs,
    // comes back" example).
    this.lastTriggeredAt.set(routine.id, now.getTime());

    const suggestion: AssistantSuggestion = {
      id: randomUUID(),
      type: "suggestion",
      source: "routines",
      createdAt: now.toISOString(),
      routineId: routine.id,
      title: routine.suggestion.title,
      message: routine.suggestion.message,
      primaryLabel: routine.suggestion.primaryLabel,
      secondaryLabel: routine.suggestion.secondaryLabel,
      expiresAt: new Date(now.getTime() + this.suggestionTtlMs).toISOString(),
      actionSummary: this.summarizeActions(routine),
    };

    this.activeSuggestions.set(suggestion.id, suggestion);
    logger.info(`Routine "${routine.name}" suggested`, { routineId: routine.id, suggestionId: suggestion.id });

    for (const listener of this.suggestionListeners) {
      try {
        listener(suggestion);
      } catch (err) {
        logger.warn("A suggestion listener threw", { error: String(err) });
      }
    }

    return suggestion;
  }

  /**
   * One line per configured action step, built from each step's own
   * registered ActionDefinition name — never a hard-coded per-service
   * string. A step referencing an action that's since been unregistered
   * (e.g. Spotify was disabled after the routine was saved) falls back
   * to its raw id rather than disappearing silently.
   */
  private summarizeActions(routine: Routine): AssistantSuggestion["actionSummary"] {
    const definitions = this.actionService.listActions();
    return routine.actions.map((step) => {
      const def = definitions.find((d) => d.id === step.actionId);
      return { label: def?.name ?? step.actionId, service: def?.affectsService ?? step.actionId.split(".")[0] };
    });
  }

  private async runActions(routine: Routine): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const step of routine.actions) {
      const result = await this.actionService.executeAction(step.actionId, step.params);
      results.push(result);
      // Deliberately continues after a failed step: an earlier action
      // failing (e.g. a volume-control step) shouldn't silently swallow
      // a later, independent one (e.g. playing a playlist). Every
      // result is returned so the caller/UI can see exactly which steps
      // failed — see "Action results" in ARCHITECTURE.md.
      try {
        this.onActionExecuted?.(step.actionId, result);
      } catch (err) {
        logger.warn("onActionExecuted listener threw", { actionId: step.actionId, error: String(err) });
      }
    }
    logger.info(`Routine "${routine.name}" executed`, {
      routineId: routine.id,
      stepCount: results.length,
      failureCount: results.filter((r) => r.status === "failure").length,
    });
    return results;
  }

  private pruneExpired(): void {
    const nowMs = this.now().getTime();
    for (const [id, suggestion] of this.activeSuggestions) {
      if (new Date(suggestion.expiresAt).getTime() <= nowMs) {
        this.activeSuggestions.delete(id);
      }
    }
  }
}
