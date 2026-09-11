/**
 * Core contract for NIMBUS's Action system — the counterpart to the
 * Context system (src/context/types.ts).
 *
 * The distinction is deliberate:
 *   Context:  "what is happening?"  — read-only, safe to fetch freely.
 *   Action:   "do something."       — may change external state, so it
 *             carries its own safety metadata and always returns a
 *             structured result instead of throwing past this boundary.
 *
 * Nothing here knows about Spotify, Electron, IPC, or natural language.
 * A future Intelligence layer turns a user's sentence into a call like
 * `actionService.executeAction("spotify.play", {})`; this module only
 * defines what that call looks like and what comes back.
 */

/** Coarse, provider-agnostic failure category — lets a caller (UI, future Intelligence/voice) react without parsing provider-specific error text. */
export type ActionErrorCategory =
  | "not_available" // provider/service disabled, not installed, or not running
  | "not_authenticated" // no credentials, or authentication expired
  | "invalid_parameters" // failed validation before execution was attempted
  | "not_found" // e.g. a search returned nothing
  | "no_active_device" // service has no active player/target to act on
  | "rate_limited"
  | "network"
  | "timeout" // provider never settled within ActionService's budget
  | "unknown";

export interface ActionError {
  category: ActionErrorCategory;
  /** User-safe message — never a raw API/HTTP error. Technical detail belongs in logs only. */
  message: string;
}

export type ActionResultStatus = "success" | "failure";

/** What every action returns, regardless of which provider or service handled it — the UI never needs to understand a provider's own API response shape. */
export interface ActionResult<T = unknown> {
  actionId: string;
  status: ActionResultStatus;
  /** Structured, provider-defined result data on success (e.g. the track that started playing). */
  data?: T;
  /** Optional user-facing confirmation message on success, e.g. "Paused playback." */
  message?: string;
  /** Present only when status is "failure". */
  error?: ActionError;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ActionParameterSchema {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  /**
   * Optional hint that a string parameter is a local path of a certain
   * kind, so an editor can offer a file/folder picker beside the text
   * field. Presentation only — validation is still the provider's job.
   */
  format?: "file" | "folder" | "application";
}

/**
 * Static, inspectable metadata about one action — this is what a future
 * permission system or confirmation UI would read *before* calling
 * `execute`. None of these flags are enforced by the Action system itself
 * today (see ActionService) — establishing accurate metadata now is what
 * lets that enforcement be added later without every provider changing.
 */
export interface ActionDefinition {
  /** Stable id, namespaced by provider, e.g. "spotify.play". */
  id: string;
  name: string;
  description: string;
  parameters: ActionParameterSchema[];
  /** True only for actions that don't change anything (none exist yet — read operations belong in Context, not Actions; see ARCHITECTURE.md). */
  readOnly: boolean;
  /** True when running this action changes state outside NIMBUS itself (a real-world or third-party-service effect). */
  changesExternalState: boolean;
  /** Whether this action should be confirmed with the user before running — metadata only; nothing calls this automatically yet (see module doc). */
  requiresConfirmation: boolean;
  /** Which system/service this action affects, e.g. "spotify" — lets a permission system scope grants per-service later. */
  affectsService: string;
}

export interface ActionValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Contract every action provider implements — the Action-system analogue
 * of ContextProvider. A provider owns every action under its own id
 * prefix (e.g. "spotify.*") and is the only thing that knows how its
 * underlying service actually works; ActionService only ever talks to
 * this interface.
 */
export interface ActionProvider {
  /** Stable, unique identifier, e.g. "spotify". Every action this provider owns is prefixed "<id>.". */
  readonly id: string;
  readonly displayName: string;
  /** All actions this provider can perform, regardless of current availability — used to build a static capability list (e.g. for a UI or a future Intelligence layer to enumerate). */
  listActions(): ActionDefinition[];
  /** Cheap check for whether this provider can currently execute anything (enabled, authenticated, service reachable in principle). Should not throw. */
  isAvailable(): boolean | Promise<boolean>;
  /** Validates params for one of this provider's actions before execution is attempted. */
  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult;
  /** Executes one action. Must never throw past this boundary — failures are returned as a "failure" ActionResult (see ActionService, which also guards this). */
  execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult>;
}
