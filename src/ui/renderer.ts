import {
  formatContextValue,
  formatEventDateLabel,
  formatEventTime,
  formatMs,
  formatTaskDue,
  maskAddress,
  triggerSummary,
  withSkipIfActiveCondition,
} from "./uiFormat";
import { initStocksTab } from "./stocksTab";
import { initNetworkTab } from "./networkTab";
import { initMemoryTab } from "./memoryTab";

/**
 * Renderer script for the placeholder UI. Talks to the main process
 * only through the `window.nimbus` API exposed by the preload script —
 * it has no Node/Electron access of its own.
 */
interface ActivityMapping {
  id: string;
  enabled: boolean;
  activity: string;
  icon?: string;
  source: "application" | "website" | "folder";
  value: string;
  matchMode: StringMatchMode;
  priority: number;
}

interface ActivityPreferences {
  enabled: boolean;
  mappings: ActivityMapping[];
  graceMinutes: number;
  suggestFrequentApps?: boolean;
}

interface CurrentActivity {
  activity: string;
  icon?: string;
  source: string;
  sourceValue: string;
  startedAt: string;
  durationMs: number;
}

interface ActivitySession {
  id: string;
  activity: string;
  icon?: string;
  source: string;
  sourceValue: string;
  startedAt: string;
  endedAt: string | null;
  state: "active" | "ended";
}

interface RoutineCheck {
  label: string;
  passed: boolean;
}

interface RoutineEvaluation {
  routineId: string;
  routineName: string;
  matched: boolean;
  checks: RoutineCheck[];
  blockedBy?: string;
}

interface RoutineHistoryEntry {
  id: string;
  at: string;
  routineId: string;
  routineName: string;
  kind: string;
  detail?: string;
}

interface AppInfo {
  name: string;
  fullName: string;
  version: string;
  environment: string;
}

interface StartupSettings {
  launchWithWindows: boolean;
  startMinimized: boolean;
}

interface AssistantEvent {
  id: string;
  type: "message" | "notification" | "briefing" | "actionRequest" | "suggestion";
  createdAt: string;
  source: string;
  [key: string]: unknown;
}

type ContextStatus = "ok" | "error" | "unavailable";

interface ContextProviderResult {
  providerId: string;
  displayName: string;
  status: ContextStatus;
  data: Record<string, unknown> | null;
  error?: string;
  timestamp: string;
  stale: boolean;
}

interface ContextSnapshot {
  generatedAt: string;
  providers: Record<string, ContextProviderResult>;
}

interface ManualLocation {
  latitude: number;
  longitude: number;
  label: string;
}

interface WeatherSettings {
  locationMode: "auto" | "manual";
  manualLocation: ManualLocation | null;
}

interface CalendarFeed {
  id: string;
  label: string;
  address: string;
  enabled: boolean;
}

interface CalendarSettings {
  enabled: boolean;
  feeds: CalendarFeed[];
}

interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
  calendarName: string | null;
}

interface CalendarContext {
  retrievedAt: string;
  timezone: string;
  todayEvents: CalendarEvent[];
  laterEvents: CalendarEvent[];
  nextEvent: CalendarEvent | null;
}

interface EmailAccount {
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

interface EmailSettings {
  enabled: boolean;
  defaultSinceDays: number;
  accounts: EmailAccount[];
}

interface TaskAccount {
  id: string;
  label: string;
  provider: "todoist";
  enabled: boolean;
  /** Never a real API token — just whether one is already saved. */
  hasApiToken: boolean;
}

interface TaskSettings {
  enabled: boolean;
  accounts: TaskAccount[];
}

type TaskPriority = "none" | "low" | "medium" | "high";
type TaskCategory = "overdue" | "dueToday" | "upcoming" | "noDeadline";

/** The renderer-facing shape of a task — mirrors TaskItem in src/context/providers/tasks/types.ts. */
interface TaskItem {
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

interface TaskAccountInfo {
  id: string;
  label: string;
  provider: string;
}

interface TodoistProjectSummary {
  id: string;
  name: string;
}

interface TaskWriteRequest {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority;
  projectId?: string | null;
}

interface SpotifySettings {
  enabled: boolean;
  preferredDeviceId: string | null;
  connected: boolean;
}

interface ActionParameterSchema {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  format?: "file" | "folder" | "application";
}

interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  parameters: ActionParameterSchema[];
  readOnly: boolean;
  changesExternalState: boolean;
  requiresConfirmation: boolean;
  affectsService: string;
}

interface ActionError {
  category: string;
  message: string;
}

interface ActionResult<T = unknown> {
  actionId: string;
  status: "success" | "failure";
  data?: T;
  message?: string;
  error?: ActionError;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface SpotifyTrackInfo {
  id: string;
  name: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  imageUrl: string | null;
}

interface SpotifyDeviceInfo {
  id: string | null;
  name: string | null;
  type: string | null;
  isActive: boolean;
  supportsVolume: boolean;
}

interface SpotifyPlaybackContext {
  retrievedAt: string;
  isAuthenticated: boolean;
  playbackState: "playing" | "paused" | "stopped";
  track: SpotifyTrackInfo | null;
  progressMs: number | null;
  volumePercent: number | null;
  device: SpotifyDeviceInfo | null;
  context: { type: string; uri: string } | null;
}

interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  uri: string;
  ownerName: string | null;
  imageUrl: string | null;
  trackCount: number | null;
}

// --- Routines ---

/** The renderer-facing shape of DesktopActivityMonitor's last poll — see src/main/activity/activitySnapshot.ts's RawActivitySnapshot. Surfaced read-only in the Routines tab so a trigger pattern can be checked against what NIMBUS actually detects instead of guessed at. */
interface RawActivitySnapshot {
  processNames: string[];
  browserWindows: Array<{ executable: string; title: string }>;
  explorerFolders: string[];
}

type StringMatchMode = "exact" | "contains";

interface ApplicationTriggerConfig {
  type: "applicationOpened";
  application: string;
  matchMode: StringMatchMode;
}
interface WebsiteTriggerConfig {
  type: "websiteOpened";
  matchField: "domain" | "url" | "windowTitle";
  pattern: string;
  matchMode: StringMatchMode;
}
interface FolderTriggerConfig {
  type: "folderOpened";
  path: string;
  matchMode: StringMatchMode;
}
interface ActivityEndedTriggerConfig {
  type: "activityEnded";
  activity: string;
  minMinutes?: number;
}
interface TimerCompletedTriggerConfig {
  type: "timerCompleted";
  timerType: string;
}
type TriggerConfig =
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
interface RoutineCondition {
  type:
    | "timeOfDay"
    | "weekdaysOnly"
    | "daysOfWeek"
    | "activityIs"
    | "activityDuration"
    | "spotifyNotAlreadyPlaying"
    | "spotifyIsPlaying"
    | "actionsNotAlreadyActive";
  startHour?: number;
  endHour?: number;
  startMinute?: number;
  endMinute?: number;
  days?: number[];
  activity?: string;
  minMinutes?: number;
}

interface RoutineActionStep {
  actionId: string;
  params: Record<string, unknown>;
}

interface RoutineSuggestionConfig {
  title: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
}

interface Routine {
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

interface RoutineSettings {
  enabled: boolean;
  routines: Routine[];
}

type BriefingCategory =
  "greeting" | "dateTime" | "weather" | "calendar" | "email" | "tasks" | "stocks" | "meals" | "other";

interface BriefingAction {
  label: string;
  actionId: string;
}

interface BriefingItem {
  id: string;
  category: BriefingCategory;
  message: string;
  importance: number;
  relevance: number;
  timestamp: string;
  action?: BriefingAction;
}

interface Briefing {
  id: string;
  generatedAt: string;
  items: BriefingItem[];
}

interface NimbusApi {
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
  updateAttentionSettings: (partial: { enabled?: boolean; popups?: boolean }) => Promise<unknown>;
  onAssistantEvent: (callback: (event: AssistantEvent) => void) => () => void;
  onNowPlayingChanged: (callback: () => void) => () => void;
  getBriefing: () => Promise<Briefing | null>;
  regenerateBriefing: () => Promise<Briefing | null>;
  onBriefingUpdated: (callback: () => void) => () => void;
}

// renderer.ts imports from ./uiFormat, which makes this file a module —
// so a bare `interface Window` would declare a local type rather than
// extend the DOM's. `declare global` is what keeps `window.nimbus`
// typed, exactly as it was when this file was a plain script.
declare global {
  interface Window {
    nimbus: NimbusApi;
  }
}

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".side-link");
  const panels = document.querySelectorAll<HTMLElement>(".panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));

      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add("active");
      // Catches up the now-playing card the moment Home becomes visible
      // again, rather than waiting for its next polling tick — covers
      // e.g. testing a Spotify routine from Settings, then switching
      // over to check Home.
      if (tab.dataset.tab === "home") {
        window.dispatchEvent(new Event(NOW_PLAYING_REFRESH_EVENT));
      } else if (tab.dataset.tab === "tasks") {
        // Catches up the Tasks tab the moment it becomes visible — e.g.
        // completing/creating a task, switching away, then back.
        window.dispatchEvent(new Event(TASK_REFRESH_EVENT));
      }
    });
  });
}

async function initAppInfo(): Promise<void> {
  try {
    const info = await window.nimbus.getAppInfo();
    document.getElementById("fullName")!.textContent = info.fullName;
    document.getElementById("version")!.textContent = info.version;
    document.getElementById("environment")!.textContent = info.environment;
  } catch (err) {
    document.getElementById("statusText")!.textContent = "Error";
    console.error("Failed to load app info", err);
  }
}

async function initSettings(): Promise<void> {
  const launchCheckbox = document.getElementById("launchWithWindows") as HTMLInputElement;
  const minimizedCheckbox = document.getElementById("startMinimized") as HTMLInputElement;

  try {
    const settings = await window.nimbus.getSettings();
    launchCheckbox.checked = settings.launchWithWindows;
    minimizedCheckbox.checked = settings.startMinimized;
  } catch (err) {
    console.error("Failed to load settings", err);
  }

  launchCheckbox.addEventListener("change", () => {
    window.nimbus.updateSettings({ launchWithWindows: launchCheckbox.checked });
  });

  minimizedCheckbox.addEventListener("change", () => {
    window.nimbus.updateSettings({ startMinimized: minimizedCheckbox.checked });
  });

  const zoomSelect = document.getElementById("uiZoom") as HTMLSelectElement;
  try {
    zoomSelect.value = String(await window.nimbus.getZoom());
  } catch (err) {
    console.error("Failed to load the interface size", err);
  }
  zoomSelect.addEventListener("change", () => {
    void window.nimbus.setZoom(Number(zoomSelect.value));
  });
  // Ctrl+= / Ctrl+- / Ctrl+0 change it too - keep the picker in step.
  window.nimbus.onZoomChanged((percent) => {
    zoomSelect.value = String(percent);
  });
}

async function initWeatherSettings(): Promise<void> {
  const modeSelect = document.getElementById("locationModeSelect") as HTMLSelectElement;
  const manualFields = document.getElementById("manualLocationFields") as HTMLElement;
  const labelInput = document.getElementById("manualLocationLabel") as HTMLInputElement;
  const latInput = document.getElementById("manualLocationLat") as HTMLInputElement;
  const lonInput = document.getElementById("manualLocationLon") as HTMLInputElement;
  const saveBtn = document.getElementById("saveManualLocationBtn") as HTMLButtonElement;

  function syncManualFieldsVisibility(): void {
    manualFields.hidden = modeSelect.value !== "manual";
  }

  try {
    const weatherSettings = await window.nimbus.getWeatherSettings();
    modeSelect.value = weatherSettings.locationMode;
    if (weatherSettings.manualLocation) {
      labelInput.value = weatherSettings.manualLocation.label;
      latInput.value = String(weatherSettings.manualLocation.latitude);
      lonInput.value = String(weatherSettings.manualLocation.longitude);
    }
  } catch (err) {
    console.error("Failed to load weather settings", err);
  }

  syncManualFieldsVisibility();

  modeSelect.addEventListener("change", () => {
    syncManualFieldsVisibility();
    window.nimbus.updateWeatherSettings({ locationMode: modeSelect.value as "auto" | "manual" });
  });

  saveBtn.addEventListener("click", () => {
    const latitude = Number(latInput.value);
    const longitude = Number(lonInput.value);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      latInput.focus();
      return;
    }
    window.nimbus.updateWeatherSettings({
      manualLocation: {
        latitude,
        longitude,
        label: labelInput.value.trim() || `${latitude}, ${longitude}`,
      },
    });
  });
}

