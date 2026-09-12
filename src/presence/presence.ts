import { logger } from "../logging/logger";

/**
 * Presence — whether you're at the PC, home but away from it, or out.
 *
 * Two signals, because neither is enough alone:
 *
 *  - **Idle time** (seconds since the last key or mouse input, from the OS)
 *    says whether you're at the PC. It can't tell "in the kitchen" from
 *    "out for the day".
 *  - **Your phone on the home network** says whether you're home — but
 *    phones drop off Wi-Fi while asleep, so a phone missing for a few
 *    minutes means nothing. It only counts as gone after a grace period
 *    since it was last seen.
 *
 * Deterministic: the same idle time, phone sighting and clock always give
 * the same answer, with the reason in words.
 */

export type PresenceState =
  /** Input within the last few minutes. */
  | "atPc"
  /** Idle, and your phone was on the network recently. */
  | "home"
  /** Idle, and your phone hasn't been seen for longer than the grace period. */
  | "away"
  /** Idle, with no phone chosen (or network watching off) — home or out can't be told. */
  | "idle";

export interface PresenceSnapshot {
  state: PresenceState;
  /** Seconds since the last input, or null when the OS couldn't say. */
  idleSeconds: number | null;
  /** When the chosen phone was last seen on the network, if one is chosen and known. */
  phoneLastSeen: string | null;
  reason: string;
  since: string;
}

/** Idle this long and you're no longer "at the PC". */
export const AWAY_FROM_PC_SECONDS = 5 * 60;
/** A phone unseen for this long counts as gone; less is a phone asleep on Wi-Fi. */
export const PHONE_GRACE_MINUTES = 45;

export interface PresenceInputs {
  idleSeconds: number | null;
  /** Null when no phone is chosen, or NIMBUS can't read the network. */
  phoneLastSeen: string | null;
  phoneChosen: boolean;
}

function minutesAgo(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 60_000;
}

export function judgePresence(inputs: PresenceInputs, now: Date): Omit<PresenceSnapshot, "since"> {
  const { idleSeconds, phoneLastSeen, phoneChosen } = inputs;
  // No idle reading at all: assume present rather than silently stop counting.
  if (idleSeconds === null || idleSeconds < AWAY_FROM_PC_SECONDS) {
    return {
      state: "atPc",
      idleSeconds,
      phoneLastSeen,
      reason: idleSeconds === null ? "Idle time unavailable — assumed at the PC" : "Using the PC",
    };
  }
  const idleMinutes = Math.floor(idleSeconds / 60);
  if (!phoneChosen || !phoneLastSeen || !Number.isFinite(Date.parse(phoneLastSeen))) {
    return {
      state: "idle",
      idleSeconds,
      phoneLastSeen,
      reason: phoneChosen
        ? `No input for ${idleMinutes} min; your phone hasn't been seen yet`
        : `No input for ${idleMinutes} min; choose your phone to tell home from out`,
    };
  }
  const unseen = Math.floor(minutesAgo(phoneLastSeen, now));
  if (unseen <= PHONE_GRACE_MINUTES) {
    return {
      state: "home",
      idleSeconds,
      phoneLastSeen,
      reason: `No input for ${idleMinutes} min; your phone was on the network ${unseen <= 1 ? "just now" : `${unseen} min ago`}`,
    };
  }
  return {
    state: "away",
    idleSeconds,
    phoneLastSeen,
    reason: `No input for ${idleMinutes} min, and your phone hasn't been on the network for ${unseen} min`,
  };
}

/**
 * Keeps the current presence, re-judged on demand (the desktop monitor's
 * poll calls `update()` every few seconds). Reads its signals through
 * injected functions, so Core knows nothing about Electron or the network.
 */
export class PresenceService {
  private current: PresenceSnapshot;
  private readonly listeners = new Set<(snapshot: PresenceSnapshot) => void>();

  constructor(
    private readonly readIdleSeconds: () => number | null,
    private readonly readPhone: () => { chosen: boolean; lastSeen: string | null },
    private readonly now: () => Date = () => new Date()
  ) {
    const at = this.now();
    this.current = { ...this.judge(at), since: at.toISOString() };
  }

  get(): PresenceSnapshot {
    return { ...this.current };
  }

  isAtPc(): boolean {
    return this.current.state === "atPc";
  }

  onChange(listener: (snapshot: PresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(): PresenceSnapshot {
    const at = this.now();
    const judged = this.judge(at);
    const changed = judged.state !== this.current.state;
    this.current = { ...judged, since: changed ? at.toISOString() : this.current.since };
    if (changed) {
      logger.info("Presence changed", { state: judged.state, reason: judged.reason });
      for (const listener of this.listeners) {
        try {
          listener({ ...this.current });
        } catch (err) {
          logger.warn("A presence listener threw", { error: String(err) });
        }
      }
    }
    return { ...this.current };
  }

  private judge(at: Date): Omit<PresenceSnapshot, "since"> {
    let idleSeconds: number | null = null;
    try {
      const read = this.readIdleSeconds();
      idleSeconds = typeof read === "number" && Number.isFinite(read) && read >= 0 ? read : null;
    } catch {
      idleSeconds = null;
    }
    let phone = { chosen: false, lastSeen: null as string | null };
    try {
      phone = this.readPhone();
    } catch {
      phone = { chosen: false, lastSeen: null };
    }
    return judgePresence({ idleSeconds, phoneLastSeen: phone.lastSeen, phoneChosen: phone.chosen }, at);
  }
}
