# Calendar

The second external context provider —
[src/context/providers/calendar/](../src/context/providers/calendar/) —
following the exact same pattern as weather: an adapter
(`CalendarProvider`) implementing `ContextProvider<CalendarContext>`,
with the actual external-service code isolated behind it.

- **Integration chosen**: ICS ("iCalendar", RFC 5545) feed subscription —
  a private, per-calendar URL, not OAuth. Google Calendar, Outlook/Office
  365, and iCloud can all generate a "secret address in iCal format" for
  a calendar with no developer app registration, no client secret, and
  no token refresh. This was the deliberate choice for a first calendar
  integration in an environment with no way to register a real Google/
  Microsoft OAuth app: **the feed URL itself is the credential** — never
  logged (see `calendarProvider.ts`'s log calls, which only ever include
  a feed's `label`/`id`, never its `address`), never sent to the
  renderer beyond what the Settings form needs to display/edit it, and
  never committed (it lives only in the local `settings.json`, which is
  gitignored the same way weather's manual location is).
- **Multi-device/OAuth boundary**: `CalendarProvider` depends only on
  `IcsCalendarSource` (fetch raw ICS text) — see
  [icsCalendarSource.ts](../src/context/providers/calendar/icsCalendarSource.ts).
  A future OAuth-based source (Google/Microsoft Graph) would implement
  the same "give me raw events" role and plug in alongside ICS without
  `CalendarProvider`, `ContextService`, the briefing, or the UI changing.
  Real OAuth (an installed-app flow with a local redirect listener,
  token storage via Electron's `safeStorage`/OS keychain, refresh
  logic) is exactly the kind of device-adjacent, security-sensitive code
  that should live in its own module under `src/main/` or a future
  `src/services/`, called from Core through a narrow interface — the
  same boundary this ICS source already demonstrates, just with a
  different implementation behind it. **Not implemented — see Known
  limitations.**
- **Data model** ([types.ts](../src/context/providers/calendar/types.ts)):
  `CalendarEvent` (id, title, start/end as ISO instants, `isAllDay`,
  `location`, `calendarName`); `CalendarContext` groups events into
  `todayEvents` / `laterEvents` (a 7-day lookahead) plus a `nextEvent`
  convenience field — the "which events are past/ongoing/upcoming"
  distinction is a pure helper (`classifyEvent`) rather than baked into
  the stored shape, so the data stays plain facts.
- **Timezone correctness**: ICS date-times come as UTC (`...Z`),
  "floating" (no zone — treated as local), or `TZID`-qualified.
  [icsTimeUtils.ts](../src/context/providers/calendar/icsTimeUtils.ts)
  resolves any IANA `TZID` to the correct UTC instant using `Intl` (no
  UTC assumption), and "today" is always computed in the system's actual
  local zone — the same source `DateTimeProvider` uses.
- **Parser**: a deliberately minimal RFC 5545 parser
  ([icsParser.ts](../src/context/providers/calendar/icsParser.ts)) — UID,
  SUMMARY, DTSTART/DTEND, LOCATION, `X-WR-CALNAME`, line unfolding, text
  unescaping. **Recurrence (`RRULE`) is not expanded** — a recurring
  event appears once, at its literal first occurrence. A malformed event
  (missing UID/DTSTART, unparseable date) is skipped, never thrown.
- **Settings** (`UserPreferences.calendar` in `settingsManager.ts` — user
  data, not a Windows-only setting): a master `enabled` switch (off by
  default — calendar awareness is opt-in) and a `feeds` list, each with
  an `id`, `label`, `address`, and `enabled` flag — supporting multiple
  calendars (e.g. "Work" + "Personal") merged into one `CalendarContext`.
  Managed from the **Calendar** section of the Settings tab; also
  settable via `NIMBUS_CALENDAR_ICS_URL`/`NIMBUS_CALENDAR_LABEL` in
  `.env` as a headless/dev default (only used when enabled but no feed
  is saved yet).
- **Caching**: a 15-minute default via the same
  [TtlCache](../src/common/ttlCache.ts) weather uses, but **dynamic** — once
  the next known event is within an hour, the TTL drops to 2 minutes so
  the briefing stays accurate as something approaches, without
  continuous polling (a broader heartbeat/background-refresh system is
  explicitly out of scope for this task).
- **Failure behavior**: `isAvailable()` is a real check here (unlike
  weather) — calendar is opt-in, so "not enabled" or "no feed configured"
  is `status: "unavailable"`, not an error. Each enabled feed is fetched
  independently (`Promise.allSettled`): one bad feed (revoked link,
  network blip, a rejected/unauthorized response) is logged and skipped
  without affecting the others; only if *every* feed fails does the
  provider throw, which `ContextService` turns into the standard
  error/stale-fallback result — confirmed live (see Known limitations
  for what remains manual).

## Tests

`icsTimeUtils.test.ts` (timezone offset conversion for multiple IANA
zones, local-date/time formatting, date-string arithmetic),
`icsParser.test.ts` (UTC/TZID/floating/all-day date-times, missing
DTEND defaults, `X-WR-CALNAME`, text unescaping, line unfolding,
multiple events, missing UID/DTSTART/malformed-date all skipped rather
than thrown, one bad event not affecting others), `icsCalendarSource.test.ts`
(HTTP fetch, non-ok status, local file reads), `calendarProvider.test.ts`
(availability with 0/1 feeds enabled, no events, one/multiple/all-day
events today, an event tomorrow, an already-ended event, an imminent
event, multiple calendars merged with correct labels, a disabled feed
excluded, one feed failing without affecting another, all feeds failing,
an unauthorized/403 response handled as a normal failure, malformed ICS
content, cache hit/expiry, TTL shrinking near an event, and the env
fallback feed), and calendar-specific cases in `briefingGenerator.test.ts`
(all the message-selection branches, relevance ordering, and omission on
missing/unavailable/errored calendar data). All external calls are
mocked — no test reaches a real calendar. 44 + 12 new tests, alongside
the 39 pre-existing ones (95 total via `npm test`).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
