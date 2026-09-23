import type { BrowserWindow } from "electron";
import type { NimbusSettings } from "../../settings/settingsManager";
import type { BriefingService } from "../../briefing";
import type { SpotifyAuthManager } from "../spotify";
import type { SpotifyApiClient } from "../../context/providers/spotify";
import type { RoutineService } from "../../routines";
import type { AttentionService } from "../../attention";
import type { TaskProvider } from "../../context/providers/tasks";
import type { StockProvider } from "../../context/providers/stocks";
import type { DesktopActivityMonitor } from "../activity";
import type { TimerService } from "../../timers";
import type { ActivityService, AppUsageTracker } from "../../activity";
import type { SiteUsageTracker } from "../../activity/siteUsage";
import type { NetworkService } from "../../network";
import type { MemoryService } from "../../memory";
import type { PresenceService } from "../../presence/presence";
import type {
  BookService,
  CatalogService,
  CollectionService,
  DeckService,
  GcdCatalog,
  WikipediaCollections,
} from "../../collections";
import type { MealService } from "../../meals/mealService";
import type { ActionResult } from "../../actions/types";

/**
 * What the IPC handlers need from lifecycle.ts: its settings, windows and
 * services, and the few things it does on their behalf.
 *
 * lifecycle.ts builds this with getters, so a handler always sees the
 * current value — the services are created after the handlers are
 * registered, and some (the activity monitor, the usage tallies, presence)
 * come and go while NIMBUS runs.
 */
export interface IpcContext {
  readonly settings: NimbusSettings;
  readonly mainWindow: BrowserWindow | null;
  readonly briefingService: BriefingService;
  readonly spotifyAuth: SpotifyAuthManager;
  readonly spotifyClient: SpotifyApiClient;
  readonly routineService: RoutineService;
  readonly attentionService: AttentionService;
  readonly taskProvider: TaskProvider;
  readonly stockProvider: StockProvider;
  readonly activityMonitor: DesktopActivityMonitor | null;
  readonly timerService: TimerService;
  readonly activityService: ActivityService;
  readonly appUsage: AppUsageTracker | null;
  readonly siteUsage: SiteUsageTracker | null;
  readonly networkService: NetworkService;
  readonly memoryService: MemoryService;
  readonly presenceService: PresenceService | null;
  readonly collectionService: CollectionService;
  readonly catalogService: CatalogService;
  readonly bookService: BookService;
  readonly deckService: DeckService;
  readonly mealService: MealService;
  readonly gcdCatalog: GcdCatalog;
  readonly wikipediaCollections: WikipediaCollections;
  /** Books whose cover was looked for by ISBN this session. */
  readonly coverAttempted: Set<string>;
  rememberRoutineDecision(suggestion: { routineId?: string }, outcome: "accepted" | "dismissed"): void;
  applyZoom(percent: unknown, save?: boolean): number;
  generateBriefing(): Promise<unknown>;
  onActionExecuted(actionId: string, result: ActionResult): void;
  syncActivityMonitor(): void;
  fillBookCovers(): Promise<void>;
}
