import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import {
  DEFAULT_TTL_DAYS,
  MAX_DETAIL_LENGTH,
  MAX_ITEMS,
  MEMORY_ORIGINS,
  MemoryFilter,
  MemoryItem,
  MemoryKind,
  MemoryOrigin,
  MemoryStateStore,
  MemoryValue,
  parseMemoryItem,
  validateMemoryValue,
  validateTitle,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Something the user asks NIMBUS to remember. */
export interface RememberInput {
  kind: "preference" | "fact";
  title: string;
  value?: MemoryValue;
  detail?: string | null;
  /** Optional: when to forget it. Absent or null means never. */
  expiresAt?: string | null;
}

/** Something NIMBUS noticed — kept as history for a while. */
export interface ObservationInput {
  key: string;
  kind: MemoryKind;
  title: string;
  value: MemoryValue;
  detail?: string | null;
  source: string;
  confidence?: number;
  ttlDays?: number;
}

/** A pattern, reinforced by each new piece of evidence. */
export interface PatternInput {
  key: string;
  kind?: MemoryKind;
  source: string;
  /** The new value from the previous one (null the first time). */
  update: (previous: MemoryValue | null) => MemoryValue;
  title: string | ((value: MemoryValue, evidence: number) => string);
  detail?: string | ((value: MemoryValue, evidence: number) => string);
  ttlDays?: number;
}

/**
 * Confidence of a learned pattern from its evidence: n / (n + 3), capped
 * at 0.95 — a pattern is never as certain as something the user said.
 * 1 → 0.25, 3 → 0.5, 9 → 0.75.
 */
export function learnedConfidence(evidence: number): number {
  return Math.round(Math.min(0.95, evidence / (evidence + 3)) * 100) / 100;
}

function checked(error: string | null): void {
  if (error) throw new Error(error);
}

function cleanDetail(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "string") throw new Error("A note must be text.");
  const text = detail.trim();
  if (text.length > MAX_DETAIL_LENGTH)
    throw new Error(`A note can be at most ${MAX_DETAIL_LENGTH} characters.`);
  return text || null;
}

/**
 * The memory layer: keeps the three tiers apart, validates everything that
 * goes in or comes back from disk, expires what's due, and answers
 * queries. Core only — persistence is the injected store, and nothing here
 * knows about Electron, files or any UI.
 */
