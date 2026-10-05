/**
 * The main window's entry point: it starts each tab and part of the page,
 * in order; the parts live in their own modules beside it. Talks to the
 * main process only through the `window.nimbus` API exposed by the
 * preload script (typed in rendererTypes.ts) — it has no Node/Electron
 * access of its own.
 */

import { initStocksTab } from "./stocksTab";
import { initNetworkTab } from "./networkTab";
import { initMemoryTab } from "./memoryTab";
import { initCollectionsTab } from "./collectionsTab";
import { initBooksTab } from "./booksTab";
import { initMealsTab } from "./mealsTab";
import { initDecksTab } from "./decksTab";
import { initCardPage } from "./cardPage";
import { initHomeWeek } from "./homeWeek";
import { initUpdateSettings } from "./updateSettings";
import { initDataTransfer } from "./dataTransfer";
import { initWeatherTab } from "./weatherTab";
import { initSidebarGroups } from "./sidebarGroups";
import { initPresenceSettings } from "./presenceSettings";
import {
  initCalendarSettings,
  initEmailSettings,
  initSettings,
  initSpotifySettings,
  initTaskSettings,
  initWeatherSettings,
} from "./settingsForms";
import { NOW_PLAYING_REFRESH_EVENT, initNowPlayingCard } from "./nowPlaying";
import { initRoutinesSettings } from "./routinesSettings";
import { TASK_REFRESH_EVENT, initTaskManagement } from "./tasksTab";
import { initBriefing } from "./homeBriefing";
import { initContext } from "./contextTab";
import { initCalendarTab } from "./calendarTab";
import { initAssistantFeed } from "./assistantFeed";
import { initActivitySettings, initCurrentActivity } from "./activityViews";

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

function initMinimizeButton(): void {
  document.getElementById("minimizeBtn")?.addEventListener("click", () => {
    window.nimbus.hideWindow();
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
initCollectionsTab();
initBooksTab();
initMealsTab();
initDecksTab();
initCardPage();
initHomeWeek();
initUpdateSettings();
initDataTransfer();
initWeatherTab();
initSidebarGroups();
initPresenceSettings();
initContext();
initAssistantFeed();
initCurrentActivity();
void initActivitySettings();
