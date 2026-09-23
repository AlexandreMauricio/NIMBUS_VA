/**
 * Reading what a renderer sent. Every handler takes its arguments as
 * `unknown` — IPC carries whatever the page passed, whatever the preload's
 * types say — and narrows them with these before use.
 */

/** A plain object's fields, or an empty object for anything else. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** An id argument as a string ("" when missing), so the service's own lookup decides. */
export function idArg(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw ?? "");
}

/** `raw` when it is a boolean, otherwise `fallback`. */
export function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** `raw` when it is a finite number, otherwise `fallback`. */
export function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** A list of plain objects, or an error naming what it should have been. */
export function recordList(raw: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.some((item) => !item || typeof item !== "object" || Array.isArray(item)))
    throw new Error(`${what} must be a list.`);
  return raw as Record<string, unknown>[];
}