export class MemoryService {
  private readonly items = new Map<string, MemoryItem>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store?: MemoryStateStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    /** The user's "Learn from what I do" switch. Off: nothing is observed or learned. */
    private readonly learningEnabled: () => boolean = () => true
  ) {
    for (const origin of MEMORY_ORIGINS) {
      let raw: unknown = [];
      try {
        raw = store?.load(origin) ?? [];
      } catch (err) {
        logger.warn(`Could not read ${origin} memory — starting without it`, { error: String(err) });
      }
      if (!Array.isArray(raw)) {
        if (raw !== null && raw !== undefined) logger.warn(`Ignoring ${origin} memory: not a list`);
        continue;
      }
      let skipped = 0;
      for (const entry of raw.slice(0, MAX_ITEMS[origin])) {
        const item = parseMemoryItem(entry, origin);
        if (item && !this.items.has(item.id)) this.items.set(item.id, item);
        else skipped++;
      }
      if (skipped > 0) logger.warn(`Skipped ${skipped} malformed ${origin} memory item(s)`);
    }
    this.prune();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The user saves a preference or a fact. Fully trusted; forgotten only if they set a date. */
  remember(input: RememberInput): MemoryItem {
    if (input?.kind !== "preference" && input?.kind !== "fact") {
      throw new Error("You can save a preference or a fact.");
    }
    checked(validateTitle(input.title));
    const value = input.value ?? null;
    checked(validateMemoryValue(value));
    const expiresAt = this.futureDate(input.expiresAt);
    if (this.count("explicit") >= MAX_ITEMS.explicit) {
      throw new Error(`At most ${MAX_ITEMS.explicit} saved memories — forget some first.`);
    }
    const nowIso = this.now().toISOString();
    const item: MemoryItem = {
      id: this.newId(),
      kind: input.kind,
      origin: "explicit",
      key: null,
      title: input.title.trim(),
      value,
      detail: cleanDetail(input.detail),
      source: "user",
      confidence: 1,
      evidence: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
      disabled: false,
    };
    this.items.set(item.id, item);
    this.save("explicit");
    return { ...item };
  }

  /** NIMBUS noticed something. Kept as history, updated if seen again, forgotten after `ttlDays`. */
  observe(input: ObservationInput): MemoryItem | null {
    if (!this.learningEnabled()) return null;
    checked(validateTitle(input.title));
    checked(validateMemoryValue(input.value));
    const now = this.now();
    const existing = this.byKey("observed", input.key);
    if (existing?.disabled) return { ...existing };
    const item: MemoryItem = {
      id: existing?.id ?? this.newId(),
      kind: input.kind,
      origin: "observed",
      key: input.key,
      title: input.title.trim(),
      value: input.value,
      detail: cleanDetail(input.detail),
      source: input.source,
      confidence: Math.min(1, Math.max(0, input.confidence ?? existing?.confidence ?? 0.5)),
      evidence: (existing?.evidence ?? 0) + 1,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (input.ttlDays ?? DEFAULT_TTL_DAYS.observed) * DAY_MS
      ).toISOString(),
      disabled: false,
    };
    this.items.set(item.id, item);
    this.enforceCap("observed");
    this.save("observed");
    return { ...item };
  }

  /** One more piece of evidence for a pattern: its value is updated and its confidence grows. */
  reinforce(input: PatternInput): MemoryItem | null {
    if (!this.learningEnabled()) return null;
    const now = this.now();
    const existing = this.byKey("learned", input.key);
    // Switched off by the user: kept as it was, and not learned from.
    if (existing?.disabled) return { ...existing };
    const value = input.update(existing ? existing.value : null);
    checked(validateMemoryValue(value));
    const evidence = (existing?.evidence ?? 0) + 1;
    const title = typeof input.title === "function" ? input.title(value, evidence) : input.title;
    checked(validateTitle(title));
    const detail =
      typeof input.detail === "function" ? input.detail(value, evidence) : (input.detail ?? null);
    const item: MemoryItem = {
      id: existing?.id ?? this.newId(),
      kind: input.kind ?? "pattern",
      origin: "learned",
      key: input.key,
      title: title.trim(),
      value,
      detail: cleanDetail(detail),
      source: input.source,
      confidence: learnedConfidence(evidence),
      evidence,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlDays ?? DEFAULT_TTL_DAYS.learned) * DAY_MS).toISOString(),
      disabled: false,
    };
    this.items.set(item.id, item);
    this.enforceCap("learned");
    this.save("learned");
    return { ...item };
  }

  /**
   * Changes an item. The user's own memories can be edited (title, value,
   * note, forget date) and switched off; learned and observed ones can only
   * be switched off or on — NIMBUS keeps those up to date itself.
   */
  update(id: string, changes: unknown): MemoryItem {
    const item = this.items.get(id);
    if (!item) throw new Error("That memory no longer exists.");
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      throw new Error("Nothing to change.");
    const c = changes as Record<string, unknown>;
    const next: MemoryItem = { ...item };
    const editable = ["title", "value", "detail", "expiresAt"].filter((field) => field in c);
    if (editable.length > 0 && item.origin !== "explicit") {
      throw new Error("Learned and observed memories can only be switched off or kept.");
    }
    if ("title" in c) {
      checked(validateTitle(c.title));
      next.title = (c.title as string).trim();
    }
    if ("value" in c) {
      checked(validateMemoryValue(c.value));
      next.value = c.value as MemoryValue;
    }
    if ("detail" in c) next.detail = cleanDetail(c.detail);
    if ("expiresAt" in c) next.expiresAt = this.futureDate(c.expiresAt);
    if ("disabled" in c) {
      if (typeof c.disabled !== "boolean") throw new Error("Disabled must be true or false.");
      next.disabled = c.disabled;
    }
    next.updatedAt = this.now().toISOString();
    this.items.set(id, next);
    this.save(item.origin);
    return { ...next };
  }

  /**
   * "Keep this": a learned or observed item becomes the user's own — full
   * confidence, no expiry, no longer changed by NIMBUS. The only way
   * anything observed becomes permanent.
   */
  promote(id: string): MemoryItem {
    const item = this.items.get(id);
    if (!item) throw new Error("That memory no longer exists.");
    if (item.origin === "explicit") return { ...item };
    if (this.count("explicit") >= MAX_ITEMS.explicit) {
      throw new Error(`At most ${MAX_ITEMS.explicit} saved memories — forget some first.`);
    }
    const kept: MemoryItem = {
      ...item,
      id: this.newId(),
      origin: "explicit",
      confidence: 1,
      expiresAt: null,
      disabled: false,
      updatedAt: this.now().toISOString(),
    };
    this.items.delete(id);
    this.items.set(kept.id, kept);
    this.save(item.origin);
    this.save("explicit");
    return { ...kept };
  }

  forget(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.delete(id);
    this.save(item.origin);
    return true;
  }

  get(id: string): MemoryItem | null {
    this.prune();
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  /** Search and filter. Most trusted first, then most recently updated. */
  list(filter: MemoryFilter = {}): MemoryItem[] {
    this.prune();
    const text = filter.text?.trim().toLowerCase() ?? "";
    return [...this.items.values()]
      .filter((item) => !filter.kind || item.kind === filter.kind)
      .filter((item) => !filter.origin || item.origin === filter.origin)
      .filter((item) => !filter.source || item.source === filter.source)
      .filter((item) => filter.includeDisabled || !item.disabled)
      .filter(
        (item) =>
          !text ||
          [item.title, item.detail ?? "", item.key ?? "", JSON.stringify(item.value)].some((field) =>
            field.toLowerCase().includes(text)
          )
      )
      .sort(
        (a, b) =>
          MEMORY_ORIGINS.indexOf(a.origin) - MEMORY_ORIGINS.indexOf(b.origin) ||
          b.updatedAt.localeCompare(a.updatedAt)
      )
      .map((item) => ({ ...item }));
  }

  /** What NIMBUS remembers about `key`: the most trusted enabled, unexpired item, or null. */
  recall(key: string): MemoryItem | null {
    return this.list().find((item) => item.key === key) ?? null;
  }

  /** Forgets everything whose time has come. */
  prune(): void {
    const nowMs = this.now().getTime();
    const touched = new Set<MemoryOrigin>();
    for (const [id, item] of this.items) {
      if (item.expiresAt && Date.parse(item.expiresAt) <= nowMs) {
        this.items.delete(id);
        touched.add(item.origin);
      }
    }
    for (const origin of touched) this.save(origin);
  }

  private byKey(origin: MemoryOrigin, key: string): MemoryItem | null {
    for (const item of this.items.values()) if (item.origin === origin && item.key === key) return item;
    return null;
  }

  private count(origin: MemoryOrigin): number {
    return [...this.items.values()].filter((item) => item.origin === origin).length;
  }

  /** Over a tier's cap, the least recently updated go first. */
  private enforceCap(origin: MemoryOrigin): void {
    const tier = [...this.items.values()].filter((i) => i.origin === origin);
    if (tier.length <= MAX_ITEMS[origin]) return;
    tier.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const item of tier.slice(0, tier.length - MAX_ITEMS[origin])) this.items.delete(item.id);
  }

  private futureDate(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      throw new Error("That date isn't valid.");
    if (Date.parse(value) <= this.now().getTime()) throw new Error("The forget date must be in the future.");
    return new Date(Date.parse(value)).toISOString();
  }

  private save(origin: MemoryOrigin): void {
    try {
      this.store?.save(
        origin,
        [...this.items.values()].filter((item) => item.origin === origin)
      );
    } catch (err) {
      logger.warn(`Could not save ${origin} memory`, { error: String(err) });
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("A memory listener threw", { error: String(err) });
      }
    }
  }
}
