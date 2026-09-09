/**
 * A tiny single-value cache with a time-to-live. Used to avoid hitting
 * external services (weather APIs, IP geolocation, ...) more often than
 * necessary. Deliberately generic — not weather-specific — so any future
 * provider that needs "reuse recent data" can use it too.
 */
export class TtlCache<T> {
  private entry: { value: T; expiresAt: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Returns the cached value if it hasn't expired yet, else undefined. */
  get(): T | undefined {
    if (!this.entry) return undefined;
    if (this.now() >= this.entry.expiresAt) {
      this.entry = null;
      return undefined;
    }
    return this.entry.value;
  }

  /**
   * Stores `value`, expiring after `ttlMsOverride` (falling back to the
   * constructor's default) — lets a caller shorten the cache lifetime for
   * this particular value, e.g. a calendar provider caching less
   * aggressively as a known event approaches.
   */
  set(value: T, ttlMsOverride?: number): void {
    this.entry = { value, expiresAt: this.now() + (ttlMsOverride ?? this.ttlMs) };
  }

  clear(): void {
    this.entry = null;
  }
}
