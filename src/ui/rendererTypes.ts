/**
 * The shapes the main window's modules share: what the preload bridge
 * (`window.nimbus`) takes and returns, as the renderer sees them.
 */

export interface ActivityMapping {
  id: string;
  enabled: boolean;
  activity: string;
  icon?: string;
  source: "application" | "website" | "folder";
  value: string;
  matchMode: StringMatchMode;
  priority: number;
}

export interface ActivityPreferences {
  enabled: boolean;
  mappings: ActivityMapping[];
  graceMinutes: number;
  suggestFrequentApps?: boolean;
}

export interface CurrentActivity {
  activity: string;
  icon?: string;
  source: string;
  sourceValue: string;
  startedAt: string;
  durationMs: number;
}

export interface ActivitySession {
  id: string;
  activity: string;
  icon?: string;
  source: string;
  sourceValue: string;
  startedAt: string;
  endedAt: string | null;
  state: "active" | "ended";
}

export interface RoutineCheck {
  label: string;
  passed: boolean;
}

export interface RoutineEvaluation {
  routineId: string;
  routineName: string;
  matched: boolean;
  checks: RoutineCheck[];
  blockedBy?: string;
}

export interface RoutineHistoryEntry {
  id: string;
  at: string;
  routineId: string;
  routineName: string;
  kind: string;
  detail?: string;
}

export interface AppInfo {
  name: string;
  fullName: string;
  version: string;
  environment: string;
}

export interface StartupSettings {
  launchWithWindows: boolean;
  startMinimized: boolean;
}

export interface AssistantEvent {
  id: string;
  type: "message" | "notification" | "briefing" | "actionRequest" | "suggestion";
  createdAt: string;
  source: string;
  [key: string]: unknown;
}

export type ContextStatus = "ok" | "error" | "unavailable";

export interface ContextProviderResult {
  providerId: string;
  displayName: string;
  status: ContextStatus;
  data: Record<string, unknown> | null;
  error?: string;
  timestamp: string;
  stale: boolean;
}

export interface ContextSnapshot {
  generatedAt: string;
  providers: Record<string, ContextProviderResult>;
}

export interface ManualLocation {
  latitude: number;
  longitude: number;
  label: string;
}

export interface WeatherSettings {
  locationMode: "auto" | "manual";
  manualLocation: ManualLocation | null;
}

export interface CalendarFeed {
  id: string;
  label: string;
  address: string;
  enabled: boolean;
}

export interface CalendarSettings {
  enabled: boolean;
  feeds: CalendarFeed[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
  calendarName: string | null;
}

export interface CalendarContext {
  retrievedAt: string;
  timezone: string;
  todayEvents: CalendarEvent[];
  laterEvents: CalendarEvent[];
  upcomingEvents?: CalendarEvent[];
  nextEvent: CalendarEvent | null;
}

export interface EmailAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  sinceDays: number;
  enabled: boolean;
  /** Never a real password — just whether one is already saved. */
  hasPassword: boolean;
}

export interface EmailSettings {
  enabled: boolean;
  defaultSinceDays: number;
  accounts: EmailAccount[];
}

export interface TaskAccount {
  id: string;
  label: string;
  provider: "todoist";
  enabled: boolean;
  /** Never a real API token — just whether one is already saved. */
  hasApiToken: boolean;
}

export interface TaskSettings {
  enabled: boolean;
  accounts: TaskAccount[];
}

export type TaskPriority = "none" | "low" | "medium" | "high";

export type TaskCategory = "overdue" | "dueToday" | "upcoming" | "noDeadline";

/** The renderer-facing shape of a task — mirrors TaskItem in src/context/providers/tasks/types.ts. */
export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  dueIsDateOnly: boolean;
  completed: boolean;
  completedAt: string | null;
  priority: TaskPriority;
  reminderAt: string | null;
  source: string;
  listName: string | null;
  createdAt: string | null;
  category: TaskCategory;
}

export interface TaskAccountInfo {
  id: string;
  label: string;
  provider: string;
}

export interface TodoistProjectSummary {
  id: string;
  name: string;
}

export interface TaskWriteRequest {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority;
  projectId?: string | null;
}

export interface SpotifySettings {
  enabled: boolean;
  preferredDeviceId: string | null;
  connected: boolean;
}

export interface ActionParameterSchema {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  format?: "file" | "folder" | "application";
}

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  parameters: ActionParameterSchema[];
  readOnly: boolean;
  changesExternalState: boolean;
  requiresConfirmation: boolean;
  affectsService: string;
}

export interface ActionError {
  category: string;
  message: string;
}

