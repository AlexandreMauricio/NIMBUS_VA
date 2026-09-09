import { logger } from "../logging/logger";
import { ActionDefinition, ActionError, ActionProvider, ActionResult } from "./types";
import { withTimeout, TimeoutError, DEFAULT_PROVIDER_TIMEOUT_MS } from "../common/timeout";

const MAX_HISTORY_ENTRIES = 50;

/**
 * Aggregates registered ActionProviders and is the single entry point for
 * executing an action — the Action-system analogue of ContextService.
 *
 * Mirrors ContextService's failure-isolation design: a provider throwing,
 * rejecting, or hanging never propagates past `executeAction`. Instead it
 * always resolves to a structured `ActionResult`, so a broken action
 * provider can never crash NIMBUS or leave a caller (UI, future
 * Intelligence layer) needing a try/catch around every call.
 *
 * Deliberately does *not* enforce `requiresConfirmation` or any
 * permission check — see ActionDefinition's doc comment. That metadata is
 * reported truthfully so a future confirmation UI/permission layer can
 * read it before calling `executeAction`; building that layer is out of
 * scope for this task.
 */
export class ActionService {
  private readonly providers = new Map<string, ActionProvider>();
  private readonly history: ActionResult[] = [];

  /**
   * `providerTimeoutMs` is injectable purely so tests can assert the
   * hang path without actually waiting the real budget.
   */
  constructor(private readonly providerTimeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS) {}

  register(provider: ActionProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Action provider with id "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** Provider ids currently registered, mainly for diagnostics/tests. */
  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Every action across every registered provider, regardless of current availability — a static capability list. */
  listActions(): ActionDefinition[] {
    return [...this.providers.values()].flatMap((provider) => provider.listActions());
  }

  /** The most recent action results, most recent first — a lightweight foundation for "what did I just ask you to do?", not a full audit log/UI. */
  getHistory(limit = MAX_HISTORY_ENTRIES): ActionResult[] {
    return this.history.slice(0, limit);
  }

  async executeAction(actionId: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
    const startedAt = new Date();
    const provider = this.providers.get(providerIdOf(actionId));

    if (!provider) {
      return this.finish(failure(actionId, startedAt, new Date(), {
        category: "not_available",
        message: "That action isn't available.",
      }));
    }

    let available: boolean;
    try {
      available = await withTimeout(
        Promise.resolve(provider.isAvailable()),
        this.providerTimeoutMs,
        `Action provider "${provider.id}" isAvailable()`
      );
    } catch (err) {
      logger.warn(`Action provider "${provider.id}" failed or hung in isAvailable()`, { error: String(err) });
      available = false;
    }

    if (!available) {
      return this.finish(failure(actionId, startedAt, new Date(), {
        category: "not_available",
        message: "That action isn't available right now.",
      }));
    }

    const validation = provider.validate(actionId, params);
    if (!validation.valid) {
      return this.finish(failure(actionId, startedAt, new Date(), {
        category: "invalid_parameters",
        message: validation.error || "Invalid parameters for that action.",
      }));
    }

    try {
      // Bounded for the same reason ContextService bounds its providers:
      // an action that never settles would leave the caller (a routine
      // step, or a renderer awaiting nimbus:execute-action) waiting
      // forever, with no result and no error to show.
      const result = await withTimeout(
        Promise.resolve(provider.execute(actionId, params)),
        this.providerTimeoutMs,
        `Action provider "${provider.id}" execute()`
      );
      return this.finish(result);
    } catch (err) {
      // A provider should already return a "failure" ActionResult for
      // anything expected (see ActionProvider.execute's contract) — this
      // catch exists only for the unexpected, so a provider bug can never
      // crash NIMBUS or leave a caller without a result.
      logger.error(`Action provider "${provider.id}" threw from or hung in execute()`, {
        actionId,
        error: String(err),
      });
      const timedOut = err instanceof TimeoutError;
      return this.finish(failure(actionId, startedAt, new Date(), {
        category: timedOut ? "timeout" : "unknown",
        message: timedOut
          ? "That action took too long and was given up on."
          : "Something went wrong performing that action.",
      }));
    }
  }

  private finish(result: ActionResult): ActionResult {
    const actionId = result.actionId;
    logger.info(`Action "${actionId}" ${result.status}`, {
      actionId,
      status: result.status,
      durationMs: result.durationMs,
      // Never the full result/error message here beyond category — keeps
      // logs useful for debugging without duplicating potentially
      // sensitive result data (e.g. track/search content) at info level.
      errorCategory: result.error?.category,
    });
    this.history.unshift(result);
    if (this.history.length > MAX_HISTORY_ENTRIES) this.history.length = MAX_HISTORY_ENTRIES;
    return result;
  }
}

function providerIdOf(actionId: string): string {
  return actionId.split(".")[0] ?? actionId;
}

function failure(actionId: string, startedAt: Date, finishedAt: Date, error: ActionError): ActionResult {
  return {
    actionId,
    status: "failure",
    error,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}
