/**
 * Core contract for NIMBUS's Context system.
 *
 * The idea: NIMBUS can ask "what is the current context?" and get back a
 * structured snapshot assembled from independent providers (date/time,
 * system info, and — later — weather, email, calendar, tasks, etc.). Each
 * provider only knows how to produce its own slice of data; nothing here
 * knows anything about the UI or about "intelligence" (no AI/LLM at this
 * layer — this is purely information plumbing).
 */

/** Outcome of asking one provider for its data. */
export type ContextStatus = "ok" | "error" | "unavailable";

/**
 * The result of a single provider's contribution to a context snapshot.
 * Always present, even on failure — a provider never gets to throw past
 * the ContextService boundary (see ContextService.getSnapshot).
 */
export interface ContextProviderResult<T = unknown> {
  providerId: string;
  displayName: string;
  status: ContextStatus;
  /** The provider's data, or null if unavailable/errored with nothing cached. */
  data: T | null;
  /** Human-readable error message, present only when status is "error". */
  error?: string;
  /** ISO timestamp of when this result was produced (or last known good, if stale). */
  timestamp: string;
  /**
   * True when `data` is a previously cached successful result being reused
   * because the most recent fetch failed — lets consumers distinguish
   * "fresh" from "last known good".
   */
  stale: boolean;
}

/** A full context snapshot: one result per registered provider. */
export interface ContextSnapshot {
  generatedAt: string;
  providers: Record<string, ContextProviderResult>;
}

/**
 * Contract every context provider implements. Kept intentionally small —
 * a provider is just "am I available?" + "give me your data". Providers
 * must not perform side effects on the UI or know about IPC; the
 * ContextService and main-process wiring handle exposing them.
 */
export interface ContextProvider<T = unknown> {
  /** Stable, unique identifier, e.g. "dateTime", "system", future "weather". */
  readonly id: string;
  /** Human-readable name for logging/UI, e.g. "Date & Time". */
  readonly displayName: string;
  /**
   * Cheap check for whether this provider can currently produce data
   * (e.g. network reachable, permission granted). Should not throw —
   * ContextService treats a thrown isAvailable() the same as `false`.
   */
  isAvailable(): boolean | Promise<boolean>;
  /** Produces this provider's context data. May throw or reject on failure. */
  getContext(): Promise<T> | T;
}