export interface ActionResult<T = unknown> {
  actionId: string;
  status: "success" | "failure";
  data?: T;
  message?: string;
  error?: ActionError;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface SpotifyTrackInfo {
  id: string;
  name: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  imageUrl: string | null;
}

export interface SpotifyDeviceInfo {
  id: string | null;
  name: string | null;
  type: string | null;
  isActive: boolean;
  supportsVolume: boolean;
}

export interface SpotifyPlaybackContext {
  retrievedAt: string;
  isAuthenticated: boolean;
  playbackState: "playing" | "paused" | "stopped";
  track: SpotifyTrackInfo | null;
  progressMs: number | null;
  volumePercent: number | null;
  device: SpotifyDeviceInfo | null;
  context: { type: string; uri: string } | null;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  uri: string;
  ownerName: string | null;
  imageUrl: string | null;
  trackCount: number | null;
}

// --- Routines ---

/** The renderer-facing shape of DesktopActivityMonitor's last poll — see src/main/activity/activitySnapshot.ts's RawActivitySnapshot. Surfaced read-only in the Routines tab so a trigger pattern can be checked against what NIMBUS actually detects instead of guessed at. */
export interface RawActivitySnapshot {
  processNames: string[];
  browserWindows: Array<{ executable: string; title: string }>;
  explorerFolders: string[];
}

export type StringMatchMode = "exact" | "contains";

export interface ApplicationTriggerConfig {
  type: "applicationOpened";
  application: string;
  matchMode: StringMatchMode;
}

export interface WebsiteTriggerConfig {
  type: "websiteOpened";
  matchField: "domain" | "url" | "windowTitle";
  pattern: string;
  matchMode: StringMatchMode;
}

export interface FolderTriggerConfig {
  type: "folderOpened";
  path: string;
  matchMode: StringMatchMode;
}

export interface ActivityEndedTriggerConfig {
  type: "activityEnded";
  activity: string;
  minMinutes?: number;
}

export interface TimerCompletedTriggerConfig {
  type: "timerCompleted";
  timerType: string;
}

export type TriggerConfig =
  | ApplicationTriggerConfig
  | WebsiteTriggerConfig
  | FolderTriggerConfig
  | ActivityEndedTriggerConfig
  | TimerCompletedTriggerConfig;

/**
 * Mirrors src/routines/types.ts's RoutineCondition. Kept as one loose
 * shape with optional fields rather than a discriminated union: the
 * renderer only reads and writes these, and a union here would have to
 * be kept in lockstep with the real one for no gain on this side of the
 * bridge. `weekdaysOnly` stays listed because older routines have it,
 * even though new ones are offered `daysOfWeek` instead.
 */
export interface RoutineCondition {
  type: string;
  [field: string]: unknown;
}

export interface RoutineActionStep {
  actionId: string;
  params: Record<string, unknown>;
}

export interface RoutineSuggestionConfig {
  title: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerConfig;
  conditions: RoutineCondition[];
  suggestion: RoutineSuggestionConfig;
  actions: RoutineActionStep[];
  cooldownMinutes: number;
  autoRun?: boolean;
  description?: string;
  conditionLogic?: "all" | "any";
  sessionRestriction?: "none" | "oncePerSession";
  stopActions?: RoutineActionStep[];
  stopTrigger?: TriggerConfig;
  stopConditions?: RoutineCondition[];
  stopConditionLogic?: "all" | "any";
  stopAutoRun?: boolean;
}

export interface RoutineSettings {
  enabled: boolean;
  routines: Routine[];
}

export type BriefingCategory =
  "greeting" | "dateTime" | "weather" | "calendar" | "email" | "tasks" | "stocks" | "meals" | "other";

export interface BriefingAction {
  label: string;
  actionId: string;
}

export interface BriefingItem {
  id: string;
  category: BriefingCategory;
  message: string;
  importance: number;
  relevance: number;
  timestamp: string;
  action?: BriefingAction;
}

export interface Briefing {
  id: string;
  generatedAt: string;
  items: BriefingItem[];
}

/** A place from the weather location search (context/providers/weather/geocoding.ts). */
export interface PlaceResult {
  label: string;
  latitude: number;
  longitude: number;
}

export interface NimbusApi {
  getAppInfo: () => Promise<AppInfo>;
  getSettings: () => Promise<StartupSettings>;
  updateSettings: (partial: Partial<StartupSettings>) => Promise<StartupSettings>;
  getZoom: () => Promise<number>;
  setZoom: (percent: number) => Promise<number>;
  onZoomChanged: (callback: (percent: number) => void) => () => void;
  hideWindow: () => Promise<void>;
  getContext: () => Promise<ContextSnapshot>;
  getWeatherSettings: () => Promise<WeatherSettings>;
  updateWeatherSettings: (partial: Partial<WeatherSettings>) => Promise<WeatherSettings>;
  searchPlaces: (query: string) => Promise<PlaceResult[]>;
  getCalendarSettings: () => Promise<CalendarSettings>;
  updateCalendarSettings: (partial: Partial<CalendarSettings>) => Promise<CalendarSettings>;
  getEmailSettings: () => Promise<EmailSettings>;
  updateEmailSettings: (partial: {
    enabled?: boolean;
    defaultSinceDays?: number;
    accounts?: Array<Omit<EmailAccount, "hasPassword"> & { newPassword?: string }>;
  }) => Promise<EmailSettings>;
  getTaskSettings: () => Promise<TaskSettings>;
  updateTaskSettings: (partial: {
    enabled?: boolean;
    accounts?: Array<Omit<TaskAccount, "hasApiToken"> & { newApiToken?: string }>;
  }) => Promise<TaskSettings>;
  listTasks: () => Promise<{ tasks: TaskItem[]; accounts: TaskAccountInfo[] }>;
  listTaskProjects: () => Promise<TodoistProjectSummary[]>;
  createTask: (request: TaskWriteRequest) => Promise<TaskItem>;
  updateTask: (taskId: string, request: Partial<TaskWriteRequest>) => Promise<TaskItem>;
  completeTask: (taskId: string) => Promise<void>;
  reopenTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  getSpotifySettings: () => Promise<SpotifySettings>;
  updateSpotifySettings: (partial: {
    enabled?: boolean;
    preferredDeviceId?: string | null;
  }) => Promise<SpotifySettings>;
  connectSpotify: () => Promise<{ connected: boolean; error: string | null }>;
  disconnectSpotify: () => Promise<{ connected: boolean }>;
  listActions: () => Promise<ActionDefinition[]>;
  executeAction: (actionId: string, params?: Record<string, unknown>) => Promise<ActionResult>;
  pickPath: (format: "file" | "folder" | "application") => Promise<string | null>;
  listSpotifyPlaylists: () => Promise<SpotifyPlaylistSummary[]>;
  /** Only what a device condition needs to offer a picker. */
  getNetworkState: () => Promise<{ devices: Array<{ id: string; displayName: string }> }>;
  getRoutineSettings: () => Promise<RoutineSettings>;
  updateRoutineSettings: (partial: { enabled?: boolean; routines?: Routine[] }) => Promise<RoutineSettings>;
  testRoutine: (routineId: string) => Promise<RoutineEvaluation | null>;
  runRoutineNow: (routineId: string) => Promise<ActionResult[]>;
  getRoutineHistory: () => Promise<RoutineHistoryEntry[]>;
  getRoutineLastTriggered: () => Promise<Record<string, number>>;
  getTimerState: () => Promise<{ id: string; title: string; status: string; remainingMs: number } | null>;
  getCurrentActivity: () => Promise<CurrentActivity | null>;
  getActivitySessions: () => Promise<ActivitySession[]>;
  getKnownActivities: () => Promise<string[]>;
  getActivitySettings: () => Promise<ActivityPreferences>;
  updateActivitySettings: (partial: {
    enabled?: boolean;
    mappings?: ActivityMapping[];
    graceMinutes?: number;
    suggestFrequentApps?: boolean;
  }) => Promise<ActivityPreferences>;
  onOpenActivityEditor: (
    callback: (prefill: { application: string; name: string; source?: "application" | "website" }) => void
  ) => () => void;
  onActivityChanged: (callback: () => void) => () => void;
  getActivitySnapshot: () => Promise<RawActivitySnapshot | null>;
  getActiveSuggestions: () => Promise<AssistantEvent[]>;
  acceptSuggestion: (suggestionId: string) => Promise<ActionResult[]>;
  dismissSuggestion: (suggestionId: string) => Promise<void>;
  getAttention: () => Promise<AttentionDebugView>;
  answerAttentionItem: (itemId: string, outcome: "accepted" | "dismissed") => Promise<boolean>;
  updateAttentionSettings: (partial: {
    enabled?: boolean;
    popups?: boolean;
    reminderMinutes?: number;
  }) => Promise<unknown>;
  onAssistantEvent: (callback: (event: AssistantEvent) => void) => () => void;
  onNowPlayingChanged: (callback: () => void) => () => void;
  getBriefing: () => Promise<Briefing | null>;
  regenerateBriefing: () => Promise<Briefing | null>;
  onBriefingUpdated: (callback: () => void) => () => void;
}

// This file is a module, so a bare `interface Window` would declare a
// local type rather than extend the DOM's —
// `declare global` is what keeps `window.nimbus` typed in every module
// of the main window.
declare global {
  interface Window {
    nimbus: NimbusApi;
  }
}

export interface AttentionItemView {
  id: string;
  source: string;
  title: string;
  description: string;
  reasons: string[];
  score: number;
  priority: string;
  factors: Array<{ label: string; points: number }>;
  decision: string;
  decisionReason: string;
}

export interface AttentionDebugView {
  enabled: boolean;
  popups: boolean;
  reminderMinutes: number;
  evaluatedAt: string | null;
  busy: boolean;
  busyReason: string | null;
  items: AttentionItemView[];
}
