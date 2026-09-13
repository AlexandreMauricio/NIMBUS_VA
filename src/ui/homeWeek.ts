/**
 * The Home page's "Your week" card, and the Settings list of what the app
 * and website tallies have counted. The numbers are built in Core
 * (src/summary/weeklySummary.ts) and the trackers; this only draws them.
 */

interface WeekView {
  days: string[];
  activities: Array<{ name: string; icon?: string; minutes: number; sessions: number; perDay: number[] }>;
  activityMinutes: number;
  usage: Array<{
    name: string;
    source: "app" | "website";
    minutes: number;
    daysUsed: number;
    perDay: number[];
  }>;
  collection: { cards: number; books: number; decksCreated: number; decksEdited: number };
  upcoming: Array<{ title: string; startsAt: string; isAllDay: boolean }>;
  highlights: string[];
}

interface UsageView {
  enabled: boolean;
  trackingOn: boolean;
  presence: string | null;
  entries: Array<{
    key: string;
    name: string;
    source: "app" | "website";
    daysUsed: number;
    minutesUsed: number;
    status: "activity" | "declined" | "snoozed" | "candidate" | "counting";
  }>;
}

interface WeekBridge {
  getWeeklySummary(): Promise<WeekView>;
  getUsage(): Promise<UsageView>;
  getActivitySettings(): Promise<{ mappings: Array<{ activity: string; icon?: string }> }>;
}

/**
 * What a counted row asks the Activities editor (renderer.ts) to do —
 * "new" fills the form in; "addTo" saves a rule for an existing activity.
 */
export interface UsagePromotion {
  kind: "new" | "addTo";
  source: "application" | "website";
  /** What the rule matches: the executable, or the site's name in titles. */
  value: string;
  name: string;
  activity?: string;
}
export const USAGE_PROMOTION_EVENT = "nimbus:usage-promotion";

function bridge(): WeekBridge {
  return (window as unknown as { nimbus: WeekBridge }).nimbus;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Seven small bars, one per day, scaled to the busiest day in the row. */
function dayBars(perDay: number[], days: string[]): HTMLElement {
  const bars = make("div", "week-bars");
  const max = Math.max(1, ...perDay);
  perDay.forEach((minutes, i) => {
    const bar = make("span", "week-bar");
    bar.style.height = `${Math.max(minutes > 0 ? 12 : 4, Math.round((minutes / max) * 100))}%`;
    if (minutes === 0) bar.classList.add("week-bar-empty");
    const label = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(
      new Date(`${days[i]}T12:00:00Z`)
    );
    bar.title = `${label}: ${minutesText(minutes)}`;
    bars.appendChild(bar);
  });
  return bars;
}

async function renderWeek(): Promise<void> {
  const container = document.getElementById("homeWeek");
  const range = document.getElementById("homeWeekRange");
  if (!container) return;
  let week: WeekView;
  try {
    week = await bridge().getWeeklySummary();
  } catch {
    container.replaceChildren(make("p", "collection-meta", "The week couldn't be added up just now."));
    return;
  }
  if (range) range.textContent = "Last 7 days";
  container.replaceChildren();

  if (week.highlights.length) {
    const list = make("ul", "week-highlights");
    for (const line of week.highlights) list.appendChild(make("li", undefined, line));
    container.appendChild(list);
  } else {
    container.appendChild(
      make(
        "p",
        "collection-meta",
        "Nothing to add up yet — activities, app time and collection additions show here."
      )
    );
  }

  const rows = (
    title: string,
    items: Array<{ name: string; minutes: number; perDay: number[]; note: string }>
  ) => {
    if (!items.length) return;
    container.appendChild(make("h6", "kicker week-heading", title));
    for (const item of items) {
      const row = make("div", "week-row");
      const text = make("div", "week-row-text");
      text.appendChild(make("span", "week-row-name", item.name));
      text.appendChild(make("span", "collection-meta", item.note));
      row.append(text, dayBars(item.perDay, week.days));
      container.appendChild(row);
    }
  };
  rows(
    "Activities",
    week.activities.slice(0, 5).map((a) => ({
      name: `${a.icon ? `${a.icon} ` : ""}${a.name}`,
      minutes: a.minutes,
      perDay: a.perDay,
      note: `${minutesText(a.minutes)} · ${a.sessions} session${a.sessions === 1 ? "" : "s"}`,
    }))
  );
  rows(
    "Apps & websites",
    week.usage.slice(0, 5).map((u) => ({
      name: u.name,
      minutes: u.minutes,
      perDay: u.perDay,
      note: `${u.source === "website" ? "Site" : "App"} · ${minutesText(u.minutes)} · ${u.daysUsed} of 7 days`,
    }))
  );

  if (week.upcoming.length) {
    container.appendChild(make("h6", "kicker week-heading", "Coming up"));
    for (const event of week.upcoming) {
      const when = new Date(event.startsAt);
      const date = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        ...(event.isAllDay ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" }),
      }).format(when);
      const row = make("div", "week-event");
      row.append(make("span", "collection-meta", date), make("span", "week-row-name", event.title));
      container.appendChild(row);
    }
  }
}

