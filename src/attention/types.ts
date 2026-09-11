/**
 * The Attention & Priority layer — deciding what deserves the user's
 * attention right now, out of everything NIMBUS knows.
 *
 *   Context ─┐
 *   Activity ├─→ Signals ─→ AttentionEngine ─→ AttentionItems ─→ Suggestion popup / feed
 *   Routines ┘                                   (scored, deduplicated, explained)
 *
 * Attention decides WHAT matters, how much, and whether it is surfaced.
 * The existing Suggestion infrastructure decides HOW it is presented and
 * what the user can do with it. Attention never runs anything: an Action
 * is reached only through a routine's suggestion that the user accepted,
 * exactly as before.
 *
 * Deterministic by design — a transparent weighted score and a handful of
 * rules, no learning and no AI — so every decision can be explained.
 */

/** Which part of NIMBUS a signal comes from. */
export type AttentionSource =
  "calendar" | "tasks" | "weather" | "email" | "stocks" | "activity" | "timer" | "routines";

export type AttentionPriority = "urgent" | "high" | "normal" | "low";

/**
 * A candidate for attention: one real-world thing that might matter,
 * produced fresh on every evaluation by a signal builder (or offered by
 * another subsystem, like a routine's suggestion). Pure data.
 */
export interface AttentionSignal {
  /**
   * Stable identity: the same real-world thing produces the same key on
   * every evaluation — this is what deduplication, cooldowns and "already
   * shown" hang off. E.g. "calendar:<event id>:<start>".
   */
  key: string;
  source: AttentionSource;
  /** What kind of thing within the source, e.g. "eventStartingSoon". */
  kind: string;
  title: string;
  description: string;
  /** 0–100: how much this kind of thing matters in general. */
  importance: number;
  /** 0–100: time pressure right now. */
  urgency: number;
  /** 0–100: how well it fits the user's situation. */
  relevance: number;
  /** The facts behind the numbers, in words — e.g. "Starts in 12 minutes". */
  reasons: string[];
  /** When the underlying thing happens, if it has a moment. */
  occursAt?: string;
  /** After this the item is no longer surfaced, and soon forgotten. */
  expiresAt: string;
  /** The activity this is about (e.g. "Study") — more relevant while that activity is on. */
  relatedActivity?: string;
  /**
   * The existing Suggestion this item stands for. Accepting that
   * suggestion is the only way anything runs; Attention merely decides
   * when it is shown.
   */
  suggestionId?: string;
  /** For an item that asks a question: what "yes" leads to — carried out by the client, never an Action. */
  followUp?: AttentionFollowUp;
  /** For an item that asks a question: its button labels (default "Got it" / "Dismiss"). */
  labels?: { primary: string; secondary: string };
}

/** One contribution to an item's score — together they answer "why is this important?". */
export interface AttentionFactor {
  label: string;
  points: number;
}

/**
 * What the engine decided about an item on its latest evaluation.
 *  - surface: shown now
 *  - shown: shown earlier and still current; shown again only if it becomes more pressing
 *  - held: worth showing, but waiting (outranked, the popup is busy, too soon after another interruption)
 *  - quiet: low priority — kept for inspection, not shown
 *  - acknowledged / dismissed: the user answered it; it isn't shown again
 */
export type AttentionDecision = "surface" | "shown" | "held" | "quiet" | "acknowledged" | "dismissed";

/** How an item reaches the user: as an interruption, or as a quiet line in the Home feed. */
export type AttentionChannel = "popup" | "feed";

export interface AttentionItem {
  /** The signal's key. */
  id: string;
  source: AttentionSource;
  kind: string;
  title: string;
  description: string;
  reasons: string[];
  importance: number;
  urgency: number;
  relevance: number;
  score: number;
  priority: AttentionPriority;
  factors: AttentionFactor[];
  decision: AttentionDecision;
  /** Why this decision, in words. */
  decisionReason: string;
  /** Where it is (or would be) shown; null for quiet items. */
  channel: AttentionChannel | null;
  occursAt: string | null;
  expiresAt: string;
  relatedActivity: string | null;
  suggestionId: string | null;
  followUp: AttentionFollowUp | null;
  labels: { primary: string; secondary: string } | null;
  firstSeenAt: string;
  surfacedAt: string | null;
  surfaceCount: number;
}

/** The activity Attention sees — a narrow copy of CurrentActivity. */
export interface AttentionActivity {
  name: string;
  startedAt: string;
  durationMs: number;
}

/** Everything about the user's situation the engine takes into account. */
export interface AttentionSituation {
  now: Date;
  activity: AttentionActivity | null;
  /** A NIMBUS timer is counting down — the user is focusing. */
  timerRunning: boolean;
  /** What the suggestion popup is showing right now, if anything. */
  popup: { itemId: string | null; score: number; expiresAt: string } | null;
}

export interface AttentionEvaluation {
  evaluatedAt: string;
  busy: boolean;
  busyReason: string | null;
  /** Every current item, highest score first — nothing is dropped, only held or kept quiet. */
  items: AttentionItem[];
  /** The items surfaced by this evaluation. */
  surfaced: AttentionItem[];
}

/** The user's switches for Attention. */
export interface AttentionSettings {
  /** Off: nothing proactive, and routine suggestions pop up immediately exactly as before. */
  enabled: boolean;
  /** Off: Attention's own items only go to the feed. Routine suggestions still pop up. */
  popups: boolean;
}

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = { enabled: true, popups: true };

/** Where answering "yes" to an item leads. The client carries it out; it is navigation, never an Action. */
export interface AttentionFollowUp {
  type: "createActivity";
  /** The program to fill in, e.g. "haloinfinite.exe". */
  application: string;
  /** What to call it, e.g. "Halo Infinite". */
  name: string;
}

/** A program used often that isn't an activity yet (see src/activity/appUsage.ts). */
export interface AttentionFrequentApp {
  executable: string;
  name: string;
  daysUsed: number;
  minutesUsed: number;
  justOpened: boolean;
}

/** The user answered one of Attention's own suggestions. */
export interface AttentionAnswer {
  itemId: string;
  kind: string;
  followUp: AttentionFollowUp | null;
  outcome: "accepted" | "dismissed";
}
