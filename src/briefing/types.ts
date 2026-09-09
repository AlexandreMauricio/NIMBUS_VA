/**
 * NIMBUS's first recognizable assistant behavior: the morning briefing.
 *
 * This is deliberately NOT one hard-coded paragraph. A Briefing is a
 * structured list of small, independently-generated items — each with
 * enough metadata (category, importance, relevance) that a future,
 * smarter prioritizer could re-rank or filter them without changing
 * this shape. Today's ranking is a simple `importance * relevance`
 * sort with a concise cap — see briefingGenerator.ts — but the data
 * model doesn't assume that stays simple forever.
 */

/**
 * The kinds of information a briefing can draw from. Only "greeting",
 * "dateTime", and "weather" are actually produced today — the rest exist
 * so a future provider (calendar, email, tasks, meals) has a category to
 * report under without changing this type.
 */
export type BriefingCategory =
  "greeting" | "dateTime" | "weather" | "calendar" | "email" | "tasks" | "meals" | "other";

/** An optional next step the user could take on an item (not wired to any handler yet). */
export interface BriefingAction {
  label: string;
  actionId: string;
}

export interface BriefingItem {
  id: string;
  category: BriefingCategory;
  message: string;
  /** 0–100: how significant this category generally is (weather > small trivia). */
  importance: number;
  /** 0–100: how much today's specific data matters (e.g. rain expected > clear skies). */
  relevance: number;
  /** ISO timestamp of when this item was produced. */
  timestamp: string;
  action?: BriefingAction;
}

/** One generated briefing — a complete, ordered, concise set of items. */
export interface Briefing {
  id: string;
  generatedAt: string;
  items: BriefingItem[];
}
