import { BrowserWindow, Menu, app, powerMonitor, shell } from "electron";
import { randomUUID } from "crypto";
import * as path from "path";

import { logger } from "../logging/logger";
import { loadSettings, hydrateCredentials, saveSettings, NimbusSettings } from "../settings/settingsManager";
import { DEFAULT_ZOOM_PERCENT, normalizeZoomPercent, steppedZoom } from "../settings/settingsSchema";
import { APP_NAME, APP_VERSION } from "../common/appInfo";
import { config } from "../config/config";
import { createTray, destroyTray } from "./tray";
import { applyAutostart } from "./autostart";
import { contextService } from "../context";
import { WeatherProvider, LocationResolver } from "../context/providers/weather";
import { CalendarProvider } from "../context/providers/calendar";
import { EmailProvider } from "../context/providers/email";
import { TaskProvider } from "../context/providers/tasks";
import { StockProvider } from "../context/providers/stocks";
import { SpotifyContextProvider, SpotifyApiClient } from "../context/providers/spotify";
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
import { RoutineService } from "../routines";
import { AttentionService, explainItem } from "../attention";
import { DesktopActivityMonitor } from "./activity";
import { FileRoutineStateStore } from "./routineStateStore";
import { FileActivityStateStore } from "./activityStateStore";
import { FileAppUsageStore } from "./appUsageStore";
import { FileSiteUsageStore } from "./siteUsageStore";
import { SiteUsageTracker } from "../activity/siteUsage";
import { NetworkProvider, NetworkService, dnsHostnameResolver } from "../network";
import { WindowsNetworkScanner } from "./network/windowsNetworkScanner";
import { DeviceProber } from "./network/deviceProbe";
import { FileNetworkStore, loadVendorLookup } from "./network/networkFiles";
import { MemoryService, recordActivityEnded, recordNewNetworkDevice, recordRoutineDecision } from "../memory";
import { FileMemoryStore } from "./memoryStore";
import { PresenceService } from "../presence/presence";
import {
  CatalogService,
  CollectionService,
  LorcastCatalog,
  OptcgCatalog,
  ScryfallCatalog,
  TcgdexCatalog,
  YgoprodeckCatalog,
} from "../collections";
import { FileCollectionStore } from "./collectionStore";
import {
  BookService,
  DeckService,
  GcdCatalog,
  WikipediaCollections,
  coverUrlForIsbn,
  isCoverUrl,
  browsers,
  cardSources,
  synergyFinders,
  detailFetchers,
  scryfallCardsByName,
} from "../collections";
import { FileDeckStore } from "./deckStore";
import { registerCoverProtocol } from "./coverStore";
import { startUpdater } from "./updater";
import { FileBookStore } from "./bookStore";
import { FileMealStore } from "./mealStore";
import { MealService } from "../meals/mealService";
import { ActivityService, AppUsageTracker } from "../activity";
import { assistantBridge } from "./assistantBridge";
import { TimerService } from "../timers";
import { showSuggestionPopup, getCurrentPopupSuggestion } from "./suggestionWindow";
import { showTimerWindow } from "./timerWindow";
import { registerAppIpc } from "./ipc/app";
import { registerHomeIpc } from "./ipc/home";
import { registerIntegrationsIpc } from "./ipc/integrations";
import { registerStocksIpc } from "./ipc/stocks";
import { registerNetworkIpc } from "./ipc/network";
import { registerMemoryIpc } from "./ipc/memory";
import { registerCollectionsIpc } from "./ipc/collections";
import { registerMealsIpc } from "./ipc/meals";
import { registerBooksIpc, kickReadingCredits } from "./ipc/books";
import { registerActionsIpc } from "./ipc/actions";
import { registerRoutinesIpc } from "./ipc/routines";
import { registerPopupsIpc } from "./ipc/popups";
import type { IpcContext } from "./ipc/context";

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
let attentionService: AttentionService;
let taskProvider: TaskProvider;
let stockProvider: StockProvider;
let activityMonitor: DesktopActivityMonitor | null = null;
const timerService = new TimerService(contextEventBus);
let activityService: ActivityService;
let appUsage: AppUsageTracker | null = null;
let siteUsage: SiteUsageTracker | null = null;
let networkService: NetworkService;
let memoryService: MemoryService;
let presenceService: PresenceService | null = null;
let collectionService: CollectionService;
let catalogService: CatalogService;
let bookService: BookService;
let deckService: DeckService;
let mealService: MealService;
let gcdCatalog: GcdCatalog;
let wikipediaCollections: WikipediaCollections;

