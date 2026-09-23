import { contextService } from "../../context";
import { buildWeeklySummary } from "../../summary/weeklySummary";
import type { CalendarEvent } from "../../context/providers/calendar/types";
import { handle } from "./handle";
import type { IpcContext } from "./context";

/** Home: the opt-in usage tally and the weekly summary. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerHomeIpc(ctx: IpcContext): void {
  handle("nimbus:get-usage", () => ({
    enabled: ctx.settings.userPreferences.activity.suggestFrequentApps === true,
    trackingOn:
      ctx.settings.userPreferences.activity.enabled || ctx.settings.userPreferences.routines.enabled,
    presence: ctx.presenceService?.update().state ?? null,
    entries: [...(ctx.appUsage?.usage() ?? []), ...(ctx.siteUsage?.usage() ?? [])].sort(
      (a, b) => b.daysUsed - a.daysUsed || b.minutesUsed - a.minutesUsed
    ),
  }));
  handle("nimbus:get-weekly-summary", async () => {
    const calendar = (await contextService.getSnapshot()).providers.calendar;
    const calendarData =
      calendar && calendar.status === "ok" && calendar.data
        ? (calendar.data as { upcomingEvents?: CalendarEvent[]; events?: CalendarEvent[] })
        : null;
    return buildWeeklySummary(
      {
        sessions: ctx.activityService.getRecentSessions(),
        usage: [...(ctx.appUsage?.usage() ?? []), ...(ctx.siteUsage?.usage() ?? [])],
        cardsAdded: ctx.collectionService.list(),
        booksAdded: ctx.bookService.list(),
        decks: ctx.deckService.list(),
        upcoming: calendarData?.upcomingEvents ?? calendarData?.events ?? [],
      },
      new Date(),
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  });
}
