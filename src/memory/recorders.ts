import { ActivityEndedEvent, NetworkDeviceAppearedEvent } from "../events/types";
import { MemoryService } from "./memoryService";
import { MemoryItem, MemoryScalar, MemoryValue } from "./types";

/**
 * Translations from what other parts of NIMBUS already know into memory.
 * Called only by the app's wiring (lifecycle.ts) — providers and services
 * never write into memory themselves. Each decides what is worth
 * remembering and how, so the memory model stays the one place that
 * persists anything.
 */

/** Sessions shorter than this don't count as evidence of a habit. */
export const MIN_ACTIVITY_MINUTES = 10;

function numberField(value: MemoryValue | null, key: string): number {
  if (!value || typeof value !== "object") return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function field(value: MemoryValue, key: string): MemoryScalar {
  return value && typeof value === "object" ? (value[key] ?? null) : null;
}

function localHour(at: Date, timeZone?: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(at);
    return Number(hour) % 24;
  } catch {
    return at.getHours();
  }
}

/**
 * A finished activity session (10+ minutes) reinforces the "recurring
 * activity" pattern: how many sessions, how long in all, and the hour it
 * usually starts.
 */
export function recordActivityEnded(
  memory: MemoryService,
  event: ActivityEndedEvent,
  timeZone?: string
): MemoryItem | null {
  const minutes = Math.round(event.durationMs / 60_000);
  if (minutes < MIN_ACTIVITY_MINUTES) return null;
  const startHour = localHour(new Date(Date.parse(event.occurredAt) - event.durationMs), timeZone);
  return memory.reinforce({
    key: `activity:${event.activity.toLowerCase()}`,
    source: "activity",
    update: (previous) => {
      const hoursText = field(previous ?? null, "hours");
      const hours =
        typeof hoursText === "string" && hoursText.split(",").length === 24
          ? hoursText.split(",").map((n) => Number(n) || 0)
          : new Array<number>(24).fill(0);
      hours[startHour] += 1;
      const usualHour = hours.indexOf(Math.max(...hours));
      return {
        activity: event.activity,
        sessions: numberField(previous, "sessions") + 1,
        minutes: numberField(previous, "minutes") + minutes,
        usualHour,
        hours: hours.join(","),
      };
    },
    title: (value) =>
      `${event.activity} — usually around ${String(field(value, "usualHour")).padStart(2, "0")}:00`,
    detail: (value) => {
      const sessions = numberField(value, "sessions");
      const hours = Math.round(numberField(value, "minutes") / 6) / 10;
      return `${sessions} session${sessions === 1 ? "" : "s"}, ${hours} h in all`;
    },
  });
}

/** How a routine's suggestions tend to be answered — "accepted 5 of 7". A popup that ran out is not an answer. */
export function recordRoutineDecision(
  memory: MemoryService,
  routine: { id: string; name: string },
  outcome: "accepted" | "dismissed"
): MemoryItem | null {
  return memory.reinforce({
    key: `routine:${routine.id}`,
    source: "routines",
    update: (previous) => ({
      routine: routine.name,
      accepted: numberField(previous, "accepted") + (outcome === "accepted" ? 1 : 0),
      dismissed: numberField(previous, "dismissed") + (outcome === "dismissed" ? 1 : 0),
    }),
    title: `Routine "${routine.name}"`,
    detail: (value) => {
      const accepted = numberField(value, "accepted");
      const total = accepted + numberField(value, "dismissed");
      return `Accepted ${accepted} of ${total} suggestion${total === 1 ? "" : "s"}`;
    },
  });
}

/** A device never seen before joined the network — history, kept 30 days. */
export function recordNewNetworkDevice(
  memory: MemoryService,
  event: NetworkDeviceAppearedEvent
): MemoryItem | null {
  const name = event.hostname ?? event.vendor ?? "Unknown device";
  return memory.observe({
    key: `network:new:${event.deviceId}`,
    kind: "history",
    source: "network",
    title: "New device on your network",
    detail: `${name} at ${event.ip}`,
    value: { ip: event.ip, mac: event.mac, hostname: event.hostname, vendor: event.vendor },
    confidence: 0.9,
    ttlDays: 30,
  });
}
