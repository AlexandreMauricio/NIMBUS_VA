/**
 * Context Events — the generic mechanism representing "something just
 * happened" that NIMBUS might want to react to. Distinct from the Context
 * system (src/context/): a ContextProvider answers "what is the current
 * state?" when asked; a ContextEvent is pushed the moment something
 * changes, independent of anyone asking.
 *
 * This is what feeds the Routine/Trigger system (src/routines/):
 *
 *   Context → Context Event → Trigger Matcher → Routine → Suggestion → Action
 *
 * Kept deliberately small and generic — nothing here knows about Spotify,
 * routines, or any specific application/website. A future producer (a new
 * detector, a Context provider noticing a state change) only needs to
 * construct one of these shapes and publish it via ContextEventBus.
 */

export type ContextEventType =
  | "applicationOpened"
  | "websiteOpened"
  | "folderOpened"
  | "timerCompleted"
  // Reserved for future producers — not emitted by anything yet, but
  // included so the trigger/routine types this task builds don't need to
  // change shape when they are. See "Context events" in README.
  | "playbackChanged"
  | "calendarEventApproaching"
  | "emailReceived";

interface ContextEventBase {
  id: string;
  type: ContextEventType;
  occurredAt: string;
  /** Which producer generated this event, e.g. "desktopActivityMonitor", "timerService" — diagnostic/traceability metadata, never used for trigger matching itself. */
  source: string;
}

/**
 * A monitored application started running. `activation` distinguishes
 * "just launched" from "brought to the foreground" — the desktop activity
 * monitor (src/main/activity/) only ever emits `"launched"` today (see its
 * own doc comment for why), but a trigger/matcher already understands the
 * other kinds so a more precise future detector can add them without a
 * shape change.
 */
export interface ApplicationOpenedEvent extends ContextEventBase {
  type: "applicationOpened";
  /** Lowercased executable name, e.g. "steam.exe". */
  executableName: string;
  windowTitle: string | null;
  activation: "launched" | "activated" | "alreadyRunning";
}

/**
 * A monitored browser window's page changed. True URL/domain detection
 * needs a browser extension (out of scope for this task — see
 * ARCHITECTURE.md); `url`/`domain` are populated only when a producer can
 * actually determine them, and are `null` otherwise. `windowTitle` is
 * always present and is what today's heuristic detector actually matches
 * against.
 */
export interface WebsiteOpenedEvent extends ContextEventBase {
  type: "websiteOpened";
  /** Lowercased browser executable name, e.g. "chrome.exe". */
  browserExecutable: string;
  windowTitle: string;
  url: string | null;
  domain: string | null;
}

export interface FolderOpenedEvent extends ContextEventBase {
  type: "folderOpened";
  path: string;
}

/**
 * A NIMBUS-owned timer (src/timers/) finished counting down. Established
 * now specifically so the Trigger/Routine system has somewhere to react
 * to it later (e.g. a "take a break?" suggestion) — no such routine is
 * built yet, per this task's own scope.
 */
export interface TimerCompletedEvent extends ContextEventBase {
  type: "timerCompleted";
  timerId: string;
  title: string;
  timerType: string;
}

export type ContextEvent =
  ApplicationOpenedEvent | WebsiteOpenedEvent | FolderOpenedEvent | TimerCompletedEvent;
