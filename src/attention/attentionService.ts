import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { AssistantSuggestion } from "../common/assistantEvents";
import { CurrentActivity } from "../activity/types";
import { ContextSnapshot } from "../context/types";
import { localTimeZone } from "../context/providers/calendar/icsTimeUtils";
import { AttentionEngine } from "./attentionEngine";
import { collectSignals, frequentAppSignals, suggestionSignal } from "./signals";
import {
  AttentionActivity,
  AttentionAnswer,
  AttentionFollowUp,
  AttentionFrequentApp,
  AttentionEvaluation,
  AttentionItem,
  AttentionSettings,
  AttentionSituation,
} from "./types";

/** How often Attention looks again. Cheap: Context is re-read far less often (below). */
export const DEFAULT_TICK_MS = 30_000;
/** A Context snapshot is reused for this long, so Attention adds little to what providers fetch. */
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
/** How long one of Attention's own popups stays up. */
export const ATTENTION_POPUP_MS = 2 * 60_000;

/**
 * How surfaced items reach the user — implemented by the client (the
 * Windows app wires it to the existing suggestion popup and the Home feed).
 * Attention owns no UI.
 */
export interface AttentionPresenter {
  /** Show a suggestion in the popup: a routine's own, or one Attention made for an item. */
  showSuggestion(suggestion: AssistantSuggestion): void;
  /** Post an item quietly to the Home feed. */
  postNotice(item: AttentionItem): void;
  /** What the popup shows right now, if anything. */
  currentPopup(): { suggestionId: string; expiresAt: string } | null;
}

export interface AttentionServiceDeps {
  getSettings: () => AttentionSettings;
  getSnapshot: () => Promise<ContextSnapshot>;
  getActivity: () => CurrentActivity | null;
  isTimerRunning: () => boolean;
  presenter: AttentionPresenter;
  now?: () => Date;
  timeZone?: () => string;
  snapshotMaxAgeMs?: number;
  /** Programs used often that aren't activities yet — optional (see src/activity/appUsage.ts). */
  getFrequentApps?: () => AttentionFrequentApp[];
}

export interface AttentionDebugState {
  enabled: boolean;
  popups: boolean;
  evaluatedAt: string | null;
  busy: boolean;
  busyReason: string | null;
  items: AttentionItem[];
}

/** "High · Starts in 12 minutes · Time-sensitive calendar event" — the "why" shown with an item. */
export function explainItem(item: AttentionItem): string {
  const priority = item.priority.charAt(0).toUpperCase() + item.priority.slice(1);
  return [`${priority} priority`, ...item.reasons].join(" · ");
}

/**
 * Runs Attention: gathers signals from Context, Activity and routine
 * suggestions, lets the engine decide, and hands what it surfaces to the
 * presenter.
 *
 * The safety boundary is structural: this class has no Action service to
 * call. A routine's suggestion is shown as it is — accepting it is still
 * RoutineService's job. Attention's own suggestions are informational;
 * answering them only tells the engine not to show them again.
 */
export class AttentionService {
  private readonly engine = new AttentionEngine();
  /** Routine suggestions waiting for (or holding) the popup, by suggestion id. */
  private readonly offered = new Map<string, AssistantSuggestion>();
  /** Suggestions Attention made itself: suggestion id → item key and expiry. */
  private readonly own = new Map<
    string,
    { key: string; expiresAtMs: number; kind: string; followUp: AttentionFollowUp | null }
  >();
  private readonly answerListeners = new Set<(answer: AttentionAnswer) => void>();
  private snapshot: ContextSnapshot | null = null;
  private snapshotAtMs = -Infinity;
  private refreshing: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly timeZone: () => string;

  constructor(private readonly deps: AttentionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeZone = deps.timeZone ?? localTimeZone;
  }

