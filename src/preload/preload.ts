import { contextBridge, ipcRenderer } from "electron";
import { AssistantEvent } from "../common/assistantEvents";
import {
  StartupSettings,
  WeatherSettings,
  CalendarSettings,
  RoutineSettings,
} from "../settings/settingsManager";
import { Routine, RoutineEvaluation, RoutineHistoryEntry } from "../routines/types";
import { SpotifyPlaylistSummary } from "../context/providers/spotify/types";
import {
  TaskItem,
  TaskAccountInfo,
  TaskWriteRequest,
  TodoistProjectSummary,
} from "../context/providers/tasks";

/**
 * The renderer-facing shape of an email account — deliberately NOT the
 * same type settingsManager.ts uses internally: there is no `password`
 * field here at all. `hasPassword` tells the Settings form whether one
 * is already saved; `newPassword` (write side only) is how the form
 * submits a new one. See nimbus:get-email-settings /
 * nimbus:update-email-settings in src/main/lifecycle.ts for the main
 * process's side of this contract.
 */
export interface PublicEmailAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  sinceDays: number;
  enabled: boolean;
  hasPassword: boolean;
}

export interface PublicEmailSettings {
  enabled: boolean;
  defaultSinceDays: number;
  accounts: PublicEmailAccount[];
}

export type EmailAccountUpdate = Omit<PublicEmailAccount, "hasPassword"> & { newPassword?: string };

/** The renderer-facing shape of a task account — mirrors PublicEmailAccount's write-only-credential contract. */
export interface PublicTaskAccount {
  id: string;
  label: string;
  provider: "todoist";
  enabled: boolean;
  hasApiToken: boolean;
}

export interface PublicTaskSettings {
  enabled: boolean;
  accounts: PublicTaskAccount[];
}

export type TaskAccountUpdate = Omit<PublicTaskAccount, "hasApiToken"> & { newApiToken?: string };

/** The renderer-facing shape of Spotify's connection state — never a token of any kind, at any point. */
export interface PublicSpotifySettings {
  enabled: boolean;
  preferredDeviceId: string | null;
  connected: boolean;
}

export interface ActionParameterSchema {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  /** A local-path parameter the editor can offer a picker for. */
  format?: "file" | "folder" | "application";
}

/** Mirrors src/actions/types.ts's ActionDefinition — duplicated here (not imported) since preload.ts is the renderer-facing boundary and should not pull in Core's Action module wholesale. */
export interface PublicActionDefinition {
  id: string;
  name: string;
  description: string;
  parameters: ActionParameterSchema[];
  readOnly: boolean;
  changesExternalState: boolean;
  requiresConfirmation: boolean;
  affectsService: string;
}

export interface PublicActionError {
  category: string;
  message: string;
}

