import { httpTimeoutSignal } from "../../common/timeout";

/** What NIMBUS sends every catalog. Scryfall asks every client to identify itself. */
export const CATALOG_HEADERS = {
  "User-Agent": "NIMBUS (personal desktop assistant; card collection lookups)",
  Accept: "application/json",
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * GETs JSON from a catalog. "Nothing matched" comes back from these APIs
 * as a 404 or 400 as often as an empty list, so those statuses resolve to
 * `null` — the caller reads that as no results. Anything else that isn't a
 * success is a real failure and throws.
 */
export async function getCatalogJson(url: string, fetchFn: FetchLike): Promise<unknown | null> {
  const response = await fetchWithRetry(fetchFn, url, { headers: CATALOG_HEADERS });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(`The card database answered ${response.status}.`);
  return response.json();
}

export function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A price as a positive number, or null — catalogs send numbers, strings, "0.00" and null alike. */
export function asPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function httpsOrNull(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\//i.test(value) ? value : null;
}

/** Tries after the first when a catalog says "too many requests". */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 10_000;

/** How retries wait — replaceable so tests don't sleep. */
export const catalogRetry = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A catalog request that waits and tries again on 429 Too Many Requests —
 * honouring Retry-After when the catalog sends one, otherwise 1, 2, then
 * 4 seconds. Other failures are returned as they are.
 */
export async function fetchWithRetry(fetchFn: FetchLike, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(url, { ...init, signal: httpTimeoutSignal(15_000) });
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await catalogRetry.sleep(Math.min(MAX_RETRY_WAIT_MS, wait));
  }
}