  start(intervalMs = DEFAULT_TICK_MS): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.tick(), intervalMs);
    (this.interval as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Re-reads Context if the snapshot is old, then evaluates. */
  async tick(): Promise<AttentionEvaluation | null> {
    await this.refreshSnapshot();
    return this.evaluateNow();
  }

  /**
   * A routine produced a suggestion. With Attention off it goes straight
   * to the popup, exactly as before; otherwise it joins the evaluation at
   * once — no waiting for Context — and is shown unless something more
   * important holds the popup.
   */
  offerSuggestion(suggestion: AssistantSuggestion): void {
    if (!this.deps.getSettings().enabled) {
      this.safely(() => this.deps.presenter.showSuggestion(suggestion));
      return;
    }
    this.offered.set(suggestion.id, suggestion);
    this.evaluateNow();
  }

  /**
   * Notified when the user answers one of Attention's own suggestions —
   * the client carries out a follow-up (like opening the Activities
   * editor). A popup that simply ran out is not an answer.
   */
  onAnswer(listener: (answer: AttentionAnswer) => void): () => void {
    this.answerListeners.add(listener);
    return () => this.answerListeners.delete(listener);
  }

  /** Whether a suggestion id is one of Attention's own (informational) suggestions. */
  ownsSuggestion(suggestionId: string): boolean {
    return this.own.has(suggestionId);
  }

  /** "Got it" on one of Attention's suggestions. Runs nothing. Returns false for a suggestion that isn't Attention's. */
  acknowledgeSuggestion(suggestionId: string): boolean {
    const own = this.own.get(suggestionId);
    if (!own) return false;
    this.own.delete(suggestionId);
    this.engine.acknowledge(own.key, this.now());
    this.emitAnswer(own, "accepted");
    return true;
  }

  /**
   * "Dismiss" on one of Attention's suggestions. The popup also calls this
   * when it simply runs out of time — that isn't an answer, so the item
   * stays eligible to come back if it becomes more pressing.
   */
  dismissSuggestion(suggestionId: string): boolean {
    const own = this.own.get(suggestionId);
    if (!own) return false;
    this.own.delete(suggestionId);
    if (this.now().getTime() < own.expiresAtMs - 1000) {
      this.engine.dismiss(own.key, this.now());
      this.emitAnswer(own, "dismissed");
    }
    return true;
  }

  /** A routine's suggestion was answered (through RoutineService) — it leaves the queue. */
  suggestionResolved(suggestionId: string, outcome: "accepted" | "dismissed"): void {
    this.offered.delete(suggestionId);
    const key = `suggestion:${suggestionId}`;
    if (outcome === "accepted") this.engine.acknowledge(key, this.now());
    else this.engine.dismiss(key, this.now());
  }

  /** The popup closed — whatever was waiting for it may be shown now. */
  popupClosed(): void {
    this.evaluateNow();
  }

  getDebugState(): AttentionDebugState {
    const settings = this.deps.getSettings();
    const last = this.engine.lastEvaluation();
    return {
      enabled: settings.enabled,
      popups: settings.popups,
      evaluatedAt: last?.evaluatedAt ?? null,
      busy: last?.busy ?? false,
      busyReason: last?.busyReason ?? null,
      items: settings.enabled ? (last?.items ?? []) : [],
    };
  }

  private emitAnswer(
    own: { key: string; kind: string; followUp: AttentionFollowUp | null },
    outcome: "accepted" | "dismissed"
  ): void {
    for (const listener of this.answerListeners) {
      try {
        listener({ itemId: own.key, kind: own.kind, followUp: own.followUp, outcome });
      } catch (err) {
        logger.warn("An attention answer listener threw", { error: String(err) });
      }
    }
  }

  private frequentApps(): AttentionFrequentApp[] {
    try {
      return this.deps.getFrequentApps?.() ?? [];
    } catch (err) {
      logger.warn("Attention could not read app usage", { error: String(err) });
      return [];
    }
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.deps.getSettings().enabled) return;
    const maxAge = this.deps.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
    if (this.now().getTime() - this.snapshotAtMs < maxAge) return;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          this.snapshot = await this.deps.getSnapshot();
        } catch (err) {
          logger.warn("Attention could not read the context", { error: String(err) });
        } finally {
          // Even a failure waits the full interval, so a broken provider isn't hammered.
          this.snapshotAtMs = this.now().getTime();
          this.refreshing = null;
        }
      })();
    }
    await this.refreshing;
  }

  private evaluateNow(): AttentionEvaluation | null {
    const settings = this.deps.getSettings();
    const now = this.now();
    const nowMs = now.getTime();
    for (const [id, suggestion] of this.offered) {
      if (Date.parse(suggestion.expiresAt) <= nowMs) this.offered.delete(id);
    }
    for (const [id, own] of this.own) if (own.expiresAtMs <= nowMs) this.own.delete(id);
    if (!settings.enabled) return null;

    let activity: AttentionActivity | null = null;
    try {
      const current = this.deps.getActivity();
      if (current) {
        activity = { name: current.activity, startedAt: current.startedAt, durationMs: current.durationMs };
      }
    } catch (err) {
      logger.warn("Attention could not read the current activity", { error: String(err) });
    }
    let timerRunning = false;
    try {
      timerRunning = this.deps.isTimerRunning();
    } catch {
      timerRunning = false;
    }

    const situation: AttentionSituation = { now, activity, timerRunning, popup: this.popupSituation(nowMs) };
    const signals = [
      ...collectSignals(this.snapshot, activity, now, this.timeZone()),
      ...frequentAppSignals(this.frequentApps(), now),
      ...[...this.offered.values()].map(suggestionSignal),
    ];
    const evaluation = this.engine.evaluate(signals, situation, { popups: settings.popups });
    for (const item of evaluation.surfaced) this.present(item, now);
    return evaluation;
  }

  private popupSituation(nowMs: number): AttentionSituation["popup"] {
    let current: { suggestionId: string; expiresAt: string } | null = null;
    try {
      current = this.deps.presenter.currentPopup();
    } catch {
      current = null;
    }
    if (!current || Date.parse(current.expiresAt) <= nowMs) return null;
    const itemId =
      this.own.get(current.suggestionId)?.key ??
      (this.offered.has(current.suggestionId) ? `suggestion:${current.suggestionId}` : null);
    return { itemId, score: itemId ? (this.engine.scoreOf(itemId) ?? 0) : 0, expiresAt: current.expiresAt };
  }

  private present(item: AttentionItem, now: Date): void {
    // A routine's suggestion is shown exactly as RoutineService made it.
    const offered = item.suggestionId ? this.offered.get(item.suggestionId) : undefined;
    if (offered) {
      this.safely(() => this.deps.presenter.showSuggestion(offered));
      return;
    }
    if (item.channel !== "popup") {
      this.safely(() => this.deps.presenter.postNotice(item));
      return;
    }
    const expiresAtMs = Math.min(Date.parse(item.expiresAt), now.getTime() + ATTENTION_POPUP_MS);
    const suggestion: AssistantSuggestion = {
      id: `attention-${randomUUID()}`,
      type: "suggestion",
      source: "attention",
      createdAt: now.toISOString(),
      origin: "attention",
      attentionItemId: item.id,
      title: item.title,
      message: item.description,
      primaryLabel: item.labels?.primary ?? "Got it",
      secondaryLabel: item.labels?.secondary ?? "Dismiss",
      expiresAt: new Date(expiresAtMs).toISOString(),
      // Informational: there is nothing to run, and the popup shows no steps.
      actionSummary: [],
      reason: explainItem(item),
    };
    this.own.set(suggestion.id, { key: item.id, expiresAtMs, kind: item.kind, followUp: item.followUp });
    this.safely(() => this.deps.presenter.showSuggestion(suggestion));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.warn("Attention presenter failed", { error: String(err) });
    }
  }
}