const STATUS_TEXT: Record<UsageView["entries"][number]["status"], string> = {
  activity: "already an activity",
  declined: "you said not to ask again",
  snoozed: "asked recently — resting for a week",
  candidate: "will be suggested",
  counting: "not enough yet",
};

async function renderUsage(): Promise<void> {
  const list = document.getElementById("activityUsageList");
  if (!list) return;
  const view = await bridge().getUsage();
  list.replaceChildren();
  if (!view.enabled) {
    list.appendChild(
      make("p", "settings-warning", "The switch above is off, so nothing is being counted or suggested.")
    );
  } else if (!view.trackingOn) {
    list.appendChild(
      make("p", "settings-warning", 'Turn on "Track what I\'m doing" (or Routines) — the tally needs it.')
    );
  }
  if (!view.entries.length) {
    list.appendChild(make("p", "collection-meta", "Nothing counted in the last 7 days."));
    return;
  }
  const activities = [
    ...new Map(
      (await bridge().getActivitySettings()).mappings.map((m) => [m.activity.toLowerCase(), m.activity])
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const promote = (detail: UsagePromotion) =>
    window.dispatchEvent(new CustomEvent<UsagePromotion>(USAGE_PROMOTION_EVENT, { detail }));
  for (const entry of view.entries.slice(0, 40)) {
    const row = make("div", "usage-row");
    row.append(
      make("span", "week-row-name", entry.name),
      make(
        "span",
        "collection-meta",
        `${entry.source === "website" ? "Site" : "App"} · ${entry.daysUsed} of 7 days · ${minutesText(entry.minutesUsed)}`
      ),
      make(
        "span",
        `tag ${entry.status === "candidate" ? "tag-accent" : "tag-neutral"}`,
        STATUS_TEXT[entry.status]
      )
    );
    if (entry.status !== "activity") {
      const source = entry.source === "website" ? "website" : "application";
      const value = entry.source === "website" ? entry.name : entry.key;
      const actions = make("span", "usage-actions");
      const create = make("button", "btn btn-ghost", "New activity");
      create.type = "button";
      create.addEventListener("click", () => promote({ kind: "new", source, value, name: entry.name }));
      actions.appendChild(create);
      if (activities.length) {
        const addTo = make("select", "select");
        addTo.appendChild(new Option("Add to…", ""));
        for (const name of activities) addTo.appendChild(new Option(name, name));
        addTo.addEventListener("change", () => {
          if (addTo.value) promote({ kind: "addTo", source, value, name: entry.name, activity: addTo.value });
        });
        actions.appendChild(addTo);
      }
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
}

/** Redraws the counted list if it's open — after an activity is added from it. */
export function refreshUsageList(): void {
  const details = document.querySelector<HTMLDetailsElement>(".usage-details");
  if (details?.open) void renderUsage();
}

export function initHomeWeek(): void {
  void renderWeek();
  // Cheap to build; refreshed when Home is opened and every 15 minutes.
  document.querySelector('.side-link[data-tab="home"]')?.addEventListener("click", () => void renderWeek());
  setInterval(() => void renderWeek(), 15 * 60_000);
  document.querySelector(".usage-details")?.addEventListener("toggle", (event) => {
    if ((event.target as HTMLDetailsElement).open) void renderUsage();
  });
  refreshUsageList();
}
