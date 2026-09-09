import { ContextEvent } from "../events/types";
import { StringMatchMode, TriggerConfig } from "./types";

/**
 * Pure matching logic between one Context Event and one Trigger config —
 * no side effects, no I/O, fully unit-testable without any detector
 * running. This is deliberately the *only* place trigger-matching rules
 * live, so a future trigger type only needs one more case here.
 */
export function matchesTrigger(event: ContextEvent, trigger: TriggerConfig): boolean {
  if (event.type !== trigger.type) return false;

  switch (trigger.type) {
    case "applicationOpened":
      if (event.type !== "applicationOpened") return false;
      return matchAnyPattern(event.executableName, trigger.application, trigger.matchMode);

    case "websiteOpened": {
      if (event.type !== "websiteOpened") return false;
      const value =
        trigger.matchField === "domain"
          ? event.domain
          : trigger.matchField === "url"
            ? event.url
            : event.windowTitle;
      if (value === null) return false; // can't match a field the detector didn't determine
      return matchAnyPattern(value, trigger.pattern, trigger.matchMode);
    }

    case "folderOpened":
      if (event.type !== "folderOpened") return false;
      return matchAnyPattern(event.path, trigger.path, trigger.matchMode);

    case "timerCompleted":
      if (event.type !== "timerCompleted") return false;
      return trigger.timerType.trim().length === 0 || event.timerType === trigger.timerType;

    default:
      return false;
  }
}

function matchString(value: string, pattern: string, mode: StringMatchMode): boolean {
  const a = value.toLowerCase();
  const b = pattern.toLowerCase();
  return mode === "exact" ? a === b : a.includes(b);
}

/**
 * A trigger's pattern field can hold multiple comma-separated
 * alternatives (e.g. "skillcert,nowuniversity") so one Routine can fire
 * from any of several apps/sites/folders instead of needing a duplicate
 * Routine per one — matches if `value` matches *any* alternative. A
 * plain single pattern (the overwhelmingly common case) behaves exactly
 * as before: splitting "skillcert" on "," just yields `["skillcert"]`.
 * Empty alternatives from stray commas/whitespace are dropped rather
 * than matching everything.
 */
function matchAnyPattern(value: string, patternField: string, mode: StringMatchMode): boolean {
  const alternatives = patternField
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return alternatives.some((pattern) => matchString(value, pattern, mode));
}
