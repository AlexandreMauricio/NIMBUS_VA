import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { ActionService } from "../actions/actionService";
import { ActionResult } from "../actions/types";
import { CurrentActivity } from "../activity/types";
import { AssistantSuggestion } from "../common/assistantEvents";
import { ContextEventBus } from "../events/eventBus";
import { ContextEvent } from "../events/types";
import { matchesTrigger } from "./triggerMatcher";
import { ConditionContext, evaluateConditionsDetailed } from "./conditionEvaluator";
import {
  DEFAULT_ROUTINE_COOLDOWN_MINUTES,
  effectiveStopTrigger,
  DEFAULT_SUGGESTION_TTL_MS,
  MAX_ROUTINE_HISTORY_ENTRIES,
  Routine,
  RoutineActionStep,
  RoutineCheck,
  RoutineEvaluation,
  RoutineHistoryEntry,
  RoutineHistoryKind,
  RoutineStateStore,
} from "./types";

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
/**
 * How long a wind-down stays owed. Persisted so a restart mid-session
 * still winds down, but bounded: a routine started yesterday must not
 * wind down on some unrelated activity ending today.
 */
const MAX_WIND_DOWN_AGE_MS = 12 * 60 * 60 * 1000;

/** Which history entry each block reason produces. */
const BLOCK_HISTORY_KIND: Record<string, RoutineHistoryKind> = {
  disabled: "blockedByConditions",
  trigger: "blockedByConditions",
  cooldown: "blockedByCooldown",
  session: "blockedBySession",
  conditions: "blockedByConditions",
};

