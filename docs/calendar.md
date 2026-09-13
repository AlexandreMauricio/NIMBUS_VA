# Calendar

An external context provider —
[src/context/providers/calendar/](../src/context/providers/calendar/) —
following the same pattern as weather: an adapter (`CalendarProvider`)
implementing `ContextProvider<CalendarContext>`, with the external-service
code isolated behind it.

- **Integration**: ICS ("iCalendar", RFC 5545) feed subscription — a
  private, per-calendar URL, not OAuth. Google Calendar, Outlook/Office 365
  and iCloud can all generate a "secret address in iCal format" with no
  developer app registration. **The feed URL itself is the credential**:
  it is never logged (log calls include only a feed's `label`/`id`), and
  the Settings list shows it masked. It is stored in `settings.json` —
  the one credential-like value that is, because the Settings form has to
  show it back for editing and it only grants read access to calendar
  data.
- **Sources** ([icsCalendarSource.ts](../src/context/providers/calendar/icsCalendarSource.ts)):
  an `http://`/`https://` address is fetched (with a 10-second timeout);
  anything else must be a path to a local `.ics`, `.ical` or `.ifb` file.
  Other local paths are refused, so a feed address can't become a way to
  read arbitrary files.
- **Multi-device/OAuth boundary**: `CalendarProvider` depends only on
  `IcsCalendarSource.fetchRaw()`. A future OAuth source (Google/Microsoft
  Graph) would fill the same role without `CalendarProvider`,
  `ContextService`, the briefing or the UI changing. **OAuth is not
  implemented.**
- **Data model** ([types.ts](../src/context/providers/calendar/types.ts)):
  `CalendarEvent` (id, title, start/end as ISO instants, `isAllDay`,
  `location`, `calendarName`); `CalendarContext` groups events into
  `todayEvents` / `laterEvents` (a 7-day lookahead) plus `nextEvent`. A
  pure helper, `classifyEvent`, says whether an event is past, ongoing or
  upcoming.
- **Timezones**: ICS date-times come as UTC (`...Z`), "floating" (no zone
  — treated as local) or `TZID`-qualified.
  [icsTimeUtils.ts](../src/context/providers/calendar/icsTimeUtils.ts)
  resolves a `TZID` to the right UTC instant with `Intl`. It also accepts
  a quoted `TZID` and the common **Windows zone names** Outlook and
  Exchange write (`GMT Standard Time`, `Eastern Standard Time`, …); a
  `TZID` it still doesn't recognise is read in the local zone rather than
  dropping the event. "Today" is always the system's local zone.
- **Parser** ([icsParser.ts](../src/context/providers/calendar/icsParser.ts)):
  deliberately minimal — UID, SUMMARY, DTSTART/DTEND, LOCATION,
  `X-WR-CALNAME`, line unfolding, text unescaping. A malformed event is
  skipped, never thrown; a `STATUS:CANCELLED` one is dropped.
- **Recurrence** ([icsRecurrence.ts](../src/context/providers/calendar/icsRecurrence.ts)):
  `RRULE`s are expanded over the window the provider can show (two days
  back to the Calendar tab's 90-day horizon). Occurrences are generated in
  the event's own wall-clock time, so a weekly 09:00 meeting stays at
  09:00 across DST. Supported: `FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`,
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (with ordinals like `2TU`, `-1FR`),
  `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `WKST`; `EXDATE`s are removed, and a
  moved or cancelled single occurrence (a `RECURRENCE-ID` event) replaces
  the generated one. Anything else (`HOURLY`, `BYWEEKNO`, `RDATE`…) keeps
  the single literal occurrence.
- **Settings** (`UserPreferences.calendar`): a master `enabled` switch (off
  by default) and a `feeds` list (`id`, `label`, `address`, `enabled`),
  merged into one `CalendarContext`. Managed in Settings → Calendar; a
  default feed can come from `NIMBUS_CALENDAR_ICS_URL` /
  `NIMBUS_CALENDAR_LABEL` in `.env` (used only when enabled and no feed is
  saved).
- **Caching**: 15 minutes, dropping to 2 minutes once the next event is
  within an hour. No push/webhook updates.
- **Failure behavior**: "not enabled" or "no feed" is `status:
  "unavailable"`. Feeds are fetched independently; one failing feed is
  logged and skipped, and only if every feed fails does the provider
  throw (which `ContextService` turns into the error/stale result).

## Where it shows up

- The **briefing's** calendar line (see [briefing.md](briefing.md)).
- The **Calendar tab** — today's events (ones already over are dimmed
  and marked "Ended") and **the next 90 days** (at most 100 events),
  rendered from the calendar provider's result in the context snapshot,
  with a Refresh button. It does not poll.
- The briefing and Attention look only at **the coming week**
  (`laterEvents`), deliberately: a meeting next month is not today's
  news. The tab's longer list is `upcomingEvents`.

**A new event takes a while to appear.** NIMBUS re-reads a feed every 15
minutes (2 when something is about to start), but the feed itself is
published by your calendar provider on its own schedule — Google's
"secret address in iCal format" can lag behind the calendar by several
hours. If an event is in Google Calendar but not in NIMBUS after a
Refresh, the feed hasn't caught up yet.

## Tests

`icsTimeUtils.test.ts`, `icsParser.test.ts` (UTC/TZID/floating/all-day
values, Windows and quoted TZIDs, unknown TZID fallback, defaults,
unfolding, unescaping, malformed events skipped), `icsCalendarSource.test.ts`,
`icsPathGuard.test.ts` (the local-file restriction), `calendarProvider.test.ts`
(availability, bucketing, merging feeds, per-feed failure, caching, the
env fallback), and calendar cases in `briefingGenerator.test.ts`. No test
reaches a real calendar.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
