/**
 * Persistent memory — what NIMBUS keeps knowing across restarts.
 *
 * Every item says what it is (`kind`), and — just as important — how
 * NIMBUS came to know it (`origin`), because those are trusted differently:
 *
 *  - explicit: the user saved it. Trusted fully, never expires unless the
 *    user says so, and only the user can change it.
 *  - learned:  a pattern NIMBUS worked out from repeated evidence. Its
 *    confidence grows with the evidence, and it fades if not reinforced.
 *  - observed: something NIMBUS noticed once ("a new device appeared").
 *    Kept for a while as history, then forgotten.
 *
 * Nothing observed is silently promoted to permanent memory: only the user
 * can turn a learned or observed item into an explicit one ("Keep").
 */

export type MemoryKind = "preference" | "fact" | "pattern" | "history";

export type MemoryOrigin = "explicit" | "learned" | "observed";

/** Most trusted first — the order recall() prefers. */
export const MEMORY_ORIGINS: readonly MemoryOrigin[] = ["explicit", "learned", "observed"];
export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact", "pattern", "history"];

export type MemoryScalar = string | number | boolean | null;
/** Deliberately small: a scalar, or one flat object of scalars. */
export type MemoryValue = MemoryScalar | Record<string, MemoryScalar>;

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  origin: MemoryOrigin;
  /**
   * A stable identity for something the system keeps up to date
   * ("activity:study", "routine:<id>") — how a pattern is found again to be
   * reinforced, and how recall() finds it. Null for the user's own notes.
   */
  key: string | null;
  title: string;
  value: MemoryValue;
  detail: string | null;
  /** Who produced it: "user", "activity", "routines", "network"… */
  source: string;
  /** 0–1. Always 1 for explicit memory. */
  confidence: number;
  /** How many times it was seen or reinforced. */
  evidence: number;
  createdAt: string;
  updatedAt: string;
  /** When it is forgotten; null for never. */
  expiresAt: string | null;
  /** Kept, but neither used nor updated. */
  disabled: boolean;
}

export interface MemoryFilter {
  kind?: MemoryKind;
  origin?: MemoryOrigin;
  source?: string;
  /** Case-insensitive, over title, detail, value and key. */
  text?: string;
  includeDisabled?: boolean;
}

/**
 * Persistence, one tier (origin) at a time — explicit memory, learned
 * patterns and observations live apart, so a problem in one never costs
 * the others. Implemented by the client (src/main/memoryStore.ts).
 */
export interface MemoryStateStore {
  /** Whatever was saved for that tier — validated by the service, never trusted. */
  load(origin: MemoryOrigin): unknown;
  save(origin: MemoryOrigin, items: MemoryItem[]): void;
}

export const MAX_TITLE_LENGTH = 120;
export const MAX_DETAIL_LENGTH = 500;
export const MAX_STRING_LENGTH = 1000;
export const MAX_OBJECT_KEYS = 20;
export const MAX_ITEMS: Record<MemoryOrigin, number> = { explicit: 1000, learned: 500, observed: 500 };
/** How long an unreinforced pattern, or an observation, is kept. */
export const DEFAULT_TTL_DAYS: Record<Exclude<MemoryOrigin, "explicit">, number> = {
  learned: 90,
  observed: 30,
};

function isScalar(value: unknown): value is MemoryScalar {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= MAX_STRING_LENGTH)
  );
}

/** Null when `value` is a valid MemoryValue; otherwise why not. */
export function validateMemoryValue(value: unknown): string | null {
  if (isScalar(value)) return null;
  if (typeof value === "string") return `A value can be at most ${MAX_STRING_LENGTH} characters.`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "A value must be text, a number, true/false, or a flat set of those.";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) return `A value can have at most ${MAX_OBJECT_KEYS} fields.`;
  for (const [key, field] of entries) {
    if (!key || key.length > 40) return "Field names must be 1–40 characters.";
    if (!isScalar(field)) return `Field "${key}" must be text, a number or true/false.`;
  }
  return null;
}

export function validateTitle(title: unknown): string | null {
  if (typeof title !== "string" || !title.trim()) return "A memory needs a title.";
  if (title.trim().length > MAX_TITLE_LENGTH) return `A title can be at most ${MAX_TITLE_LENGTH} characters.`;
  return null;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * One persisted item, checked field by field. Anything malformed — or
 * found in the wrong tier's file — is rejected (null), never half-used.
 */
export function parseMemoryItem(raw: unknown, origin: MemoryOrigin): MemoryItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.length > 80) return null;
  if (r.origin !== origin) return null;
  if (!MEMORY_KINDS.includes(r.kind as MemoryKind)) return null;
  if (validateTitle(r.title) !== null) return null;
  if (validateMemoryValue(r.value) !== null) return null;
  if (r.key !== null && (typeof r.key !== "string" || !r.key || r.key.length > 200)) return null;
  if (typeof r.source !== "string" || !r.source || r.source.length > 40) return null;
  if (!isIsoDate(r.createdAt) || !isIsoDate(r.updatedAt)) return null;
  if (r.expiresAt !== null && !isIsoDate(r.expiresAt)) return null;
  const confidence =
    typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
  if (confidence === null) return null;
  return {
    id: r.id,
    kind: r.kind as MemoryKind,
    origin,
    key: (r.key as string | null) ?? null,
    title: (r.title as string).trim(),
    value: r.value as MemoryValue,
    detail: typeof r.detail === "string" ? r.detail.slice(0, MAX_DETAIL_LENGTH) : null,
    source: r.source,
    confidence: origin === "explicit" ? 1 : confidence,
    evidence: typeof r.evidence === "number" && r.evidence >= 1 ? Math.floor(r.evidence) : 1,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
    expiresAt: (r.expiresAt as string | null) ?? null,
    disabled: r.disabled === true,
  };
}
