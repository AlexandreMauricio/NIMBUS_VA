import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import { randomUUID } from "crypto";
import * as path from "path";
import { logger } from "../logging/logger";
import { loadSettings, hydrateCredentials, saveSettings, NimbusSettings } from "../settings/settingsManager";
import { APP_NAME, APP_FULL_NAME, APP_VERSION } from "../common/appInfo";
import { config } from "../config/config";
import { createTray, destroyTray } from "./tray";
import { applyAutostart } from "./autostart";
import { contextService } from "../context";
import { WeatherProvider, LocationResolver } from "../context/providers/weather";
import { CalendarProvider } from "../context/providers/calendar";
import { EmailProvider } from "../context/providers/email";
import { TaskProvider, TaskWriteRequest } from "../context/providers/tasks";
import {
  StockProvider,
  StockPosition,
  normalizeSymbol,
  validateStockPositions,
} from "../context/providers/stocks";
import { SpotifyContextProvider, SpotifyApiClient, mapPlaylists } from "../context/providers/spotify";
import { actionService } from "../actions";
import {
  SpotifyActionProvider,
  TimerActionProvider,
  SystemActionProvider,
  AppActionProvider,
  FileActionProvider,
  MediaActionProvider,
} from "../actions/providers";
import { WindowsDesktop } from "./desktop/windowsDesktop";
import { ActionResult } from "../actions/types";
import { SpotifyAuthManager } from "./spotify";
import { BriefingService } from "../briefing";
import { ContextEventBus } from "../events";
import { RoutineService, validateRoutine, Routine } from "../routines";
import { DesktopActivityMonitor } from "./activity";
import { FileRoutineStateStore } from "./routineStateStore";
import { FileActivityStateStore } from "./activityStateStore";
import { ActivityService, ActivityMapping, validateActivityMapping, knownActivityNames } from "../activity";
import { assistantBridge } from "./assistantBridge";
import { TimerService } from "../timers";
import { showSuggestionPopup, getCurrentPopupSuggestion, closeSuggestionPopup } from "./suggestionWindow";
import { showTimerWindow, closeTimerWindow } from "./timerWindow";

const BRIEFING_UPDATED_CHANNEL = "nimbus:briefing-updated";

/** How long resizing must stay quiet before window bounds are written to disk. */
const RESIZE_SAVE_DEBOUNCE_MS = 500;

let mainWindow: BrowserWindow | null = null;
let settings: NimbusSettings;
let resizeSaveTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
const briefingService = new BriefingService(contextService);
let spotifyAuth: SpotifyAuthManager;
let spotifyClient: SpotifyApiClient;
let spotifyContextProvider: SpotifyContextProvider;
const contextEventBus = new ContextEventBus();
let routineService: RoutineService;
let taskProvider: TaskProvider;
let stockProvider: StockProvider;
let activityMonitor: DesktopActivityMonitor | null = null;
const timerService = new TimerService(contextEventBus);
let activityService: ActivityService;

function createMainWindow(show: boolean): void {
  mainWindow = new BrowserWindow({
    width: settings.windowsClient.windowBounds.width,
    height: settings.windowsClient.windowBounds.height,
    title: APP_NAME,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    show,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "ui", "index.html"));

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logger.debug("Renderer console", { level, message, line, sourceId });
  });

  // Debounced rather than saved on every resize event (which fires
  // continuously while a drag is in progress) — and actually saved, not
  // just held in memory. Relying on `before-quit` to persist bounds
  // means an OS-forced kill, a crash, or a power loss loses them, which
  // reads as "NIMBUS forgets my window size at random."
  mainWindow.on("resize", () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    settings.windowsClient.windowBounds = { width, height };
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      resizeSaveTimer = null;
      saveSettings(settings);
    }, RESIZE_SAVE_DEBOUNCE_MS);
  });

  // Closing the window is treated as "hide to tray", not quitting — that's
  // what makes NIMBUS behave like a background assistant rather than a
  // normal app. Only the tray's Quit item (or an OS shutdown) actually exits.
  mainWindow.on("close", (event) => {
    logger.debug("Main window close event received", { isQuitting });
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  logger.info("Main window created", { shown: show });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/**
 * Applies a renderer-supplied partial update to a settings group, keeping
 * only fields the group already has and only values of the same kind.
 *
 * The routine and activity handlers validate everything they save; the
 * simpler groups used to spread whatever arrived straight into
 * settings.json. The renderer is NIMBUS's own code, but a bug there (or a
 * stray field) shouldn't be able to write an unknown key or a string
 * where a boolean belongs. null is accepted, since several fields are
 * nullable by design (a manual location, a preferred device).
 */
function mergeKnown<T extends object>(current: T, partial: unknown): T {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) return current;
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in current)) continue;
    const existing = (current as Record<string, unknown>)[key];
    const sameKind =
      value === null ||
      existing === null ||
      (typeof value === typeof existing && Array.isArray(value) === Array.isArray(existing));
    if (sameKind) out[key] = value;
  }
  return out as T;
}