export class RoutineService {
  private readonly lastTriggeredAt = new Map<string, number>();
  /** routine id -> session keys it has already fired for. See sessionKeyFor. */
  private readonly firedSessions = new Map<string, Set<string>>();
  private readonly history: RoutineHistoryEntry[] = [];
  /**
   * Routines whose start actions have run and whose activity has not yet
   * ended — the set whose end actions are owed.
   *
   * Winding down is only meaningful for something that was wound up: if
   * the user dismissed the suggestion and studied with their own music,
   * running the end actions would stop music this routine never started.
   */
  private readonly awaitingStop = new Map<string, number>();
  /** Steps a suggestion should run, when they are not the routine's start actions. */
  private readonly pendingSuggestionSteps = new Map<string, RoutineActionStep[]>();
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
    private readonly areActionsAlreadyActive?: (steps: RoutineActionStep[]) => boolean | Promise<boolean>,
    /**
     * Persists cooldown timestamps across restarts. Optional so Core
     * tests can run without any storage; when absent, cooldowns behave
     * exactly as they did before — in memory, reset on restart.
     */
    private readonly stateStore?: RoutineStateStore,
    /** Injected like isSpotifyPlaying — the engine never reaches into the Activity service itself. Used only by the activity conditions. */
    private readonly getCurrentActivity?: () => CurrentActivity | null,
    /**
     * The remaining signals the newer conditions read: Spotify's current
     * playlist, the timer's state, and whether a known device is on the
     * local network. Grouped in one object rather than three more
     * positional parameters — and injected like every other signal, so
     * this class still knows nothing about what provides them. An absent
     * getter means "can't tell", and those conditions fail closed.
     */
    private readonly conditionSignals?: Pick<
      ConditionContext,
      "getPlaybackContextUri" | "getTimerStatus" | "isDeviceOnline"
    >
  ) {
    if (stateStore) {
      try {
        const state = stateStore.load();
        for (const [routineId, at] of Object.entries(state.lastTriggeredAt ?? {})) {
          if (typeof at === "number" && Number.isFinite(at)) this.lastTriggeredAt.set(routineId, at);
        }
        const nowMs = this.now().getTime();
        for (const [routineId, at] of Object.entries(state.awaitingStop ?? {})) {
          if (typeof at === "number" && Number.isFinite(at) && nowMs - at < MAX_WIND_DOWN_AGE_MS) {
            this.awaitingStop.set(routineId, at);
          }
        }
      } catch (err) {
        // A missing or corrupt state file must never stop NIMBUS
        // starting — the cost is only that cooldowns start fresh.
        logger.warn("Could not restore routine cooldown state", { error: String(err) });
      }
    }
  }

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

    this.record(routine, "accepted");
    const steps = this.pendingSuggestionSteps.get(suggestionId);
    this.pendingSuggestionSteps.delete(suggestionId);
    const results = await this.runActions(routine, steps);
    const failures = results.filter((r) => r.status === "failure").length;
    this.record(
      routine,
      "actionsCompleted",
      `${results.length} action${results.length === 1 ? "" : "s"}, ${failures} failed`
    );
    return results;
  }

  /** The user dismissed a suggestion — just clears it; the routine's cooldown (already started when the suggestion was created) still governs when it can suggest again. */
  dismissSuggestion(suggestionId: string): void {
    const suggestion = this.activeSuggestions.get(suggestionId);
    this.activeSuggestions.delete(suggestionId);
    this.pendingSuggestionSteps.delete(suggestionId);
    if (!suggestion) return;
    const routine = this.getRoutines().find((r) => r.id === suggestion.routineId);
    if (routine) this.record(routine, "dismissed");
  }

  /**
   * Evaluates a routine against the current state and explains the
   * result WITHOUT executing anything.
   *
   * This is what the editor's "Test" button calls. It deliberately runs
   * no actions: testing a routine must never start playback, start a
   * timer, or open anything — a user checking whether a rule is correct
   * has not asked for its effects. `runRoutineNow` is the separate,
   * explicit way to actually run one.
   *
   * There is no triggering event here, so the trigger itself cannot be
   * evaluated; the returned checks say so rather than pretending. Every
   * other gate — cooldown, session, conditions — is the real one.
   */
  async testRoutine(routineId: string): Promise<RoutineEvaluation | null> {
    const routine = this.getRoutines().find((r) => r.id === routineId);
    if (!routine) return null;

    const evaluation = await this.evaluate(routine, null);
    return {
      ...evaluation,
      checks: [
        {
          label: `Trigger not evaluated here: ${describeTrigger(routine)} decides that live`,
          passed: true,
        },
        ...evaluation.checks,
      ],
    };
  }

  /**
   * Runs a routine's actions immediately, bypassing trigger, cooldown and
   * condition checks.
   *
   * This is what "Test" used to do. It is kept — deliberately running a
   * routine on demand is genuinely useful, and removing it would take
   * away working behaviour — but it is now its own explicitly-named
   * operation, so nothing executes merely because the user asked whether
   * a rule matches.
   */
  async runRoutineNow(routineId: string): Promise<ActionResult[]> {
    const routine = this.getRoutines().find((r) => r.id === routineId);
    if (!routine) return [];
    return this.runActions(routine);
  }

  /**
   * The decision log, most recent first — routine decisions only, never
   * anything the user typed, read or browsed. See RoutineHistoryEntry.
   */
  getHistory(limit = MAX_ROUTINE_HISTORY_ENTRIES): RoutineHistoryEntry[] {
    return this.history.slice(0, limit);
  }

  /** When each routine last fired, for the routine list. Epoch ms, keyed by routine id. */
  getLastTriggeredAt(): Record<string, number> {
    return Object.fromEntries(this.lastTriggeredAt);
  }

  private async handleEvent(event: ContextEvent): Promise<void> {
    // The end half of every routine gets a look at this event first.
    // Separate from the trigger matching below: this is a routine
    // completing its own lifecycle, not a new routine being considered.
    await this.runStopActionsFor(event);

    // A closing application ends its session, so the next launch is a
    // genuinely new one for any "once per session" routine. Nothing
    // triggers on this event; it is bookkeeping only.
    if (event.type === "applicationClosed") {
      const exe = event.executableName.toLowerCase();
      this.endSession(`app:${exe}`);
      // A closed browser also ends the website session it was carrying.
      this.endSession(`site:${exe}`);
      return;
    }

    const sessionKey = this.sessionKeyFor(event);

    for (const routine of this.getRoutines()) {
      // The trigger decides whether this routine is a candidate at all.
      // Checked before anything is recorded: every routine sees every
      // event, and recording all of them would bury the interesting ones.
      if (!routine.enabled) continue;
      if (!matchesTrigger(event, routine.trigger)) continue;

      let evaluation: RoutineEvaluation;
      try {
        evaluation = await this.evaluate(routine, sessionKey);
      } catch (err) {
        logger.warn(`Routine "${routine.name}" evaluation failed`, {
          routineId: routine.id,
          error: String(err),
        });
        continue;
      }

      if (!evaluation.matched) {
        this.record(routine, BLOCK_HISTORY_KIND[evaluation.blockedBy ?? "conditions"]);
        continue;
      }

      this.record(routine, "matched");
      if (routine.autoRun) {
        await this.runAutoRun(routine, sessionKey);
      } else {
        this.createSuggestion(routine, sessionKey);
      }
    }
  }

  /**
   * Runs the gates a routine must pass, in order, and reports each one.
   *
   * The single source of truth for "should this routine fire?" — live
   * event handling and the editor's Test button both call it, so what a
   * user is told while testing is produced by the code that actually
   * decides, rather than a description of it that could drift.
   *
   * `sessionKey` is null when there is no event in hand (testing), in
   * which case the session gate is reported as inapplicable rather than
   * guessed at.
   */
  private async evaluate(routine: Routine, sessionKey: string | null): Promise<RoutineEvaluation> {
    const checks: RoutineCheck[] = [];
    const base = { routineId: routine.id, routineName: routine.name };

    if (!routine.enabled) {
      checks.push({ label: "Routine is enabled", passed: false });
      return { ...base, matched: false, checks, blockedBy: "disabled" };
    }

    const cooldownOk = !this.isInCooldown(routine);
    const cooldownMinutes = routine.cooldownMinutes ?? DEFAULT_ROUTINE_COOLDOWN_MINUTES;
    checks.push({
      label: cooldownOk
        ? this.describeCooldownPassed(routine)
        : `Cooldown has not elapsed (${cooldownMinutes} min)`,
      passed: cooldownOk,
    });

    const restricted = (routine.sessionRestriction ?? "none") === "oncePerSession";
    const sessionOk = !restricted || sessionKey === null || !this.hasFiredThisSession(routine, sessionKey);
    if (restricted) {
      checks.push({
        label:
          sessionKey === null
            ? "Session restriction not applicable without a triggering event"
            : sessionOk
              ? "Not already triggered this session"
              : "Already triggered once this session",
        passed: sessionOk,
      });
    }

    const conditions = await evaluateConditionsDetailed(
      routine.conditions,
      {
        now: this.now(),
        isSpotifyPlaying: this.isSpotifyPlaying,
        routineActions: routine.actions,
        areActionsAlreadyActive: this.areActionsAlreadyActive,
        getCurrentActivity: this.getCurrentActivity,
        ...this.conditionSignals,
      },
      routine.conditionLogic ?? "all"
    );
    for (const result of conditions.results) {
      checks.push({ label: result.label, passed: result.passed });
    }

    // Reported in the order the engine applies them, so the first failing
    // line is the reason.
    if (!cooldownOk) return { ...base, matched: false, checks, blockedBy: "cooldown" };
    if (!sessionOk) return { ...base, matched: false, checks, blockedBy: "session" };
    if (!conditions.passed) return { ...base, matched: false, checks, blockedBy: "conditions" };
    return { ...base, matched: true, checks };
  }

  private describeCooldownPassed(routine: Routine): string {
    const minutes = routine.cooldownMinutes ?? DEFAULT_ROUTINE_COOLDOWN_MINUTES;
    if (minutes <= 0) return "No cooldown configured";
    return this.lastTriggeredAt.has(routine.id)
      ? "Cooldown has elapsed"
      : "Has not run yet, so no cooldown applies";
  }

  /**
   * The session an event belongs to. A session is a property of the
   * *thing* that triggered — a particular application, page or folder —
   * not of NIMBUS, so switching away and coming back is the same session
   * while opening a different app is a new one.
   *
   * A completed timer is a one-off occurrence rather than something with
   * a duration, so each gets its own key and a "once per session"
   * restriction never suppresses one.
   */
  private sessionKeyFor(event: ContextEvent): string | null {
    switch (event.type) {
      case "applicationOpened":
        return `app:${event.executableName.toLowerCase()}`;
      case "websiteOpened":
        // The browser, not the page: a title changes with every page and
        // tab, which made "once per session" reset on each navigation.
        return `site:${event.browserExecutable.toLowerCase()}`;
      case "folderOpened":
        return `folder:${event.path.toLowerCase()}`;
      case "timerCompleted":
        return `timer:${event.timerId}`;
      default:
        return null;
    }
  }

  private hasFiredThisSession(routine: Routine, sessionKey: string): boolean {
    return this.firedSessions.get(routine.id)?.has(sessionKey) ?? false;
  }

  /** Starts the cooldown and, when there is a session in hand, marks it used. */
  private markFired(routine: Routine, sessionKey: string | null): void {
    this.lastTriggeredAt.set(routine.id, this.now().getTime());
    this.persistState();
    if (sessionKey === null) return;
    let keys = this.firedSessions.get(routine.id);
    if (!keys) {
      keys = new Set();
      this.firedSessions.set(routine.id, keys);
    }
    keys.add(sessionKey);
  }

  /** Forgets one session across every routine — called when its application closes. */
  private endSession(sessionKey: string): void {
    for (const keys of this.firedSessions.values()) keys.delete(sessionKey);
  }

  private persistState(): void {
    if (!this.stateStore) return;
    try {
      this.stateStore.save({
        lastTriggeredAt: Object.fromEntries(this.lastTriggeredAt),
        awaitingStop: Object.fromEntries(this.awaitingStop),
      });
    } catch (err) {
      // Losing a cooldown timestamp is a small annoyance; failing a
      // suggestion because of it would not be.
      logger.warn("Could not persist routine cooldown state", { error: String(err) });
    }
  }

  /** Appends to the decision log, oldest entries dropped past the cap. */
  private record(routine: Routine, kind: RoutineHistoryKind, detail?: string): void {
    this.history.unshift({
      id: randomUUID(),
      at: this.now().toISOString(),
      routineId: routine.id,
      routineName: routine.name,
      kind,
      detail,
    });
    if (this.history.length > MAX_ROUTINE_HISTORY_ENTRIES) {
      this.history.length = MAX_ROUTINE_HISTORY_ENTRIES;
    }
  }

  /**
   * Runs the end actions of every routine that declared this activity and
   * actually started during it.
   *
   * Deliberately NOT gated on conditions or cooldown. Those decide
   * whether a routine should START; applying them here would mean a
   * routine that began at 22:00 fails to stop the timer at 23:30 because
   * its time window closed — leaving exactly the mess it exists to
   * prevent.
   */
  private async runStopActionsFor(event: ContextEvent): Promise<void> {
    for (const routine of this.getRoutines()) {
      if (!routine.enabled) continue;
      if (!routine.stopActions?.length) continue;

      const trigger = effectiveStopTrigger(routine);
      if (!trigger || !matchesTrigger(event, trigger)) continue;

      // Conditions for the end half are its own — the start half's must
      // not apply, or a routine that began inside its time window would
      // fail to wind down once the window closed.
      let conditionsOk: boolean;
      try {
        conditionsOk = (
          await evaluateConditionsDetailed(
            routine.stopConditions ?? [],
            {
              now: this.now(),
              isSpotifyPlaying: this.isSpotifyPlaying,
              routineActions: routine.stopActions,
              areActionsAlreadyActive: this.areActionsAlreadyActive,
              getCurrentActivity: this.getCurrentActivity,
              ...this.conditionSignals,
            },
            routine.stopConditionLogic ?? "all"
          )
        ).passed;
      } catch (err) {
        logger.warn(`Routine "${routine.name}" end-condition evaluation failed`, {
          routineId: routine.id,
          error: String(err),
        });
        continue;
      }
      if (!conditionsOk) continue;

      const owedSince = this.awaitingStop.get(routine.id);
      if (owedSince === undefined) continue; // never started; nothing to wind down
      this.awaitingStop.delete(routine.id);
      this.persistState();
      if (this.now().getTime() - owedSince >= MAX_WIND_DOWN_AGE_MS) continue; // too old to still be this session's

      const steps = routine.stopActions;
      if (routine.stopAutoRun === false) {
        // The user asked to be consulted rather than have it just happen.
        this.createSuggestion(routine, null, steps, "windDown");
        continue;
      }

      const results = await this.runActions(routine, steps);
      const failures = results.filter((r) => r.status === "failure").length;
      this.record(
        routine,
        "actionsCompleted",
        `wind-down: ${results.length} action${results.length === 1 ? "" : "s"}, ${failures} failed`
      );
      logger.info(`Routine "${routine.name}" wound down`, {
        routineId: routine.id,
        failureCount: failures,
      });
    }
  }

  private async runAutoRun(routine: Routine, sessionKey: string | null = null): Promise<void> {
    // Cooldown starts the moment this fires, exactly like a normal
    // suggestion's cooldown starts the moment it's shown — not tied to
    // whether anything "succeeded", so a routine whose action keeps
    // failing still can't fire on every single matching event.
    this.markFired(routine, sessionKey);
    const results = await this.runActions(routine);
    const failures = results.filter((r) => r.status === "failure").length;
    this.record(
      routine,
      "autoRan",
      `${results.length} action${results.length === 1 ? "" : "s"}, ${failures} failed`
    );
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

  private createSuggestion(
    routine: Routine,
    sessionKey: string | null = null,
    steps?: RoutineActionStep[],
    kind: "start" | "windDown" = "start"
  ): AssistantSuggestion {
    const now = this.now();
    const windDown = kind === "windDown";
    // Cooldown starts the moment a suggestion is made — not when/if the
    // user acts on it — so a dismissed-then-re-triggered routine still
    // can't spam (see the task's own "user dismisses, switches tabs,
    // comes back" example). The cooldown governs STARTING, so a
    // wind-down leaves it alone: ending a session must not block
    // resuming it ten minutes later.
    if (!windDown) this.markFired(routine, sessionKey);

    const suggestion: AssistantSuggestion = {
      id: randomUUID(),
      type: "suggestion",
      source: "routines",
      createdAt: now.toISOString(),
      routineId: routine.id,
      // The configured title and message are the start prompt ("Study
      // mode? Play your study playlist?"); asking that while offering to
      // run the stop actions would mean "Yes" does the opposite of what
      // it says.
      title: windDown ? `Wrap up ${routine.name}?` : routine.suggestion.title,
      message: windDown ? "Run what you set up for when it ends?" : routine.suggestion.message,
      primaryLabel: routine.suggestion.primaryLabel,
      secondaryLabel: routine.suggestion.secondaryLabel,
      expiresAt: new Date(now.getTime() + this.suggestionTtlMs).toISOString(),
      actionSummary: this.summarizeActions(routine, steps),
    };
    if (steps) this.pendingSuggestionSteps.set(suggestion.id, steps);

    this.activeSuggestions.set(suggestion.id, suggestion);
    this.record(routine, "suggested");
    logger.info(`Routine "${routine.name}" suggested`, {
      routineId: routine.id,
      suggestionId: suggestion.id,
    });

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
  private summarizeActions(
    routine: Routine,
    steps: RoutineActionStep[] = routine.actions
  ): AssistantSuggestion["actionSummary"] {
    const definitions = this.actionService.listActions();
    return steps.map((step) => {
      const def = definitions.find((d) => d.id === step.actionId);
      return {
        label: def?.name ?? step.actionId,
        service: def?.affectsService ?? step.actionId.split(".")[0],
      };
    });
  }

  /**
   * Runs a set of the routine's steps. `steps` defaults to the start
   * actions; the wind-down passes its own.
   */
  private async runActions(
    routine: Routine,
    steps: RoutineActionStep[] = routine.actions
  ): Promise<ActionResult[]> {
    // Only the start half owes a wind-down.
    if (steps === routine.actions && routine.stopActions?.length) {
      this.awaitingStop.set(routine.id, this.now().getTime());
      this.persistState();
    }

    const results: ActionResult[] = [];
    for (const step of steps) {
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
        const routine = this.getRoutines().find((r) => r.id === suggestion.routineId);
        if (routine) this.record(routine, "expired");
      }
    }
  }
}

/**
 * A one-line description of what would fire a routine, built from the
 * user's own configuration — nothing here names a specific application,
 * site or service.
 */
function describeTrigger(routine: Routine): string {
  const trigger = routine.trigger;
  switch (trigger.type) {
    case "applicationOpened":
      return `opening ${trigger.application}`;
    case "websiteOpened":
      return `a browser window matching "${trigger.pattern}"`;
    case "folderOpened":
      return `opening a folder matching "${trigger.path}"`;
    case "timerCompleted":
      return trigger.timerType ? `a "${trigger.timerType}" timer completing` : "any timer completing";
    default:
      return "its trigger";
  }
}