/** Shortens a feed address for display — it's a credential, not something to show in full in a settings list. */
async function initCalendarSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("calendarEnabled") as HTMLInputElement;
  const feedList = document.getElementById("calendarFeedList") as HTMLElement;
  const labelInput = document.getElementById("calendarFeedLabel") as HTMLInputElement;
  const addressInput = document.getElementById("calendarFeedAddress") as HTMLInputElement;
  const addBtn = document.getElementById("addCalendarFeedBtn") as HTMLButtonElement;

  function renderFeeds(settings: CalendarSettings): void {
    feedList.innerHTML = "";
    for (const feed of settings.feeds) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = feed.label;
      const addressEl = document.createElement("span");
      addressEl.className = "calendar-feed-row-address";
      addressEl.textContent = maskAddress(feed.address);
      info.appendChild(labelEl);
      info.appendChild(addressEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = feed.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.feeds.map((f) => (f.id === feed.id ? { ...f, enabled: toggle.checked } : f));
        const saved = await window.nimbus.updateCalendarSettings({ feeds: updated });
        renderFeeds(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.feeds.filter((f) => f.id !== feed.id);
        const saved = await window.nimbus.updateCalendarSettings({ feeds: updated });
        renderFeeds(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      feedList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getCalendarSettings();
    enabledCheckbox.checked = settings.enabled;
    renderFeeds(settings);
  } catch (err) {
    console.error("Failed to load calendar settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateCalendarSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const address = addressInput.value.trim();
    if (!label || !address) {
      (label ? addressInput : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getCalendarSettings();
    const newFeed: CalendarFeed = {
      id: `feed-${Date.now()}`,
      label,
      address,
      enabled: true,
    };
    const saved = await window.nimbus.updateCalendarSettings({
      feeds: [...current.feeds, newFeed],
    });
    renderFeeds(saved);
    labelInput.value = "";
    addressInput.value = "";
  });
}

async function initEmailSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("emailEnabled") as HTMLInputElement;
  const accountList = document.getElementById("emailAccountList") as HTMLElement;
  const labelInput = document.getElementById("emailAccountLabel") as HTMLInputElement;
  const hostInput = document.getElementById("emailAccountHost") as HTMLInputElement;
  const portInput = document.getElementById("emailAccountPort") as HTMLInputElement;
  const secureInput = document.getElementById("emailAccountSecure") as HTMLInputElement;
  const usernameInput = document.getElementById("emailAccountUsername") as HTMLInputElement;
  const passwordInput = document.getElementById("emailAccountPassword") as HTMLInputElement;
  const addBtn = document.getElementById("addEmailAccountBtn") as HTMLButtonElement;

  // The password never comes back from getEmailSettings() — every update
  // must resubmit every account so we don't accidentally drop one, and
  // must never include a password unless the user is actually changing it.
  function toUpdatePayload(account: EmailAccount): Omit<EmailAccount, "hasPassword"> {
    const { hasPassword: _hasPassword, ...rest } = account;
    return rest;
  }

  function renderAccounts(settings: EmailSettings): void {
    accountList.innerHTML = "";
    for (const account of settings.accounts) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = account.label;
      const metaEl = document.createElement("span");
      metaEl.className = "calendar-feed-row-address";
      metaEl.textContent = `${account.username} · ${account.host}:${account.port}${account.hasPassword ? "" : " · no password saved"}`;
      info.appendChild(labelEl);
      info.appendChild(metaEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.accounts.map((a) =>
          a.id === account.id ? toUpdatePayload({ ...a, enabled: toggle.checked }) : toUpdatePayload(a)
        );
        const saved = await window.nimbus.updateEmailSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.accounts.filter((a) => a.id !== account.id).map(toUpdatePayload);
        const saved = await window.nimbus.updateEmailSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      accountList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getEmailSettings();
    enabledCheckbox.checked = settings.enabled;
    renderAccounts(settings);
  } catch (err) {
    console.error("Failed to load email settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateEmailSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const host = hostInput.value.trim();
    const username = usernameInput.value.trim();
    const password = passwordInput.value; // not trimmed — a password could legitimately have leading/trailing spaces
    const port = Number(portInput.value) || 993;

    if (!label || !host || !username || !password) {
      (label ? (host ? (username ? passwordInput : usernameInput) : hostInput) : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getEmailSettings();
    const newAccount = {
      id: `account-${Date.now()}`,
      label,
      host,
      port,
      secure: secureInput.checked,
      username,
      sinceDays: 0,
      enabled: true,
      newPassword: password,
    };
    const saved = await window.nimbus.updateEmailSettings({
      accounts: [...current.accounts.map(toUpdatePayload), newAccount],
    });
    renderAccounts(saved);
    labelInput.value = "";
    hostInput.value = "";
    usernameInput.value = "";
    passwordInput.value = "";
    portInput.value = "993";
    secureInput.checked = true;
  });
}

async function initTaskSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("tasksEnabled") as HTMLInputElement;
  const accountList = document.getElementById("taskAccountList") as HTMLElement;
  const labelInput = document.getElementById("taskAccountLabel") as HTMLInputElement;
  const tokenInput = document.getElementById("taskAccountToken") as HTMLInputElement;
  const addBtn = document.getElementById("addTaskAccountBtn") as HTMLButtonElement;

  // The API token never comes back from getTaskSettings() — every update
  // must resubmit every account so we don't accidentally drop one, and
  // must never include a token unless the user is actually changing it.
  function toUpdatePayload(account: TaskAccount): Omit<TaskAccount, "hasApiToken"> {
    const { hasApiToken: _hasApiToken, ...rest } = account;
    return rest;
  }

  function renderAccounts(settings: TaskSettings): void {
    accountList.innerHTML = "";
    for (const account of settings.accounts) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = account.label;
      const metaEl = document.createElement("span");
      metaEl.className = "calendar-feed-row-address";
      metaEl.textContent = `Todoist${account.hasApiToken ? "" : " · no API token saved"}`;
      info.appendChild(labelEl);
      info.appendChild(metaEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.accounts.map((a) =>
          a.id === account.id ? toUpdatePayload({ ...a, enabled: toggle.checked }) : toUpdatePayload(a)
        );
        const saved = await window.nimbus.updateTaskSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.accounts.filter((a) => a.id !== account.id).map(toUpdatePayload);
        const saved = await window.nimbus.updateTaskSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      accountList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getTaskSettings();
    enabledCheckbox.checked = settings.enabled;
    renderAccounts(settings);
  } catch (err) {
    console.error("Failed to load task settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateTaskSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const apiToken = tokenInput.value.trim();

    if (!label || !apiToken) {
      (label ? tokenInput : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getTaskSettings();
    const newAccount = {
      id: `task-account-${Date.now()}`,
      label,
      provider: "todoist" as const,
      enabled: true,
      newApiToken: apiToken,
    };
    const saved = await window.nimbus.updateTaskSettings({
      accounts: [...current.accounts.map(toUpdatePayload), newAccount],
    });
    renderAccounts(saved);
    labelInput.value = "";
    tokenInput.value = "";
  });
}

async function initSpotifySettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("spotifyEnabled") as HTMLInputElement;
  const statusEl = document.getElementById("spotifyStatus") as HTMLElement;
  const connectBtn = document.getElementById("spotifyConnectBtn") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("spotifyDisconnectBtn") as HTMLButtonElement;

  function renderConnectionState(settings: SpotifySettings): void {
    statusEl.textContent = settings.connected ? "Connected" : "Not connected";
    connectBtn.hidden = settings.connected;
    disconnectBtn.hidden = !settings.connected;
  }

  try {
    const settings = await window.nimbus.getSpotifySettings();
    enabledCheckbox.checked = settings.enabled;
    renderConnectionState(settings);
  } catch (err) {
    console.error("Failed to load Spotify settings", err);
  }

  enabledCheckbox.addEventListener("change", async () => {
    const settings = await window.nimbus.updateSpotifySettings({ enabled: enabledCheckbox.checked });
    renderConnectionState(settings);
  });

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    statusEl.textContent = "Connecting… complete sign-in in your browser";
    try {
      const result = await window.nimbus.connectSpotify();
      const settings = await window.nimbus.getSpotifySettings();
      renderConnectionState(settings);
      if (result.error) statusEl.textContent = result.error;
    } finally {
      connectBtn.disabled = false;
    }
  });

  disconnectBtn.addEventListener("click", async () => {
    await window.nimbus.disconnectSpotify();
    const settings = await window.nimbus.getSpotifySettings();
    renderConnectionState(settings);
  });
}

/** mm:ss formatting for track progress/duration. */
const NOW_PLAYING_POLL_MS = 5000;
/**
 * A same-window custom event nudging the now-playing card to refresh
 * immediately instead of waiting for its next poll — dispatched locally
 * after this window's own "Test routine" button runs a Spotify action,
 * and also whenever the main process pushes `onNowPlayingChanged` (see
 * below), which is what covers a Spotify action accepted from the
 * separate suggestion popup window.
 */
const NOW_PLAYING_REFRESH_EVENT = "nimbus:refresh-now-playing";

// A Spotify action can now be accepted from the suggestion popup — a
// completely separate BrowserWindow with no direct link to this one's
// DOM. Without this, the Home now-playing card only learned about it on
// its own next 5-second poll. See `onActionExecuted` in lifecycle.ts,
// which pushes this to every open window right after a Spotify action
// runs, regardless of which window (or none) triggered it.
window.nimbus.onNowPlayingChanged(() => window.dispatchEvent(new Event(NOW_PLAYING_REFRESH_EVENT)));

/**
 * The Home tab's compact "currently playing" area — makes Spotify feel
 * like part of the assistant rather than a separate app, without turning
 * Home into a music player. Reads the existing SpotifyContextProvider
 * data (already in every getContext() snapshot) and drives playback
 * through the existing generic executeAction — no Spotify-specific IPC
 * of its own beyond what Settings already added.
 */
function initNowPlayingCard(): void {
  const card = document.getElementById("nowPlayingCard") as HTMLElement;
  const clickzone = document.getElementById("nowPlayingClickzone") as HTMLButtonElement;
  const artEl = document.getElementById("nowPlayingArt") as HTMLElement;
  const kickerEl = document.getElementById("nowPlayingKicker") as HTMLElement;
  const titleEl = document.getElementById("nowPlayingTitle") as HTMLElement;
  const artistEl = document.getElementById("nowPlayingArtist") as HTMLElement;
  const elapsedEl = document.getElementById("nowPlayingElapsed") as HTMLElement;
  const durationEl = document.getElementById("nowPlayingDuration") as HTMLElement;
  const progressFillEl = document.getElementById("nowPlayingProgressFill") as HTMLElement;
  const playPauseBtn = document.getElementById("nowPlayingPlayPauseBtn") as HTMLButtonElement;
  // Inline SVG (matching the sidebar nav icons) instead of a Unicode
  // glyph — Windows' Segoe UI Emoji renders ▶/⏸ in full color regardless
  // of the text-presentation variation selector, which clashed badly
  // against this button's own accent-colored background. SVG with
  // fill="currentColor" always follows the button's actual text color.
  const PLAY_ICON_SVG = `<svg width="12" height="13" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,1 3,15 15,8"/></svg>`;
  const PAUSE_ICON_SVG = `<svg width="12" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="1" width="4" height="14"/><rect x="10" y="1" width="4" height="14"/></svg>`;
  function setPlayPauseIcon(isPlaying: boolean): void {
    playPauseBtn.innerHTML = isPlaying ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
  }
  const prevBtn = document.getElementById("nowPlayingPrevBtn") as HTMLButtonElement;
  const nextBtn = document.getElementById("nowPlayingNextBtn") as HTMLButtonElement;
  const volumeSlider = document.getElementById("nowPlayingVolumeSlider") as HTMLInputElement;
  const errorEl = document.getElementById("nowPlayingError") as HTMLElement;
  const playlistDropdown = document.getElementById("nowPlayingPlaylistDropdown") as HTMLElement;

  let knownPlaylists: SpotifyPlaylistSummary[] = [];
  let playlistsLoaded = false;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let volumeSliderBeingDragged = false;
  let lastPlaybackSignature = "";
  let reconcilePollToken = 0;

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorEl.hidden = true;
    }, 4000);
  }

  function closePlaylistDropdown(): void {
    playlistDropdown.hidden = true;
    playlistDropdown.innerHTML = "";
  }

  async function openPlaylistDropdown(): Promise<void> {
    if (!playlistDropdown.hidden) {
      closePlaylistDropdown();
      return;
    }

    playlistDropdown.innerHTML = "";
    playlistDropdown.hidden = false;

    if (!playlistsLoaded) {
      const loading = document.createElement("div");
      loading.className = "now-playing-playlist-message";
      loading.textContent = "Loading playlists…";
      playlistDropdown.appendChild(loading);
      try {
        knownPlaylists = await window.nimbus.listSpotifyPlaylists();
        playlistsLoaded = true;
      } catch (err) {
        console.error("Failed to load Spotify playlists", err);
        playlistDropdown.innerHTML = "";
        const errorMsg = document.createElement("div");
        errorMsg.className = "now-playing-playlist-message";
        errorMsg.textContent = "Couldn't load playlists.";
        playlistDropdown.appendChild(errorMsg);
        return;
      }
    }

    playlistDropdown.innerHTML = "";
    if (knownPlaylists.length === 0) {
      const empty = document.createElement("div");
      empty.className = "now-playing-playlist-message";
      empty.textContent = "No playlists found.";
      playlistDropdown.appendChild(empty);
      return;
    }

    for (const playlist of knownPlaylists) {
      const item = document.createElement("div");
      item.className = "now-playing-playlist-item";

      const art = document.createElement("div");
      art.className = "now-playing-playlist-item-art";
      if (playlist.imageUrl) art.style.backgroundImage = `url("${playlist.imageUrl}")`;
      item.appendChild(art);

      const info = document.createElement("div");
      info.className = "now-playing-playlist-item-info";
      const name = document.createElement("div");
      name.className = "now-playing-playlist-item-name";
      name.textContent = playlist.name;
      info.appendChild(name);
      if (playlist.trackCount !== null) {
        const meta = document.createElement("div");
        meta.className = "now-playing-playlist-item-meta";
        meta.textContent = `${playlist.trackCount} track${playlist.trackCount === 1 ? "" : "s"}`;
        info.appendChild(meta);
      }
      item.appendChild(info);

      item.addEventListener("click", () => {
        closePlaylistDropdown();
        runAction("spotify.playPlaylist", { playlistUri: playlist.uri });
      });

      playlistDropdown.appendChild(item);
    }
  }

  document.addEventListener("click", (event) => {
    if (!playlistDropdown.hidden && !card.contains(event.target as Node)) {
      closePlaylistDropdown();
    }
  });

  function render(context: SpotifyPlaybackContext | null, connected: boolean): void {
    if (!connected) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const supportsVolume = context?.device?.supportsVolume ?? true;
    volumeSlider.disabled = !supportsVolume;
    volumeSlider.title = supportsVolume ? "Volume" : "This device doesn't support remote volume control";

    if (!context || context.playbackState === "stopped" || !context.track) {
      artEl.style.backgroundImage = "";
      titleEl.textContent = "Nothing is playing";
      artistEl.textContent = "";
      elapsedEl.textContent = "";
      durationEl.textContent = "";
      progressFillEl.style.width = "0%";
      setPlayPauseIcon(false);
      playPauseBtn.title = "Play";
      return;
    }

    artEl.style.backgroundImage = context.track.imageUrl ? `url("${context.track.imageUrl}")` : "";
    titleEl.textContent = context.track.name;
    artistEl.textContent = context.track.artists.join(", ") || "";

    const playlistName =
      context.context?.type === "playlist"
        ? knownPlaylists.find((p) => p.uri === context.context!.uri)?.name
        : null;
    kickerEl.textContent = playlistName ? `Spotify · ${playlistName}` : "Spotify";

    const progress = context.progressMs ?? 0;
    const duration = context.track.durationMs || 1;
    elapsedEl.textContent = formatMs(progress);
    durationEl.textContent = formatMs(duration);
    progressFillEl.style.width = `${Math.min(100, (progress / duration) * 100)}%`;

    const isPlaying = context.playbackState === "playing";
    setPlayPauseIcon(isPlaying);
    playPauseBtn.title = isPlaying ? "Pause" : "Play";

    if (!volumeSliderBeingDragged && context.volumePercent !== null) {
      volumeSlider.value = String(context.volumePercent);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [spotifySettings, snapshot] = await Promise.all([
        window.nimbus.getSpotifySettings(),
        window.nimbus.getContext(),
      ]);
      if (!spotifySettings.connected) {
        render(null, false);
        return;
      }
      const spotify = snapshot.providers.spotify;
      // ContextService falls back to the last known-good result (with
      // `status: "error"`, `stale: true`) on a transient fetch failure
      // rather than returning no data — treating only `status === "ok"`
      // as real data threw that stale-but-valid snapshot away on every
      // hiccup, which both blanked the card unnecessarily and (worse)
      // fed refreshUntilChanged below a bogus "" signature that looked
      // like a genuine change and made it give up early.
      const data = spotify?.data ? (spotify.data as unknown as SpotifyPlaybackContext) : null;
      lastPlaybackSignature = `${data?.context?.uri ?? ""}::${data?.track?.id ?? ""}`;
      render(data, true);
    } catch (err) {
      console.error("Failed to load Spotify now-playing", err);
    }
  }

  /**
   * Used instead of a single `refresh()` right after a Spotify action —
   * Spotify's own `/me/player` endpoint can lag behind the actual device
   * state right after a playback-changing command (most noticeably after
   * switching playlists via a Routine), sometimes by more than the ~15s
   * this used to give up after — that looked like "the Home card just
   * never updates" even though it was still quietly retrying. Keeps
   * re-fetching every 2s for up to a full minute, which is patient
   * enough to survive one of these longer stretches while still not
   * polling forever.
   */
  async function refreshUntilChanged(): Promise<void> {
    const myToken = ++reconcilePollToken; // a newer call (e.g. the user clicked Next) supersedes this one
    const before = lastPlaybackSignature;
    for (let attempt = 0; attempt < 30; attempt++) {
      await refresh();
      if (myToken !== reconcilePollToken || lastPlaybackSignature !== before) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function runAction(actionId: string, params?: Record<string, unknown>): Promise<void> {
    try {
      const result = await window.nimbus.executeAction(actionId, params);
      if (result.status !== "success") {
        console.warn(`Spotify action "${actionId}" failed`, result.error);
        showError(result.error?.message || "That didn't work — try again.");
      } else {
        errorEl.hidden = true;
      }
    } catch (err) {
      console.error(`Failed to execute action "${actionId}"`, err);
      showError("That didn't work — try again.");
    } finally {
      await refresh();
    }
  }

  clickzone.addEventListener("click", () => {
    openPlaylistDropdown();
  });
  playPauseBtn.addEventListener("click", () => {
    const isPlaying = playPauseBtn.title === "Pause";
    runAction(isPlaying ? "spotify.pause" : "spotify.play");
  });
  prevBtn.addEventListener("click", () => runAction("spotify.previous"));
  nextBtn.addEventListener("click", () => runAction("spotify.next"));
  volumeSlider.addEventListener("mousedown", () => {
    volumeSliderBeingDragged = true;
  });
  volumeSlider.addEventListener("change", () => {
    volumeSliderBeingDragged = false;
    if (volumeSlider.disabled) return;
    runAction("spotify.setVolume", { volumePercent: Number(volumeSlider.value) });
  });

  window.nimbus
    .listSpotifyPlaylists()
    .then((playlists) => {
      knownPlaylists = playlists;
      playlistsLoaded = true;
    })
    .catch(() => {}); // pre-fetched for the kicker label and a snappier first dropdown open — safe to skip if unavailable, openPlaylistDropdown re-fetches on demand otherwise

  refresh();
  // Only worth polling while the user can actually see it — the Home tab.
  setInterval(() => {
    if (document.getElementById("tab-home")?.classList.contains("active")) {
      refresh();
    }
  }, NOW_PLAYING_POLL_MS);
  window.addEventListener(NOW_PLAYING_REFRESH_EVENT, () => refreshUntilChanged());
}

const TRIGGER_TYPES: TriggerConfig["type"][] = [
  "applicationOpened",
  "websiteOpened",
  "folderOpened",
  "activityEnded",
];

/**
 * Builds a trigger from the form.
 *
 * `existing` is the trigger being edited, when there is one. The form has
 * no match-mode control, so without this an edit would rewrite whatever
 * was saved to "contains" — silently loosening an "exact" routine's
 * matching as a side effect of changing something unrelated. The saved
 * mode is carried over whenever the trigger type is unchanged; a genuinely
 * new trigger type gets the form's default.
 */
function buildTriggerFromForm(existing?: TriggerConfig): TriggerConfig | null {
  const type = (document.getElementById("routineTriggerType") as HTMLSelectElement)
    .value as TriggerConfig["type"];
  // Only the pattern-matching triggers carry a match mode to preserve;
  // "activity ended" and "timer completed" match by name, not pattern.
  const matchMode: StringMatchMode =
    existing &&
    existing.type === type &&
    existing.type !== "activityEnded" &&
    existing.type !== "timerCompleted"
      ? existing.matchMode
      : "contains";

  if (type === "applicationOpened") {
    const application = (document.getElementById("routineAppName") as HTMLInputElement).value.trim();
    return application ? { type, application, matchMode } : null;
  }
  if (type === "websiteOpened") {
    const pattern = (document.getElementById("routineWebsitePattern") as HTMLInputElement).value.trim();
    const matchField = existing?.type === "websiteOpened" ? existing.matchField : ("windowTitle" as const);
    return pattern ? { type, matchField, pattern, matchMode } : null;
  }
  if (type === "activityEnded") {
    // An empty activity name is meaningful here — it means "any activity
    // ending" — so unlike the other triggers this one is never null for
    // want of a value.
    const activity = (document.getElementById("routineActivityEndedName") as HTMLSelectElement).value.trim();
    const minutes = Number(
      (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value
    );
    return {
      type,
      activity,
      minMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
    };
  }

  const path = (document.getElementById("routineFolderPath") as HTMLInputElement).value.trim();
  return path ? { type: "folderOpened", path, matchMode } : null;
}

/**
 * Wraps a checkbox in the pill switch markup the rest of the UI uses
 * (`.toggle` + `.track`). Built rather than written out at each call
 * site so a row's switch cannot drift from the ones in the forms.
 */
function buildSwitch(input: HTMLInputElement): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "toggle";
  wrapper.appendChild(input);
  const track = document.createElement("span");
  track.className = "track";
  wrapper.appendChild(track);
  return wrapper;
}

const ROUTINE_RUN_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,1 3,15 15,8"/></svg>`;
const ROUTINE_RUNNING_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6" stroke-dasharray="28" stroke-dashoffset="10"/></svg>`;
const ROUTINE_RUN_SUCCESS_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,9 6,13 14,3"/></svg>`;
const ROUTINE_RUN_FAILURE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>`;

/**
 * Wires the whole Routines configuration flow: create/enable-disable/
 * delete/test a Routine, choose a trigger + its parameters, and build an
 * ordered action sequence from NIMBUS's existing, already-registered
 * Actions — never anything Routines invents or hard-codes itself (see
 * "Generic configuration" in docs/routines.md).
 */
async function initRoutinesSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("routinesEnabled") as HTMLInputElement;
  const disabledWarningEl = document.getElementById("routinesDisabledWarning") as HTMLElement;
  const routineListEl = document.getElementById("routineList") as HTMLElement;
  const nameInput = document.getElementById("routineName") as HTMLInputElement;
  const triggerTypeSelect = document.getElementById("routineTriggerType") as HTMLSelectElement;
  const suggestionTitleInput = document.getElementById("routineSuggestionTitle") as HTMLInputElement;
  const suggestionMessageInput = document.getElementById("routineSuggestionMessage") as HTMLInputElement;
  const cooldownInput = document.getElementById("routineCooldown") as HTMLInputElement;
  const skipIfActiveCheckbox = document.getElementById("routineSkipIfActive") as HTMLInputElement;
  const autoRunCheckbox = document.getElementById("routineAutoRun") as HTMLInputElement;
  const actionListEl = document.getElementById("routineActionList") as HTMLElement;
  const actionServiceSelect = document.getElementById("routineActionServiceSelect") as HTMLSelectElement;
  const actionSelect = document.getElementById("routineActionSelect") as HTMLSelectElement;
  const addActionBtn = document.getElementById("routineAddActionBtn") as HTMLButtonElement;
  const cancelActionEditBtn = document.getElementById("routineCancelActionEditBtn") as HTMLButtonElement;
  const actionParamFieldsEl = document.getElementById("routineActionParamFields") as HTMLElement;
  const saveBtn = document.getElementById("addRoutineBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelRoutineEditBtn") as HTMLButtonElement;
  const formHeadingEl = document.getElementById("routineFormHeading") as HTMLElement;
  const listViewEl = document.getElementById("routinesListView") as HTMLElement;
  const editViewEl = document.getElementById("routinesEditView") as HTMLElement;
  const newRoutineBtn = document.getElementById("newRoutineBtn") as HTMLButtonElement;
  const backToListBtn = document.getElementById("backToRoutineListBtn") as HTMLButtonElement;
  const viewListBtn = document.getElementById("routinesViewListBtn") as HTMLButtonElement;
  const viewGridBtn = document.getElementById("routinesViewGridBtn") as HTMLButtonElement;
  const routineListEmptyEl = document.getElementById("routineListEmpty") as HTMLElement;
  const activityDebugDetails = document.querySelector(".activity-debug") as HTMLDetailsElement;
  const activitySnapshotContentEl = document.getElementById("activitySnapshotContent") as HTMLElement;
  const refreshActivitySnapshotBtn = document.getElementById(
    "refreshActivitySnapshotBtn"
  ) as HTMLButtonElement;

  function showListView(): void {
    listViewEl.hidden = false;
    editViewEl.hidden = true;
  }

  function showEditView(): void {
    listViewEl.hidden = true;
    editViewEl.hidden = false;
  }

  const CARD_LAYOUT_STORAGE_KEY = "nimbus:routines-card-layout";
  function applyCardLayout(layout: "list" | "grid"): void {
    routineListEl.classList.toggle("grid-view", layout === "grid");
    viewListBtn.classList.toggle("active", layout === "list");
    viewGridBtn.classList.toggle("active", layout === "grid");
    try {
      localStorage.setItem(CARD_LAYOUT_STORAGE_KEY, layout);
    } catch {
      // per-viewer convenience only — fine if storage is unavailable (private window, etc.)
    }
  }
  viewListBtn.addEventListener("click", () => applyCardLayout("list"));
  viewGridBtn.addEventListener("click", () => applyCardLayout("grid"));
  let savedLayout: string | null = null;
  try {
    savedLayout = localStorage.getItem(CARD_LAYOUT_STORAGE_KEY);
  } catch {
    // ignore — defaults to list view below
  }
  applyCardLayout(savedLayout === "grid" ? "grid" : "list");

  let availableActions: ActionDefinition[] = [];
  let availablePlaylists: SpotifyPlaylistSummary[] = [];
  let pendingActions: RoutineActionStep[] = [];
  // Index into pendingActions currently loaded into the picker row for
  // editing — null means the picker is building a brand new step to
  // append, matching the "Save routine"/"Update routine" duality above.
  let editingActionIndex: number | null = null;
  // Set only while editing an existing routine — the same create form
  // above doubles as the editor (see this function's doc comment); this
  // is the one bit of state that changes "Save routine" from appending a
  // new routine to replacing this one in place.
  let editingRoutineId: string | null = null;
  /** The trigger of the routine open in the editor, so an edit preserves its match mode. */
  let editedRoutineTrigger: TriggerConfig | null = null;

  function syncTriggerFieldsVisibility(): void {
    for (const type of TRIGGER_TYPES) {
      const el = document.getElementById(`routineTriggerFields-${type}`) as HTMLElement;
      el.hidden = type !== triggerTypeSelect.value;
    }
    // "Activity ended" is the one trigger with a second field of its own.
    const minEl = document.getElementById("routineTriggerFields-activityEndedMin") as HTMLElement;
    minEl.hidden = triggerTypeSelect.value !== "activityEnded";
  }

  function paramFieldId(name: string): string {
    return `routineParam-${name}`;
  }

  /**
   * A service-first picker for the action dropdown — with every action
   * from every provider in one flat list, a routine only interested in
   * "open a website" had to scroll past every Spotify action first (and
   * will have to scroll past even more once more providers exist).
   * Services come entirely from `ActionDefinition.affectsService`, never
   * a hard-coded list — a brand new provider shows up here with no
   * changes to this file.
   */
  function populateActionServiceSelect(): void {
    const previousValue = actionServiceSelect.value;
    actionServiceSelect.innerHTML = "";
    const services = [...new Set(availableActions.map((a) => a.affectsService))].sort();
    for (const service of services) {
      const option = document.createElement("option");
      option.value = service;
      option.textContent = capitalize(service);
      actionServiceSelect.appendChild(option);
    }
    if (services.includes(previousValue)) actionServiceSelect.value = previousValue;
  }

  function populateActionSelectForService(service: string): void {
    actionSelect.innerHTML = "";
    for (const def of availableActions.filter((a) => a.affectsService === service)) {
      const option = document.createElement("option");
      option.value = def.id;
      option.textContent = def.name;
      actionSelect.appendChild(option);
    }
  }

  function capitalize(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Fields declare their choices in plain English in ActionDefinition's
  // own `description` (e.g. "single | pomodoro — defaults to single") —
  // an existing convention (see spotify.search's "type" param) reused
  // here rather than invented for Timer specifically. Parsing it into a
  // dropdown works for any action's enum-shaped string param, current or
  // future, without the Routine editor needing to special-case which
  // action or param it is.
  function parseEnumOptions(description: string): string[] | null {
    const beforeDash = description.split("—")[0];
    const candidates = beforeDash.split("|").map((s) => s.trim());
    if (candidates.length < 2 || candidates.some((c) => c.length === 0 || /\s/.test(c))) return null;
    return candidates;
  }

  // timer.start's params fall into two groups depending on `mode` — a
  // single duration/type/title, or a Pomodoro studyMinutes/breakMinutes/
  // cycles plan. Both sets are always sent to collectActionParams (a
  // hidden field simply isn't filled in, same as any other optional
  // field left blank), this only avoids showing the user irrelevant
  // fields for the mode they didn't pick.
  const TIMER_SINGLE_ONLY_PARAMS = new Set(["duration", "type"]);
  const TIMER_POMODORO_ONLY_PARAMS = new Set(["studyMinutes", "breakMinutes", "cycles"]);

  function updateTimerModeVisibility(mode: string): void {
    for (const [name, row] of paramRowsByName) {
      if (TIMER_SINGLE_ONLY_PARAMS.has(name)) row.hidden = mode !== "single";
      else if (TIMER_POMODORO_ONLY_PARAMS.has(name)) row.hidden = mode !== "pomodoro";
    }
  }

  let paramRowsByName = new Map<string, HTMLElement>();

  function renderActionParamFields(actionDef: ActionDefinition | undefined): void {
    actionParamFieldsEl.innerHTML = "";
    paramRowsByName = new Map();
    if (!actionDef) return;

    for (const param of actionDef.parameters) {
      const row = document.createElement("label");
      row.className = "field-row";
      const label = document.createElement("span");
      label.className = "setting-title";
      label.textContent = param.required ? param.name : `${param.name} (optional)`;
      row.appendChild(label);

      const enumOptions =
        param.type === "string" && param.description ? parseEnumOptions(param.description) : null;

      // A picked-playlist affordance for Spotify's playPlaylist action —
      // still just filling in a plain action parameter, not a special
      // routine concept (see "Generic configuration" in docs/routines.md).
      if (
        actionDef.id === "spotify.playPlaylist" &&
        param.name === "playlistUri" &&
        availablePlaylists.length > 0
      ) {
        const select = document.createElement("select");
        select.className = "select";
        select.id = paramFieldId(param.name);
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "(search by name instead)";
        select.appendChild(blank);
        for (const playlist of availablePlaylists) {
          const option = document.createElement("option");
          option.value = playlist.uri;
          option.textContent = playlist.name;
          select.appendChild(option);
        }
        row.appendChild(select);
      } else if (enumOptions) {
        const select = document.createElement("select");
        select.className = "select";
        select.id = paramFieldId(param.name);
        if (!param.required) {
          const blank = document.createElement("option");
          blank.value = "";
          blank.textContent = "(default)";
          select.appendChild(blank);
        }
        for (const optionValue of enumOptions) {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionValue;
          select.appendChild(option);
        }
        if (actionDef.id === "timer.start" && param.name === "mode") {
          select.addEventListener("change", () => updateTimerModeVisibility(select.value || "single"));
        }
        row.appendChild(select);
      } else {
        const input = document.createElement("input");
        input.id = paramFieldId(param.name);
        input.type = param.type === "number" ? "number" : "text";
        // The provider's own description doubles as the hint — which
        // process name, what range — so the field isn't a blank guess.
        if (param.description) input.placeholder = param.description;
        if (param.format) {
          // A path parameter gets a picker beside the text field. The text
          // stays editable, so a path — say, a shortcut the picker would
          // resolve to its target — can also be pasted in directly.
          const pickerRow = document.createElement("div");
          pickerRow.className = "action-picker-row";
          pickerRow.appendChild(input);
          const browse = document.createElement("button");
          browse.type = "button";
          browse.className = "btn btn-secondary";
          browse.textContent = "Browse…";
          const format = param.format;
          browse.addEventListener("click", async (event) => {
            event.preventDefault();
            const picked = await window.nimbus.pickPath(format);
            if (picked) input.value = picked;
          });
          pickerRow.appendChild(browse);
          row.appendChild(pickerRow);
        } else {
          row.appendChild(input);
        }
      }

      actionParamFieldsEl.appendChild(row);
      paramRowsByName.set(param.name, row);
    }

    if (actionDef.id === "timer.start") {
      updateTimerModeVisibility("single"); // matches the mode select's own default first option
    }
  }

  function collectActionParams(actionDef: ActionDefinition): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const param of actionDef.parameters) {
      const el = document.getElementById(paramFieldId(param.name)) as
        HTMLInputElement | HTMLSelectElement | null;
      if (!el || !el.value) continue;
      params[param.name] = param.type === "number" ? Number(el.value) : el.value;
    }
    return params;
  }

  function countLabel(count: number): string {
    return count === 0 ? "none" : `${count} action${count === 1 ? "" : "s"}`;
  }

  /**
   * The wind-down list. Deliberately simpler than the start list: add and
   * remove, no in-place edit or reordering. Undoing what a routine
   * started is usually one or two steps, and "remove and add again" is a
   * smaller thing to learn than a second editing mode.
   */
  const STOP_TRIGGER_TYPES = [
    "activityEnded",
    "timerCompleted",
    "applicationOpened",
    "websiteOpened",
    "folderOpened",
  ];

  function syncStopTriggerFields(): void {
    for (const type of STOP_TRIGGER_TYPES) {
      const el = document.getElementById(`routineStopTriggerFields-${type}`) as HTMLElement | null;
      if (el) el.hidden = type !== stopTriggerTypeSelect.value;
    }
  }

  /**
   * The end half's trigger. Mirrors buildTriggerFromForm for the start
   * half, over its own fields — the two halves are the same kind of rule,
   * so they are configured the same way.
   */
  function buildStopTriggerFromForm(): TriggerConfig | null {
    const value = (id: string): string =>
      (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();

    switch (stopTriggerTypeSelect.value) {
      case "activityEnded":
        // An empty activity means "any activity ending" — a real choice,
        // so this never fails for want of a value.
        return { type: "activityEnded", activity: stopActivitySelect.value.trim() };
      case "timerCompleted":
        return { type: "timerCompleted", timerType: value("routineStopTimerType") };
      case "applicationOpened": {
        const application = value("routineStopAppName");
        return application ? { type: "applicationOpened", application, matchMode: "contains" } : null;
      }
      case "websiteOpened": {
        const pattern = value("routineStopWebsitePattern");
        return pattern
          ? { type: "websiteOpened", matchField: "windowTitle", pattern, matchMode: "contains" }
          : null;
      }
      case "folderOpened": {
        const path = value("routineStopFolderPath");
        return path ? { type: "folderOpened", path, matchMode: "contains" } : null;
      }
      default:
        return null;
    }
  }

  function loadStopTrigger(trigger: TriggerConfig | undefined): void {
    const set = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = v;
    };
    set("routineStopTimerType", "");
    set("routineStopAppName", "");
    set("routineStopWebsitePattern", "");
    set("routineStopFolderPath", "");

    // No saved end trigger means the default: this routine's own activity
    // ending. Shown as such rather than left blank.
    stopTriggerTypeSelect.value = trigger?.type ?? "activityEnded";
    if (trigger?.type === "activityEnded") {
      fillActivityOptions(stopActivitySelect, trigger.activity, "Any activity");
    } else {
      fillActivityOptions(stopActivitySelect, "", "Any activity");
    }
    if (trigger?.type === "timerCompleted") set("routineStopTimerType", trigger.timerType);
    if (trigger?.type === "applicationOpened") set("routineStopAppName", trigger.application);
    if (trigger?.type === "websiteOpened") set("routineStopWebsitePattern", trigger.pattern);
    if (trigger?.type === "folderOpened") set("routineStopFolderPath", trigger.path);
    syncStopTriggerFields();
    syncStopSectionAvailability();
  }

  function renderStopActions(): void {
    stopActionListEl.innerHTML = "";

    pendingStopActions.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "action-row";

      const info = document.createElement("span");
      info.className = "action-row-label";
      const badge = document.createElement("span");
      badge.className = "tag tag-accent action-row-index";
      badge.textContent = String(index + 1);
      info.appendChild(badge);
      const def = availableActions.find((a) => a.id === step.actionId);
      const name = document.createElement("span");
      name.textContent = def?.name ?? step.actionId;
      info.appendChild(name);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "action-row-actions";
      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        pendingStopActions = pendingStopActions.filter((_, i) => i !== index);
        renderStopActions();
      });
      actions.appendChild(remove);
      row.appendChild(actions);

      stopActionListEl.appendChild(row);
    });

    stopCountEl.textContent = countLabel(pendingStopActions.length);
    syncStopSectionAvailability();
  }

  /**
   * The end half always has a trigger of its own — every type in the list
   * is complete without help, and "activity ended" with nothing chosen
   * means any activity ending, not this routine's. So there is nothing
   * left to gate on: the section is always available.
   */
  function syncStopSectionAvailability(): void {
    addStopActionBtn.disabled = false;
    // An end trigger with nothing to run is saved but inert. Saying so
    // beats letting someone set one and wonder why nothing happens.
    const triggerWithoutActions = stopTriggerToSave() !== undefined && pendingStopActions.length === 0;
    stopHintEl.textContent = triggerWithoutActions
      ? "This end trigger is saved, but nothing runs on it yet — add an action below."
      : "Only runs if this routine actually started — winding down something that was never wound up would, at best, do nothing.";
    // A section with something in it stays open, so it isn't forgotten.
    if (pendingStopActions.length > 0) stopSectionEl.open = true;
  }

  function renderPendingActions(): void {
    actionListEl.innerHTML = "";
    startCountEl.textContent = countLabel(pendingActions.length);
    pendingActions.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "action-row";

      // The step number is a tag rather than a "1." prefix on the label,
      // so the order of a multi-step routine reads at a glance.
      const info = document.createElement("span");
      info.className = "action-row-label";
      const badge = document.createElement("span");
      badge.className = "tag tag-accent action-row-index";
      badge.textContent = String(index + 1);
      info.appendChild(badge);
      const def = availableActions.find((a) => a.id === step.actionId);
      const name = document.createElement("span");
      name.textContent = def?.name ?? step.actionId;
      info.appendChild(name);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "action-row-actions";

      if (index > 0) {
        const up = document.createElement("button");
        up.className = "btn btn-ghost";
        up.textContent = "↑";
        up.addEventListener("click", () => {
          stopEditingAction(); // reordering while the picker has one of these steps loaded would edit the wrong one after the swap
          [pendingActions[index - 1], pendingActions[index]] = [
            pendingActions[index],
            pendingActions[index - 1],
          ];
          renderPendingActions();
        });
        actions.appendChild(up);
      }
      if (index < pendingActions.length - 1) {
        const down = document.createElement("button");
        down.className = "btn btn-ghost";
        down.textContent = "↓";
        down.addEventListener("click", () => {
          stopEditingAction();
          [pendingActions[index + 1], pendingActions[index]] = [
            pendingActions[index],
            pendingActions[index + 1],
          ];
          renderPendingActions();
        });
        actions.appendChild(down);
      }

      const edit = document.createElement("button");
      edit.className = "btn btn-ghost";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditingAction(index));
      actions.appendChild(edit);

      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (editingActionIndex === index) stopEditingAction(); // the step being edited is the one being removed
        pendingActions = pendingActions.filter((_, i) => i !== index);
        renderPendingActions();
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      actionListEl.appendChild(row);
    });
  }

  /**
   * Loads one already-added action step back into the picker row so it
   * can be changed in place — without this, changing a single param
   * meant Remove-then-re-Add-from-scratch, retyping everything. Reuses
   * the exact same service/action selects and param fields "Add action"
   * already builds; only what happens on click (replace vs. append)
   * differs, mirroring how the routine-level form doubles as create/edit.
   */
  const actionBuilderEl = document.getElementById("routineActionBuilder") as HTMLElement;
  const confirmActionBtn = document.getElementById("routineConfirmActionBtn") as HTMLButtonElement;

  /** Which list the builder is currently adding to, or null when it is closed. */
  let builderTarget: "start" | "stop" | null = null;

  /**
   * Opens the action builder inside a section.
   *
   * The builder is one element that MOVES rather than two copies: it
   * always reads as part of the section being edited, and there is only
   * ever one set of parameter fields to keep straight.
   */
  function openActionBuilder(target: "start" | "stop"): void {
    builderTarget = target;
    const button = target === "start" ? addActionBtn : addStopActionBtn;
    button.parentElement?.insertBefore(actionBuilderEl, button);
    actionBuilderEl.hidden = false;

    populateActionServiceSelect();
    populateActionSelectForService(actionServiceSelect.value);
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
    confirmActionBtn.textContent = editingActionIndex !== null ? "Update" : "Add";
    actionBuilderEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeActionBuilder(): void {
    builderTarget = null;
    editingActionIndex = null;
    actionBuilderEl.hidden = true;
  }

  function startEditingAction(index: number): void {
    const step = pendingActions[index];
    const def = availableActions.find((a) => a.id === step.actionId);
    if (!def) return;

    editingActionIndex = index;
    builderTarget = "start";
    actionServiceSelect.value = def.affectsService;
    populateActionSelectForService(def.affectsService);
    actionSelect.value = def.id;
    renderActionParamFields(def);
    for (const param of def.parameters) {
      const value = step.params[param.name];
      if (value === undefined) continue;
      const el = document.getElementById(paramFieldId(param.name)) as
        HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = String(value);
    }

    openActionBuilder("start");
    confirmActionBtn.textContent = "Update";
  }

  function stopEditingAction(): void {
    closeActionBuilder();
  }

  function resetForm(): void {
    stopEditingAction();
    editingRoutineId = null;
    editedRoutineTrigger = null;
    clearFormError();
    formHeadingEl.textContent = "New routine";
    saveBtn.textContent = "Save routine";
    cancelEditBtn.hidden = true;

    nameInput.value = "";
    triggerTypeSelect.value = "applicationOpened";
    (document.getElementById("routineAppName") as HTMLInputElement).value = "";
    (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = "";
    (document.getElementById("routineFolderPath") as HTMLInputElement).value = "";
    fillActivityOptions(activityEndedSelect, "", "Any activity");
    (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value = "0";
    syncTriggerFieldsVisibility();
    suggestionTitleInput.value = "";
    suggestionMessageInput.value = "";
    cooldownInput.value = "30";
    skipIfActiveCheckbox.checked = false;
    autoRunCheckbox.checked = false;
    routineEnabledCheckbox.checked = true; // a routine you just created is meant to run
    oncePerSessionCheckbox.checked = false;
    descriptionInput.value = "";
    conditionLogicSelect.value = "all";
    pendingConditions = [];
    renderPendingConditions();
    pendingActions = [];
    renderPendingActions();
    pendingStopActions = [];
    pendingStopConditions = [];
    stopAutoRunCheckbox.checked = true;
    stopConditionLogicSelect.value = "all";
    stopSectionEl.open = false;
    loadStopTrigger(undefined);
    renderStopConditions();
    renderStopActions();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  }

  /**
   * Loads an existing routine's fields into the same create form above,
   * so Edit reuses one form/save-path instead of a second editor (see
   * this function's doc comment / task's own "reuse the create UI"
   * requirement). Only application/website/folder triggers have form
   * fields today — a routine with any other trigger type still opens
   * for editing, just with the trigger section left on its default.
   */
  function populateFormForEdit(routine: Routine): void {
    // Awaited nowhere: the pickers below are filled from whatever is
    // known now, and refilled when the fetch lands.
    void refreshKnownActivities().then(() => {
      if (editingRoutineId !== routine.id) return; // the user moved on
      fillActivityOptions(
        activityEndedSelect,
        routine.trigger.type === "activityEnded" ? routine.trigger.activity : "",
        "Any activity"
      );
      // The end half has its own picker over the same list, and its
      // selection was made before the list arrived.
      fillActivityOptions(stopActivitySelect, stopActivitySelect.value, "Any activity");
      renderStopConditions();
      renderPendingConditions();
    });
    showEditView();
    stopEditingAction();
    clearFormError();
    editingRoutineId = routine.id;
    editedRoutineTrigger = routine.trigger;
    formHeadingEl.textContent = `Editing "${routine.name}"`;
    saveBtn.textContent = "Update routine";
    cancelEditBtn.hidden = false;

    nameInput.value = routine.name;
    suggestionTitleInput.value = routine.suggestion.title;
    suggestionMessageInput.value = routine.suggestion.message;
    cooldownInput.value = String(routine.cooldownMinutes);
    skipIfActiveCheckbox.checked = routine.conditions.some((c) => c.type === "actionsNotAlreadyActive");
    autoRunCheckbox.checked = routine.autoRun ?? false;
    routineEnabledCheckbox.checked = routine.enabled;
    oncePerSessionCheckbox.checked = (routine.sessionRestriction ?? "none") === "oncePerSession";
    descriptionInput.value = routine.description ?? "";
    conditionLogicSelect.value = routine.conditionLogic ?? "all";
    // Everything except the "Skip if already active" switch, which owns
    // that one condition — see buildConditionsFromForm. Deep-copied so
    // editing the form never mutates the stored routine before save.
    pendingConditions = routine.conditions
      .filter((c) => c.type !== "actionsNotAlreadyActive")
      .map((c) => ({ ...c, days: c.days ? [...c.days] : undefined }));
    renderPendingConditions();

    (document.getElementById("routineAppName") as HTMLInputElement).value = "";
    (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = "";
    (document.getElementById("routineFolderPath") as HTMLInputElement).value = "";
    if (routine.trigger.type === "applicationOpened") {
      triggerTypeSelect.value = "applicationOpened";
      (document.getElementById("routineAppName") as HTMLInputElement).value = routine.trigger.application;
    } else if (routine.trigger.type === "websiteOpened") {
      triggerTypeSelect.value = "websiteOpened";
      (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = routine.trigger.pattern;
    } else if (routine.trigger.type === "folderOpened") {
      triggerTypeSelect.value = "folderOpened";
      (document.getElementById("routineFolderPath") as HTMLInputElement).value = routine.trigger.path;
    } else if (routine.trigger.type === "activityEnded") {
      triggerTypeSelect.value = "activityEnded";
      fillActivityOptions(activityEndedSelect, routine.trigger.activity, "Any activity");
      (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value = String(
        routine.trigger.minMinutes ?? 0
      );
    }
    syncTriggerFieldsVisibility();

    pendingActions = routine.actions.map((step) => ({ ...step, params: { ...step.params } }));
    renderPendingActions();
    pendingStopActions = (routine.stopActions ?? []).map((step) => ({
      ...step,
      params: { ...step.params },
    }));
    stopAutoRunCheckbox.checked = routine.stopAutoRun !== false;
    pendingStopConditions = (routine.stopConditions ?? []).map((c) => ({
      ...c,
      days: c.days ? [...c.days] : undefined,
    }));
    stopConditionLogicSelect.value = routine.stopConditionLogic ?? "all";
    loadStopTrigger(routine.stopTrigger);
    renderStopConditions();
    renderStopActions();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));

    document.getElementById("routineName")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /**
   * The conditions being edited, mirroring `pendingActions` above: the
   * form owns a working copy and only writes it back into a Routine on
   * save, so cancelling leaves the stored routine untouched.
   *
   * There are two of these now — one per half of the routine — so the
   * editor below is built once and pointed at whichever it is editing.
   *
   * `actionsNotAlreadyActive` is deliberately NOT in the start list — it
   * is the "Skip if already active" switch. Keeping one setting in two
   * places is worse than the small asymmetry of leaving it out, and a
   * routine that already has it keeps it through an edit either way (see
   * buildConditionsFromForm).
   */
  let pendingConditions: RoutineCondition[] = [];
  let pendingStopConditions: RoutineCondition[] = [];

  /**
   * Activity names already defined anywhere — refreshed whenever the
   * editor opens, so a picker never offers a stale list.
   *
   * Referencing an activity by choice rather than by retyping it is the
   * point: a typo in a free-text box produces a routine that silently
   * can never match, and nothing tells you why.
   */
  let knownActivities: string[] = [];

  const activityEndedSelect = document.getElementById("routineActivityEndedName") as HTMLSelectElement;

  async function refreshKnownActivities(): Promise<void> {
    try {
      knownActivities = await window.nimbus.getKnownActivities();
    } catch {
      knownActivities = [];
    }
  }

  /**
   * Fills a picker with the known activities, keeping `selected` even if
   * it is no longer one of them — a routine that references an activity
   * whose definition was removed must not silently lose the reference
   * just by being opened.
   */
  function fillActivityOptions(select: HTMLSelectElement, selected: string, anyLabel?: string): void {
    select.innerHTML = "";
    if (anyLabel !== undefined) {
      const any = document.createElement("option");
      any.value = "";
      any.textContent = anyLabel;
      select.appendChild(any);
    }

    const names = [...knownActivities];

    if (selected && !names.some((n) => n.toLowerCase() === selected.toLowerCase())) {
      names.push(selected);
    }
    // With an "any" option there is already something selectable, so a
    // second placeholder would just be a dead entry in the list.
    if (names.length === 0 && anyLabel === undefined) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "No activities yet — name one above";
      select.appendChild(none);
    }

    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.value = selected;
  }

  /** The wind-down half, kept separate so each section owns its own list. */
  let pendingStopActions: RoutineActionStep[] = [];

  const stopActionListEl = document.getElementById("routineStopActionList") as HTMLElement;
  const addStopActionBtn = document.getElementById("routineAddStopActionBtn") as HTMLButtonElement;
  const stopAutoRunCheckbox = document.getElementById("routineStopAutoRun") as HTMLInputElement;
  const startCountEl = document.getElementById("routineStartCount") as HTMLElement;
  const stopCountEl = document.getElementById("routineStopCount") as HTMLElement;
  const stopSectionEl = document.getElementById("routineStopSection") as HTMLDetailsElement;
  const stopHintEl = document.getElementById("routineStopHint") as HTMLElement;

  const conditionListEl = document.getElementById("routineConditionList") as HTMLElement;
  const stopConditionListEl = document.getElementById("routineStopConditionList") as HTMLElement;
  const stopConditionEmptyEl = document.getElementById("routineStopConditionEmpty") as HTMLElement;
  const stopConditionLogicSelect = document.getElementById("routineStopConditionLogic") as HTMLSelectElement;
  const stopConditionTypeSelect = document.getElementById(
    "routineStopConditionTypeSelect"
  ) as HTMLSelectElement;
  const addStopConditionBtn = document.getElementById("routineAddStopConditionBtn") as HTMLButtonElement;
  const stopTriggerTypeSelect = document.getElementById("routineStopTriggerType") as HTMLSelectElement;
  const stopActivitySelect = document.getElementById("routineStopActivityName") as HTMLSelectElement;
  const conditionEmptyEl = document.getElementById("routineConditionEmpty") as HTMLElement;
  const conditionLogicSelect = document.getElementById("routineConditionLogic") as HTMLSelectElement;
  const conditionTypeSelect = document.getElementById("routineConditionTypeSelect") as HTMLSelectElement;
  const addConditionBtn = document.getElementById("routineAddConditionBtn") as HTMLButtonElement;
  const descriptionInput = document.getElementById("routineDescription") as HTMLInputElement;
  const oncePerSessionCheckbox = document.getElementById("routineOncePerSession") as HTMLInputElement;
  const routineEnabledCheckbox = document.getElementById("routineEnabled") as HTMLInputElement;

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /** Minutes-since-midnight <-> the "HH:MM" an <input type="time"> speaks. */
  function toTimeValue(hour: number, minute: number | undefined): string {
    return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
  }

  /** A blank condition of the chosen type, ready to be edited in place. */
  function newCondition(type: string): RoutineCondition | null {
    if (type === "timeOfDay") return { type: "timeOfDay", startHour: 18, endHour: 23 };
    if (type === "daysOfWeek") return { type: "daysOfWeek", days: [1, 2, 3, 4, 5] };
    if (type === "activityIs") return { type: "activityIs", activity: knownActivities[0] ?? "" };
    if (type === "activityDuration") return { type: "activityDuration", minMinutes: 90 };
    if (type === "spotifyNotAlreadyPlaying") return { type: "spotifyNotAlreadyPlaying" };
    if (type === "spotifyIsPlaying") return { type: "spotifyIsPlaying" };
    return null;
  }

  function addCondition(type: string): void {
    const condition = newCondition(type);
    if (condition) pendingConditions.push(condition);
    renderPendingConditions();
  }

  function renderPendingConditions(): void {
    renderConditionsInto(conditionListEl, conditionEmptyEl, pendingConditions, (next) => {
      pendingConditions = next;
      renderPendingConditions();
    });
  }

  function renderStopConditions(): void {
    renderConditionsInto(stopConditionListEl, stopConditionEmptyEl, pendingStopConditions, (next) => {
      pendingStopConditions = next;
      renderStopConditions();
    });
  }

  /**
   * Draws one list of conditions. Both halves of a routine use this —
   * the rows are identical, only the array they edit differs.
   */
  function renderConditionsInto(
    listEl: HTMLElement,
    emptyEl: HTMLElement,
    conditions: RoutineCondition[],
    onChange: (next: RoutineCondition[]) => void
  ): void {
    listEl.innerHTML = "";
    emptyEl.hidden = conditions.length > 0;

    conditions.forEach((condition, index) => {
      const row = document.createElement("div");
      row.className = "condition-row";

      const label = document.createElement("span");
      label.className = "condition-row-label";
      row.appendChild(label);

      const controls = document.createElement("div");
      controls.className = "condition-row-controls";
      row.appendChild(controls);

      if (condition.type === "timeOfDay") {
        label.textContent = "Time of day";
        const from = document.createElement("input");
        from.type = "time";
        from.className = "input";
        from.value = toTimeValue(condition.startHour ?? 0, condition.startMinute);
        from.addEventListener("change", () => {
          const [h, m] = from.value.split(":").map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) {
            condition.startHour = h;
            condition.startMinute = m;
          }
        });
        const to = document.createElement("input");
        to.type = "time";
        to.className = "input";
        to.value = toTimeValue(condition.endHour ?? 0, condition.endMinute);
        to.addEventListener("change", () => {
          const [h, m] = to.value.split(":").map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) {
            condition.endHour = h;
            condition.endMinute = m;
          }
        });
        const between = document.createElement("span");
        between.className = "condition-row-sep";
        between.textContent = "to";
        controls.append(from, between, to);
      } else if (condition.type === "daysOfWeek") {
        label.textContent = "Days of the week";
        // Normalized up front so a malformed saved condition (no days
        // array at all) still edits cleanly rather than throwing.
        const days = condition;
        if (!Array.isArray(days.days)) days.days = [];
        for (let day = 0; day < 7; day++) {
          const dayLabel = document.createElement("label");
          dayLabel.className = "day-chip";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = (days.days ?? []).includes(day);
          box.addEventListener("change", () => {
            const current = days.days ?? [];
            days.days = box.checked
              ? [...current, day].sort((a, b) => a - b)
              : current.filter((d) => d !== day);
          });
          const text = document.createElement("span");
          text.textContent = DAY_LABELS[day];
          dayLabel.append(box, text);
          controls.appendChild(dayLabel);
        }
      } else if (condition.type === "weekdaysOnly") {
        // Superseded by daysOfWeek and not offered for new routines, but
        // still rendered so an older routine that uses it stays editable
        // and is not silently dropped on save.
        label.textContent = "Weekdays only (Mon-Fri)";
      } else if (condition.type === "activityIs") {
        label.textContent = "Current activity is";
        const picker = document.createElement("select");
        picker.className = "input input-compact";
        fillActivityOptions(picker, condition.activity ?? "");
        picker.addEventListener("change", () => {
          condition.activity = picker.value;
        });
        controls.appendChild(picker);
      } else if (condition.type === "activityDuration") {
        label.textContent = "Current activity has lasted at least";
        const minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "0";
        minutes.className = "input";
        minutes.value = String(condition.minMinutes ?? 0);
        minutes.addEventListener("change", () => {
          const value = Number(minutes.value);
          if (Number.isFinite(value) && value >= 0) condition.minMinutes = value;
        });
        const unit = document.createElement("span");
        unit.className = "condition-row-sep";
        unit.textContent = "minutes";
        controls.append(minutes, unit);
      } else if (condition.type === "spotifyNotAlreadyPlaying") {
        label.textContent = "Spotify is not already playing";
      } else if (condition.type === "spotifyIsPlaying") {
        label.textContent = "Spotify is playing";
      } else {
        label.textContent = `Unrecognized condition (${(condition as { type?: string }).type})`;
      }

      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        onChange(conditions.filter((_, i) => i !== index));
      });
      controls.appendChild(remove);

      listEl.appendChild(row);
    });
  }

  addConditionBtn.addEventListener("click", () => addCondition(conditionTypeSelect.value));
  stopTriggerTypeSelect.addEventListener("change", () => {
    syncStopTriggerFields();
    syncStopSectionAvailability();
  });
  stopActivitySelect.addEventListener("change", () => syncStopSectionAvailability());
  // The hint above depends on the trigger, so every path that changes it
  // has to refresh -- including loading a routine into the form.

  addStopConditionBtn.addEventListener("click", () => {
    const condition = newCondition(stopConditionTypeSelect.value);
    if (condition) pendingStopConditions.push(condition);
    renderStopConditions();
  });

  /**
   * The end trigger to persist, or undefined when there is nothing worth
   * keeping.
   *
   * Not gated on there being end actions. A trigger without actions does
   * nothing at runtime, but forgetting what the user picked because they
   * hadn't finished the other half yet loses their work silently -- which
   * is exactly how this was found. The default ("any activity ended",
   * chosen by nobody) is still dropped, so an untouched form doesn't
   * write a trigger onto every routine.
   */
  function stopTriggerToSave(): TriggerConfig | undefined {
    const trigger = buildStopTriggerFromForm();
    if (!trigger) return undefined;
    if (pendingStopActions.length > 0) return trigger;
    const untouched = trigger.type === "activityEnded" && trigger.activity.trim().length === 0;
    return untouched ? undefined : trigger;
  }

  /**
   * The conditions to save: the edited list, plus the "Skip if already
   * active" switch expressed as the condition it has always been.
   */
  function buildConditionsFromForm(): RoutineCondition[] {
    return withSkipIfActiveCondition(pendingConditions, skipIfActiveCheckbox.checked);
  }

  /**
   * Renders a routine evaluation as the tick/cross list the engine
   * produced. The labels come from the engine itself rather than being
   * re-derived here, so what the user reads is what actually decided.
   */
  function renderRoutineExplanation(target: HTMLElement, evaluation: RoutineEvaluation | null): void {
    target.innerHTML = "";
    if (!evaluation) {
      target.textContent = "That routine no longer exists.";
      return;
    }

    const verdict = document.createElement("div");
    verdict.className = evaluation.matched
      ? "routine-explain-verdict matched"
      : "routine-explain-verdict blocked";
    verdict.textContent = evaluation.matched ? "Would match" : "Would not match";
    target.appendChild(verdict);

    for (const check of evaluation.checks) {
      const line = document.createElement("div");
      line.className = check.passed ? "routine-explain-check pass" : "routine-explain-check fail";
      line.textContent = `${check.passed ? "\u2713" : "\u2717"} ${check.label}`;
      target.appendChild(line);
    }

    const note = document.createElement("div");
    note.className = "routine-explain-note";
    note.textContent = "Evaluated against the current state. Nothing was run.";
    target.appendChild(note);
  }

  /**
   * When each routine last fired, refreshed alongside the list. Held
   * here rather than fetched per card so rendering stays synchronous.
   */
  let lastTriggeredAt: Record<string, number> = {};

  /**
   * One line describing what a routine does and what limits it. Built
   * from the routine's own configuration — every part is omitted when
   * not configured, so a simple routine still reads simply.
   */
  function summarizeRoutine(routine: Routine): string {
    const parts = [triggerSummary(routine.trigger)];

    const conditions = routine.conditions ?? [];
    if (conditions.length > 0) {
      const joiner = (routine.conditionLogic ?? "all") === "any" ? "any of" : "all of";
      parts.push(`${joiner} ${conditions.length} condition${conditions.length === 1 ? "" : "s"}`);
    }

    parts.push(`${routine.actions.length} action${routine.actions.length === 1 ? "" : "s"}`);

    if (routine.stopActions?.length) {
      parts.push(`${routine.stopActions.length} on end`);
    }
    if (routine.cooldownMinutes > 0) parts.push(`${routine.cooldownMinutes} min cooldown`);
    if ((routine.sessionRestriction ?? "none") === "oncePerSession") parts.push("once per session");
    if (routine.autoRun) parts.push("runs automatically");

    return parts.join(" · ");
  }

  /** Coarse on purpose — the exact second a routine fired is noise in a list. */
  function formatRelativeTime(epochMs: number): string {
    const minutes = Math.floor((Date.now() - epochMs) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  const formErrorEl = document.getElementById("routineFormError") as HTMLElement;

  /**
   * Reports what a save is missing, inline.
   *
   * Deliberately not `alert()`. A native dialog blocks the renderer, and
   * in Electron on Windows it routinely leaves the window without
   * keyboard focus once dismissed — which left the form impossible to
   * type into after a failed save, exactly when the user needs to fix
   * it. Inline text cannot steal focus, and it stays on screen while
   * they do.
   */
  function showFormError(message: string, invalid: HTMLElement[] = []): void {
    clearFormError();
    formErrorEl.textContent = message;
    formErrorEl.hidden = false;

    for (const el of invalid) el.classList.add("field-invalid");
    // Put the caret where the work is, rather than making them hunt for
    // the field the message is about.
    const first = invalid[0] as HTMLInputElement | undefined;
    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      first.focus();
    } else {
      formErrorEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function clearFormError(): void {
    formErrorEl.hidden = true;
    formErrorEl.textContent = "";
    for (const el of Array.from(document.querySelectorAll(".field-invalid"))) {
      el.classList.remove("field-invalid");
    }
  }

  /** The trigger's own value field, which differs per trigger type. */
  function triggerValueInput(): HTMLInputElement | null {
    switch (triggerTypeSelect.value) {
      case "applicationOpened":
        return document.getElementById("routineAppName") as HTMLInputElement;
      case "websiteOpened":
        return document.getElementById("routineWebsitePattern") as HTMLInputElement;
      case "folderOpened":
        return document.getElementById("routineFolderPath") as HTMLInputElement;
      default:
        // "Activity ended" needs no value: an empty name means any
        // activity, which is a real choice rather than a missing one.
        return null;
    }
  }

  /**
   * Routines and Activities are two views of the same tab rather than
   * two places in the app. Activities are personal definitions like
   * routines are — sitting them next to weather and calendar preferences
   * in Settings made them feel like configuration, which they aren't.
   */
  function initRoutinesTabSwitch(): void {
    const routinesBtn = document.getElementById("routinesTabRoutinesBtn") as HTMLButtonElement;
    const activitiesBtn = document.getElementById("routinesTabActivitiesBtn") as HTMLButtonElement;
    const routinesPane = document.getElementById("routinesPane") as HTMLElement;
    const activitiesPane = document.getElementById("activitiesPane") as HTMLElement;

    const show = (activities: boolean): void => {
      routinesPane.hidden = activities;
      activitiesPane.hidden = !activities;
      routinesBtn.classList.toggle("active", !activities);
      activitiesBtn.classList.toggle("active", activities);
    };

    routinesBtn.addEventListener("click", () => show(false));
    activitiesBtn.addEventListener("click", () => show(true));
    show(false);
  }

  initRoutinesTabSwitch();

  function renderRoutineList(settings: RoutineSettings): void {
    // Refreshed in the background: a stale "last triggered" line is a
    // cosmetic lag, and awaiting it would make every list render async.
    void window.nimbus
      .getRoutineLastTriggered()
      .then((latest) => {
        const changed = JSON.stringify(latest) !== JSON.stringify(lastTriggeredAt);
        lastTriggeredAt = latest;
        if (changed) renderRoutineList(settings);
      })
      .catch(() => undefined);

    // Surfaces the "your routine exists but can't fire" trap directly in
    // the UI instead of leaving it silently confusing — see the
    // save-routine handler below for the other half of this fix.
    disabledWarningEl.hidden = settings.enabled || settings.routines.length === 0;
    routineListEmptyEl.hidden = settings.routines.length > 0;

    routineListEl.innerHTML = "";
    for (const routine of settings.routines) {
      const card = document.createElement("div");
      card.className = "routine-card";

      // The card's own name/summary area opens it for editing — the
      // same "click the thing to open it" pattern as any list of
      // editable items, so a click anywhere except an explicit control
      // (toggle/Test/Delete) below opens the editor, matching "open a
      // single one and edit/customize" without needing a separate "Edit"
      // button to hunt for.
      const body = document.createElement("button");
      body.type = "button";
      body.className = "routine-card-body";
      body.addEventListener("click", () => populateFormForEdit(routine));

      const nameEl = document.createElement("span");
      nameEl.className = "routine-card-name";
      nameEl.textContent = routine.name;
      body.appendChild(nameEl);

      const metaEl = document.createElement("span");
      metaEl.className = "routine-card-meta";
      metaEl.textContent = summarizeRoutine(routine);
      body.appendChild(metaEl);

      // "Last triggered" comes from the engine's own cooldown clock, so
      // it reflects when the routine actually fired — not when it was
      // edited or when a suggestion happened to be accepted.
      const lastAt = lastTriggeredAt[routine.id];
      if (lastAt) {
        const lastEl = document.createElement("span");
        lastEl.className = "routine-card-meta";
        lastEl.textContent = `Last triggered ${formatRelativeTime(lastAt)}`;
        body.appendChild(lastEl);
      }

      if (routine.description) {
        const descEl = document.createElement("span");
        descEl.className = "routine-card-meta";
        descEl.textContent = routine.description;
        body.appendChild(descEl);
      }

      // The design splits the card: everything you read and every control
      // that changes the routine on the left, and one big affordance for
      // "run it now" on the right. The run button is the only thing that
      // acts on the world, so it is the only thing set apart.
      const main = document.createElement("div");
      main.className = "routine-card-main";
      const left = document.createElement("div");
      left.className = "routine-card-left";
      left.appendChild(body);
      main.appendChild(left);

      const actions = document.createElement("div");
      actions.className = "routine-card-actions";

      const toggleLabel = document.createElement("label");
      toggleLabel.className = "routine-active-toggle";
      toggleLabel.title = "Disable to stop this routine from triggering, without deleting it";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = routine.enabled;
      toggle.addEventListener("change", async () => {
        const updated = settings.routines.map((r) =>
          r.id === routine.id ? { ...r, enabled: toggle.checked } : r
        );
        const saved = await window.nimbus.updateRoutineSettings({ routines: updated });
        renderRoutineList(saved);
      });
      toggleLabel.appendChild(buildSwitch(toggle));
      const toggleText = document.createElement("span");
      toggleText.textContent = "Active";
      toggleLabel.appendChild(toggleText);
      actions.appendChild(toggleLabel);

      // Runs the routine's actions immediately — bypasses trigger match,
      // cooldown, and conditions entirely. Distinct from the Test button
      // beside it, which only evaluates and explains: asking whether a
      // routine matches must never start playing music or open anything.
      const runBtn = document.createElement("button");
      runBtn.className = "routine-run-btn";
      runBtn.title = "Run now";
      runBtn.innerHTML = ROUTINE_RUN_ICON_SVG;
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        runBtn.innerHTML = ROUTINE_RUNNING_ICON_SVG;
        try {
          const results = await window.nimbus.runRoutineNow(routine.id);
          const failed = results.filter((r) => r.status === "failure");
          runBtn.title =
            failed.length === 0
              ? "Ran successfully"
              : `${failed.length} action${failed.length === 1 ? "" : "s"} failed`;
          runBtn.innerHTML =
            failed.length === 0 ? ROUTINE_RUN_SUCCESS_ICON_SVG : ROUTINE_RUN_FAILURE_ICON_SVG;
          window.dispatchEvent(new Event(NOW_PLAYING_REFRESH_EVENT));
        } catch {
          runBtn.title = "Failed to run";
          runBtn.innerHTML = ROUTINE_RUN_FAILURE_ICON_SVG;
        } finally {
          setTimeout(() => {
            runBtn.title = "Run now";
            runBtn.innerHTML = ROUTINE_RUN_ICON_SVG;
            runBtn.disabled = false;
          }, 2000);
        }
      });
      // Evaluates the routine against the current state and shows every
      // check behind the verdict. Runs nothing — see the run button
      // above for the deliberate counterpart.
      const explainEl = document.createElement("div");
      explainEl.className = "routine-explain";
      explainEl.hidden = true;

      const testBtn = document.createElement("button");
      testBtn.className = "btn btn-ghost";
      testBtn.textContent = "Test";
      testBtn.title = "Check whether this routine would match right now — runs nothing";
      testBtn.addEventListener("click", async () => {
        if (!explainEl.hidden) {
          explainEl.hidden = true;
          return;
        }
        testBtn.disabled = true;
        try {
          const evaluation = await window.nimbus.testRoutine(routine.id);
          renderRoutineExplanation(explainEl, evaluation);
        } catch (err) {
          explainEl.textContent = `Could not evaluate this routine: ${String(err)}`;
        } finally {
          explainEl.hidden = false;
          testBtn.disabled = false;
        }
      });
      actions.appendChild(testBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-ghost routine-delete-btn";
      removeBtn.textContent = "Delete";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.routines.filter((r) => r.id !== routine.id);
        const saved = await window.nimbus.updateRoutineSettings({ routines: updated });
        if (editingRoutineId === routine.id) resetForm(); // the routine being edited no longer exists — don't leave a stale edit form open
        renderRoutineList(saved);
      });
      actions.appendChild(removeBtn);

      left.appendChild(actions);
      main.appendChild(runBtn);
      card.appendChild(main);
      // Full width under the split, since an explanation is a paragraph
      // rather than something that belongs in either column.
      card.appendChild(explainEl);
      routineListEl.appendChild(card);
    }
  }

  try {
    const [settings, actions, lastTriggered] = await Promise.all([
      window.nimbus.getRoutineSettings(),
      window.nimbus.listActions(),
      window.nimbus.getRoutineLastTriggered(),
    ]);
    lastTriggeredAt = lastTriggered;
    availableActions = actions;
    populateActionServiceSelect();
    populateActionSelectForService(actionServiceSelect.value);

    enabledCheckbox.checked = settings.enabled;
    renderRoutineList(settings);
    syncTriggerFieldsVisibility();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  } catch (err) {
    console.error("Failed to load routine settings/actions", err);
  }

  window.nimbus
    .listSpotifyPlaylists()
    .then((playlists) => {
      availablePlaylists = playlists;
    })
    .catch(() => {}); // playlist picker is a nice-to-have; a manual query still works without it

  enabledCheckbox.addEventListener("change", async () => {
    const saved = await window.nimbus.updateRoutineSettings({ enabled: enabledCheckbox.checked });
    disabledWarningEl.hidden = saved.enabled || saved.routines.length === 0;
  });

  triggerTypeSelect.addEventListener("change", syncTriggerFieldsVisibility);

  actionServiceSelect.addEventListener("change", () => {
    populateActionSelectForService(actionServiceSelect.value);
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  });

  actionSelect.addEventListener("change", () => {
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  });

  addStopActionBtn.addEventListener("click", () => openActionBuilder("stop"));

  addActionBtn.addEventListener("click", () => openActionBuilder("start"));

  /**
   * Commits whatever the builder is showing into the list it was opened
   * for. Required parameters are checked here, once, for both lists.
   */
  confirmActionBtn.addEventListener("click", () => {
    const def = availableActions.find((a) => a.id === actionSelect.value);
    if (!def || !builderTarget) return;

    const params = collectActionParams(def);
    const missing = def.parameters.filter((prm) => prm.required && params[prm.name] === undefined);
    if (missing.length > 0) {
      const fields = missing
        .map((prm) => document.getElementById(paramFieldId(prm.name)))
        .filter((el): el is HTMLElement => el !== null);
      showFormError(`This action still needs: ${missing.map((prm) => prm.name).join(", ")}.`, fields);
      return;
    }
    clearFormError();

    if (builderTarget === "stop") {
      pendingStopActions.push({ actionId: def.id, params });
      renderStopActions();
    } else if (editingActionIndex !== null) {
      pendingActions[editingActionIndex] = { actionId: def.id, params };
      renderPendingActions();
    } else {
      pendingActions.push({ actionId: def.id, params });
      renderPendingActions();
    }
    closeActionBuilder();
  });

  cancelActionEditBtn.addEventListener("click", () => stopEditingAction());

  // Fixing a field should visibly un-break it, not leave a red border
  // and a stale message sitting there until the next save attempt.
  for (const field of [nameInput, suggestionTitleInput, suggestionMessageInput]) {
    field.addEventListener("input", () => field.classList.remove("field-invalid"));
  }
  document.getElementById("routinesEditView")?.addEventListener("input", (event) => {
    (event.target as HTMLElement)?.classList?.remove("field-invalid");
  });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    // The routine being edited (if any) is looked up before building the
    // trigger so its saved match mode survives the edit — see
    // buildTriggerFromForm.
    const editingTrigger = editingRoutineId ? (editedRoutineTrigger ?? undefined) : undefined;
    const trigger = buildTriggerFromForm(editingTrigger);
    const title = suggestionTitleInput.value.trim();
    const message = suggestionMessageInput.value.trim();
    const cooldownMinutes = Number(cooldownInput.value) || 0;

    // Each missing thing is named, and its field highlighted, so fixing
    // it doesn't mean re-reading the whole form to work out which one.
    const missing: string[] = [];
    const invalid: HTMLElement[] = [];
    if (!name) {
      missing.push("a name");
      invalid.push(nameInput);
    }
    if (!trigger) {
      missing.push("something for the trigger to match");
      const field = triggerValueInput();
      if (field) invalid.push(field);
    }
    if (!title) {
      missing.push("a suggestion title");
      invalid.push(suggestionTitleInput);
    }
    if (!message) {
      missing.push("a suggestion message");
      invalid.push(suggestionMessageInput);
    }
    if (pendingActions.length === 0) missing.push("at least one action");

    if (missing.length > 0) {
      showFormError(`This routine still needs ${missing.join(", ")}.`, invalid);
      return;
    }
    // Already covered by the check above; restated so the compiler can
    // see it too.
    if (!trigger) return;
    clearFormError();

    try {
      const current = await window.nimbus.getRoutineSettings();

      let updatedRoutines: Routine[];
      if (editingRoutineId) {
        const existing = current.routines.find((r) => r.id === editingRoutineId);
        if (!existing) {
          showFormError("This routine no longer exists — it may have been deleted.");
          resetForm();
          showListView();
          renderRoutineList(current);
          return;
        }
        // Spread `existing` first so any field this editor doesn't know
        // about survives a round-trip rather than being dropped.
        const updated: Routine = {
          ...existing,
          name,
          enabled: routineEnabledCheckbox.checked,
          trigger,
          suggestion: { ...existing.suggestion, title, message },
          actions: pendingActions,
          cooldownMinutes,
          conditions: buildConditionsFromForm(),
          stopActions: pendingStopActions.length > 0 ? pendingStopActions : undefined,
          stopTrigger: stopTriggerToSave(),
          stopConditions: pendingStopConditions.length > 0 ? pendingStopConditions : undefined,
          stopConditionLogic: stopConditionLogicSelect.value === "any" ? "any" : "all",
          stopAutoRun: stopAutoRunCheckbox.checked,
          conditionLogic: conditionLogicSelect.value === "any" ? "any" : "all",
          sessionRestriction: oncePerSessionCheckbox.checked ? "oncePerSession" : "none",
          description: descriptionInput.value.trim() || undefined,
          autoRun: autoRunCheckbox.checked,
        };
        updatedRoutines = current.routines.map((r) => (r.id === editingRoutineId ? updated : r));
      } else {
        const newRoutine: Routine = {
          id: `routine-${Date.now()}`,
          name,
          enabled: routineEnabledCheckbox.checked,
          trigger,
          conditions: buildConditionsFromForm(),
          stopActions: pendingStopActions.length > 0 ? pendingStopActions : undefined,
          stopTrigger: stopTriggerToSave(),
          stopConditions: pendingStopConditions.length > 0 ? pendingStopConditions : undefined,
          stopConditionLogic: stopConditionLogicSelect.value === "any" ? "any" : "all",
          stopAutoRun: stopAutoRunCheckbox.checked,
          conditionLogic: conditionLogicSelect.value === "any" ? "any" : "all",
          sessionRestriction: oncePerSessionCheckbox.checked ? "oncePerSession" : "none",
          description: descriptionInput.value.trim() || undefined,
          suggestion: { title, message, primaryLabel: "Yes", secondaryLabel: "Not now" },
          actions: pendingActions,
          cooldownMinutes,
          autoRun: autoRunCheckbox.checked,
        };
        updatedRoutines = [...current.routines, newRoutine];
      }

      // A routine a user just created is obviously meant to actually run
      // — but it only can if the master "Enable context-aware
      // suggestions" switch above is also on (that's what starts the
      // desktop activity monitor in the first place). Saving a routine
      // without it produces a routine that Test can run but that can
      // never fire from a real trigger, with nothing in the UI
      // explaining why — auto-enabling here closes that trap. Editing an
      // existing routine leaves the switch as the user already set it.
      const saved = await window.nimbus.updateRoutineSettings(
        editingRoutineId ? { routines: updatedRoutines } : { enabled: true, routines: updatedRoutines }
      );
      enabledCheckbox.checked = saved.enabled;
      renderRoutineList(saved);
      resetForm();
      showListView();
    } catch (err) {
      // Validation from the main process (an unknown action id, a
      // malformed condition) lands here — shown in the same place as the
      // client-side checks rather than in a dialog.
      showFormError(`Couldn't save this routine: ${String(err)}`);
    }
  });

  cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });
  backToListBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });
  newRoutineBtn.addEventListener("click", () => {
    void refreshKnownActivities().then(() => {
      fillActivityOptions(activityEndedSelect, "", "Any activity");
      fillActivityOptions(stopActivitySelect, "", "Any activity");
      renderPendingConditions();
      renderStopConditions();
    });
    resetForm();
    showEditView();
  });

  async function refreshActivitySnapshot(): Promise<void> {
    activitySnapshotContentEl.textContent = "Loading…";
    try {
      const snapshot = await window.nimbus.getActivitySnapshot();
      renderActivitySnapshot(snapshot);
    } catch (err) {
      activitySnapshotContentEl.textContent = "Couldn't read current activity.";
      console.error("Failed to load activity snapshot", err);
    }
  }

  function renderActivitySnapshot(snapshot: RawActivitySnapshot | null): void {
    activitySnapshotContentEl.innerHTML = "";
    if (!snapshot) {
      activitySnapshotContentEl.textContent =
        'Turn on "Enable context-aware suggestions" above first — this only has anything to show while that\'s on.';
      return;
    }

    const addSection = (label: string, items: string[]): void => {
      const section = document.createElement("div");
      const heading = document.createElement("div");
      heading.className = "setting-title";
      heading.textContent = label;
      section.appendChild(heading);
      if (items.length === 0) {
        const none = document.createElement("div");
        none.className = "activity-debug-empty";
        none.textContent = "None right now.";
        section.appendChild(none);
      } else {
        for (const item of items) {
          const line = document.createElement("div");
          line.className = "activity-debug-line";
          line.textContent = item;
          section.appendChild(line);
        }
      }
      activitySnapshotContentEl.appendChild(section);
    };

    addSection(
      "Browser tab titles (what a website trigger matches against)",
      snapshot.browserWindows.map((w) => w.title)
    );
    addSection("Running applications (what an app trigger matches against)", snapshot.processNames);
    addSection("Open Explorer folders (what a folder trigger matches against)", snapshot.explorerFolders);
  }

  refreshActivitySnapshotBtn.addEventListener("click", refreshActivitySnapshot);
  activityDebugDetails.addEventListener("toggle", () => {
    if (activityDebugDetails.open) refreshActivitySnapshot();
  });
}

