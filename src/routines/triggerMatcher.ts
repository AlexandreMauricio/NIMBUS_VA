import { ContextEvent } from "../events/types";
import { matchAnyPattern } from "../common/patternMatch";
import { TriggerConfig } from "./types";

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

    case "activityEnded": {
      if (event.type !== "activityEnded") return false;
      // Matched by name rather than pattern: an activity name is chosen
      // from a short list the user wrote, not observed from the world.
      const wanted = trigger.activity.trim();
      if (wanted.length > 0 && wanted.toLowerCase() !== event.activity.trim().toLowerCase()) {
        return false;
      }
      const minMs = (trigger.minMinutes ?? 0) * 60_000;
      return event.durationMs >= minMs;
    }

    default:
      return false;
  }
}
