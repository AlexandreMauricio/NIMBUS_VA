import { busyState, priorityRank, scoreSignal } from "./scoring";
import {
  AttentionChannel,
  AttentionDecision,
  AttentionEvaluation,
  AttentionItem,
  AttentionPriority,
  AttentionSignal,
  AttentionSituation,
} from "./types";

/**
 * Decides, for every current signal, whether it is surfaced now.
 *
 * Deterministic: the same signals, situation and history give the same
 * decisions. The rules, in the order they apply:
 *
 *  1. Expired signals are ignored.
 *  2. Signals with the same key are one item (the first wins).
 *  3. Answered items (acknowledged or dismissed) are never shown again.
 *  4. Low priority is kept quiet — visible in the debug view, not shown.
 *  5. An item already shown is shown again only if its priority rose.
 *  6. High and urgent items interrupt (the popup); normal items go to the
 *     feed. With popups off, only routine suggestions still interrupt.
 *  7. At most one interruption per evaluation — the highest score; the
 *     rest are held, with the name of what outranked them.
 *  8. While the popup shows something else, only an urgent item with a
 *     higher score may replace it.
 *  9. No two interruptions within two minutes, unless the second is urgent
 *     or a routine's suggestion (which only lasts a minute).
 * 10. At most three feed posts per evaluation; the rest follow next time.
 *
 * Nothing is dropped: a held or quiet item stays in `items` with its
 * reason, and is reconsidered on every evaluation until it expires.
 */
export const INTERRUPTION_GAP_MS = 2 * 60_000;
export const MAX_FEED_PER_EVALUATION = 3;
/** How long an expired item's history is remembered (so a late duplicate isn't shown again). */
const FORGET_AFTER_EXPIRY_MS = 60 * 60_000;

interface ItemState {
  firstSeenAt: string;
  surfacedAt: string | null;
  surfacedPriority: AttentionPriority | null;
  surfaceCount: number;
  channel: AttentionChannel | null;
  resolution: "acknowledged" | "dismissed" | null;
  expiresAtMs: number;
}

export interface AttentionEngineOptions {
  /** The user allows Attention's own items to pop up. */
  popups: boolean;
}

function describeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export class AttentionEngine {
  private readonly states = new Map<string, ItemState>();
  private lastPopupAtMs = -Infinity;
  private last: AttentionEvaluation | null = null;

  evaluate(
    signals: AttentionSignal[],
    situation: AttentionSituation,
    options: AttentionEngineOptions
  ): AttentionEvaluation {
    const nowMs = situation.now.getTime();
    const nowIso = situation.now.toISOString();
    this.forget(nowMs);
    const busy = busyState(situation);

    const unique = new Map<string, AttentionSignal>();
    for (const signal of signals) if (!unique.has(signal.key)) unique.set(signal.key, signal);
    const scored = [...unique.values()]
      .filter((signal) => Date.parse(signal.expiresAt) > nowMs)
      .map((signal) => ({ signal, ...scoreSignal(signal, situation) }))
      .sort((a, b) => b.score - a.score || a.signal.key.localeCompare(b.signal.key));

    const onScreen =
      situation.popup && Date.parse(situation.popup.expiresAt) > nowMs ? situation.popup : null;
    let interruption: string | null = null;
    let feedPosts = 0;
    const items: AttentionItem[] = [];
    const surfaced: AttentionItem[] = [];

    for (const { signal, score, priority, factors } of scored) {
      let state = this.states.get(signal.key);
      if (!state) {
        state = {
          firstSeenAt: nowIso,
          surfacedAt: null,
          surfacedPriority: null,
          surfaceCount: 0,
          channel: null,
          resolution: null,
          expiresAtMs: 0,
        };
        this.states.set(signal.key, state);
      }
      state.expiresAtMs = Date.parse(signal.expiresAt);

      const popupAllowed = options.popups || signal.source === "routines";
      const channel: AttentionChannel =
        popupAllowed && priorityRank(priority) >= priorityRank("high") ? "popup" : "feed";
      const escalated =
        state.surfacedPriority !== null && priorityRank(priority) > priorityRank(state.surfacedPriority);

      let decision: AttentionDecision;
      let reason: string;
      if (state.resolution === "acknowledged") {
        decision = "acknowledged";
        reason = "You acknowledged this — it won't be shown again";
      } else if (state.resolution === "dismissed") {
        decision = "dismissed";
        reason = "You dismissed this — it won't be shown again";
      } else if (priority === "low") {
        decision = "quiet";
        reason = "Low priority — kept here, not shown";
      } else if (state.surfacedAt !== null && !escalated) {
        decision = "shown";
        reason = `Shown ${describeAgo(nowMs - Date.parse(state.surfacedAt))} — shown again only if it becomes more pressing`;
      } else if (channel === "popup") {
        const other = onScreen && onScreen.itemId !== signal.key ? onScreen : null;
        const gapExempt = priority === "urgent" || signal.source === "routines";
        if (interruption) {
          decision = "held";
          reason = `Outranked by "${interruption}"`;
        } else if (other && !(priority === "urgent" && score > other.score)) {
          decision = "held";
          reason = "Waiting — another suggestion is on screen";
        } else if (!gapExempt && nowMs - this.lastPopupAtMs < INTERRUPTION_GAP_MS) {
          decision = "held";
          reason = `Waiting — NIMBUS interrupted ${describeAgo(nowMs - this.lastPopupAtMs)}`;
        } else {
          decision = "surface";
          reason = escalated
            ? "Shown again: it became more pressing"
            : "Shown: it deserves your attention now";
          interruption = signal.title;
        }
      } else if (feedPosts >= MAX_FEED_PER_EVALUATION) {
        decision = "held";
        reason = "Waiting — a few other items were just posted";
      } else {
        decision = "surface";
        reason = escalated ? "Posted again: it became more pressing" : "Posted to the Home feed";
        feedPosts += 1;
      }

      if (decision === "surface") {
        state.surfacedAt = nowIso;
        state.surfacedPriority = priority;
        state.surfaceCount += 1;
        state.channel = channel;
        if (channel === "popup") this.lastPopupAtMs = nowMs;
      }

      const item: AttentionItem = {
        id: signal.key,
        source: signal.source,
        kind: signal.kind,
        title: signal.title,
        description: signal.description,
        reasons: [...signal.reasons],
        importance: signal.importance,
        urgency: signal.urgency,
        relevance: signal.relevance,
        score,
        priority,
        factors,
        decision,
        decisionReason: reason,
        channel:
          decision === "quiet"
            ? null
            : decision === "surface" || decision === "held"
              ? channel
              : state.channel,
        occursAt: signal.occursAt ?? null,
        expiresAt: signal.expiresAt,
        relatedActivity: signal.relatedActivity ?? null,
        suggestionId: signal.suggestionId ?? null,
        followUp: signal.followUp ?? null,
        labels: signal.labels ?? null,
        firstSeenAt: state.firstSeenAt,
        surfacedAt: state.surfacedAt,
        surfaceCount: state.surfaceCount,
      };
      items.push(item);
      if (decision === "surface") surfaced.push(item);
    }

    this.last = { evaluatedAt: nowIso, busy: busy.busy, busyReason: busy.reason, items, surfaced };
    return this.last;
  }

  /** The user said "got it" — never shown again, even if it escalates. */
  acknowledge(key: string, now: Date): void {
    this.resolve(key, "acknowledged", now);
  }

  /** The user dismissed it — never shown again. */
  dismiss(key: string, now: Date): void {
    this.resolve(key, "dismissed", now);
  }

  /** The popup expired without an answer: it counts as shown, not answered — it may come back if it escalates. */
  lastEvaluation(): AttentionEvaluation | null {
    return this.last;
  }

  /** The score an item had on the latest evaluation. */
  scoreOf(key: string): number | null {
    return this.last?.items.find((item) => item.id === key)?.score ?? null;
  }

  private resolve(key: string, resolution: "acknowledged" | "dismissed", now: Date): void {
    const state = this.states.get(key);
    if (state) {
      state.resolution = resolution;
      return;
    }
    this.states.set(key, {
      firstSeenAt: now.toISOString(),
      surfacedAt: null,
      surfacedPriority: null,
      surfaceCount: 0,
      channel: null,
      resolution,
      expiresAtMs: now.getTime() + FORGET_AFTER_EXPIRY_MS,
    });
  }

  private forget(nowMs: number): void {
    for (const [key, state] of this.states) {
      if (nowMs > state.expiresAtMs + FORGET_AFTER_EXPIRY_MS) this.states.delete(key);
    }
  }
}