function registerIpcHandlers(): void {
  ipcMain.handle("nimbus:get-app-info", () => ({
    name: APP_NAME,
    fullName: APP_FULL_NAME,
    version: APP_VERSION,
    environment: config.appEnv,
  }));

  ipcMain.handle("nimbus:get-settings", () => settings.windowsClient.startup);

  ipcMain.handle(
    "nimbus:update-settings",
    (_event, partial: Partial<typeof settings.windowsClient.startup>) => {
      settings.windowsClient.startup = mergeKnown(settings.windowsClient.startup, partial);
      saveSettings(settings);
      if (partial.launchWithWindows !== undefined) {
        applyAutostart(settings.windowsClient.startup.launchWithWindows);
      }
      logger.info("Settings updated", settings.windowsClient.startup);
      return settings.windowsClient.startup;
    }
  );

  ipcMain.handle("nimbus:hide-window", () => {
    mainWindow?.hide();
  });

  ipcMain.handle("nimbus:get-context", () => contextService.getSnapshot());

  ipcMain.handle("nimbus:get-weather-settings", () => settings.userPreferences.weather);

  ipcMain.handle(
    "nimbus:update-weather-settings",
    (_event, partial: Partial<typeof settings.userPreferences.weather>) => {
      const next = mergeKnown(settings.userPreferences.weather, partial);
      if (next.locationMode !== "auto" && next.locationMode !== "manual") {
        throw new Error('Weather locationMode must be "auto" or "manual".');
      }
      settings.userPreferences.weather = next;
      saveSettings(settings);
      logger.info("Weather settings updated", settings.userPreferences.weather);
      return settings.userPreferences.weather;
    }
  );

  ipcMain.handle("nimbus:get-calendar-settings", () => settings.userPreferences.calendar);

  ipcMain.handle(
    "nimbus:update-calendar-settings",
    (_event, partial: Partial<typeof settings.userPreferences.calendar>) => {
      const next = mergeKnown(settings.userPreferences.calendar, partial);
      for (const feed of next.feeds) {
        if (
          !feed ||
          typeof feed.id !== "string" ||
          typeof feed.label !== "string" ||
          typeof feed.address !== "string" ||
          typeof feed.enabled !== "boolean"
        ) {
          throw new Error("Each calendar feed needs an id, label, address and enabled flag.");
        }
      }
      settings.userPreferences.calendar = next;
      saveSettings(settings);
      // Feed addresses are credentials (private ICS URLs) — log only
      // shape/counts, never the addresses themselves.
      logger.info("Calendar settings updated", {
        enabled: settings.userPreferences.calendar.enabled,
        feedCount: settings.userPreferences.calendar.feeds.length,
      });
      return settings.userPreferences.calendar;
    }
  );

  // Unlike calendar's feed address, an email account's password is never
  // sent to the renderer at all — not even masked. The Settings form is
  // write-only for it: `hasPassword` tells the UI whether one is already
  // saved (to decide what placeholder to show), and saving a new value
  // goes through nimbus:update-email-settings, which is never read back.
  ipcMain.handle("nimbus:get-email-settings", () => ({
    enabled: settings.userPreferences.email.enabled,
    defaultSinceDays: settings.userPreferences.email.defaultSinceDays,
    accounts: settings.userPreferences.email.accounts.map(({ password, ...rest }) => ({
      ...rest,
      hasPassword: password.length > 0,
    })),
  }));

  ipcMain.handle(
    "nimbus:update-email-settings",
    (
      _event,
      partial: {
        enabled?: boolean;
        defaultSinceDays?: number;
        // Accounts come back without a `password` field (see get-email-settings
        // above) — `newPassword` is only present when the user actually typed
        // a new one. Anything else must keep its existing stored password;
        // otherwise every non-password edit (toggling enabled, renaming...)
        // would silently wipe it.
        accounts?: Array<
          Omit<(typeof settings)["userPreferences"]["email"]["accounts"][number], "password"> & {
            newPassword?: string;
          }
        >;
      }
    ) => {
      const current = settings.userPreferences.email;

      const accounts = partial.accounts
        ? partial.accounts.map(({ newPassword, ...rest }) => {
            const existing = current.accounts.find((a) => a.id === rest.id);
            return { ...rest, password: newPassword ?? existing?.password ?? "" };
          })
        : current.accounts;

      settings.userPreferences.email = {
        enabled: partial.enabled ?? current.enabled,
        defaultSinceDays: partial.defaultSinceDays ?? current.defaultSinceDays,
        accounts,
      };
      saveSettings(settings);
      // Never log account credentials — shape/counts only.
      logger.info("Email settings updated", {
        enabled: settings.userPreferences.email.enabled,
        accountCount: settings.userPreferences.email.accounts.length,
      });
      return {
        enabled: settings.userPreferences.email.enabled,
        defaultSinceDays: settings.userPreferences.email.defaultSinceDays,
        accounts: settings.userPreferences.email.accounts.map(({ password, ...rest }) => ({
          ...rest,
          hasPassword: password.length > 0,
        })),
      };
    }
  );

  // Unlike calendar's feed address, a task account's API token is never
  // sent to the renderer at all — same write-only pattern as email's
  // password. `hasApiToken` tells the UI whether one is already saved;
  // saving a new value goes through nimbus:update-task-settings, which is
  // never read back.
  ipcMain.handle("nimbus:get-task-settings", () => ({
    enabled: settings.userPreferences.tasks.enabled,
    accounts: settings.userPreferences.tasks.accounts.map(({ apiToken, ...rest }) => ({
      ...rest,
      hasApiToken: apiToken.length > 0,
    })),
  }));

  ipcMain.handle(
    "nimbus:update-task-settings",
    (
      _event,
      partial: {
        enabled?: boolean;
        // Accounts come back without an `apiToken` field (see
        // get-task-settings above) — `newApiToken` is only present when
        // the user actually typed a new one. Anything else must keep its
        // existing stored token; otherwise every non-token edit (toggling
        // enabled, renaming...) would silently wipe it.
        accounts?: Array<
          Omit<(typeof settings)["userPreferences"]["tasks"]["accounts"][number], "apiToken"> & {
            newApiToken?: string;
          }
        >;
      }
    ) => {
      const current = settings.userPreferences.tasks;

      const accounts = partial.accounts
        ? partial.accounts.map(({ newApiToken, ...rest }) => {
            const existing = current.accounts.find((a) => a.id === rest.id);
            return { ...rest, apiToken: newApiToken ?? existing?.apiToken ?? "" };
          })
        : current.accounts;

      settings.userPreferences.tasks = {
        enabled: partial.enabled ?? current.enabled,
        accounts,
      };
      saveSettings(settings);
      // Never log account credentials — shape/counts only.
      logger.info("Task settings updated", {
        enabled: settings.userPreferences.tasks.enabled,
        accountCount: settings.userPreferences.tasks.accounts.length,
      });
      return {
        enabled: settings.userPreferences.tasks.enabled,
        accounts: settings.userPreferences.tasks.accounts.map(({ apiToken, ...rest }) => ({
          ...rest,
          hasApiToken: apiToken.length > 0,
        })),
      };
    }
  );

  // The Tasks tab's management surface — list/create/edit/complete/
  // delete, all delegating straight to TaskProvider (which resolves the
  // right Todoist account per call; see TaskProvider.resolveAccount).
  // Distinct from nimbus:get-context's task snapshot, which is the
  // briefing-focused bucketed/capped view — this is the full list a
  // management UI actually needs. Every handler lets a rejection
  // propagate to the renderer's own try/catch rather than swallowing it
  // into a generic "false" — the renderer needs the real error message
  // (e.g. "status 403" for a revoked token) to show the user anything
  // useful.
  ipcMain.handle("nimbus:list-tasks", () => taskProvider.listAllTasks());
  ipcMain.handle("nimbus:list-task-projects", () => taskProvider.listProjects());
  ipcMain.handle("nimbus:create-task", (_event, request: TaskWriteRequest) =>
    taskProvider.createTask(request)
  );
  ipcMain.handle("nimbus:update-task", (_event, taskId: string, request: Partial<TaskWriteRequest>) =>
    taskProvider.updateTask(taskId, request)
  );
  ipcMain.handle("nimbus:complete-task", (_event, taskId: string) => taskProvider.completeTask(taskId));
  ipcMain.handle("nimbus:reopen-task", (_event, taskId: string) => taskProvider.reopenTask(taskId));
  ipcMain.handle("nimbus:delete-task", (_event, taskId: string) => taskProvider.deleteTask(taskId));

  // Stocks (src/context/providers/stocks/) — read-only tracking of
  // positions the user entered by hand. Nothing here trades or talks to a
  // brokerage: these handlers save the user's own position notes and read
  // market data, and that is all.
  ipcMain.handle("nimbus:get-stock-settings", () => settings.userPreferences.stocks);
  ipcMain.handle(
    "nimbus:update-stock-settings",
    (_event, partial: { enabled?: unknown; newsEnabled?: unknown; positions?: unknown }) => {
      const current = settings.userPreferences.stocks;
      let positions = current.positions;
      if (partial?.positions !== undefined) {
        const result = validateStockPositions(partial.positions);
        if (!result.valid) throw new Error(`Invalid stock position: ${result.error}`);
        // Rebuilt field by field, so nothing beyond the known shape is saved.
        positions = (partial.positions as StockPosition[]).map((p) => ({
          id: p.id,
          symbol: normalizeSymbol(p.symbol)!,
          companyName: p.companyName?.trim() || undefined,
          shares: p.shares,
          averageCost: p.averageCost,
          purchaseDate: p.purchaseDate || undefined,
          notes: p.notes?.trim() || undefined,
        }));
      }
      settings.userPreferences.stocks = {
        enabled: typeof partial?.enabled === "boolean" ? partial.enabled : current.enabled,
        newsEnabled: typeof partial?.newsEnabled === "boolean" ? partial.newsEnabled : current.newsEnabled,
        positions,
      };
      saveSettings(settings);
      logger.info("Stock settings updated", {
        enabled: settings.userPreferences.stocks.enabled,
        newsEnabled: settings.userPreferences.stocks.newsEnabled,
        positionCount: positions.length,
      });
      return settings.userPreferences.stocks;
    }
  );
  // Asks for fresh prices on the next read (at most every 30 s); the tab
  // then re-reads the context snapshot as usual.
  ipcMain.handle("nimbus:refresh-stocks", () => stockProvider.refresh());
  // Headlines for a symbol the user actually tracks — never an arbitrary one.
  ipcMain.handle("nimbus:get-stock-news", (_event, symbol: unknown) => {
    const normalized = normalizeSymbol(symbol);
    const tracked = settings.userPreferences.stocks.positions.some(
      (p) => normalizeSymbol(p.symbol) === normalized
    );
    if (!normalized || !tracked) {
      return { symbol: String(symbol), status: "unavailable", items: [], retrievedAt: null };
    }
    return stockProvider.getNews(normalized);
  });

  // Spotify's connection state is derived from SpotifyAuthManager (has a
  // stored refresh token or not) rather than persisted as its own
  // settings field — the tokens themselves are the source of truth, kept
  // out of settings.json entirely (see src/main/spotify/spotifyTokenStore.ts).
  ipcMain.handle("nimbus:get-spotify-settings", () => ({
    enabled: settings.userPreferences.spotify.enabled,
    preferredDeviceId: settings.userPreferences.spotify.preferredDeviceId,
    connected: spotifyAuth.isAuthenticated(),
  }));

  ipcMain.handle(
    "nimbus:update-spotify-settings",
    (_event, partial: Partial<typeof settings.userPreferences.spotify>) => {
      settings.userPreferences.spotify = mergeKnown(settings.userPreferences.spotify, partial);
      saveSettings(settings);
      logger.info("Spotify settings updated", settings.userPreferences.spotify);
      return {
        enabled: settings.userPreferences.spotify.enabled,
        preferredDeviceId: settings.userPreferences.spotify.preferredDeviceId,
        connected: spotifyAuth.isAuthenticated(),
      };
    }
  );

  // Starts the PKCE auth flow (opens the system browser). The renderer
  // only ever gets a connected/not-connected boolean back — never a token
  // of any kind, at any point in this exchange.
  ipcMain.handle("nimbus:spotify-connect", async () => {
    try {
      await spotifyAuth.startAuthFlow();
      return { connected: spotifyAuth.isAuthenticated(), error: null };
    } catch (err) {
      logger.warn("Spotify auth flow failed", { error: String(err) });
      return { connected: spotifyAuth.isAuthenticated(), error: "Couldn't connect to Spotify." };
    }
  });

  ipcMain.handle("nimbus:spotify-disconnect", () => {
    spotifyAuth.disconnect();
    return { connected: false };
  });

  // The generic Action-execution surface (see src/actions/). The renderer
  // never gets direct access to a provider or its credentials — it can
  // only ask for a specific, already-registered action id with plain
  // JSON params, exactly like "execute Spotify pause action" in the
  // task's own security-boundary example. ActionService validates the id
  // and params itself; there is no way to reach arbitrary Node/API access
  // through this handler.
  ipcMain.handle("nimbus:list-actions", () => actionService.listActions());
  // A file/folder picker for action parameters that are local paths (see
  // ActionParameterSchema.format). It only ever returns a path for the
  // renderer to put in a text field — the action still validates that
  // path itself when it runs.
  ipcMain.handle("nimbus:pick-path", async (_event, format: unknown) => {
    if (format !== "file" && format !== "folder" && format !== "application") return null;
    const options: OpenDialogOptions =
      format === "folder"
        ? { properties: ["openDirectory"] }
        : format === "application"
          ? {
              properties: ["openFile"],
              defaultPath: path.join(
                process.env.ProgramData ?? "C:/ProgramData",
                "Microsoft",
                "Windows",
                "Start Menu",
                "Programs"
              ),
              filters: [{ name: "Applications and shortcuts", extensions: ["exe", "lnk"] }],
            }
          : { properties: ["openFile"] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(
    "nimbus:execute-action",
    async (_event, actionId: string, params?: Record<string, unknown>) => {
      const result = await actionService.executeAction(actionId, params ?? {});
      onActionExecuted(actionId, result);
      return result;
    }
  );

  // Playlist metadata only (name/id/artwork/owner/track count) — never
  // downloads a playlist's actual tracks. Lets requests reject naturally
  // (not authenticated, API down, etc.) rather than pretending success;
  // the renderer already handles a rejected invoke with its own try/catch.
  ipcMain.handle("nimbus:spotify-list-playlists", async () => {
    const raw = await spotifyClient.listPlaylists();
    return mapPlaylists(raw);
  });

  // Routines (src/routines/) — a user-configurable Trigger → Suggestion →
  // Action relationship. Every write is validated the same way action
  // params are: reject before it's ever saved or executed, never trust
  // renderer-supplied configuration blindly.
  ipcMain.handle("nimbus:get-routine-settings", () => settings.userPreferences.routines);

  ipcMain.handle(
    "nimbus:update-routine-settings",
    (_event, partial: { enabled?: boolean; routines?: Routine[] }) => {
      if (partial.routines) {
        const knownActionIds = actionService.listActions().map((a) => a.id);
        for (const routine of partial.routines) {
          const result = validateRoutine(routine, knownActionIds);
          if (!result.valid) {
            throw new Error(`Invalid routine "${routine?.name ?? "?"}": ${result.error}`);
          }
        }
      }

      settings.userPreferences.routines = {
        enabled: partial.enabled ?? settings.userPreferences.routines.enabled,
        routines: partial.routines ?? settings.userPreferences.routines.routines,
      };
      saveSettings(settings);
      syncActivityMonitor();
      logger.info("Routine settings updated", {
        enabled: settings.userPreferences.routines.enabled,
        routineCount: settings.userPreferences.routines.routines.length,
      });
      return settings.userPreferences.routines;
    }
  );

  // "Test" evaluates and explains; it deliberately runs nothing (see
  // RoutineService.testRoutine). "Run now" is the separate, explicit way
  // to actually execute a routine's actions — what Test used to do.
  ipcMain.handle("nimbus:test-routine", (_event, routineId: string) => routineService.testRoutine(routineId));
  ipcMain.handle("nimbus:run-routine-now", (_event, routineId: string) =>
    routineService.runRoutineNow(routineId)
  );
  ipcMain.handle("nimbus:get-routine-history", () => routineService.getHistory());

  // Activity is read-only over IPC apart from its configuration: the
  // renderer can see what NIMBUS concluded and edit the rules, but
  // cannot assert an activity or end a session by hand.
  ipcMain.handle("nimbus:get-current-activity", () => activityService.getCurrentActivity());
  ipcMain.handle("nimbus:get-activity-sessions", () => activityService.getRecentSessions(50));
  // Every activity name in play, so the editor can offer them as a
  // choice instead of asking the user to retype one exactly.
  ipcMain.handle("nimbus:get-known-activities", () =>
    knownActivityNames(settings.userPreferences.activity.mappings)
  );
  ipcMain.handle("nimbus:get-activity-settings", () => settings.userPreferences.activity);
  ipcMain.handle(
    "nimbus:update-activity-settings",
    (_event, partial: { enabled?: boolean; mappings?: ActivityMapping[]; graceMinutes?: number }) => {
      // Same discipline as routines: reject before saving, never trust
      // renderer-supplied configuration blindly.
      if (partial.mappings) {
        for (const mapping of partial.mappings) {
          const result = validateActivityMapping(mapping);
          if (!result.valid) {
            throw new Error(`Invalid activity mapping "${mapping?.activity ?? "?"}": ${result.error}`);
          }
        }
      }
      const current = settings.userPreferences.activity;
      settings.userPreferences.activity = {
        enabled: partial.enabled ?? current.enabled,
        mappings: partial.mappings ?? current.mappings,
        graceMinutes: partial.graceMinutes ?? current.graceMinutes,
      };
      saveSettings(settings);
      syncActivityMonitor();
      logger.info("Activity settings updated", {
        enabled: settings.userPreferences.activity.enabled,
        mappingCount: settings.userPreferences.activity.mappings.length,
      });
      return settings.userPreferences.activity;
    }
  );
  ipcMain.handle("nimbus:get-routine-last-triggered", () => routineService.getLastTriggeredAt());

  // A debugging aid for "why didn't my trigger fire" — the exact raw
  // process/window/folder data the desktop activity monitor saw on its
  // most recent poll, or null if it isn't running. Same information the
  // monitor already reads for matching; nothing new is exposed.
  ipcMain.handle("nimbus:get-activity-snapshot", () => activityMonitor?.getLastSnapshot() ?? null);

  ipcMain.handle("nimbus:get-active-suggestions", () => routineService.getActiveSuggestions());
  ipcMain.handle("nimbus:accept-suggestion", (_event, suggestionId: string) =>
    routineService.acceptSuggestion(suggestionId)
  );
  ipcMain.handle("nimbus:dismiss-suggestion", (_event, suggestionId: string) => {
    routineService.dismissSuggestion(suggestionId);
  });

  // The suggestion popup window's own small surface (src/main/suggestionWindow.ts,
  // src/preload/suggestionPreload.ts) — reuses the accept/dismiss handlers
  // above, just adds a way for that window to read what it should show
  // and to close itself.
  ipcMain.handle("nimbus:get-popup-suggestion", () => getCurrentPopupSuggestion());
  ipcMain.handle("nimbus:close-suggestion-popup", () => closeSuggestionPopup());

  // The timer popup window's surface (src/main/timerWindow.ts,
  // src/timers/). A generic timer engine — nothing here is Spotify- or
  // Routine-specific.
  ipcMain.handle("nimbus:get-timer-state", () => timerService.getState());
  ipcMain.handle("nimbus:pause-timer", (_event, timerId: string) => timerService.pause(timerId));
  ipcMain.handle("nimbus:resume-timer", (_event, timerId: string) => timerService.resume(timerId));
  ipcMain.handle("nimbus:cancel-timer", (_event, timerId: string) => timerService.cancel(timerId));
  // Extends the running Pomodoro through the normal Action path, so it
  // gets the same validation and result handling as any other action.
  ipcMain.handle("nimbus:timer-add-study", async () => {
    const result = await actionService.executeAction("timer.addStudy", {});
    onActionExecuted("timer.addStudy", result);
    return { status: result.status, message: result.message ?? result.error?.message };
  });
  ipcMain.handle("nimbus:close-timer-window", () => closeTimerWindow());

  // Pull-only: returns whatever briefing was last generated (or null before
  // the first one completes). Never generates — that's what keeps a UI
  // reload from producing a new briefing every time it asks.
  ipcMain.handle("nimbus:get-briefing", () => briefingService.getCurrent());

  // Explicit, user-initiated regeneration (e.g. a "Regenerate" button) —
  // distinct from the pull above, and from the one automatic generation
  // that happens at startup.
  ipcMain.handle("nimbus:regenerate-briefing", () => generateBriefing());
}

/**
 * Generates a briefing and notifies any open window it changed. Failures
 * here are already contained by ContextService/BriefingService (a bad
 * provider just gets omitted) — this catch is only for something
 * unexpected, so a briefing failure can never take the app down.
 */
async function generateBriefing() {
  try {
    const briefing = await briefingService.generate();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(BRIEFING_UPDATED_CHANNEL);
    }
    logger.info("Briefing ready", { id: briefing.id, itemCount: briefing.items.length });
    return briefing;
  } catch (err) {
    logger.error("Failed to generate briefing", { error: String(err) });
    return null;
  }
}

/**
 * Runs whatever side effect a just-executed action needs beyond its own
 * ActionResult, regardless of which path triggered it (direct
 * nimbus:execute-action, or a Routine's acceptSuggestion/testRoutine).
 * Two unrelated concerns share this hook only because they share the
 * same "an action of id X just ran" seam — each stays a plain
 * actionId-keyed branch, not a shared abstraction:
 *  - Spotify actions invalidate SpotifyContextProvider's cache, so the
 *    Home now-playing card doesn't keep showing pre-action state (e.g.
 *    still "Play" right after a play actually succeeded) for up to the
 *    Context provider's cache TTL.
 *  - timer.start opens the NIMBUS-owned timer popup window, since
 *    starting a timer is meaningless to the user without a visible
 *    countdown — the Action/Timer systems themselves stay unaware of
 *    any window.
 */
function onActionExecuted(actionId: string, result: ActionResult): void {
  if (actionId.startsWith("spotify.")) {
    spotifyContextProvider.invalidateCache();
    // The Home now-playing card's own click handlers already refresh
    // themselves locally, but a Spotify action accepted from the
    // separate suggestion popup window has no other way to reach it —
    // this is what makes that path update immediately instead of
    // waiting for the card's next 5-second poll.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("nimbus:now-playing-changed");
    }
  }
  // Only open the timer window when a timer actually started — a
  // routine saved with an incomplete timer.start step (e.g. no
  // duration configured) fails validation before TimerService.start()
  // ever runs, and popping up a window for a timer that doesn't exist
  // just opens and immediately self-closes (its poll finds no current
  // timer), which looked like "the timer didn't appear."
  if (actionId === "timer.start" && result.status === "success") {
    showTimerWindow();
  }
}

/**
 * Starts or stops the desktop activity monitor to match the Routines
 * "Enable context-aware suggestions" setting — called at startup and
 * again whenever that setting changes. Desktop activity monitoring only
 * ever runs while this is on; it is off by default (see RoutineSettings'
 * doc comment).
 */
function syncActivityMonitor(): void {
  // Either feature needs the same underlying signal, so the monitor runs
  // if either is on — and stops when neither is, so nothing is observed
  // for a feature the user has switched off.
  const shouldRun = settings.userPreferences.routines.enabled || settings.userPreferences.activity.enabled;
  if (shouldRun && !activityMonitor) {
    activityMonitor = new DesktopActivityMonitor(contextEventBus);
    activityMonitor.start();
    logger.info("Desktop activity monitor started");
  } else if (!shouldRun && activityMonitor) {
    activityMonitor.stop();
    activityMonitor = null;
    logger.info("Desktop activity monitor stopped");
  }
}

export function startApp(): void {
  settings = loadSettings();
  registerIpcHandlers();

  // Registered here (rather than in src/context/index.ts) because, unlike
  // dateTime/system, weather needs live settings — those only exist once
  // loadSettings() has run. The getter closes over `settings`, so it keeps
  // seeing the latest saved location preference, including changes made
  // after startup via nimbus:update-weather-settings.
  contextService.register(
    new WeatherProvider(
      new LocationResolver(() => settings.userPreferences.weather, config.weatherManualLocation)
    )
  );

  // Same reasoning as weather above — calendar needs live settings too.
  contextService.register(
    CalendarProvider.withDefaults(() => settings.userPreferences.calendar, config.calendarFeed)
  );

  // Same reasoning as weather/calendar above — email needs live settings too.
  contextService.register(
    EmailProvider.withDefaults(() => settings.userPreferences.email, config.emailAccount)
  );

  // Same reasoning as weather/calendar/email above — tasks need live settings too.
  // Kept as a named reference (not just registered) because the Tasks tab's
  // create/edit/complete/delete IPC handlers (see registerIpcHandlers)
  // call straight into it — the same "keep a reference for direct calls
  // beyond the Context snapshot" reasoning spotifyContextProvider already
  // needed.
  taskProvider = TaskProvider.withDefaults(() => settings.userPreferences.tasks, config.taskAccount);
  contextService.register(taskProvider);

  // Stocks need no credentials — the market-data source is key-free — so
  // only the live settings getter is passed in. Kept as a reference for
  // the Stocks tab's refresh and news handlers.
  stockProvider = new StockProvider(() => settings.userPreferences.stocks);
  contextService.register(stockProvider);

  // Spotify is NIMBUS's first Action Provider alongside its Context
  // Provider — see src/actions/ and ARCHITECTURE.md's Context-vs-Action
  // split. Both share the same SpotifyApiClient/SpotifyAuthManager
  // instances; auth (PKCE, token storage) is fully isolated in
  // src/main/spotify/ and handed down only as `getAccessToken`/
  // `isAuthenticated` functions, matching the boundary calendar/email/
  // tasks already established for their own credentials.
  spotifyAuth = new SpotifyAuthManager(() => config.spotify);
  spotifyClient = new SpotifyApiClient(() => spotifyAuth.getAccessToken());
  spotifyContextProvider = new SpotifyContextProvider(
    () => settings.userPreferences.spotify,
    spotifyClient,
    () => spotifyAuth.isAuthenticated()
  );
  contextService.register(spotifyContextProvider);
  actionService.register(
    new SpotifyActionProvider(
      spotifyClient,
      () => settings.userPreferences.spotify,
      () => spotifyAuth.isAuthenticated(),
      undefined,
      // Spotify's desktop client registers "spotify:" as a URI protocol
      // handler — the same launch mechanism the OAuth flow already uses
      // for opening a browser. Lets a "play" action that fails with "no
      // active device" open Spotify and retry once, instead of just
      // failing outright.
      async () => {
        await shell.openExternal("spotify:");
      }
    )
  );

  // The second and third Action Providers — proof the Action/Routine
  // systems were never actually Spotify-specific. A Routine's actions
  // can freely mix "spotify.*", "timer.start", and "system.openUrl"
  // steps; none of the providers know any other exists. See src/timers/
  // for the generic timer engine, and systemActionProvider.ts for why
  // opening a URL through Electron's `shell.openExternal` (injected here
  // rather than the provider touching Electron itself) is safe — it's
  // the same as clicking a link, never arbitrary code/shell execution.
  actionService.register(new TimerActionProvider(timerService));
  // The desktop actions (apps, files, media/volume, locking) share one
  // Windows implementation, built here at the device edge and handed to
  // Core providers that never touch Electron or the OS themselves.
  const desktop = new WindowsDesktop((p) => shell.openPath(p));
  actionService.register(
    new SystemActionProvider(
      (url) => shell.openExternal(url),
      undefined,
      () => desktop.lockScreen()
    )
  );
  actionService.register(new AppActionProvider(desktop));
  actionService.register(new FileActionProvider(desktop));
  actionService.register(new MediaActionProvider(desktop));

  // The Routine system (src/routines/) — reacts to Context Events
  // (src/events/) by suggesting, never by executing directly (see
  // "Context Event → Trigger → Routine → Suggestion → Action" in
  // ARCHITECTURE.md). `isSpotifyPlaying` is the one condition this task
  // implements that needs a live signal; reusing the already-registered
  // SpotifyContextProvider here is exactly the "reuse the existing
  // Context system" the task asked for, rather than a second Spotify
  // poll.
  // Activity watches the same event bus everything else does — no second
  // monitor, no new signal collected. It only observes and records; the
  // Routine engine below reads it through a condition, which is the only
  // route from "what the user is doing" to anything happening.
  activityService = new ActivityService(
    () => settings.userPreferences.activity,
    contextEventBus,
    () => new Date(),
    new FileActivityStateStore()
  );
  activityService.start();
  activityService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("nimbus:activity-changed");
    }
  });

  routineService = new RoutineService(
    () => settings.userPreferences.routines.routines,
    actionService,
    contextEventBus,
    () => new Date(),
    async () => {
      try {
        const ctx = await spotifyContextProvider.getContext();
        return ctx.playbackState === "playing";
      } catch {
        return false;
      }
    },
    undefined,
    // A Routine's own action steps (via acceptSuggestion or the Settings
    // "Test" button) bypass nimbus:execute-action entirely — this is the
    // same per-action side effect the IPC handler above triggers,
    // applied to that path too. Without it, a Spotify routine step left
    // the Home now-playing card stale, and a timer.start routine step
    // would start counting down with no popup ever shown.
    (actionId, result) => onActionExecuted(actionId, result),
    // Backs the "actionsNotAlreadyActive" condition — checks the
    // routine's own configured steps against live Spotify/Timer state,
    // not just "is anything playing" (that's spotifyNotAlreadyPlaying).
    // Only `spotify.playPlaylist` (by exact playlistUri) and
    // `timer.start` are checkable today; a routine with neither, or a
    // playlist step configured by search query rather than an exact
    // URI, has nothing to check and this reports "not active" so the
    // condition never blocks it. `anyCheckable` guards against a
    // routine with no checkable steps at all being treated as
    // vacuously "already active".
    async (steps) => {
      let anyCheckable = false;
      for (const step of steps) {
        if (step.actionId === "spotify.playPlaylist") {
          const playlistUri = step.params?.playlistUri;
          if (typeof playlistUri !== "string" || !playlistUri) continue;
          anyCheckable = true;
          try {
            const ctx = await spotifyContextProvider.getContext();
            if (!(ctx.playbackState === "playing" && ctx.context?.uri === playlistUri)) return false;
          } catch {
            return false;
          }
        } else if (step.actionId === "timer.start") {
          anyCheckable = true;
          const timerState = timerService.getState();
          if (!timerState || (timerState.status !== "running" && timerState.status !== "paused"))
            return false;
        }
      }
      return anyCheckable;
    },
    // Cooldowns outlive the process — without this, quitting and
    // relaunching NIMBUS would clear every cooldown and let routines
    // re-suggest immediately.
    new FileRoutineStateStore(),
    // Injected rather than imported, same as isSpotifyPlaying: the
    // engine reads the current activity without knowing what produces it.
    () => activityService.getCurrentActivity()
  );
  routineService.start();
  routineService.onSuggestion((suggestion) => {
    // Reuses the existing assistant-event seam (src/common/assistantEvents.ts,
    // src/main/assistantBridge.ts) rather than a second push channel —
    // it already exists for exactly this "a subsystem wants to reach the
    // UI" purpose. The main window's Activity feed still shows a plain
    // log line from this; the actual interactive prompt is the popup
    // below.
    assistantBridge.publish(suggestion);

    // Suggestions must reach the user even when NIMBUS's window is
    // hidden in the tray (routines are triggered by background desktop
    // activity, which is exactly when the window is likely NOT open).
    // A NIMBUS-owned popup window is used instead of the native
    // Windows `Notification` — see "Suggestion popup" in
    // ARCHITECTURE.md for why: an unpackaged Electron app has no real
    // AppUserModelID, so Windows shows a generic/technical identity
    // (fixed for any *other* native notification via
    // app.setAppUserModelId in main.ts, but a rich suggestion — two
    // real buttons, a per-action summary, NIMBUS branding — isn't
    // something the native toast API can render anyway). This is the
    // one popup implementation shared by every kind of suggestion.
    showSuggestionPopup(suggestion);
  });
  // A routine opted into `autoRun` skips the suggestion/popup step
  // entirely (see Routine.autoRun's doc comment) — this is the one
  // place that still tells the user *something* happened, as a passive
  // Activity-feed line via the existing AssistantNotification shape,
  // never a popup (that would defeat the point of opting out of one).
  routineService.onAutoRun((routine, results) => {
    const failed = results.filter((r) => r.status === "failure").length;
    assistantBridge.publish({
      id: randomUUID(),
      type: "notification",
      source: "routines",
      createdAt: new Date().toISOString(),
      title: routine.name,
      body:
        failed === 0
          ? "Ran automatically."
          : `Ran automatically — ${failed} action${failed === 1 ? "" : "s"} failed.`,
    });
  });

  syncActivityMonitor();

  // If NIMBUS is already running (e.g. auto-started at login, sitting in
  // the tray) and the user launches it again — via a shortcut, or
  // `npm start` — Electron blocks the second process from starting at
  // all (see main.ts). Without this, that second launch would just do
  // nothing visible, which looks like "it didn't open" even though the
  // first instance is fine. This brings the *existing* window forward
  // instead, which is what a second launch is actually asking for.
  app.on("second-instance", () => {
    logger.info("Second launch attempted — focusing the existing window instead");
    showMainWindow();
  });

  app.on("ready", () => {
    // userData is named explicitly because everything NIMBUS persists
    // hangs off it, and a running app writing to a different one than you
    // are reading is not something you can see from the outside.
    logger.info(`${APP_NAME} starting`, {
      version: APP_VERSION,
      env: config.appEnv,
      userData: app.getPath("userData"),
    });

    // Credentials are read here, not in loadSettings() above, because
    // Electron's safeStorage reports itself unavailable until the app is
    // ready — and does so silently, so reading earlier yields blanks
    // rather than an error. Must happen before anything touches a
    // credential: the providers below, the IPC handlers, and any save.
    settings = hydrateCredentials(settings);

    // NIMBUS's own UI is the only chrome it needs — the default Electron
    // menu bar (File/Edit/View/Window/Help) doesn't do anything useful
    // here and clashes with the custom sidebar design.
    Menu.setApplicationMenu(null);

    // Keep the OS login-item registration in sync with the saved setting
    // every launch, in case it drifted (e.g. settings.json was edited).
    applyAutostart(settings.windowsClient.startup.launchWithWindows);

    createMainWindow(!settings.windowsClient.startup.startMinimized);

    createTray({
      onOpen: showMainWindow,
      onQuit: quitApp,
    });

    // Startup lifecycle: providers are already registered above; this
    // retrieves context and generates the one briefing for this session
    // launch. Not awaited — a slow/failing weather fetch must not delay
    // the window/tray from appearing. The window pulls the result via
    // nimbus:get-briefing once it's loaded (and again on the
    // nimbus:briefing-updated push if it loaded before this finished).
    generateBriefing();
  });

  // No window-all-closed -> quit here: NIMBUS keeps running via the tray
  // even with no window open. Quitting only happens through quitApp().
  app.on("window-all-closed", () => {
    logger.info("All windows closed — NIMBUS continues running in the tray");
  });

  app.on("activate", () => {
    showMainWindow();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    // Ends the session in progress at shutdown rather than leaving it
    // open to be resumed with invented time on the next launch.
    activityService?.stop();
    if (resizeSaveTimer) {
      clearTimeout(resizeSaveTimer);
      resizeSaveTimer = null;
    }
    if (settings) {
      saveSettings(settings);
    }
    destroyTray();
    logger.info(`${APP_NAME} shutting down`);
  });
}
