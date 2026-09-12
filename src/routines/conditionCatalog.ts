/**
 * What a routine can check, as data: **field → operator → value**.
 *
 * One place describes every condition NIMBUS understands — "Spotify",
 * "is playing", no value — so the editor builds its pickers from this
 * list instead of hard-coding a row per condition, and adding a new
 * check means one entry here, one case in conditionEvaluator.ts, and
 * nothing else.
 *
 * Conditions are still stored as the typed objects in types.ts: this
 * module only translates between that stored shape and the three things
 * a picker needs. Older saved conditions keep working — `weekdaysOnly`
 * is marked `legacy` so it still renders but is no longer offered.
 *
 * Pure, with no imports: Core evaluates conditions with it, and the
 * renderer draws its editor from it, without either owning it.
 */

/** Loose on purpose — both the stored union and the UI's own mirror of it fit. */
export interface ConditionLike {
  type: string;
  [key: string]: unknown;
}

/** What kind of value an operator needs, which is what the editor draws. */
export type ConditionValueKind =
  "none" | "timeRange" | "time" | "days" | "activity" | "minutes" | "playlist" | "device";

export interface ConditionOperator {
  id: string;
  label: string;
  value: ConditionValueKind;
  /** Still understood and rendered, but not offered for new conditions. */
  legacy?: boolean;
}

export interface ConditionField {
  id: string;
  label: string;
  /** Why a field might have nothing to check against right now. */
  note?: string;
  operators: ConditionOperator[];
}

export interface ConditionRow {
  fieldId: string;
  fieldLabel: string;
  operatorId: string;
  operatorLabel: string;
  valueKind: ConditionValueKind;
  /** The stored value, in the shape that `valueKind` implies. */
  value: ConditionValue;
}

export type ConditionValue =
  | null
  | number
  | string
  | number[]
  | { startHour: number; startMinute: number; endHour: number; endMinute: number }
  | { hour: number; minute: number }
  | { id: string; name: string };