const TASK_REFRESH_EVENT = "nimbus:refresh-tasks";
const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * The Tasks tab — list/grid view, sorting, and create/edit/complete/
 * delete, all writing straight through to Todoist (see
 * src/context/providers/tasks/todoistTaskSource.ts's write methods).
 * Mirrors initRoutinesSettings()'s own list-view/edit-view pattern
 * (same show/hide toggle, same one-form-for-create-and-edit reuse) —
 * deliberately not sharing code with it beyond that shape, since a task
 * and a routine are unrelated concepts that just happen to want a
 * similar management UI.
 */
function initTaskManagement(): void {
  const listViewEl = document.getElementById("tasksListView") as HTMLElement;
  const editViewEl = document.getElementById("tasksEditView") as HTMLElement;
  const taskListEl = document.getElementById("taskList") as HTMLElement;
  const taskListEmptyEl = document.getElementById("taskListEmpty") as HTMLElement;
  const disabledWarningEl = document.getElementById("tasksDisabledWarning") as HTMLElement;
  const viewListBtn = document.getElementById("tasksViewListBtn") as HTMLButtonElement;
  const viewGridBtn = document.getElementById("tasksViewGridBtn") as HTMLButtonElement;
  const sortSelect = document.getElementById("taskSortSelect") as HTMLSelectElement;
  const newTaskBtn = document.getElementById("newTaskBtn") as HTMLButtonElement;
  const backToListBtn = document.getElementById("backToTaskListBtn") as HTMLButtonElement;

  const formHeadingEl = document.getElementById("taskFormHeading") as HTMLElement;
  const titleInput = document.getElementById("taskTitleInput") as HTMLInputElement;
  const descriptionInput = document.getElementById("taskDescriptionInput") as HTMLInputElement;
  const dueDateInput = document.getElementById("taskDueDateInput") as HTMLInputElement;
  const prioritySelect = document.getElementById("taskPrioritySelect") as HTMLSelectElement;
  const projectSelect = document.getElementById("taskProjectSelect") as HTMLSelectElement;
  const saveBtn = document.getElementById("saveTaskBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelTaskEditBtn") as HTMLButtonElement;

  let currentTasks: TaskItem[] = [];
  let editingTaskId: string | null = null;
  let projectsLoaded = false;

  function showListView(): void {
    listViewEl.hidden = false;
    editViewEl.hidden = true;
  }
  function showEditView(): void {
    listViewEl.hidden = true;
    editViewEl.hidden = false;
  }

  const CARD_LAYOUT_STORAGE_KEY = "nimbus:tasks-card-layout";
  function applyCardLayout(layout: "list" | "grid"): void {
    taskListEl.classList.toggle("grid-view", layout === "grid");
    viewListBtn.classList.toggle("active", layout === "list");
    viewGridBtn.classList.toggle("active", layout === "grid");
    try {
      localStorage.setItem(CARD_LAYOUT_STORAGE_KEY, layout);
    } catch {
      // per-viewer convenience only
    }
  }
  viewListBtn.addEventListener("click", () => applyCardLayout("list"));
  viewGridBtn.addEventListener("click", () => applyCardLayout("grid"));
  let savedLayout: string | null = null;
  try {
    savedLayout = localStorage.getItem(CARD_LAYOUT_STORAGE_KEY);
  } catch {
    // defaults to list below
  }
  applyCardLayout(savedLayout === "grid" ? "grid" : "list");

  const SORT_STORAGE_KEY = "nimbus:tasks-sort";
  try {
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (savedSort) sortSelect.value = savedSort;
  } catch {
    // defaults to the select's own first option
  }

  function sortTasks(tasks: TaskItem[]): TaskItem[] {
    const sorted = [...tasks];
    const priorityRank: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };
    switch (sortSelect.value) {
      case "priority":
        sorted.sort(
          (a, b) =>
            priorityRank[a.priority] - priorityRank[b.priority] ||
            (a.dueAt ?? "").localeCompare(b.dueAt ?? "")
        );
        break;
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "created":
        sorted.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        break;
      default: // due date — tasks with no due date sort last, alphabetically among themselves
        sorted.sort((a, b) => {
          if (!a.dueAt && !b.dueAt) return a.title.localeCompare(b.title);
          if (!a.dueAt) return 1;
          if (!b.dueAt) return -1;
          return a.dueAt.localeCompare(b.dueAt);
        });
    }
    return sorted;
  }

  async function ensureProjectsLoaded(): Promise<void> {
    if (projectsLoaded) return;
    try {
      const projects = await window.nimbus.listTaskProjects();
      projectSelect.innerHTML = '<option value="">(default)</option>';
      for (const p of projects) {
        const option = document.createElement("option");
        option.value = p.id;
        option.textContent = p.name;
        projectSelect.appendChild(option);
      }
      projectsLoaded = true;
    } catch (err) {
      console.error("Failed to load task lists", err);
    }
  }

  const taskListErrorEl = document.getElementById("taskListError") as HTMLElement;
  const taskFormErrorEl = document.getElementById("taskFormError") as HTMLElement;

  /**
   * Shows a problem inline. Not alert()/confirm(): a native dialog in
   * Electron takes keyboard focus away from the page, and more than once
   * left a form that could no longer be typed into.
   */
  function showTaskError(target: HTMLElement, message: string): void {
    target.textContent = message;
    target.hidden = false;
  }

  function renderTaskCard(task: TaskItem): HTMLElement {
    const card = document.createElement("div");
    card.className = task.category === "overdue" ? "task-card task-card-overdue" : "task-card";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-card-checkbox";
    checkbox.title = "Mark complete";
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await window.nimbus.completeTask(task.id);
        await loadAndRenderTasks();
      } catch (err) {
        showTaskError(taskListErrorEl, `Couldn't complete "${task.title}": ${String(err)}`);
        checkbox.checked = false;
        checkbox.disabled = false;
      }
    });
    card.appendChild(checkbox);

    const body = document.createElement("div");
    body.className = "task-card-body";

    const titleEl = document.createElement("div");
    titleEl.className = "task-card-title";
    titleEl.textContent = task.title;
    body.appendChild(titleEl);

    if (task.description) {
      const descEl = document.createElement("div");
      descEl.className = "task-card-description";
      descEl.textContent = task.description;
      body.appendChild(descEl);
    }

    const meta = document.createElement("div");
    meta.className = "task-card-meta";
    const due = formatTaskDue(task);
    if (due) {
      const dueEl = document.createElement("span");
      if (due.overdue) dueEl.className = "task-due-overdue";
      dueEl.textContent = due.text;
      meta.appendChild(dueEl);
    }
    if (task.priority !== "none") {
      const badge = document.createElement("span");
      badge.className = `task-priority-badge task-priority-${task.priority}`;
      badge.textContent = TASK_PRIORITY_LABELS[task.priority];
      meta.appendChild(badge);
    }
    if (task.listName) {
      const listEl = document.createElement("span");
      listEl.textContent = task.listName;
      meta.appendChild(listEl);
    }
    if (meta.children.length > 0) body.appendChild(meta);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "task-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => populateFormForEdit(task));
    actions.appendChild(editBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "calendar-feed-remove";
    removeBtn.textContent = "Delete";
    // Two clicks instead of a confirm() dialog: the first arms it, the
    // second deletes, and it disarms itself if the second never comes.
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    removeBtn.addEventListener("click", async () => {
      if (!armTimer) {
        removeBtn.textContent = "Click again to delete";
        armTimer = setTimeout(() => {
          armTimer = null;
          removeBtn.textContent = "Delete";
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      armTimer = null;
      removeBtn.disabled = true;
      try {
        await window.nimbus.deleteTask(task.id);
        if (editingTaskId === task.id) {
          resetForm();
          showListView();
        }
        await loadAndRenderTasks();
      } catch (err) {
        showTaskError(taskListErrorEl, `Couldn't delete "${task.title}": ${String(err)}`);
        removeBtn.textContent = "Delete";
        removeBtn.disabled = false;
      }
    });
    actions.appendChild(removeBtn);

    card.appendChild(actions);
    return card;
  }

  function renderList(): void {
    const sorted = sortTasks(currentTasks);
    taskListEl.innerHTML = "";
    taskListEmptyEl.hidden = sorted.length > 0;
    for (const task of sorted) {
      taskListEl.appendChild(renderTaskCard(task));
    }
  }

  async function loadAndRenderTasks(): Promise<void> {
    try {
      const { tasks } = await window.nimbus.listTasks();
      currentTasks = tasks;
      taskListErrorEl.hidden = true;
      taskListEmptyEl.textContent =
        'No active tasks. Click "+ New task" to add one — or enjoy being caught up.';
      renderList();
    } catch (err) {
      console.error("Failed to load tasks", err);
      currentTasks = [];
      taskListEl.innerHTML = "";
      taskListEmptyEl.hidden = false;
      taskListEmptyEl.textContent = "Couldn't load tasks — check your Todoist connection in Settings.";
    }
  }

  async function refreshEnabledState(): Promise<void> {
    try {
      const settings = await window.nimbus.getTaskSettings();
      disabledWarningEl.hidden = settings.enabled && settings.accounts.some((a) => a.enabled);
    } catch {
      disabledWarningEl.hidden = true;
    }
  }

  function resetForm(): void {
    editingTaskId = null;
    taskFormErrorEl.hidden = true;
    formHeadingEl.textContent = "New task";
    saveBtn.textContent = "Save task";
    cancelEditBtn.hidden = true;
    titleInput.value = "";
    descriptionInput.value = "";
    dueDateInput.value = "";
    prioritySelect.value = "none";
    projectSelect.value = "";
  }

  async function populateFormForEdit(task: TaskItem): Promise<void> {
    showEditView();
    editingTaskId = task.id;
    formHeadingEl.textContent = `Editing "${task.title}"`;
    saveBtn.textContent = "Update task";
    cancelEditBtn.hidden = false;

    titleInput.value = task.title;
    descriptionInput.value = task.description ?? "";
    dueDateInput.value = task.dueAt ? task.dueAt.slice(0, 10) : "";
    prioritySelect.value = task.priority;

    await ensureProjectsLoaded();
    // TaskItem only carries the project's resolved *name*, not its id
    // (see todoistTaskSource.ts) — matching by name against the loaded
    // project list is the best this form can do without a shape change
    // there; project names are effectively unique per Todoist account in
    // practice.
    projectSelect.value = "";
    if (task.listName) {
      const match = Array.from(projectSelect.options).find((o) => o.textContent === task.listName);
      if (match) projectSelect.value = match.value;
    }
  }

  sortSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sortSelect.value);
    } catch {
      // per-viewer convenience only
    }
    renderList();
  });

  newTaskBtn.addEventListener("click", async () => {
    resetForm();
    showEditView();
    await ensureProjectsLoaded();
  });

  backToListBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });

  cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });

  saveBtn.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    if (!title) {
      showTaskError(taskFormErrorEl, "A task needs a title.");
      titleInput.focus();
      return;
    }
    taskFormErrorEl.hidden = true;

    const request: TaskWriteRequest = {
      title,
      description: descriptionInput.value.trim() || null,
      dueDate: dueDateInput.value || null,
      priority: prioritySelect.value as TaskPriority,
      projectId: projectSelect.value || null,
    };

    saveBtn.disabled = true;
    try {
      if (editingTaskId) {
        await window.nimbus.updateTask(editingTaskId, request);
      } else {
        await window.nimbus.createTask(request);
      }
      resetForm();
      showListView();
      await loadAndRenderTasks();
    } catch (err) {
      showTaskError(taskFormErrorEl, `Couldn't save the task: ${String(err)}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  window.addEventListener(TASK_REFRESH_EVENT, () => loadAndRenderTasks());

  refreshEnabledState();
  loadAndRenderTasks();
}

function initMinimizeButton(): void {
  document.getElementById("minimizeBtn")?.addEventListener("click", () => {
    window.nimbus.hideWindow();
  });
}

function switchToTab(tabName: string): void {
  document.querySelector<HTMLButtonElement>(`.side-link[data-tab="${tabName}"]`)?.click();
}

/** Handles the small set of action ids a briefing item can currently carry. */
function handleBriefingAction(actionId: string): void {
  if (actionId === "view-context") {
    switchToTab("context");
  } else if (actionId === "view-calendar") {
    switchToTab("calendar");
  } else if (actionId === "view-stocks") {
    switchToTab("stocks");
  }
}

const CATEGORY_LABELS: Record<BriefingCategory, string> = {
  greeting: "Greeting",
  dateTime: "Datetime",
  weather: "Weather",
  calendar: "Calendar",
  email: "Email",
  tasks: "Tasks",
  stocks: "Stocks",
  meals: "Meals",
  other: "Other",
};

/** Icon per briefing category — falls back to a plain ring for anything not covered. */
const CATEGORY_ICONS: Partial<Record<BriefingCategory, string>> = {
  weather:
    '<path d="M160,40a88.09,88.09,0,0,0-85.61,66.64A64,64,0,0,0,64,232H192a72,72,0,0,0,0-144h-1.13A88.15,88.15,0,0,0,160,40Zm32,176H64a48,48,0,0,1,0-96c1.1,0,2.2,0,3.31.14A88,88,0,0,0,64,152a8,8,0,0,0,16,0,72.11,72.11,0,0,1,72-72,72,72,0,0,1,0,144Z"/>',
  dateTime:
    '<path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,176H48V96H208V208ZM48,80V48H72v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80Z"/>',
  calendar:
    '<path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,176H48V96H208V208ZM48,80V48H72v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80Z"/>',
  email:
    '<path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/>',
  tasks:
    '<path d="M226.83,74.83l-96,96a28,28,0,0,1-39.6,0l-40-40a4,4,0,0,1,0-5.66l17.17-17.17a4,4,0,0,1,5.66,0L104,137.94l86.83-86.83a4,4,0,0,1,5.66,0l17.17,17.17A4,4,0,0,1,226.83,74.83ZM216,128a8,8,0,0,0-8,8v72H48V80h96a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V136A8,8,0,0,0,216,128Z"/>',
};
const DEFAULT_ICON =
  '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"/>';

function categoryIconSvg(category: BriefingCategory): string {
  const path = CATEGORY_ICONS[category] ?? DEFAULT_ICON;
  return `<svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor">${path}</svg>`;
}

function renderBriefing(briefing: Briefing | null): void {
  const container = document.getElementById("briefing")!;
  container.innerHTML = "";

  if (!briefing || briefing.items.length === 0) {
    const status = document.createElement("p");
    status.className = "briefing-status";
    status.textContent = "Preparing your briefing…";
    container.appendChild(status);
    return;
  }

  const [greeting, ...rest] = briefing.items;

  const hero = document.createElement("div");
  hero.className = "hero-card";
  const heroKicker = document.createElement("div");
  heroKicker.className = "card-kicker";
  heroKicker.textContent = CATEGORY_LABELS[greeting.category] ?? "Greeting";
  const heroMessage = document.createElement("h2");
  heroMessage.className = "hero-message";
  heroMessage.textContent = greeting.message;
  hero.appendChild(heroKicker);
  hero.appendChild(heroMessage);
  container.appendChild(hero);

  if (rest.length === 0) return;

  const grid = document.createElement("div");
  grid.className = "tile-grid";

  for (const item of rest) {
    const tile = document.createElement("div");
    tile.className = "tile";

    const icon = document.createElement("div");
    icon.className = "tile-icon";
    icon.innerHTML = categoryIconSvg(item.category);
    tile.appendChild(icon);

    const kicker = document.createElement("div");
    kicker.className = "card-kicker";
    kicker.textContent = CATEGORY_LABELS[item.category] ?? item.category;
    tile.appendChild(kicker);

    const body = document.createElement("p");
    body.className = "card-body";
    body.textContent = item.message;
    tile.appendChild(body);

    if (item.action) {
      const actionBtn = document.createElement("button");
      actionBtn.className = "btn btn-ghost";
      actionBtn.textContent = item.action.label;
      actionBtn.addEventListener("click", () => handleBriefingAction(item.action!.actionId));
      tile.appendChild(actionBtn);
    }

    grid.appendChild(tile);
  }

  container.appendChild(grid);
}

async function loadBriefing(): Promise<void> {
  try {
    const briefing = await window.nimbus.getBriefing();
    renderBriefing(briefing);
  } catch (err) {
    console.error("Failed to load briefing", err);
  }
}

function initBriefing(): void {
  loadBriefing();

  // The startup briefing is generated asynchronously in the main process
  // and may not be ready the instant this window loads — this just
  // re-pulls the (already-generated) result when it becomes available.
  // It does not itself generate anything.
  window.nimbus.onBriefingUpdated(loadBriefing);

  document.getElementById("regenerateBriefingBtn")?.addEventListener("click", async () => {
    const container = document.getElementById("briefing")!;
    container.innerHTML = '<p class="briefing-status">Regenerating…</p>';
    const briefing = await window.nimbus.regenerateBriefing();
    renderBriefing(briefing);
  });
}

/**
 * Renders any context value generically — providers can contribute
 * arbitrarily-shaped data (nested objects, arrays) and this still shows
 * something reasonable without the UI needing per-provider rendering code.
 */
function renderContextSnapshot(snapshot: ContextSnapshot): void {
  document.getElementById("contextGeneratedAt")!.textContent =
    `Last updated: ${new Date(snapshot.generatedAt).toLocaleString()}`;

  const container = document.getElementById("contextProviders")!;
  container.innerHTML = "";
  const open = readOpenContextCards();

  for (const result of Object.values(snapshot.providers)) {
    // A fold-away box per provider: the header (name and status) is always
    // visible; how it works and its raw data are inside.
    const card = document.createElement("details");
    card.className = "context-card";
    card.open = open.has(result.providerId);
    card.addEventListener("toggle", () => rememberContextCard(result.providerId, card.open));

    const header = document.createElement("summary");
    header.className = "context-card-header";

    const title = document.createElement("span");
    title.className = "context-card-title";
    title.textContent = result.displayName;
    header.appendChild(title);

    const badges = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = `context-badge ${result.status}`;
    badge.textContent = result.status;
    badges.appendChild(badge);
    if (result.stale) {
      const staleBadge = document.createElement("span");
      staleBadge.className = "context-badge stale";
      staleBadge.textContent = "stale";
      badges.appendChild(staleBadge);
    }
    header.appendChild(badges);
    card.appendChild(header);

    const explanation = CONTEXT_EXPLANATIONS[result.providerId];
    if (explanation) {
      const explainer = document.createElement("p");
      explainer.className = "context-explainer";
      explainer.textContent = explanation;
      card.appendChild(explainer);
    }

    if (result.error) {
      const errorEl = document.createElement("p");
      errorEl.className = "context-error";
      errorEl.textContent = result.error;
      card.appendChild(errorEl);
    }

    if (result.data) {
      const dl = document.createElement("dl");
      dl.className = "context-fields";
      for (const [key, value] of Object.entries(result.data)) {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = formatContextValue(value);
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    container.appendChild(card);
  }
}

/** How each Context provider works, in plain words — shown inside its box. */
const CONTEXT_EXPLANATIONS: Record<string, string> = {
  network:
    "Devices on your local network, from Windows' own list of nearby devices (read every 2 minutes; nothing is sent) and the Network tab's scan (one ping to each local address, at most once a minute). Devices are told apart by hardware (MAC) address, not IP. \"Recognized\" is NIMBUS's own label, not a security check. A device never seen before is published as an event.",
  dateTime:
    "Reads the date, time and time zone from this PC's own clock. Nothing is fetched or cached, so it is always current. The briefing uses it for the greeting and the date line.",
  system:
    "Reads basic facts about this PC from the operating system. Local only — nothing leaves the machine.",
  weather:
    "Current conditions and the coming days' forecast from Open-Meteo (free, no account), for the location you set in Settings or one estimated from your internet connection. Fetched at most every 10 minutes. Feeds the briefing and Attention's \"rain likely\" notice.",
  calendar:
    "Today's and upcoming events from the calendar feeds (.ics links or files) you added in Settings. Refreshed every 15 minutes, or every 2 when an event is close. Recurring events appear once, at their first occurrence. Feeds the Calendar tab, the briefing and Attention's \"meeting soon\" alerts.",
  email:
    'Recent messages from your email accounts over IMAP, strictly read-only — NIMBUS never sends, moves, deletes or marks anything. Each message gets an importance from simple signals: unread, flagged, automated senders, keywords. Refreshed every 5 minutes. Feeds the briefing and Attention\'s "important email" notices.',
  tasks:
    "Your active Todoist tasks, sorted into overdue, due today, upcoming and no deadline, each with an urgency worked out from its due time, priority and reminder. Refreshed every 5 minutes, or every minute when something is due soon. Feeds the Tasks tab, the briefing and Attention.",
  spotify:
    "What is playing on your Spotify account, read through Spotify's Web API once you connect it. Refreshed at most every 20 seconds. Used by the Home now-playing card and by routine conditions such as \"Spotify isn't already playing\".",
  stocks:
    "Prices for the positions in your Stocks tab from Yahoo Finance's public data (no account), turned into estimates of value and gain, with totals converted to your base currency. Quotes are reused for 2 minutes. Read-only — no trading. Feeds the Stocks tab, the briefing and Attention's \"big move\" notice.",
};

/** Which Context boxes are open is a per-device convenience, so it lives in localStorage. */
const OPEN_CONTEXT_CARDS_KEY = "nimbus.context.openCards";

function readOpenContextCards(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_CONTEXT_CARDS_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberContextCard(id: string, open: boolean): void {
  try {
    const cards = readOpenContextCards();
    if (open) cards.add(id);
    else cards.delete(id);
    localStorage.setItem(OPEN_CONTEXT_CARDS_KEY, JSON.stringify([...cards]));
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

interface AttentionItemView {
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

interface AttentionDebugView {
  enabled: boolean;
  popups: boolean;
  evaluatedAt: string | null;
  busy: boolean;
  busyReason: string | null;
  items: AttentionItemView[];
}

const ATTENTION_DECISIONS: Record<string, string> = {
  surface: "Shown now",
  shown: "Already shown",
  held: "Waiting",
  quiet: "Quiet",
  acknowledged: "Acknowledged",
  dismissed: "Dismissed",
};

/** The Attention debug view: what NIMBUS thinks deserves attention, and why. */
function renderAttention(state: AttentionDebugView): void {
  (document.getElementById("attentionEnabled") as HTMLInputElement).checked = state.enabled;
  (document.getElementById("attentionPopups") as HTMLInputElement).checked = state.popups;
  document.getElementById("attentionBadge")!.textContent = !state.enabled
    ? "off"
    : `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  const summary = document.getElementById("attentionSummary")!;
  summary.textContent = !state.enabled
    ? "Attention is off — routine suggestions pop up as they come, and nothing else is raised."
    : state.evaluatedAt
      ? `Last looked at ${new Date(state.evaluatedAt).toLocaleTimeString()}${state.busy ? ` · ${state.busyReason}` : ""}.`
      : "Not evaluated yet.";

  const list = document.getElementById("attentionItems")!;
  list.innerHTML = "";
  if (state.enabled && state.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "feed-empty";
    empty.textContent = "Nothing needs your attention right now.";
    list.appendChild(empty);
  }
  for (const item of state.items) {
    const card = document.createElement("div");
    card.className = "attention-item";

    const header = document.createElement("div");
    header.className = "attention-item-header";
    const title = document.createElement("span");
    title.className = "attention-title";
    title.textContent = item.title;
    const badge = document.createElement("span");
    badge.className = `context-badge attention-${item.priority}`;
    badge.textContent = `${item.priority} · ${item.score}`;
    const source = document.createElement("span");
    source.className = "attention-source";
    source.textContent = item.source;
    header.append(title, badge, source);
    card.appendChild(header);

    if (item.description) {
      const description = document.createElement("p");
      description.className = "attention-line";
      description.textContent = item.description;
      card.appendChild(description);
    }
    const decision = document.createElement("p");
    decision.className = "attention-line";
    decision.textContent = `${ATTENTION_DECISIONS[item.decision] ?? item.decision} — ${item.decisionReason}`;
    card.appendChild(decision);

    const why = document.createElement("details");
    why.className = "attention-why";
    const whySummary = document.createElement("summary");
    whySummary.textContent = "Why";
    why.appendChild(whySummary);
    const factors = document.createElement("ul");
    for (const reason of item.reasons) {
      const li = document.createElement("li");
      li.textContent = reason;
      factors.appendChild(li);
    }
    for (const factor of item.factors) {
      const li = document.createElement("li");
      li.textContent = `${factor.label}: ${factor.points > 0 ? "+" : ""}${factor.points}`;
      factors.appendChild(li);
    }
    why.appendChild(factors);
    card.appendChild(why);
    list.appendChild(card);
  }
}

async function loadAttention(): Promise<void> {
  try {
    renderAttention(await window.nimbus.getAttention());
  } catch (err) {
    console.error("Failed to load attention", err);
  }
}

async function loadContext(): Promise<void> {
  try {
    const snapshot = await window.nimbus.getContext();
    renderContextSnapshot(snapshot);
  } catch (err) {
    console.error("Failed to load context", err);
  }
}

function initContext(): void {
  loadContext();
  void loadAttention();
  const attentionSection = document.getElementById("attentionSection") as HTMLDetailsElement;
  attentionSection.open = readOpenContextCards().has("attention");
  attentionSection.addEventListener("toggle", () => rememberContextCard("attention", attentionSection.open));
  document.getElementById("refreshContextBtn")?.addEventListener("click", loadContext);
  document.getElementById("refreshContextBtn")?.addEventListener("click", () => void loadAttention());
  for (const [id, key] of [
    ["attentionEnabled", "enabled"],
    ["attentionPopups", "popups"],
  ] as const) {
    document.getElementById(id)?.addEventListener("change", async (event) => {
      await window.nimbus.updateAttentionSettings({ [key]: (event.target as HTMLInputElement).checked });
      await loadAttention();
    });
  }
}

function renderEventList(
  container: HTMLElement,
  events: CalendarEvent[],
  timezone: string,
  showDate: boolean
): void {
  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "calendar-empty";
    empty.textContent = "Nothing here.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "calendar-event-list";

  for (const event of events) {
    const row = document.createElement("div");
    row.className = "calendar-event-row";

    const time = document.createElement("span");
    time.className = "calendar-event-time";
    time.textContent = event.isAllDay
      ? "All day"
      : showDate
        ? `${formatEventDateLabel(event.startsAt, timezone)}`
        : formatEventTime(event.startsAt, timezone);
    row.appendChild(time);

    const body = document.createElement("div");
    body.className = "calendar-event-body";

    const title = document.createElement("span");
    title.className = "calendar-event-title";
    title.textContent = event.title;
    body.appendChild(title);

    const metaParts: string[] = [];
    if (showDate && !event.isAllDay) metaParts.push(formatEventTime(event.startsAt, timezone));
    if (event.location) metaParts.push(event.location);
    if (event.calendarName) metaParts.push(event.calendarName);
    if (metaParts.length > 0) {
      const meta = document.createElement("span");
      meta.className = "calendar-event-meta";
      meta.textContent = metaParts.join(" · ");
      body.appendChild(meta);
    }

    row.appendChild(body);
    list.appendChild(row);
  }

  container.appendChild(list);
}

function renderCalendarTab(result: ContextProviderResult | undefined): void {
  const container = document.getElementById("calendarTabContent")!;
  container.innerHTML = "";

  if (!result || result.status === "unavailable") {
    const empty = document.createElement("p");
    empty.className = "calendar-empty";
    empty.textContent =
      "Calendar isn't connected yet. Add a feed from the Settings tab to see your schedule here.";
    container.appendChild(empty);
    return;
  }

  if (result.status === "error" || !result.data) {
    const empty = document.createElement("p");
    empty.className = "calendar-empty";
    empty.textContent = "Calendar is temporarily unavailable. Check the Context tab for details.";
    container.appendChild(empty);
    return;
  }

  const data = result.data as unknown as CalendarContext;

  const todaySection = document.createElement("div");
  todaySection.className = "calendar-section";
  const todayTitle = document.createElement("h3");
  todayTitle.className = "calendar-section-title";
  todayTitle.textContent = "Today";
  todaySection.appendChild(todayTitle);
  renderEventList(todaySection, data.todayEvents, data.timezone, false);
  container.appendChild(todaySection);

  const laterSection = document.createElement("div");
  laterSection.className = "calendar-section";
  const laterTitle = document.createElement("h3");
  laterTitle.className = "calendar-section-title";
  laterTitle.textContent = "Upcoming";
  laterSection.appendChild(laterTitle);
  renderEventList(laterSection, data.laterEvents, data.timezone, true);
  container.appendChild(laterSection);

  if (result.stale) {
    const staleNote = document.createElement("p");
    staleNote.className = "calendar-empty";
    staleNote.textContent = "Showing the last successfully loaded schedule.";
    container.appendChild(staleNote);
  }
}

async function loadCalendarTab(): Promise<void> {
  try {
    const snapshot = await window.nimbus.getContext();
    renderCalendarTab(snapshot.providers.calendar);
  } catch (err) {
    console.error("Failed to load calendar", err);
  }
}

function initCalendarTab(): void {
  loadCalendarTab();
  document.getElementById("refreshCalendarBtn")?.addEventListener("click", loadCalendarTab);
}

function initAssistantFeed(): void {
  const feed = document.getElementById("feed")!;
  const countTag = document.getElementById("activityCount")!;
  let count = 0;

  window.nimbus.onAssistantEvent((event) => {
    const empty = feed.querySelector(".feed-empty");
    empty?.remove();

    const item = document.createElement("div");
    item.className = "feed-item";
    // The interactive prompt for a suggestion is the NIMBUS-owned popup
    // window (see src/main/suggestionWindow.ts) — this is just a passive
    // record that it happened, same as every other event type here. A
    // "notification" is what an `autoRun` routine's own completion
    // shows up as instead of a suggestion — see Routine.autoRun.
    if (event.type === "suggestion") {
      item.textContent = `Suggested: ${event.title}`;
    } else if (event.type === "notification") {
      item.textContent = `${event.title}: ${event.body}`;
    } else {
      item.textContent = `[${event.source}] ${event.type}`;
    }
    feed.prepend(item);

    count += 1;
    countTag.textContent = `${count} event${count === 1 ? "" : "s"}`;
  });
}

initTabs();
initAppInfo();
initSettings();
initWeatherSettings();
initCalendarSettings();
initEmailSettings();
initTaskSettings();
initSpotifySettings();
initRoutinesSettings();
initTaskManagement();
initMinimizeButton();
initBriefing();
initNowPlayingCard();
initCalendarTab();
initStocksTab();
initNetworkTab();
initMemoryTab();
initContext();
initAssistantFeed();

/**
 * The Home page's "what am I doing right now" card.
 *
 * Reads the Activity service's conclusion and, when relevant, shows the
 * Spotify and Timer state alongside it — by reading their existing
 * surfaces, not by owning any of it. Hidden entirely when there is no
 * recognized activity, so a user who hasn't configured mappings isn't
 * shown an empty frame.
 */
function initCurrentActivity(): void {
  const card = document.getElementById("currentActivityCard") as HTMLElement;
  const iconEl = document.getElementById("currentActivityIcon") as HTMLElement;
  const nameEl = document.getElementById("currentActivityName") as HTMLElement;
  const sourceEl = document.getElementById("currentActivitySource") as HTMLElement;
  const durationEl = document.getElementById("currentActivityDuration") as HTMLElement;
  const contextEl = document.getElementById("currentActivityContext") as HTMLElement;
  const historyCard = document.getElementById("activityHistoryCard") as HTMLElement;
  const historyList = document.getElementById("activityHistoryList") as HTMLElement;

  function formatMinutes(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  function formatClock(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  async function renderContext(): Promise<void> {
    contextEl.innerHTML = "";

    // Spotify and the timer are read from their existing state. If
    // either isn't running or configured, its line simply isn't there.
    const [snapshot, timer] = await Promise.all([
      window.nimbus.getContext().catch(() => null),
      window.nimbus.getTimerState().catch(() => null),
    ]);

    const spotify = snapshot?.providers?.spotify?.data as
      { playbackState?: string; track?: { name?: string; artists?: string[] } } | undefined;
    if (spotify?.playbackState === "playing" && spotify.track?.name) {
      const line = document.createElement("div");
      line.className = "current-activity-context-line";
      const artists = spotify.track.artists?.join(", ");
      line.textContent = `🎵 ${spotify.track.name}${artists ? ` · ${artists}` : ""}`;
      contextEl.appendChild(line);
    }

    // Paused counts as current state: a paused Pomodoro is still the
    // session you are in, and hiding it makes the card look like the
    // timer vanished. Completed and cancelled ones are genuinely over.
    if (timer && (timer.status === "running" || timer.status === "paused")) {
      const line = document.createElement("div");
      line.className = "current-activity-context-line";
      const remaining = `${formatMinutes(timer.remainingMs)} remaining`;
      line.textContent =
        timer.status === "paused"
          ? `⏱ ${timer.title} · ${remaining} · paused`
          : `⏱ ${timer.title} · ${remaining}`;
      contextEl.appendChild(line);
    }
  }

  function renderHistory(sessions: ActivitySession[]): void {
    const ended = sessions.filter((s) => s.state === "ended" && s.endedAt);
    historyCard.hidden = ended.length === 0;
    historyList.innerHTML = "";

    for (const session of ended.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "activity-history-row";

      const when = document.createElement("span");
      when.className = "activity-history-when";
      when.textContent = `${formatClock(session.startedAt)}–${formatClock(session.endedAt!)}`;
      row.appendChild(when);

      const what = document.createElement("span");
      what.className = "activity-history-what";
      what.textContent = `${session.icon ? session.icon + " " : ""}${session.activity}`;
      row.appendChild(what);

      const where = document.createElement("span");
      where.className = "activity-history-where";
      where.textContent = session.sourceValue;
      row.appendChild(where);

      historyList.appendChild(row);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [current, sessions] = await Promise.all([
        window.nimbus.getCurrentActivity(),
        window.nimbus.getActivitySessions(),
      ]);

      card.hidden = current === null;
      if (current) {
        iconEl.textContent = current.icon ?? "";
        iconEl.hidden = !current.icon;
        nameEl.textContent = current.activity;
        sourceEl.textContent = current.sourceValue;
        durationEl.textContent = formatMinutes(current.durationMs);
        await renderContext();
      }

      renderHistory(sessions);
    } catch (err) {
      console.error("Failed to refresh current activity", err);
    }
  }

  void refresh();
  // Ten seconds, not thirty. The activity's own duration changes slowly,
  // but the Spotify and timer lines beside it do not: accepting a
  // routine's suggestion starts a timer moments AFTER the activity
  // began, and a card that only re-read every 30s showed no timer for
  // half a minute afterwards — which reads as "it stopped showing the
  // timer" rather than "not yet".
  setInterval(() => void refresh(), 10_000);
  window.nimbus.onActivityChanged(() => void refresh());
  // Spotify actions already push this; a routine that starts playback
  // and a timer together then updates both lines at once.
  window.nimbus.onNowPlayingChanged(() => void refresh());
}

initCurrentActivity();

/**
 * The Activity mappings editor in Settings — "this app means that
 * activity". Follows the same list-plus-add-row shape the calendar feed
 * and email account editors already use, rather than inventing a
 * different pattern for the same job.
 */
async function initActivitySettings(): Promise<void> {
  const enabled = document.getElementById("activityEnabled") as HTMLInputElement;
  const suggestApps = document.getElementById("activitySuggestApps") as HTMLInputElement;
  const list = document.getElementById("activityMappingList") as HTMLElement;
  const empty = document.getElementById("activityMappingEmpty") as HTMLElement;
  const nameInput = document.getElementById("activityMappingName") as HTMLInputElement;
  const iconInput = document.getElementById("activityMappingIcon") as HTMLInputElement;
  const sourceSelect = document.getElementById("activityMappingSource") as HTMLSelectElement;
  const valueInput = document.getElementById("activityMappingValue") as HTMLInputElement;
  const priorityInput = document.getElementById("activityMappingPriority") as HTMLInputElement;
  const graceInput = document.getElementById("activityGraceMinutes") as HTMLInputElement;
  const addBtn = document.getElementById("addActivityMappingBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelActivityMappingEditBtn") as HTMLButtonElement;
  const errorEl = document.getElementById("activityMappingError") as HTMLElement;

  /** The activity being edited, or null when the form is adding a new one. */
  let editingMappingId: string | null = null;

  function showError(message: string): void {
    // Not alert(): a modal dialog in Electron takes keyboard focus away
    // from the form behind it, and the form is what needs fixing.
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError(): void {
    errorEl.hidden = true;
  }

  function resetForm(): void {
    editingMappingId = null;
    nameInput.value = "";
    iconInput.value = "";
    valueInput.value = "";
    priorityInput.value = "0";
    sourceSelect.value = "application";
    addBtn.textContent = "Add activity";
    cancelEditBtn.hidden = true;
    clearError();
  }

  /**
   * Loads an existing activity back into the same fields that create one.
   * One form for both, rather than a second editing surface to keep in
   * step with the first.
   */
  function startEditing(mapping: ActivityMapping): void {
    editingMappingId = mapping.id;
    nameInput.value = mapping.activity;
    iconInput.value = mapping.icon ?? "";
    sourceSelect.value = mapping.source;
    valueInput.value = mapping.value;
    priorityInput.value = String(mapping.priority);
    addBtn.textContent = "Update activity";
    cancelEditBtn.hidden = false;
    clearError();
    nameInput.focus();
  }

  const SOURCE_LABELS: Record<string, string> = {
    application: "App",
    website: "Site",
    folder: "Folder",
  };

  function render(settings: ActivityPreferences): void {
    enabled.checked = settings.enabled;
    suggestApps.checked = settings.suggestFrequentApps === true;
    graceInput.value = String(settings.graceMinutes);
    empty.hidden = settings.mappings.length > 0;
    list.innerHTML = "";

    // Shown in the order they are applied, so the precedence rules are
    // visible rather than something to infer.
    const ordered = [...settings.mappings].sort((a, b) => b.priority - a.priority);
    for (const m of ordered) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const label = document.createElement("span");
      label.className = "calendar-feed-row-label";
      label.textContent = `${m.icon ? m.icon + " " : ""}${m.activity}`;
      row.appendChild(label);

      const detail = document.createElement("span");
      detail.className = "calendar-feed-row-address";
      detail.textContent = `${SOURCE_LABELS[m.source] ?? m.source}: ${m.value}${m.priority !== 0 ? ` · priority ${m.priority}` : ""}`;
      row.appendChild(detail);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("label");
      toggle.className = "routine-active-toggle";
      toggle.title = "Disable to keep the mapping without using it";
      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.checked = m.enabled;
      toggleInput.addEventListener("change", async () => {
        const updated = settings.mappings.map((x) =>
          x.id === m.id ? { ...x, enabled: toggleInput.checked } : x
        );
        render(await window.nimbus.updateActivitySettings({ mappings: updated }));
      });
      toggle.appendChild(buildSwitch(toggleInput));
      const toggleText = document.createElement("span");
      toggleText.textContent = "On";
      toggle.appendChild(toggleText);
      actions.appendChild(toggle);

      const edit = document.createElement("button");
      edit.className = "calendar-feed-remove";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditing(m));
      actions.appendChild(edit);

      const remove = document.createElement("button");
      remove.className = "calendar-feed-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        // Editing the very row being removed would leave the form
        // pointing at something that no longer exists.
        if (editingMappingId === m.id) resetForm();
        const updated = settings.mappings.filter((x) => x.id !== m.id);
        render(await window.nimbus.updateActivitySettings({ mappings: updated }));
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getActivitySettings();
    render(settings);

    enabled.addEventListener("change", async () => {
      render(await window.nimbus.updateActivitySettings({ enabled: enabled.checked }));
    });

    suggestApps.addEventListener("change", async () => {
      render(await window.nimbus.updateActivitySettings({ suggestFrequentApps: suggestApps.checked }));
    });

    // "Make it an activity?" answered yes: this form, with the program
    // filled in. Nothing is saved until the user presses "Add activity".
    window.nimbus.onOpenActivityEditor(({ application, name, source }) => {
      switchToTab("routines");
      document.getElementById("routinesTabActivitiesBtn")?.click();
      resetForm();
      nameInput.value = name;
      sourceSelect.value = source === "website" ? "website" : "application";
      sourceSelect.dispatchEvent(new Event("change"));
      valueInput.value = application;
      nameInput.focus();
      nameInput.select();
    });

    graceInput.addEventListener("change", async () => {
      const minutes = Number(graceInput.value);
      if (!Number.isFinite(minutes) || minutes < 0) return;
      render(await window.nimbus.updateActivitySettings({ graceMinutes: minutes }));
    });

    cancelEditBtn.addEventListener("click", () => resetForm());

    addBtn.addEventListener("click", async () => {
      const activity = nameInput.value.trim();
      const value = valueInput.value.trim();
      if (!activity || !value) {
        showError("Give the activity a name and something to match against.");
        return;
      }
      clearError();

      const current = await window.nimbus.getActivitySettings();
      const existing = current.mappings.find((m) => m.id === editingMappingId);
      const mapping: ActivityMapping = {
        id: existing?.id ?? `activity-${Date.now()}`,
        // Editing an activity shouldn't silently switch a disabled one
        // back on; that is what the row's own toggle is for.
        enabled: existing?.enabled ?? true,
        activity,
        icon: iconInput.value.trim() || undefined,
        source: sourceSelect.value as ActivityMapping["source"],
        value,
        // "contains" for everything but an exact executable name, which
        // is what the Routine trigger form does for the same reason: a
        // window title is never going to match exactly.
        matchMode: sourceSelect.value === "application" ? "exact" : "contains",
        priority: Number(priorityInput.value) || 0,
      };

      const mappings = existing
        ? current.mappings.map((m) => (m.id === existing.id ? mapping : m))
        : [...current.mappings, mapping];

      try {
        render(await window.nimbus.updateActivitySettings({ mappings }));
        resetForm();
      } catch (err) {
        // The main process validates before saving; show why rather than
        // failing silently.
        showError(`Couldn't save that activity: ${String(err)}`);
      }
    });
  } catch (err) {
    console.error("Failed to load activity settings", err);
  }
}

void initActivitySettings();
