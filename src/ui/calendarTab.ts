/**
 * The Calendar tab: today's events and the days ahead.
 */

import { calendarEventWhen } from "./uiFormat";
import type { CalendarContext, CalendarEvent, ContextProviderResult } from "./rendererTypes";

function renderEventList(
  container: HTMLElement,
  events: CalendarEvent[],
  timezone: string,
  showDate: boolean,
  now: Date = new Date()
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
    // Today's list keeps events that are over - they did happen today -
    // but says so, so a morning meeting doesn't read as still to come.
    const ended = !event.isAllDay && new Date(event.endsAt).getTime() <= now.getTime();
    if (ended) row.classList.add("calendar-event-ended");

    const time = document.createElement("span");
    time.className = "calendar-event-time";
    const when = calendarEventWhen(event, timezone, showDate);
    time.textContent = when.column;
    row.appendChild(time);

    const body = document.createElement("div");
    body.className = "calendar-event-body";

    const title = document.createElement("span");
    title.className = "calendar-event-title";
    title.textContent = event.title;
    body.appendChild(title);

    const metaParts: string[] = [];
    if (when.meta) metaParts.push(when.meta);
    if (event.location) metaParts.push(event.location);
    if (event.calendarName) metaParts.push(event.calendarName);
    if (ended) metaParts.unshift("Ended");
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
  // The next 90 days. `laterEvents` (one week) is what the briefing uses;
  // it is the fallback only for a snapshot taken before the longer list.
  renderEventList(laterSection, data.upcomingEvents ?? data.laterEvents, data.timezone, true);
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

export function initCalendarTab(): void {
  loadCalendarTab();
  document.getElementById("refreshCalendarBtn")?.addEventListener("click", loadCalendarTab);
}