export const CONDITION_FIELDS: readonly ConditionField[] = [
  {
    id: "time",
    label: "Time",
    operators: [
      { id: "between", label: "is between", value: "timeRange" },
      { id: "before", label: "is before", value: "time" },
      { id: "after", label: "is after", value: "time" },
    ],
  },
  {
    id: "day",
    label: "Day",
    operators: [
      { id: "isOneOf", label: "is one of", value: "days" },
      { id: "weekdaysOnly", label: "is a weekday (Mon-Fri)", value: "none", legacy: true },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    note: "Needs activity tracking on.",
    operators: [
      { id: "is", label: "is", value: "activity" },
      { id: "isNot", label: "is not", value: "activity" },
      { id: "lastedAtLeast", label: "has lasted at least", value: "minutes" },
      { id: "lastedLessThan", label: "has lasted less than", value: "minutes" },
    ],
  },
  {
    id: "spotify",
    label: "Spotify",
    operators: [
      { id: "isPlaying", label: "is playing", value: "none" },
      { id: "isNotPlaying", label: "is not playing", value: "none" },
    ],
  },
  {
    id: "spotifyPlaylist",
    label: "Spotify playlist",
    note: "What Spotify reports as playing now.",
    operators: [
      { id: "is", label: "is", value: "playlist" },
      { id: "isNot", label: "is not", value: "playlist" },
    ],
  },
  {
    id: "timer",
    label: "Timer",
    operators: [
      { id: "isRunning", label: "is running", value: "none" },
      { id: "isPaused", label: "is paused", value: "none" },
      { id: "isNotRunning", label: "is not running", value: "none" },
    ],
  },
  {
    id: "presence",
    label: "You",
    note: "From keyboard and mouse activity, and your phone if you chose one in Settings.",
    operators: [
      { id: "isAtPc", label: "are at the PC", value: "none" },
      { id: "isNotAtPc", label: "are away from the PC", value: "none" },
      { id: "isOut", label: "are out", value: "none" },
    ],
  },
  {
    id: "device",
    label: "Device",
    note: "A device from the Network tab. Needs network watching on.",
    operators: [
      { id: "isHome", label: "is on the network", value: "device" },
      { id: "isAway", label: "is not on the network", value: "device" },
    ],
  },
];

export function fieldById(fieldId: string): ConditionField | null {
  return CONDITION_FIELDS.find((field) => field.id === fieldId) ?? null;
}

/** The operators a field offers for a NEW condition — legacy ones excluded. */
export function operatorsFor(fieldId: string): ConditionOperator[] {
  return (fieldById(fieldId)?.operators ?? []).filter((operator) => !operator.legacy);
}

export function operatorFor(fieldId: string, operatorId: string): ConditionOperator | null {
  return fieldById(fieldId)?.operators.find((operator) => operator.id === operatorId) ?? null;
}

/** What a freshly added row starts as, so it is valid before being edited. */
export function defaultValueFor(kind: ConditionValueKind): ConditionValue {
  switch (kind) {
    case "timeRange":
      return { startHour: 18, startMinute: 0, endHour: 23, endMinute: 0 };
    case "time":
      return { hour: 18, minute: 0 };
    case "days":
      return [1, 2, 3, 4, 5];
    case "minutes":
      return 90;
    case "activity":
      return "";
    case "playlist":
    case "device":
      return { id: "", name: "" };
    default:
      return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function idAndName(value: unknown): { id: string; name: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return { id: textOf(v.id), name: textOf(v.name) };
  }
  return { id: textOf(value), name: "" };
}

/**
 * The stored condition for a field/operator/value choice, or null if the
 * combination isn't one NIMBUS knows.
 */
export function buildCondition(
  fieldId: string,
  operatorId: string,
  value?: ConditionValue
): ConditionLike | null {
  const operator = operatorFor(fieldId, operatorId);
  // Legacy operators are still read (so an old routine renders), but
  // never built anew: the catalog offers their replacement instead.
  if (!operator || operator.legacy) return null;
  const v = value === undefined ? defaultValueFor(operator.value) : value;

  switch (`${fieldId}.${operatorId}`) {
    case "time.between": {
      const range = (v ?? {}) as Record<string, unknown>;
      return {
        type: "timeOfDay",
        startHour: numberOr(range.startHour, 18),
        startMinute: numberOr(range.startMinute, 0),
        endHour: numberOr(range.endHour, 23),
        endMinute: numberOr(range.endMinute, 0),
      };
    }
    case "time.before":
    case "time.after": {
      const at = (v ?? {}) as Record<string, unknown>;
      return {
        type: "timeIs",
        operator: operatorId,
        hour: numberOr(at.hour, 18),
        minute: numberOr(at.minute, 0),
      };
    }
    case "day.isOneOf":
      return { type: "daysOfWeek", days: Array.isArray(v) ? v.filter((d) => typeof d === "number") : [] };
    case "day.weekdaysOnly":
      return { type: "weekdaysOnly" };
    case "activity.is":
      return { type: "activityIs", activity: textOf(v) };
    case "activity.isNot":
      return { type: "activityIs", activity: textOf(v), negate: true };
    case "activity.lastedAtLeast":
      return { type: "activityDuration", minMinutes: numberOr(v, 0), operator: "atLeast" };
    case "activity.lastedLessThan":
      return { type: "activityDuration", minMinutes: numberOr(v, 0), operator: "lessThan" };
    case "spotify.isPlaying":
      return { type: "spotifyIsPlaying" };
    case "spotify.isNotPlaying":
      return { type: "spotifyNotAlreadyPlaying" };
    case "spotifyPlaylist.is":
    case "spotifyPlaylist.isNot": {
      const playlist = idAndName(v);
      return {
        type: "spotifyPlaylistIs",
        playlistUri: playlist.id,
        playlistName: playlist.name,
        ...(operatorId === "isNot" ? { negate: true } : {}),
      };
    }
    case "timer.isRunning":
      return { type: "timerStatusIs", status: "running" };
    case "timer.isPaused":
      return { type: "timerStatusIs", status: "paused" };
    case "timer.isNotRunning":
      return { type: "timerStatusIs", status: "none" };
    case "presence.isAtPc":
      return { type: "presenceIs", status: "atPc" };
    case "presence.isNotAtPc":
      return { type: "presenceIs", status: "notAtPc" };
    case "presence.isOut":
      return { type: "presenceIs", status: "out" };
    case "device.isHome":
    case "device.isAway": {
      const device = idAndName(v);
      return {
        type: "deviceOnline",
        deviceId: device.id,
        deviceName: device.name,
        ...(operatorId === "isAway" ? { negate: true } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * A stored condition read back as field/operator/value, so one editor row
 * can draw any of them. Null for a condition this catalog doesn't cover
 * (`actionsNotAlreadyActive`, which is its own checkbox, or something
 * saved by a newer NIMBUS).
 */
export function readCondition(condition: ConditionLike | null | undefined): ConditionRow | null {
  if (!condition || typeof condition.type !== "string") return null;
  const c = condition as Record<string, unknown>;

  const row = (fieldId: string, operatorId: string, value: ConditionValue): ConditionRow | null => {
    const field = fieldById(fieldId);
    const operator = operatorFor(fieldId, operatorId);
    if (!field || !operator) return null;
    return {
      fieldId,
      fieldLabel: field.label,
      operatorId,
      operatorLabel: operator.label,
      valueKind: operator.value,
      value,
    };
  };

  switch (condition.type) {
    case "timeOfDay":
      return row("time", "between", {
        startHour: numberOr(c.startHour, 0),
        startMinute: numberOr(c.startMinute, 0),
        endHour: numberOr(c.endHour, 0),
        endMinute: numberOr(c.endMinute, 0),
      });
    case "timeIs":
      return row("time", c.operator === "after" ? "after" : "before", {
        hour: numberOr(c.hour, 0),
        minute: numberOr(c.minute, 0),
      });
    case "daysOfWeek":
      return row("day", "isOneOf", Array.isArray(c.days) ? (c.days as number[]) : []);
    case "weekdaysOnly":
      return row("day", "weekdaysOnly", null);
    case "activityIs":
      return row("activity", c.negate === true ? "isNot" : "is", textOf(c.activity));
    case "activityDuration":
      return row(
        "activity",
        c.operator === "lessThan" ? "lastedLessThan" : "lastedAtLeast",
        numberOr(c.minMinutes, 0)
      );
    case "spotifyIsPlaying":
      return row("spotify", "isPlaying", null);
    case "spotifyNotAlreadyPlaying":
      return row("spotify", "isNotPlaying", null);
    case "spotifyPlaylistIs":
      return row("spotifyPlaylist", c.negate === true ? "isNot" : "is", {
        id: textOf(c.playlistUri),
        name: textOf(c.playlistName),
      });
    case "timerStatusIs":
      return row(
        "timer",
        c.status === "paused" ? "isPaused" : c.status === "none" ? "isNotRunning" : "isRunning",
        null
      );
    case "presenceIs":
      return row(
        "presence",
        c.status === "out" ? "isOut" : c.status === "notAtPc" ? "isNotAtPc" : "isAtPc",
        null
      );
    case "deviceOnline":
      return row("device", c.negate === true ? "isAway" : "isHome", {
        id: textOf(c.deviceId),
        name: textOf(c.deviceName),
      });
    default:
      return null;
  }
}