/** A routine suggestion the user answered — reinforces that routine's acceptance pattern. */
function rememberRoutineDecision(
  suggestion: { routineId?: string },
  outcome: "accepted" | "dismissed"
): void {
  const routine = settings.userPreferences.routines.routines.find((r) => r.id === suggestion.routineId);
  if (!routine) return;
  try {
    recordRoutineDecision(memoryService, { id: routine.id, name: routine.name }, outcome);
  } catch (err) {
    logger.warn("Could not record a routine decision to memory", { error: String(err) });
  }
}

/**
 * Draws the main window at `percent`, remembers it, and tells the
 * Settings tab so its picker matches what the keyboard just did.
 *
 * Only the main window: the two popups are sized to their content, and
 * scaling them would clip rather than enlarge.
 */
function applyZoom(percent: unknown, save = true): number {
  const zoomPercent = normalizeZoomPercent(percent);
  settings.windowsClient.zoomPercent = zoomPercent;
  mainWindow?.webContents.setZoomFactor(zoomPercent / 100);
  if (save) {
    saveSettings(settings);
    mainWindow?.webContents.send("nimbus:zoom-changed", zoomPercent);
  }
  return zoomPercent;
}

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

  // Applied once the page exists - a zoom factor set before the first
  // load doesn't stick to it.
  mainWindow.webContents.once("did-finish-load", () => {
    applyZoom(settings.windowsClient.zoomPercent, false);
  });

  // Ctrl+= / Ctrl+- / Ctrl+0, as a browser does. Handled in the main
  // process because the shortcut belongs to the window and the value is
  // saved per PC - the renderer only follows along.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || input.meta) return;
    const current = settings.windowsClient.zoomPercent;
    if (input.key === "+" || input.key === "=") applyZoom(steppedZoom(current, 1));
    else if (input.key === "-" || input.key === "_") applyZoom(steppedZoom(current, -1));
    else if (input.key === "0") applyZoom(DEFAULT_ZOOM_PERCENT);
    else return;
    event.preventDefault();
  });

  // The details object, not the positional arguments Electron deprecated
  // alongside it.
  mainWindow.webContents.on("console-message", (details) => {
    logger.debug("Renderer console", {
      level: details.level,
      message: details.message,
      line: details.lineNumber,
      source: details.sourceId,
    });
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
 * Registers every main-window and popup IPC channel (src/main/ipc/). The
 * handlers reach this module's services through `ctx`, whose getters read
 * the live values — the services are built after this runs, and some are
 * replaced while NIMBUS runs.
 */
function registerIpcHandlers(): void {
  const ctx: IpcContext = {
    get settings() {
      return settings;
    },
    get mainWindow() {
      return mainWindow;
    },
    get briefingService() {
      return briefingService;
    },
    get spotifyAuth() {
      return spotifyAuth;
    },
    get spotifyClient() {
      return spotifyClient;
    },
    get routineService() {
      return routineService;
    },
    get attentionService() {
      return attentionService;
    },
    get taskProvider() {
      return taskProvider;
    },
    get stockProvider() {
      return stockProvider;
    },
    get activityMonitor() {
      return activityMonitor;
    },
    get timerService() {
      return timerService;
    },
    get activityService() {
      return activityService;
    },
    get appUsage() {
      return appUsage;
    },
    get siteUsage() {
      return siteUsage;
    },
    get networkService() {
      return networkService;
    },
    get memoryService() {
      return memoryService;
    },
    get presenceService() {
      return presenceService;
    },
    get collectionService() {
      return collectionService;
    },
    get catalogService() {
      return catalogService;
    },
    get bookService() {
      return bookService;
    },
    get deckService() {
      return deckService;
    },
    get mealService() {
      return mealService;
    },
    get gcdCatalog() {
      return gcdCatalog;
    },
    get wikipediaCollections() {
      return wikipediaCollections;
    },
    coverAttempted,
    rememberRoutineDecision,
    applyZoom,
    generateBriefing,
    onActionExecuted,
    syncActivityMonitor,
    fillBookCovers,
  };
  registerAppIpc(ctx);
  registerHomeIpc(ctx);
  registerIntegrationsIpc(ctx);
  registerStocksIpc(ctx);
  registerNetworkIpc(ctx);
  registerMemoryIpc(ctx);
  registerCollectionsIpc(ctx);
  registerMealsIpc(ctx);
  registerBooksIpc(ctx);
  registerActionsIpc(ctx);
  registerRoutinesIpc(ctx);
  registerPopupsIpc(ctx);
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
    activityMonitor = new DesktopActivityMonitor(
      contextEventBus,
      undefined,
      undefined,
      undefined,
      undefined,
      (snapshot) => {
        // Only time you're actually at the PC counts: an app left open
        // while you're out shouldn't become "5 hours of it this week".
        const present = presenceService?.update().state ?? "atPc";
        if (present === "atPc") {
          appUsage?.observe(snapshot.windowedApps ?? []);
          siteUsage?.observe(snapshot.browserWindows);
        } else {
          appUsage?.pause();
          siteUsage?.pause();
        }
      }
    );
    activityMonitor.start();
    logger.info("Desktop activity monitor started");
  } else if (!shouldRun && activityMonitor) {
    activityMonitor.stop();
    activityMonitor = null;
    logger.info("Desktop activity monitor stopped");
  }
}

/** Shows the main window on Routines → Activities with a new activity filled in, ready to save. */
function openActivityEditor(
  application: string,
  name: string,
  source: "application" | "website" = "application"
): void {
  showMainWindow();
  const send = () =>
    mainWindow?.webContents.send("nimbus:open-activity-editor", { application, name, source });
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

/**
 * Covers, from Open Library's cover service by ISBN: each book with an ISBN
 * and no cover yet is looked for once a session, one at a time, a second
 * apart. "?default=false" makes a missing cover a 404 instead of a blank
 * image; only the ISBN is sent.
 */
const coverAttempted = new Set<string>();
let fillingCovers = false;
async function fillBookCovers(): Promise<void> {
  if (fillingCovers || !bookService || !gcdCatalog) return;
  fillingCovers = true;
  try {
    for (;;) {
      const next = bookService
        .list()
        .find((book) => !book.coverUrl && coverUrlForIsbn(book.isbn) && !coverAttempted.has(book.id));
      if (!next) break;
      coverAttempted.add(next.id);
      const url = coverUrlForIsbn(next.isbn)!;
      try {
        const response = await fetch(`${url}?default=false`, {
          method: "HEAD",
          headers: { "User-Agent": "NIMBUS (personal desktop assistant; book covers)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok && isCoverUrl(url)) bookService.setCover(next.id, url);
      } catch (err) {
        logger.debug("No cover for a book", { error: String(err) });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    fillingCovers = false;
  }
}

export function startApp(): void {
  settings = loadSettings();
  void app.whenReady().then(registerCoverProtocol);
  registerIpcHandlers();
  startUpdater();

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

  // Network awareness (src/network/) — observation only: Windows' neighbor
  // cache every two minutes, and a bounded ping sweep of the local subnet
  // when the user presses "Scan network". Deliberately not an Action
  // provider: nothing a routine or the generic execute channel could call.
  // See docs/network.md.
  networkService = new NetworkService({
    scanner: new WindowsNetworkScanner(),
    resolver: dnsHostnameResolver(),
    identifier: new DeviceProber(),
    store: new FileNetworkStore(),
    bus: contextEventBus,
    vendorFor: loadVendorLookup(),
    isEnabled: () => settings.windowsClient.network.enabled,
    onChange: () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:network-changed");
    },
  });
  contextService.register(new NetworkProvider(networkService));

  // Presence (src/presence/): idle time from the OS, and — when you've
  // chosen one — when your phone was last on the network. Re-judged by
  // the desktop monitor's polls and every 20 s regardless.
  presenceService = new PresenceService(
    () => powerMonitor.getSystemIdleTime(),
    () => {
      const phoneId = settings.windowsClient.network.phoneDeviceId;
      if (!phoneId) return { chosen: false, lastSeen: null };
      if (!settings.windowsClient.network.enabled) return { chosen: true, lastSeen: null };
      const phone = networkService.getState().devices.find((device) => device.id === phoneId);
      return { chosen: true, lastSeen: phone?.lastSeen ?? null };
    }
  );
  presenceService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:presence-changed");
  });
  const presenceTimer = setInterval(() => presenceService?.update(), 20_000);
  (presenceTimer as { unref?: () => void }).unref?.();

  // Persistent memory (src/memory/): the user's own memories, learned
  // patterns and observations, each in its own file under userData/memory.
  // Only this wiring translates what other services already publish into
  // memory — no provider or service writes to it. See docs/memory.md.
  // Collections (src/collections/): your cards, and the card databases that
  // look them up. The catalogs are read-only and need no account; only the
  // text of a search is sent to them, never anything from the collection.
  // Card lists shared by the deck builder's browsing and card synergies.
  const cardLists = cardSources();
  catalogService = new CatalogService(
    [
      new ScryfallCatalog(),
      new TcgdexCatalog(),
      new YgoprodeckCatalog(),
      new LorcastCatalog(),
      new OptcgCatalog(),
    ],
    Date.now,
    undefined,
    detailFetchers(),
    { mtg: (names) => scryfallCardsByName(names) },
    browsers(fetch, Date.now, cardLists),
    synergyFinders(fetch, cardLists)
  );
  deckService = new DeckService(new FileDeckStore());
  deckService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:decks-changed");
  });
  collectionService = new CollectionService(new FileCollectionStore());
  // The comics and manga shelf, and the Grand Comics Database it can look
  // volumes up in (read-only, no account; only the series name or volume
  // id is sent).
  bookService = new BookService(new FileBookStore());
  // Meals: recipes, the pantry and the plan, all on this PC.
  mealService = new MealService(new FileMealStore());
  mealService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:meals-changed");
  });
  gcdCatalog = new GcdCatalog();
  wikipediaCollections = new WikipediaCollections();
  bookService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:books-changed");
    void fillBookCovers();
    kickReadingCredits();
  });
  void fillBookCovers();
  collectionService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:collection-changed");
  });

  memoryService = new MemoryService(
    new FileMemoryStore(path.join(app.getPath("userData"), "memory")),
    undefined,
    undefined,
    () => settings.userPreferences.memory.learning
  );
  memoryService.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:memory-changed");
  });
  contextEventBus.subscribe((event) => {
    try {
      if (event.type === "activityEnded") recordActivityEnded(memoryService, event);
      else if (event.type === "networkDeviceAppeared") recordNewNetworkDevice(memoryService, event);
    } catch (err) {
      logger.warn("Could not record to memory", { event: event.type, error: String(err) });
    }
  });

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

  // The opt-in app-usage tally behind "make it an activity?" — fed by the
  // desktop monitor's polls (programs with a window only), read by
  // Attention. Records nothing while the option is off.
  appUsage = new AppUsageTracker(
    () => settings.userPreferences.activity.suggestFrequentApps === true,
    () => settings.userPreferences.activity.mappings,
    () => new Date(),
    new FileAppUsageStore()
  );
  // Its website counterpart, fed by the browser titles the same polls
  // already read — same switch, same "Make it an activity?" question.
  siteUsage = new SiteUsageTracker(
    () => settings.userPreferences.activity.suggestFrequentApps === true,
    () => settings.userPreferences.activity.mappings,
    () => new Date(),
    new FileSiteUsageStore()
  );
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
    () => activityService.getCurrentActivity(),
    // The signals the newer conditions read. Each throws or reports
    // "can't tell" rather than guessing, which is what makes those
    // conditions fail closed instead of firing blind.
    {
      // Whatever Spotify says is driving playback right now. A failure
      // propagates: the evaluator reads that as "can't tell".
      getPlaybackContextUri: async () => {
        const playback = await spotifyContextProvider.getContext();
        return playback.context?.uri ?? null;
      },
      getTimerStatus: () => {
        const state = timerService.getState();
        if (state?.status === "running") return "running";
        if (state?.status === "paused") return "paused";
        return "none";
      },
      // undefined means NIMBUS has no idea: network watching is off, or
      // it has never seen that device.
      getPresenceState: () => presenceService?.get().state ?? "atPc",
      isDeviceOnline: (deviceId: string) => {
        if (!settings.windowsClient.network.enabled) return undefined;
        return networkService.getState().devices.find((device) => device.id === deviceId)?.online;
      },
    }
  );
  routineService.start();

  // The Attention & Priority engine (src/attention/) — decides what
  // deserves attention: proactive items from Context and Activity, and the
  // order routine suggestions reach the popup in. It has no Action service;
  // what it surfaces goes through the same popup and feed as before.
  attentionService = new AttentionService({
    getSettings: () => settings.userPreferences.attention,
    getSnapshot: () => contextService.getSnapshot(),
    getActivity: () => activityService.getCurrentActivity(),
    isTimerRunning: () => timerService.getState()?.status === "running",
    getFrequentApps: () => [...(appUsage?.candidates() ?? []), ...(siteUsage?.candidates() ?? [])],
    presenter: {
      showSuggestion: (suggestion) => showSuggestionPopup(suggestion),
      postNotice: (item) =>
        assistantBridge.publish({
          id: randomUUID(),
          type: "notification",
          source: "attention",
          createdAt: new Date().toISOString(),
          title: item.title,
          body: `${item.description} (${explainItem(item)})`,
          // A question posted to the feed carries its answers, so it can
          // be answered there instead of sitting unanswerable.
          ...(item.followUp && item.labels
            ? {
                attentionItemId: item.id,
                primaryLabel: item.labels.primary,
                secondaryLabel: item.labels.secondary,
              }
            : {}),
        }),
      currentPopup: () => {
        const current = getCurrentPopupSuggestion();
        return current ? { suggestionId: current.id, expiresAt: current.expiresAt } : null;
      },
    },
  });

  // Answers to Attention's questions that lead somewhere: "make it an
  // activity?" opens the Activities editor with the program filled in
  // (navigation only — nothing is saved until the user saves it), and
  // "Not now" is remembered so NIMBUS stops asking.
  attentionService.onAnswer((answer) => {
    if (answer.followUp?.type !== "createActivity") return;
    const { application, name } = answer.followUp;
    const website = answer.followUp.source === "website";
    const tracker = website ? siteUsage : appUsage;
    if (answer.outcome === "dismissed") {
      tracker?.decline(application);
      return;
    }
    tracker?.accept(application);
    // A website activity matches its window title, so the site's name is
    // what goes in the form — not the lowercased key it's counted under.
    if (website) openActivityEditor(name, name, "website");
    else openActivityEditor(application, name);
  });

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
    //
    // Attention decides when: at once, unless something more important
    // holds the popup — then it waits instead of overwriting it.
    attentionService.offerSuggestion(suggestion);
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

    // Attention starts only now, once credentials are loaded: its first look
    // asks every provider for context, and asking earlier made Spotify's
    // stored login look disconnected and email/tasks look unconfigured.
    attentionService.start();
    // Network watching reads Windows' neighbor cache (sends nothing) every
    // two minutes while it's on.
    networkService.start();
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
    attentionService?.stop();
    appUsage?.flush();
    siteUsage?.flush();
    networkService?.stop();
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
