/**
 * Shared contract between future "assistant" producers (AI, automation,
 * integrations — none of which exist yet) and the UI.
 *
 * The UI only ever knows about these shapes. It never knows *how* an event
 * was produced (an LLM, a scheduled check, a rule, a plugin...) — that
 * logic lives entirely behind `AssistantBridge` (see
 * `src/main/assistantBridge.ts`). This is the seam future features plug
 * into without coupling themselves to window/renderer details, and
 * without the UI needing to know anything about them.
 *
 * Nothing currently produces these events — this file only establishes
 * the shape so the plumbing (IPC channel, preload API, UI listener)
 * exists ahead of time.
 */

export type AssistantEventType = "message" | "notification" | "briefing" | "actionRequest" | "suggestion";

interface AssistantEventBase {
  id: string;
  type: AssistantEventType;
  createdAt: string;
  /** Which subsystem produced this event, e.g. "system", future "weather", "scheduler". */
  source: string;
}

/** A conversational or informational message NIMBUS wants to show the user. */
export interface AssistantMessage extends AssistantEventBase {
  type: "message";
  text: string;
}

/** A short, low-priority heads-up (as opposed to an OS-level notification). */
export interface AssistantNotification extends AssistantEventBase {
  type: "notification";
  title: string;
  body: string;
  /**
   * Set when the notice is one of Attention's questions ("make it an
   * activity?"): the item to answer, and its two answers, so the feed can
   * offer them as buttons. Absent for a plain notice.
   */
  attentionItemId?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
}

/** A summarized bundle of information (e.g. a future daily/status briefing). */
export interface AssistantBriefing extends AssistantEventBase {
  type: "briefing";
  title: string;
  items: string[];
}

/** A request for the user to approve/choose something before NIMBUS acts. */
export interface AssistantActionRequest extends AssistantEventBase {
  type: "actionRequest";
  description: string;
  options: string[];
}

/**
 * A quiet, dismissible offer to run a user-configured Routine — the
 * output of the Context Event → Trigger → Routine pipeline (see
 * src/routines/). Distinct from AssistantActionRequest (a generic,
 * unused-so-far "approve/choose" shape): a suggestion always names the
 * one specific Routine it came from and always carries exactly one
 * primary action plus a dismiss option, matching the "NIMBUS suggests
 * before it acts" flow the Routine system is built around.
 */
export interface AssistantSuggestion extends AssistantEventBase {
  type: "suggestion";
  /** The Routine it came from. Absent for a suggestion the Attention engine raised. */
  routineId?: string;
  /**
   * Who raised it. "routine" (the default when absent — every suggestion
   * before Attention existed): accepting runs the routine's actions.
   * "attention": informational — accepting only acknowledges it, and
   * nothing runs.
   */
  origin?: "routine" | "attention";
  /** For an Attention suggestion: the item it stands for (see src/attention/). */
  attentionItemId?: string;
  /** One line on why NIMBUS thought this mattered, shown small in the popup. */
  reason?: string;
  title: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
  /** ISO timestamp — the UI auto-dismisses the suggestion at this point if the user hasn't acted on it. */
  expiresAt: string;
  /**
   * One entry per configured action step, generated from each step's
   * registered ActionDefinition (see RoutineService) — never a
   * hard-coded "Spotify + Timer" string. `service` is the owning
   * provider's id (e.g. "spotify", "timer"), included only so a
   * presentation layer can pick a generic icon by service without this
   * type (or RoutineService) needing to know what icon that is.
   */
  actionSummary: Array<{ label: string; service: string }>;
}

export type AssistantEvent =
  AssistantMessage | AssistantNotification | AssistantBriefing | AssistantActionRequest | AssistantSuggestion;
