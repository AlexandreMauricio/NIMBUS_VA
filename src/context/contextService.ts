import { logger } from "../logging/logger";
import { ContextProvider, ContextProviderResult, ContextSnapshot } from "./types";
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from "../common/timeout";

/**
 * Aggregates registered ContextProviders into a single structured snapshot.
 *
 * This is the answer to "what is the current context?" — callers (IPC
 * handlers today, an intelligence layer later) call `getSnapshot()` and get
 * a `ContextSnapshot` back. They never talk to individual providers, and
 * providers never talk to each other.
 *
 * Failure isolation is the main design constraint: one provider throwing,
 * rejecting, or hanging on `isAvailable()`/`getContext()` must never take
 * down the snapshot for the others, let alone the app. Every provider call
 * is wrapped so failures degrade to a structured error result instead of
 * propagating.
 */
export class ContextService {
  private readonly providers = new Map<string, ContextProvider>();
  private readonly lastGood = new Map<string, ContextProviderResult>();

  /**
   * `providerTimeoutMs` is injectable purely so tests can assert the
   * hang path without actually waiting the real budget.
   */
  constructor(private readonly providerTimeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS) {}

  register(provider: ContextProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Context provider with id "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** Provider ids currently registered, mainly for diagnostics/tests. */
  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  async getSnapshot(): Promise<ContextSnapshot> {
    const results = await Promise.all(
      [...this.providers.values()].map((provider) => this.collect(provider))
    );

    const providers: Record<string, ContextProviderResult> = {};
    for (const result of results) {
      providers[result.providerId] = result;
    }

    return {
      generatedAt: new Date().toISOString(),
      providers,
    };
  }

  /**
   * Runs a single provider end-to-end, never throwing. On failure, falls
   * back to the last successful result for that provider (marked stale)
   * when one exists, so a transient failure doesn't blank out data NIMBUS
   * already had.
   */
  private async collect(provider: ContextProvider): Promise<ContextProviderResult> {
    const timestamp = new Date().toISOString();

    let available: boolean;
    try {
      available = await withTimeout(
        Promise.resolve(provider.isAvailable()),
        this.providerTimeoutMs,
        `Context provider "${provider.id}" isAvailable()`
      );
    } catch (err) {
      logger.warn(`Context provider "${provider.id}" failed or hung in isAvailable()`, {
        error: String(err),
      });
      available = false;
    }

    if (!available) {
      return this.fallbackOr(provider, {
        providerId: provider.id,
        displayName: provider.displayName,
        status: "unavailable",
        data: null,
        timestamp,
        stale: false,
      });
    }

    try {
      // Bounded so a provider that never settles degrades to the same
      // stale-or-error result as one that throws. Without this the
      // `Promise.all` in getSnapshot() never resolves, which hangs
      // briefing generation and the nimbus:get-context IPC for good.
      const data = await withTimeout(
        Promise.resolve(provider.getContext()),
        this.providerTimeoutMs,
        `Context provider "${provider.id}" getContext()`
      );
      const result: ContextProviderResult = {
        providerId: provider.id,
        displayName: provider.displayName,
        status: "ok",
        data,
        timestamp,
        stale: false,
      };
      this.lastGood.set(provider.id, result);
      return result;
    } catch (err) {
      logger.error(`Context provider "${provider.id}" failed`, { error: String(err) });
      return this.fallbackOr(provider, {
        providerId: provider.id,
        displayName: provider.displayName,
        status: "error",
        data: null,
        error: String(err),
        timestamp,
        stale: false,
      });
    }
  }

  /** Reuses the last known-good result (marked stale) if one exists, else returns `empty` as-is. */
  private fallbackOr(
    provider: ContextProvider,
    empty: ContextProviderResult
  ): ContextProviderResult {
    const cached = this.lastGood.get(provider.id);
    if (!cached) return empty;
    return {
      ...cached,
      status: empty.status,
      error: empty.error,
      stale: true,
    };
  }
}