/** Mirrors src/actions/types.ts's ActionResult. */
export interface PublicActionResult<T = unknown> {
  actionId: string;
  status: "success" | "failure";
  data?: T;
  message?: string;
  error?: PublicActionError;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
import { ContextSnapshot } from "../context/types";
import { Briefing } from "../briefing/types";
import { ActivityMapping, ActivitySession, CurrentActivity } from "../activity/types";
import { ActivityPreferences } from "../settings/settingsSchema";

/**
 * Exposes a small, explicit API surface to the renderer. The renderer
 * never gets direct Node/Electron access (contextIsolation is on) —
 * anything it needs must be added here deliberately.
 */
contextBridge.exposeInMainWorld("nimbus", {
  getAppInfo: () => ipcRenderer.invoke("nimbus:get-app-info"),

  getSettings: (): Promise<StartupSettings> => ipcRenderer.invoke("nimbus:get-settings"),
  updateSettings: (partial: Partial<StartupSettings>): Promise<StartupSettings> =>
    ipcRenderer.invoke("nimbus:update-settings", partial),

  hideWindow: () => ipcRenderer.invoke("nimbus:hide-window"),

  getContext: (): Promise<ContextSnapshot> => ipcRenderer.invoke("nimbus:get-context"),

  getWeatherSettings: (): Promise<WeatherSettings> => ipcRenderer.invoke("nimbus:get-weather-settings"),
  updateWeatherSettings: (partial: Partial<WeatherSettings>): Promise<WeatherSettings> =>
    ipcRenderer.invoke("nimbus:update-weather-settings", partial),

  getCalendarSettings: (): Promise<CalendarSettings> => ipcRenderer.invoke("nimbus:get-calendar-settings"),
  updateCalendarSettings: (partial: Partial<CalendarSettings>): Promise<CalendarSettings> =>
    ipcRenderer.invoke("nimbus:update-calendar-settings", partial),

  getEmailSettings: (): Promise<PublicEmailSettings> => ipcRenderer.invoke("nimbus:get-email-settings"),
  updateEmailSettings: (partial: {
    enabled?: boolean;
    defaultSinceDays?: number;
    accounts?: EmailAccountUpdate[];
  }): Promise<PublicEmailSettings> => ipcRenderer.invoke("nimbus:update-email-settings", partial),

  getTaskSettings: (): Promise<PublicTaskSettings> => ipcRenderer.invoke("nimbus:get-task-settings"),
  updateTaskSettings: (partial: {
    enabled?: boolean;
    accounts?: TaskAccountUpdate[];
  }): Promise<PublicTaskSettings> => ipcRenderer.invoke("nimbus:update-task-settings", partial),

  // The Tasks tab's management surface — distinct from the settings
  // handlers above (which only configure *which* Todoist account is
  // connected) and from whatever task data reaches the Home briefing via
  // nimbus:get-context (a bucketed/capped subset). This is the full
  // active task list, plus create/edit/complete/delete.
  listTasks: (): Promise<{ tasks: TaskItem[]; accounts: TaskAccountInfo[] }> =>
    ipcRenderer.invoke("nimbus:list-tasks"),
  listTaskProjects: (): Promise<TodoistProjectSummary[]> => ipcRenderer.invoke("nimbus:list-task-projects"),
  createTask: (request: TaskWriteRequest): Promise<TaskItem> =>
    ipcRenderer.invoke("nimbus:create-task", request),
  updateTask: (taskId: string, request: Partial<TaskWriteRequest>): Promise<TaskItem> =>
    ipcRenderer.invoke("nimbus:update-task", taskId, request),
  completeTask: (taskId: string): Promise<void> => ipcRenderer.invoke("nimbus:complete-task", taskId),
  reopenTask: (taskId: string): Promise<void> => ipcRenderer.invoke("nimbus:reopen-task", taskId),
  deleteTask: (taskId: string): Promise<void> => ipcRenderer.invoke("nimbus:delete-task", taskId),

  getSpotifySettings: (): Promise<PublicSpotifySettings> => ipcRenderer.invoke("nimbus:get-spotify-settings"),
  updateSpotifySettings: (partial: {
    enabled?: boolean;
    preferredDeviceId?: string | null;
  }): Promise<PublicSpotifySettings> => ipcRenderer.invoke("nimbus:update-spotify-settings", partial),
  connectSpotify: (): Promise<{ connected: boolean; error: string | null }> =>
    ipcRenderer.invoke("nimbus:spotify-connect"),
  disconnectSpotify: (): Promise<{ connected: boolean }> => ipcRenderer.invoke("nimbus:spotify-disconnect"),

  /**
   * The generic Action-execution surface. `actionId` must match one of
   * the entries `listActions()` returns — there is no way to reach any
   * other Node/API capability through this call (see
   * nimbus:execute-action in lifecycle.ts).
   */
  listActions: (): Promise<PublicActionDefinition[]> => ipcRenderer.invoke("nimbus:list-actions"),
  executeAction: (actionId: string, params?: Record<string, unknown>): Promise<PublicActionResult> =>
    ipcRenderer.invoke("nimbus:execute-action", actionId, params),
  /** Opens a file/folder picker for a path parameter; resolves with the chosen path, or null if cancelled. */
  pickPath: (format: "file" | "folder" | "application"): Promise<string | null> =>
    ipcRenderer.invoke("nimbus:pick-path", format),

  /** Playlist metadata only — never track contents. */
  listSpotifyPlaylists: (): Promise<SpotifyPlaylistSummary[]> =>
    ipcRenderer.invoke("nimbus:spotify-list-playlists"),

  getRoutineSettings: (): Promise<RoutineSettings> => ipcRenderer.invoke("nimbus:get-routine-settings"),
  updateRoutineSettings: (partial: { enabled?: boolean; routines?: Routine[] }): Promise<RoutineSettings> =>
    ipcRenderer.invoke("nimbus:update-routine-settings", partial),
  /**
   * Evaluates a routine against the current state and returns the
   * deterministic explanation — runs NOTHING. Backs the editor's "Test"
   * button; see RoutineService.testRoutine for why testing must not
   * execute actions.
   */
  testRoutine: (routineId: string): Promise<RoutineEvaluation | null> =>
    ipcRenderer.invoke("nimbus:test-routine", routineId),
  /** Actually runs a routine's actions now, bypassing trigger/cooldown/conditions — the explicit counterpart to testRoutine. */
  runRoutineNow: (routineId: string): Promise<PublicActionResult[]> =>
    ipcRenderer.invoke("nimbus:run-routine-now", routineId),
  /** NIMBUS's own routine decisions, most recent first — never anything the user typed, read or browsed. */
  getRoutineHistory: (): Promise<RoutineHistoryEntry[]> => ipcRenderer.invoke("nimbus:get-routine-history"),
  /**
   * Activity & Sessions — what NIMBUS thinks the user is doing. Read-only
   * apart from the mappings: the renderer can see and configure, but
   * cannot assert an activity or end a session by hand.
   */
  /** The one current timer, read-only — Home shows it beside the current activity. Control stays in the timer popup. */
  getTimerState: (): Promise<{
    id: string;
    title: string;
    status: string;
    remainingMs: number;
  } | null> => ipcRenderer.invoke("nimbus:get-timer-state"),
  getCurrentActivity: (): Promise<CurrentActivity | null> =>
    ipcRenderer.invoke("nimbus:get-current-activity"),
  getActivitySessions: (): Promise<ActivitySession[]> => ipcRenderer.invoke("nimbus:get-activity-sessions"),
  /** Activity names already defined anywhere, for choosing rather than retyping. */
  getKnownActivities: (): Promise<string[]> => ipcRenderer.invoke("nimbus:get-known-activities"),
  getActivitySettings: (): Promise<ActivityPreferences> => ipcRenderer.invoke("nimbus:get-activity-settings"),
  updateActivitySettings: (partial: {
    enabled?: boolean;
    mappings?: ActivityMapping[];
    graceMinutes?: number;
  }): Promise<ActivityPreferences> => ipcRenderer.invoke("nimbus:update-activity-settings", partial),
  /** Fires when the current activity changes, so Home can refresh without polling hard. */
  onActivityChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("nimbus:activity-changed", listener);
    return () => ipcRenderer.removeListener("nimbus:activity-changed", listener);
  },

  /** Epoch ms per routine id, for the routine list's "last triggered" line. */
  getRoutineLastTriggered: (): Promise<Record<string, number>> =>
    ipcRenderer.invoke("nimbus:get-routine-last-triggered"),
  /** Debugging aid: the raw process/window/folder data the desktop activity monitor saw on its most recent poll, or null if it isn't running. */
  /** DesktopActivityMonitor's last poll (raw process names/browser window titles/folder paths), or null if it isn't running — surfaced read-only in the Routines tab so a trigger pattern can be checked against reality instead of guessed at. */
  getActivitySnapshot: (): Promise<unknown> => ipcRenderer.invoke("nimbus:get-activity-snapshot"),

  getActiveSuggestions: (): Promise<AssistantEvent[]> => ipcRenderer.invoke("nimbus:get-active-suggestions"),
  acceptSuggestion: (suggestionId: string): Promise<PublicActionResult[]> =>
    ipcRenderer.invoke("nimbus:accept-suggestion", suggestionId),
  dismissSuggestion: (suggestionId: string): Promise<void> =>
    ipcRenderer.invoke("nimbus:dismiss-suggestion", suggestionId),

  /** Subscribes to events from future assistant subsystems. Returns an unsubscribe function. */
  onAssistantEvent: (callback: (event: AssistantEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: AssistantEvent) => callback(payload);
    ipcRenderer.on("nimbus:assistant-event", listener);
    return () => ipcRenderer.removeListener("nimbus:assistant-event", listener);
  },

  /**
   * Fires whenever a Spotify action ran anywhere — this window's own
   * Test button, a Routine accepted from the main window, or (notably)
   * a Routine accepted from the separate suggestion popup window, which
   * has no other way to tell the Home now-playing card to refresh
   * immediately instead of waiting for its next poll.
   */
  onNowPlayingChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("nimbus:now-playing-changed", listener);
    return () => ipcRenderer.removeListener("nimbus:now-playing-changed", listener);
  },

  /** The current briefing, or null if none has been generated yet. Never triggers generation. */
  getBriefing: (): Promise<Briefing | null> => ipcRenderer.invoke("nimbus:get-briefing"),
  /** Explicitly generates a new briefing (e.g. a manual "Regenerate" button). */
  regenerateBriefing: (): Promise<Briefing | null> => ipcRenderer.invoke("nimbus:regenerate-briefing"),
  /** Fires when the startup (or a manually regenerated) briefing becomes available. */
  onBriefingUpdated: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("nimbus:briefing-updated", listener);
    return () => ipcRenderer.removeListener("nimbus:briefing-updated", listener);
  },
});
