/**
 * Home's briefing: rendering it, its item actions, and regenerating it.
 */

import type { Briefing, BriefingCategory } from "./rendererTypes";
import { switchToTab } from "./sidebarGroups";

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

export function initBriefing(): void {
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
