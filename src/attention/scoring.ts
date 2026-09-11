import { AttentionFactor, AttentionPriority, AttentionSignal, AttentionSituation } from "./types";

/**
 * The scoring model — deliberately small enough to read in one go:
 *
 *   score = 0.40 × urgency + 0.35 × importance + 0.25 × relevance
 *           − 15 while the user is busy, for anything with urgency under 70
 *           + 10 when the item is about the activity the user is doing
 *
 * clamped to 0–100 and rounded, then banded:
 *
 *   urgent ≥ 80   high ≥ 65   normal ≥ 40   low below that
 *
 * Every term becomes an AttentionFactor, so the explanation shown to the
 * user is the calculation itself rather than a description of it.
 */
/** Weights in percent — whole numbers, so every factor is exact to the hundredth. */
export const SCORE_WEIGHTS = { urgency: 40, importance: 35, relevance: 25 } as const;
export const PRIORITY_THRESHOLDS = { urgent: 80, high: 65, normal: 40 } as const;
/** Taken off while the user is busy, for anything that isn't time-critical. */
export const BUSY_PENALTY = 15;
/** Urgency at or above this gets through when the user is busy — a meeting in 15 minutes still matters mid-study. */
export const BUSY_EXEMPT_URGENCY = 70;
/** Added when an item is about the very activity the user is doing. */
export const ACTIVITY_MATCH_BONUS = 10;

const PRIORITY_RANK: Record<AttentionPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export function priorityRank(priority: AttentionPriority): number {
  return PRIORITY_RANK[priority];
}

export function priorityFor(score: number): AttentionPriority {
  if (score >= PRIORITY_THRESHOLDS.urgent) return "urgent";
  if (score >= PRIORITY_THRESHOLDS.high) return "high";
  if (score >= PRIORITY_THRESHOLDS.normal) return "normal";
  return "low";
}

/** Whether the user is busy, and with what — an activity in progress, or a running timer. */
export function busyState(situation: AttentionSituation): { busy: boolean; reason: string | null } {
  if (situation.activity) return { busy: true, reason: `You're busy with ${situation.activity.name}` };
  if (situation.timerRunning) return { busy: true, reason: "A focus timer is running" };
  return { busy: false, reason: null };
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

function weighted(value: number, weightPercent: number): number {
  return (value * weightPercent) / 100;
}

export function scoreSignal(
  signal: AttentionSignal,
  situation: AttentionSituation
): { score: number; priority: AttentionPriority; factors: AttentionFactor[] } {
  const urgency = clamp(signal.urgency);
  const importance = clamp(signal.importance);
  const relevance = clamp(signal.relevance);
  const factors: AttentionFactor[] = [
    {
      label: `Urgency ${urgency} × ${(SCORE_WEIGHTS.urgency / 100).toFixed(2)}`,
      points: weighted(urgency, SCORE_WEIGHTS.urgency),
    },
    {
      label: `Importance ${importance} × ${(SCORE_WEIGHTS.importance / 100).toFixed(2)}`,
      points: weighted(importance, SCORE_WEIGHTS.importance),
    },
    {
      label: `Relevance ${relevance} × ${(SCORE_WEIGHTS.relevance / 100).toFixed(2)}`,
      points: weighted(relevance, SCORE_WEIGHTS.relevance),
    },
  ];

  const busy = busyState(situation);
  if (busy.busy && urgency < BUSY_EXEMPT_URGENCY) {
    factors.push({ label: `${busy.reason} — this isn't time-critical`, points: -BUSY_PENALTY });
  }
  if (
    signal.relatedActivity &&
    situation.activity &&
    signal.relatedActivity.toLowerCase() === situation.activity.name.toLowerCase()
  ) {
    factors.push({
      label: `About what you're doing (${situation.activity.name})`,
      points: ACTIVITY_MATCH_BONUS,
    });
  }

  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return { score, priority: priorityFor(score), factors };
}
