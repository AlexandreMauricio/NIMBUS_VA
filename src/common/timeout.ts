/**
 * Shared deadlines for anything NIMBUS waits on.
 *
 * Two distinct needs, deliberately kept in one small module because they
 * exist for the same reason — nothing NIMBUS awaits should be able to
 * wait forever:
 *
 *  - `httpTimeoutSignal()` bounds a single outbound HTTP request. Node's
 *    `fetch` has no default request timeout: a server that accepts the
 *    connection and then never responds leaves the promise pending
 *    indefinitely.
 *  - `withTimeout()` bounds an arbitrary promise whose implementation
 *    NIMBUS doesn't control — specifically a ContextProvider's or
 *    ActionProvider's methods, which are the extension points where
 *    third-party/never-returning code is most likely to appear.
 *
 * Core-safe: no Electron, no Node-only APIs beyond what plain
 * `node --test` already provides.
 */

/**
 * Default per-request budget for outbound HTTP. Long enough that a slow
 * mobile-tethered connection still succeeds, short enough that a stalled
 * request doesn't outlive the context refresh that triggered it.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Default budget for one provider call. Larger than the HTTP timeout on
 * purpose: a provider may legitimately make several sequential requests
 * (the email provider fans out per account, Todoist paginates), so this
 * is the outer backstop for a provider that hangs *between* requests or
 * never makes one at all — not a second copy of the per-request limit.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/** Distinguishes "we gave up waiting" from an error the callee actually raised. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * An `AbortSignal` for a single `fetch` call. Pass as `signal` in the
 * request init; the fetch rejects once the deadline passes, which every
 * caller here already handles as an ordinary network failure.
 */
export function httpTimeoutSignal(ms: number = DEFAULT_HTTP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Resolves with `promise`, or rejects with a `TimeoutError` after `ms`.
 *
 * Note this does not (and cannot) cancel the underlying work — a hung
 * provider keeps hanging in the background. What it guarantees is that
 * *the caller* stops waiting, which is the property that matters here:
 * one bad provider must not hold up the whole snapshot.
 *
 * The timer is deliberately NOT `unref`'d: an unref'd deadline does not
 * hold the event loop open, so in an otherwise idle process it can fail
 * to fire at all — silently restoring the exact hang this exists to
 * prevent. It is always cleared once the promise settles, so a fast path
 * never leaves one armed, and the longest it can hold the loop open is
 * a single budget.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
