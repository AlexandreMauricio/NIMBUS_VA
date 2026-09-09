# NIMBUS

**N**avigation & **I**ntelligent **M**onitoring **B**ase for **U**ser **S**ystems

NIMBUS is a personal desktop assistant for Windows, inspired by the idea of
JARVIS but built with its own identity and architecture. This repository
currently contains the **foundation** plus **basic desktop presence**:
application shell, configuration, logging, settings, lifecycle management,
system tray integration, and background operation. No AI, voice, automation,
or integrations are implemented yet — those come later, plugged into the
structure established here.

NIMBUS's long-term direction is multi-device (Windows, Android, possibly
web) sharing a common backend/core rather than independent assistants.
This repo is Windows-only today, but the code is already organized along
that boundary — see **[ARCHITECTURE.md](ARCHITECTURE.md)** for exactly
which modules are portable "Core" versus Windows-specific, and the
guidance for keeping it that way as features are added.

## Technology

- **Electron** — cross-platform desktop shell, runs on Windows with a
  Chromium UI and a Node.js main process.
- **TypeScript** — typed source for both the main process and the UI.
- **dotenv** — loads `.env` for environment-driven configuration.

Chosen because Node.js/npm were the readily available, working toolchain in
this environment (no .NET SDK present), and Electron is a mature, widely
supported way to build a Windows desktop app with room to grow.

## Project structure

```
src/
  main/            App entry point + lifecycle (startup/shutdown, windows,
                   tray, autostart)
  preload/         Electron preload script — the only bridge into the UI
  ui/               Placeholder renderer UI (HTML/CSS/TS)
  config/          Environment/deployment configuration (.env-driven)
  settings/        Persisted user settings (JSON file in userData)
  logging/         File + console logger
  services/        Placeholder for future integrations (empty for now)
  context/         The Context system — providers + aggregator (see below)
  briefing/        The Briefing system — turns Context into a concise,
                   structured morning briefing (see below)
  common/          Shared constants (branding, app info) and the
                   assistant-event contract (see Architecture below)
```

- **UI never talks to Node/Electron directly.** It only calls the small API
  exposed by `src/preload/preload.ts` (context isolation is on).
- **`config` vs `settings`**: `config` is environment/deployment config
  (log level, environment name) read from `.env`. `settings` is persisted,
  user-editable state — split into `WindowsClientSettings` (window bounds,
  launch-with-Windows; Windows-only) and `UserPreferences` (currently just
  weather location; conceptually cross-device data) — see
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **`logging/logger.ts` has no Electron dependency.** File output is
  opt-in via `configureFileLogging(...)`, called once from
  `src/main/main.ts`. This is what lets Core (`context/`, `briefing/`)
  depend on `logger` without dragging in Electron.
- **`services/`** is intentionally empty. Future features (AI/LLM, voice,
  weather, calendar, etc.) should each get their own subdirectory there and
  expose a small interface for `src/main` to call — nothing else should
  import from `services/` directly.

## Desktop presence

NIMBUS behaves like a background assistant, not an ordinary window-based app:

- **System tray icon** ([src/main/tray.ts](src/main/tray.ts)) — always present
  while NIMBUS is running. Click it (or "Open NIMBUS" in its menu) to show
  the main window; "Quit NIMBUS" is the only thing that actually exits.
- **Close-to-tray**: clicking the window's close button hides the window
  instead of quitting the app ([src/main/lifecycle.ts](src/main/lifecycle.ts)).
  NIMBUS keeps running in the background until you quit it from the tray.
- **Launch with Windows** ([src/main/autostart.ts](src/main/autostart.ts)) —
  wraps Electron's native `app.setLoginItemSettings`. Toggle it from the
  Settings tab in the app.
- **Start minimized** — when enabled, NIMBUS starts with only the tray icon
  visible; the window isn't shown until you open it.

Both startup preferences are persisted (see `NimbusSettings.startup` in
[src/settings/settingsManager.ts](src/settings/settingsManager.ts)) and
re-applied every launch.

## Architecture: decoupling future assistant logic from the UI

The task's architecture requirement is that `src/ui` must never know *how*
a message, notification, briefing, or action-request was produced — only
that it received one. That seam exists now, even though nothing produces
events yet:

- [src/common/assistantEvents.ts](src/common/assistantEvents.ts) — the
  shared event contract (`AssistantMessage`, `AssistantNotification`,
  `AssistantBriefing`, `AssistantActionRequest`, unioned as `AssistantEvent`).
- [src/main/assistantBridge.ts](src/main/assistantBridge.ts) — the publish
  point. A future service calls `assistantBridge.publish(event)`; it doesn't
  need a window reference or know about IPC.
- `preload.ts` exposes `window.nimbus.onAssistantEvent(callback)` so the
  renderer can subscribe without any Electron/Node access.
- The Home tab's "feed" area is the (currently empty) place those events
  would render.

When AI/automation/other systems are added later, they publish through
`assistantBridge` from their own module under `src/services/` — `src/main`
and `src/ui` don't change.

## The Context system

NIMBUS's first real capability: a way to ask "what is the current
context?" and get back structured, self-describing data — the
information layer the future intelligence layer will eventually reason
over. No AI/LLM is involved at this layer; it's plumbing.

- [src/context/types.ts](src/context/types.ts) — the contract.
  `ContextProvider` is deliberately tiny: `id`, `displayName`,
  `isAvailable()`, `getContext()`. `ContextProviderResult` is what every
  provider call resolves to, win or lose — `status` (`ok` / `error` /
  `unavailable`), `data`, an optional `error` message, a `timestamp`, and
  a `stale` flag.
- [src/context/contextService.ts](src/context/contextService.ts) — the
  aggregator. `ContextService.register(provider)` adds a provider;
  `getSnapshot()` queries all of them concurrently and returns one
  `ContextSnapshot` (`{ generatedAt, providers: { [id]: result } }`).
- [src/context/providers/](src/context/providers/) — the implementations
  shipped so far: `DateTimeProvider` (date, time, IANA timezone, day of
  week — clock is injectable for deterministic tests), `SystemInfoProvider`
  (platform, OS release, CPU count, memory, uptime; read-only, nothing
  leaves the machine), and `WeatherProvider` (see below).
- [src/context/index.ts](src/context/index.ts) — the single
  `contextService` instance the app uses, pre-registered with the
  providers that don't need runtime settings (`DateTimeProvider`,
  `SystemInfoProvider`). `WeatherProvider` is registered separately, in
  `src/main/lifecycle.ts`, because it needs live settings access — see
  below. A future *settings-independent* provider (news, system status,
  ...) is a new file under `providers/` plus one `.register(...)` call in
  `context/index.ts`; one that needs live settings follows the weather
  pattern instead.

**Failure isolation is the load-bearing design constraint.** `collect()`
inside `ContextService` wraps every `isAvailable()`/`getContext()` call so
a provider can never throw past the service boundary:

- `isAvailable()` returning `false` (or throwing) → `status: "unavailable"`,
  `getContext()` is never called.
- `getContext()` throwing/rejecting → logged via `logger.error`, and the
  result falls back to the **last known-good data** for that provider if
  one exists, marked `stale: true`; otherwise `data: null` with the error
  message attached.
- One provider failing never affects another's result — each is collected
  independently and the snapshot is assembled from whatever each returned.

This is why "if WeatherProvider eventually fails, NIMBUS should still
function normally" holds: a failing provider degrades to a structured
error entry in the snapshot, not an exception that propagates.

The main process exposes this via `nimbus:get-context`
(`src/main/lifecycle.ts`) → `window.nimbus.getContext()`
(`src/preload/preload.ts`) → the **Context** tab in the UI, which just
renders whatever `ContextSnapshot` it's handed (status badges, a "stale"
badge when relevant, and the provider's fields) — it doesn't know how any
of that data was produced.

### Tests

```bash
npm test
```

Compiles the project and runs `src/context/**/*.test.ts` (compiled to
`dist/context/**/*.test.js`) under Node's built-in test runner (`node:test`
— no test framework dependency added). Coverage: `ContextService`
aggregation, error/unavailable/stale handling, isolation between
providers, duplicate-id registration, plus `DateTimeProvider` (fixed-clock
date/time/day-of-week correctness) and `SystemInfoProvider` (plausible
system values).

## Weather

NIMBUS's first *external* context provider —
[src/context/providers/weather/](src/context/providers/weather/) — built
entirely on top of the Context architecture above. Nothing about
`ContextService` or the UI changed to add it.

- **Service**: [Open-Meteo](https://open-meteo.com) — free, **no API key
  required**. If NIMBUS ever needs a keyed provider instead, read the key
  through `config.ts` (env-var backed) the same way
  `weatherManualLocation` is read there, and let a missing key throw a
  descriptive error from the client — `ContextService` already turns that
  into a graceful "unavailable" result, so the "fail gracefully if
  credentials are missing" requirement falls out of the existing
  architecture rather than needing new code.
- **Data returned** ([types.ts](src/context/providers/weather/types.ts)):
  current temperature, apparent (feels-like) temperature, condition
  (mapped from Open-Meteo's WMO weather code), today's precipitation
  probability, today's high/low, a 3-day forecast, the location used, and
  an `retrievedAt` timestamp of the underlying API call (separate from the
  provider result's own `timestamp`, which reflects when the context
  system asked).
- **Location** — configurable, not hard-coded
  ([locationResolver.ts](src/context/providers/weather/locationResolver.ts)):
  - **Automatic** (default): resolves an approximate location from the
    machine's public IP via [geojs.io](https://www.geojs.io/) (also free,
    no key), cached for 1 hour since location rarely changes.
  - **Manual**: a fixed latitude/longitude/label, set from the Settings
    tab (**Weather location**) or via `NIMBUS_WEATHER_LAT` /
    `NIMBUS_WEATHER_LON` / `NIMBUS_WEATHER_LOCATION_LABEL` in `.env` as a
    default for headless/dev use before any UI setting is saved. This is
    the "user can choose automatic vs. manual" system the task asked for;
    the mode itself is persisted in `NimbusSettings.weather.locationMode`.
- **Caching** — two independent layers, both via the generic
  [TtlCache](src/common/ttlCache.ts):
  1. `WeatherProvider` itself caches a fetched `WeatherContext` for 10
     minutes, so repeated `getSnapshot()` calls (e.g. the UI's Refresh
     button, or a future polling loop) don't hit Open-Meteo unnecessarily.
  2. `LocationResolver` caches an auto-resolved IP location for 1 hour,
     independent of the weather-data cache.
- **Failure behavior**: `WeatherProvider.isAvailable()` is always `true`
  (weather isn't something cheaply pre-checkable, unlike a static OS
  feature flag) — a real failure (no network, geolocation service down,
  manual mode with nothing configured, Open-Meteo erroring) surfaces as a
  thrown error from `getContext()`. `ContextService` catches that exactly
  like any other provider: logs it, and returns `status: "error"` (falling
  back to the last successful weather data, marked `stale: true`, if one
  exists) — `dateTime` and `system` are entirely unaffected. NIMBUS never
  fabricates weather data it doesn't have.

### Tests

Weather-specific tests live alongside the other provider tests, run via
`npm test`: `openMeteoClient.test.ts` (response mapping, HTTP-failure
error message, unknown weather codes), `locationResolver.test.ts` (manual
mode, manual→env fallback, manual with nothing configured, auto mode,
auto-location caching, geolocation failure propagation),
`weatherProvider.test.ts` (availability, structured output, cache
hit/expiry using an injectable clock, failures propagating for
`ContextService` to catch), and `weatherProvider.integration.test.ts` —
the exact scenario from the task ("if WeatherProvider eventually fails,
NIMBUS should still function normally"), registering a failing
`WeatherProvider` into a real `ContextService` alongside `DateTimeProvider`
and asserting the failure is contained. All network calls are mocked via
an injected `fetch` — no test hits the real APIs.

## Calendar

The second external context provider —
[src/context/providers/calendar/](src/context/providers/calendar/) —
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
  [icsCalendarSource.ts](src/context/providers/calendar/icsCalendarSource.ts).
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
- **Data model** ([types.ts](src/context/providers/calendar/types.ts)):
  `CalendarEvent` (id, title, start/end as ISO instants, `isAllDay`,
  `location`, `calendarName`); `CalendarContext` groups events into
  `todayEvents` / `laterEvents` (a 7-day lookahead) plus a `nextEvent`
  convenience field — the "which events are past/ongoing/upcoming"
  distinction is a pure helper (`classifyEvent`) rather than baked into
  the stored shape, so the data stays plain facts.
- **Timezone correctness**: ICS date-times come as UTC (`...Z`),
  "floating" (no zone — treated as local), or `TZID`-qualified.
  [icsTimeUtils.ts](src/context/providers/calendar/icsTimeUtils.ts)
  resolves any IANA `TZID` to the correct UTC instant using `Intl` (no
  UTC assumption), and "today" is always computed in the system's actual
  local zone — the same source `DateTimeProvider` uses.
- **Parser**: a deliberately minimal RFC 5545 parser
  ([icsParser.ts](src/context/providers/calendar/icsParser.ts)) — UID,
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
  [TtlCache](src/common/ttlCache.ts) weather uses, but **dynamic** — once
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

### Tests

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

## Email

The third external context provider —
[src/context/providers/email/](src/context/providers/email/) — following
the same adapter pattern as weather and calendar: `EmailProvider`
implements `ContextProvider<EmailContext>`, with the actual IMAP protocol
code isolated behind a small source interface. NIMBUS is aware of your
inbox for the purpose of the morning briefing — **it is not an email
client**: there's no inbox viewer, no reading individual messages, and no
send/reply/delete/archive/mark-read/move/forward actions anywhere.

- **Integration chosen**: IMAP (via the [imapflow](https://imapflow.com/)
  library), connecting **read-only**
  (`getMailboxLock(path, { readOnly: true })` — asserted in
  [imapEmailSource.ts](src/context/providers/email/imapEmailSource.ts) and
  covered by a test that fails if that flag is ever dropped). Like
  Calendar's ICS choice, this needs no OAuth app registration: Gmail,
  Outlook, and iCloud all support connecting an IMAP client with an
  app-specific password generated from the account's own security
  settings, so there's no developer credential to provision in this
  environment. The password is a credential like the calendar feed URL —
  stored only in the local `settings.json`, never logged (log calls only
  ever include an account's `label`/`id`, see `emailProvider.ts`), and,
  unlike the calendar URL, **never sent back to the renderer at all**: the
  Settings API returns `hasPassword: boolean` instead of the value itself,
  and a saved password is only replaced when the form explicitly submits a
  `newPassword` (see `nimbus:get-email-settings`/`nimbus:update-email-settings`
  in `lifecycle.ts`) — toggling an account on/off or editing another field
  never wipes it.
- **Multi-device/OAuth boundary**: `EmailProvider` depends only on
  `ImapEmailSource.fetchRecentMessages()` — see
  [imapEmailSource.ts](src/context/providers/email/imapEmailSource.ts). A
  future OAuth-based source (Gmail API, Microsoft Graph) would implement
  the same "give me recent messages" role and plug in without
  `EmailProvider`, `ContextService`, the briefing, or the UI changing —
  the same boundary Calendar's `IcsCalendarSource` already demonstrates.
  Real OAuth is out of scope here for the same reason as Calendar's.
- **Data model** ([types.ts](src/context/providers/email/types.ts)):
  `EmailMessage` carries only metadata and a short preview — message and
  thread id, sender name/address, subject, received timestamp, read/
  flagged state, labels, a `snippet` (≤160 characters, HTML-stripped,
  whitespace-collapsed), the source `accountId`, and a computed
  `importance` tier with the `signals` that produced it. **Full message
  bodies are never retrieved or stored** — see "Snippet fetching" below.
  `EmailAccountInfo` (id/label/address only, never a password) keeps
  account identity separate from messages, so `EmailContext.accounts` can
  list multiple accounts without duplicating that data onto every message;
  each `EmailMessage.id` is namespaced as `${accountId}:${uid}` so UIDs
  from different accounts never collide.
- **Snippet fetching is opt-in per message**: before downloading any body
  content, `EmailProvider` runs the same deterministic classifier against
  cheap signals only (sender, subject, unread/flagged state) via
  `isPreliminarilyNoteworthy()`; a snippet is only fetched for messages
  that already look potentially important from that check. Ordinary/
  automated mail never has its body touched at all — satisfying "avoid
  unnecessarily retrieving full email bodies" while still supporting a
  preview field when one is warranted. Snippet downloads are capped at
  2048 bytes and a fetch failure returns `null` rather than failing the
  whole message.
- **Deterministic importance** ([emailImportance.ts](src/context/providers/email/emailImportance.ts)) —
  **no LLM anywhere in this feature**. A small point-based scorer (unread
  +1, flagged +3, an attention keyword in the subject/sender +3 — invoice,
  payment, verification code, security alert, password, deadline, etc. —
  automated/newsletter sender or subject patterns −2) maps to
  `low`/`normal`/`important`/`high`. Every message keeps its raw
  `signals`, so the reasoning behind a tier is inspectable, and briefing
  language is always hedged ("may require your attention"), never a
  certainty claim.
- **Settings** (`UserPreferences.email` in `settingsManager.ts`): a master
  `enabled` switch (off by default) and an `accounts` list, each with
  `id`/`label`/`host`/`port`/`secure`/`username`/`sinceDays`/`enabled` plus
  a locally-stored `password` — supporting multiple accounts the same way
  Calendar supports multiple feeds. Managed from the **Email** section of
  the Settings tab; also settable via `NIMBUS_EMAIL_HOST`/`PORT`/`SECURE`/
  `USERNAME`/`PASSWORD`/`LABEL` in `.env` as a headless/dev default (only
  used when enabled but no account has been saved yet).
- **Caching**: a 5-minute default via the same
  [TtlCache](src/common/ttlCache.ts) weather and calendar use — shorter
  than either, since a mailbox is more dynamic. Still simple polling (no
  IMAP IDLE/push), but the data model already carries what a future
  incremental-refresh/heartbeat system would need (per-message
  read/flagged state, `retrievedAt`) without requiring another shape
  change.
- **Relevance**: the briefing never just reports a raw inbox count. Recent
  messages are capped (`MAX_RECENT_MESSAGES_SAMPLE = 20` fetched per
  account, `MAX_IMPORTANT_MESSAGES = 5` surfaced), and the message builder
  in `briefingGenerator.ts` only escalates language when there's an actual
  unread-and-high-importance message, or at least one `important`/`high`
  message among the recent set — 30 newsletters landing overnight
  produces the same calm "nothing important came in overnight" line as an
  empty inbox, not "You have 30 emails."
- **Failure behavior**: like Calendar, `isAvailable()` treats "not enabled"
  or "no account configured" as `status: "unavailable"`, not an error.
  Each enabled account is fetched independently (`Promise.allSettled`):
  one bad account (wrong password, DNS failure, expired auth, rate
  limiting) is logged — account label/id and error message only, **never
  the password** — and skipped without affecting the others; only if
  *every* account fails does the provider throw, which `ContextService`
  turns into the standard error/stale-fallback result. Confirmed live: a
  fake IMAP host produces `[WARN] Email account "..." failed` in the log
  with no credential in it, `status: "error"` on the Context tab, and a
  briefing that still generates normally (weather/calendar/dateTime
  intact) with the email item simply omitted.

### Tests

`emailImportance.test.ts` (every scoring branch: newsletter/no-reply →
low, plain read/unread → normal, a keyword match, a bank-like sender, a
flagged message → important, unread+flagged and unread+keyword → high,
signals always present on the result), `imapEmailSource.test.ts` (empty
results, most-recent-first ordering, a `maxMessages` cap, unread/flagged
flag mapping, snippet only fetched when the predicate says so, snippet
HTML-stripping/whitespace-collapse/160-char truncation, a snippet fetch
failure returning `null` instead of throwing, no text part found, the
read-only mailbox-lock assertion, always logging out even after a search
failure, a connection failure propagating as a rejection),
`emailProvider.test.ts` (availability with 0/1 accounts enabled, no
messages, unread counting, ordering across multiple messages, an
important message via keyword, a potentially-important unread+flagged
message ranked first, a newsletter excluded from "important", thread
messages counted, malformed/sparse raw data not crashing the mapper, an
auth failure on the only account rejecting `getContext()`, one account
failing without blocking another, all accounts failing rejecting, cache
hit within TTL, multiple accounts merged with distinct namespaced message
ids, account identity in `EmailContext.accounts` never including a
password, a per-account `sinceDays` override, the default window
computation, the env-fallback account used only when no account is
saved), `emailProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider` alongside a deliberately broken `EmailProvider` —
proves email failing produces a valid `Briefing` with every other item
intact and email cleanly omitted), and email-specific cases in
`briefingGenerator.test.ts` (no recent mail, singular/plural unread-count
phrasing, the "N received / M may require attention" phrasing matched
exactly to the task's own example, the unread-and-important spotlight by
sender name and by address when no name is present, omission on missing/
unavailable/errored email data, and priority ranking against other
categories). All IMAP calls are mocked via a hand-built fake client — no
test reaches a real mail server or needs a real account. 55 new tests,
alongside the 95 pre-existing ones (150 total via `npm test`).

## Tasks

The fourth external context provider —
[src/context/providers/tasks/](src/context/providers/tasks/) — following
the same adapter pattern as weather, calendar, and email: `TaskProvider`
implements `ContextProvider<TaskContext>` for the morning briefing, with
the actual Todoist REST API code isolated behind a small source class.
NIMBUS also has a full **Tasks tab** (its own sidebar entry, mirroring
the Routines tab's list/grid/create-edit pattern) for actually managing
tasks — list/grid view, sorting, and creating/editing/completing/
deleting — see "The Tasks tab" below. Everything written there goes
straight to Todoist; NIMBUS keeps no separate copy of a task.

- **Integration chosen**: [Todoist](https://todoist.com)'s unified API v1
  (`api.todoist.com/api/v1` — Todoist retired the old `/rest/v2` API,
  which now returns `410 Gone`; see `todoistTaskSource.ts`'s pagination
  handling for the other consequence of that migration: v1 list
  endpoints return a paginated `{ results, next_cursor }` envelope
  instead of a plain array), authenticated with a personal API token
  (Settings > Integrations > Developer in Todoist) — the same reasoning
  as Calendar's ICS URL and
  Email's IMAP app password: no OAuth app registration needed, since the
  user generates the credential themselves. Todoist was picked over
  building a CalDAV/VTODO source (the other no-OAuth option, mirroring
  Calendar's approach) because it's a plain JSON REST API with clean due
  date/priority/project fields, keeping the source module small and easy
  to test against a fake `fetch`. The token is sent only as a `Bearer`
  auth header ([todoistTaskSource.ts](src/context/providers/tasks/todoistTaskSource.ts)),
  stored only in the local `settings.json`, never logged (log calls only
  ever include an account's `label`/`id`, see `taskProvider.ts`), and —
  like the email password, unlike the calendar URL — **never sent back to
  the renderer at all**: the Settings API returns `hasApiToken: boolean`
  instead of the value itself, using the exact same write-only merge
  pattern as `nimbus:update-email-settings` (see
  `nimbus:get-task-settings`/`nimbus:update-task-settings` in
  `lifecycle.ts`).
- **Multi-device/OAuth boundary**: `TaskProvider` depends only on
  `TodoistTaskSource.fetchActiveTasks()` — see
  [todoistTaskSource.ts](src/context/providers/tasks/todoistTaskSource.ts).
  A future second connector (a different task app, a local list, a
  CalDAV/VTODO source) implements the same method and plugs in without
  `TaskProvider`, `ContextService`, the briefing, or the UI changing —
  the account shape already carries a `provider` field for exactly this,
  even though only `"todoist"` exists today.
- **Data model** ([types.ts](src/context/providers/tasks/types.ts)):
  `TaskItem` carries id, title, an optional description, an optional due
  date/time (with a `dueIsDateOnly` flag distinguishing an all-day due
  date from a specific time), completed state, an explicit `priority`
  (the source app's own marking, when available), a `reminderAt`, the
  originating `source`/`listName`, timestamps, and both a computed
  `category` (`overdue` / `dueToday` / `upcoming` / `noDeadline`) and a
  computed `urgency` tier with its raw `signals` — see "Relevance" below.
  `TaskAccountInfo` (id/label/provider only, never a token) keeps account
  identity separate from tasks, the same way `EmailAccountInfo` does;
  each `TaskItem.id` is namespaced as `${accountId}:${rawId}` so two
  accounts' ids never collide.
- **Completed tasks are never surfaced**: Todoist's REST API simply
  doesn't return completed tasks from its `/tasks` endpoint, which
  already satisfies "don't normally show completed tasks" at the source
  level rather than needing a filter after the fact — `TaskProvider`
  still filters defensively (`buildContext` drops any `completed: true`
  item from every bucket), so a future source that *does* return
  completed tasks stays correct too.
- **Reminders**: Todoist's REST API has no separate "reminder" concept
  without its separate Sync API (a premium feature at that), so
  `reminderAt` is populated from a task's own specific due *time* when it
  has one — the closest honest equivalent available without a second API
  surface. This is intentionally just data exposure (per the task's own
  scope): the architecture is ready for NIMBUS to eventually say
  "Reminder: you wanted to call John" or "you have a reminder in 20
  minutes," but no autonomous notification/heartbeat system is built
  here — that's a separate future feature.
- **Timezone correctness**: category bucketing (`overdue`/`dueToday`/
  `upcoming`) is computed by comparing each task's due date, converted to
  the user's actual local calendar date via
  [icsTimeUtils.localCalendarDate](src/context/providers/calendar/icsTimeUtils.ts)
  (the same timezone-aware helper Calendar uses — reused rather than
  duplicated), against "today" in that same zone — never a raw UTC date
  comparison.
- **Deterministic urgency** ([taskRelevance.ts](src/context/providers/tasks/taskRelevance.ts)) —
  **no LLM/AI anywhere in this feature**. A small point-based scorer
  (overdue, due today, due within 2 hours, the source's own high-priority
  marking, an approaching reminder, and a small "still open after 2+
  weeks" staleness nudge) maps to `low`/`normal`/`important`/`high`,
  weighted so that an overdue task and a task due very soon each reach
  `high` on their own — matching the task's own examples ("an overdue
  task should have high relevance," "a task due in 30 minutes should have
  very high relevance") without needing another signal stacked on top.
  Every task keeps its raw `signals`, so the reasoning behind a tier is
  inspectable by a future Intelligence layer, not just a bare verdict.
- **Settings** (`UserPreferences.tasks` in `settingsManager.ts`): a master
  `enabled` switch (off by default) and an `accounts` list, each with
  `id`/`label`/`provider`/`enabled` plus a locally-stored `apiToken` —
  supporting multiple accounts the same way Calendar/Email support
  multiple feeds/mailboxes. Managed from the **Tasks** section of the
  Settings tab; also settable via `NIMBUS_TASKS_TODOIST_TOKEN`/
  `NIMBUS_TASKS_LABEL` in `.env` as a headless/dev default (only used
  when enabled but no account has been saved yet).
- **Caching**: a 5-minute default via the same
  [TtlCache](src/common/ttlCache.ts) weather/calendar/email use, dropping
  to 1 minute once some task's due time is within the 2-hour "imminent"
  window — the same proximity-based TTL-shrink idea as Calendar's, just
  with different thresholds. Still simple polling (no push/webhook), but
  the data model (per-task `category`/`urgency`, `retrievedAt`) already
  carries what a future incremental-refresh/heartbeat system would need.
- **Relevance**: the briefing never just reports a raw task count without
  regard for what actually matters. A task due imminently is spotlighted
  by itself regardless of how many other tasks exist; otherwise overdue
  and due-today counts are combined into one message, and a single named
  task is called out when there's exactly one or when highlighting the
  first of several — see "Briefing behavior" in `briefingGenerator.ts`'s
  `buildTasksItem`.
- **Failure behavior**: like Calendar/Email, `isAvailable()` treats "not
  enabled" or "no account configured" as `status: "unavailable"`, not an
  error. Each enabled account is fetched independently
  (`Promise.allSettled`): one bad account (invalid token, Todoist down,
  rate limiting) is logged — account label/id and error message only,
  **never the API token** — and skipped without affecting the others;
  only if *every* account fails does the provider throw, which
  `ContextService` turns into the standard error/stale-fallback result.
  Confirmed live: a fake API token produces `[WARN] Task account "..."
  failed` in the log with no credential in it, `status: "error"` on the
  Context tab, and a briefing that still generates normally (weather/
  calendar/dateTime intact) with the task item simply omitted.

### The Tasks tab

Its own sidebar entry, not nested inside Settings — same reasoning as
the Routines tab getting one: a growing task list shouldn't crowd
Settings into a control panel. Mirrors the Routines tab's own
list/grid-toggle and one-form-for-create-and-edit pattern, applied to a
completely unrelated concept (no code is shared beyond that shape).

- **List/grid view** (remembered per-browser via `localStorage`, same as
  Routines') and a **sort** dropdown (due date / priority / title /
  recently added) — all client-side over whatever `nimbus:list-tasks`
  returns, so switching sort order never re-fetches.
- **This is the full active task list**, not the briefing's
  bucketed-and-capped-at-20-per-category view — `TaskProvider.listAllTasks()`
  is a separate method from `getContext()` precisely because a management
  view and a briefing summary have different shapes and different
  freshness needs (this always re-fetches; the briefing stays cached).
- **Create/edit** form: title, optional description, optional due date
  (a plain date — no natural-language recurrence parsing, matching the
  "don't over-engineer" scope elsewhere in this app), priority
  (none/low/medium/high — NIMBUS's own read-side labels, translated to
  Todoist's numeric scale on write so the form and the task cards speak
  the same vocabulary instead of exposing Todoist's own P1-P4 UI
  inversion), and an optional project/list (fetched live from Todoist via
  `nimbus:list-task-projects`).
- **Complete** is a checkbox on each card — Todoist's `/tasks` endpoint
  never returns completed tasks at all, so a completed task simply
  disappears from the list on the next refresh rather than needing a
  "show completed" toggle anywhere.
- **Delete asks for confirmation** (a plain `confirm()` — this is the one
  genuinely irreversible action in the tab) before calling through.
- **Write endpoints**: `POST /tasks` (create), `POST /tasks/{id}` (update
  — only the fields actually changed are sent, so an edit never silently
  clears an untouched field), `POST /tasks/{id}/close` /
  `POST /tasks/{id}/reopen`, `DELETE /tasks/{id}` — all in
  [todoistTaskSource.ts](src/context/providers/tasks/todoistTaskSource.ts),
  same Bearer-token auth as every read.
- **Multi-account note**: `TaskProvider.createTask` writes to the first
  configured account (most setups have exactly one); `updateTask`/
  `completeTask`/`reopenTask`/`deleteTask` resolve the right account from
  a task's own namespaced id (`${accountId}:${rawId}`) instead, so those
  four already work correctly across multiple accounts even without a
  picker in the create form.

### Tests

`taskRelevance.test.ts` (every scoring branch: no signals → low, a
completed task always low regardless of other signals, overdue alone →
high, due-today alone → normal-or-higher, the imminent-window boundary at
exactly 120/121 minutes, overdue+due-today+high-priority combined → high,
explicit priority/reminder-approaching/staleness signals each reflected
and nudging urgency up, signals always present on the result),
`todoistTaskSource.test.ts` (empty results, a task with a specific due
time mapped with a matching reminder, a date-only due date mapped with no
reminder, no due field at all, a missing `content` field defaulting to a
placeholder title, a task in an unknown project getting a null list name,
a failed projects request still letting tasks through, a non-ok tasks
response throwing descriptively, the token sent only as a `Bearer`
header — never a query parameter or body — and malformed/sparse task
objects not crashing the mapper), `taskProvider.test.ts` (availability
with 0/1 accounts enabled, no tasks, completed tasks excluded from every
bucket and from the active total, a task with no due date bucketed as
`noDeadline`, multiple tasks correctly bucketed across all four
categories, overdue vs. due-today vs. tomorrow-is-upcoming boundary
correctness, a far-future task at low urgency, a reminder carried through
to context, an explicit high priority mapped and reflected in signals, a
due-soon task reaching high urgency, malformed/sparse data not crashing
the provider, an auth failure on the only account rejecting
`getContext()`, one account failing without blocking another, all
accounts failing rejecting, cache hit within TTL, multiple accounts
merged with distinct namespaced task ids, account identity never
including the API token, timezone-aware bucketing using the resolved
local zone, and the env-fallback account used only when no account is
saved), `taskProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider`/`EmailProvider` alongside a deliberately broken
`TaskProvider` — proves tasks failing produces a valid `Briefing` with
every other item intact and the tasks item cleanly omitted), and
task-specific cases in `briefingGenerator.test.ts` (no active tasks,
multiple/single tasks due today with and without naming one, singular/
plural overdue phrasing, the overdue-and-due-today mixed message matched
exactly to the task's own example, an imminent task spotlighted with a
time estimate and taking priority over the count messages, a date-only
(all-day) task never treated as imminent, omission on missing/
unavailable/errored task data, and priority ranking against other
categories). All Todoist API calls are mocked via a fake `fetch` — no
test reaches the real Todoist API or needs a real account. 62 new tests,
alongside the 150 pre-existing ones (212 total via `npm test`).

## The Action system

Everything above this point is NIMBUS *observing*. This is where NIMBUS
starts being able to *do* something — the foundation for that distinction
is [src/actions/](src/actions/), a new system deliberately kept separate
from Context rather than bolted onto it:

- **Context** answers "what is happening?" — read-only, safe to fetch
  freely, and every provider's `getContext()` never changes anything
  outside NIMBUS.
- **Action** answers "do something." — may change external state (skip a
  song, eventually: send an email, lock the PC), and always returns a
  structured result instead of a value to read.

[src/actions/types.ts](src/actions/types.ts) defines the contract, mirroring
`ContextProvider`/`ContextProviderResult` in shape and spirit:

- `ActionDefinition` — static, inspectable metadata about one action: id
  (namespaced by provider, e.g. `"spotify.play"`), name, description, a
  parameter schema, and four safety flags — `readOnly`,
  `changesExternalState`, `requiresConfirmation`, `affectsService`. This
  is what a future permission system or confirmation UI would read
  *before* calling the action — seeded now with the "harmless things don't
  need confirmation, an eventually-added destructive action would set
  `requiresConfirmation: true`" reasoning the task called for, but nothing
  in `ActionService` reads or enforces `requiresConfirmation` yet (see
  "known limitations" below).
- `ActionResult` — what every action returns regardless of provider:
  `status` ("success" | "failure"), optional `data`/`message` on success,
  a structured `error` (a coarse `category` plus a user-safe `message`,
  never a raw API error) on failure, and timing (`startedAt`/
  `finishedAt`/`durationMs`). The UI never needs to understand a
  provider's own API response shape — see "Action results" below.
- `ActionProvider` — the interface every action provider implements:
  `listActions()`, `isAvailable()`, `validate(actionId, params)`,
  `execute(actionId, params)`. A provider owns every action under its own
  id prefix (`"spotify.*"` today).
- [ActionService](src/actions/actionService.ts) — the Action-system
  analogue of `ContextService`. Aggregates registered providers and is the
  single entry point (`executeAction(actionId, params)`): resolves the
  owning provider from the id prefix, checks `isAvailable()`, validates
  params, executes, and — critically — **never lets a provider's
  exception propagate**. A provider throwing, rejecting, or reporting
  itself unavailable always degrades to a structured `ActionResult`
  (`status: "failure"`, a coarse `error.category`), the same
  failure-isolation guarantee `ContextService` already makes for Context
  providers. Also keeps a small in-memory ring buffer (last 50 results,
  most recent first) via `getHistory()` — a lightweight foundation for
  "what did I just ask you to do?", not a full audit log/UI.
- `src/actions/index.ts` exports the application's single `actionService`
  instance — like `contextService`, no providers are pre-registered there
  (Spotify needs live settings/auth), so registration happens in
  `src/main/lifecycle.ts`.

### Action safety, today vs. later

The task was explicit that this establishes a *foundation*, not a full
permission system: `ActionDefinition` carries accurate
`changesExternalState`/`requiresConfirmation` metadata (every Spotify
action today is `changesExternalState: true`, `requiresConfirmation:
false` — playing/pausing/skipping is harmless and easy to undo), and a
caller (the future Intelligence layer, or a confirmation UI) is expected
to read that metadata before calling `executeAction`. `ActionService`
itself does not check `requiresConfirmation` or gate on any permission —
building that enforcement is explicitly future work; what exists now is
the shape it would read.

### Tests

`actionService.test.ts`: a valid/available action succeeds; an unknown
action id fails with `not_available`; an unavailable provider fails
without ever calling `execute`; invalid parameters fail validation
without ever calling `execute`; a provider's own structured failure
passes through unchanged; a provider throwing from `execute()` or
`isAvailable()` degrades to a structured failure instead of propagating;
`listActions()` surfaces each provider's permission/confirmation
metadata; `getHistory()` records executed actions most-recent-first;
registering two providers with the same id throws. No real service is
involved — a hand-built stub `ActionProvider` exercises `ActionService`
in isolation.

## Spotify

The first real Action Provider — [src/actions/providers/spotifyActionProvider.ts](src/actions/providers/spotifyActionProvider.ts)
— plus a companion Context Provider for the read side —
[src/context/providers/spotify/](src/context/providers/spotify/). The
split matters: **"what's playing" is Context, "play this" is an Action**
— the task was explicit that a read operation must never be forced into
the Action system, so `spotify.currentPlayback` does not exist as an
action; it's `SpotifyContextProvider.getContext()` instead, fitting the
existing Context architecture exactly like weather/calendar/email/tasks.

- **Integration chosen**: Spotify's Web API, authenticated with
  **Authorization Code + PKCE** — the flow Spotify's own docs recommend
  for installed/desktop apps specifically because it needs no client
  secret at all (unlike the classic Authorization Code flow). This was
  the deciding factor: NIMBUS can talk to Spotify with only a public
  Client ID from the user's own free Spotify Developer app registration
  (https://developer.spotify.com/dashboard) — there is no client secret
  to ever generate, store, or accidentally leak. Playback control
  (play/pause/skip/volume/search) requires a Spotify Premium account on
  Spotify's side — a `PREMIUM_REQUIRED` API response is mapped to a clear
  "Spotify playback control isn't available right now" failure rather
  than a technical error (see "Error handling" below).
- **Authentication flow**
  ([spotifyAuthManager.ts](src/main/spotify/spotifyAuthManager.ts),
  [spotifyPkce.ts](src/main/spotify/spotifyPkce.ts)): clicking "Connect"
  in Settings generates a PKCE code verifier/challenge and a CSRF `state`
  value, opens the user's **system browser** to Spotify's own sign-in
  page (`shell.openExternal` — NIMBUS never sees the Spotify password),
  and starts a temporary local HTTP server on `127.0.0.1:<redirect
  port>/callback` to catch the redirect. Once Spotify redirects back with
  an authorization code, it's exchanged for an access + refresh token
  (again, no client secret involved) and the local server shuts down.
  Requests only the three scopes actually needed
  (`user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`) — nothing broader like library or
  profile access.
- **Token storage**
  ([spotifyTokenStore.ts](src/main/spotify/spotifyTokenStore.ts)): unlike
  every other provider's credential (calendar's ICS URL, email's IMAP
  password, tasks' API token — all plain strings in `settings.json`),
  Spotify's tokens are encrypted at rest using Electron's `safeStorage`
  (Windows DPAPI, tied to the OS user account) and written to their own
  file (`spotify-tokens.json` in the userData directory), never
  `settings.json`. If OS-level secure storage isn't available on a given
  machine, NIMBUS fails safe — it declines to persist tokens rather than
  falling back to plaintext — logging a warning instead (see "Known
  limitations").
- **Multi-device/Electron boundary**: `SpotifyApiClient` (Core, see
  [spotifyApiClient.ts](src/context/providers/spotify/spotifyApiClient.ts))
  depends only on an injected `getAccessToken(): Promise<string | null>`
  function — it has no idea a browser was opened or a local HTTP server
  was involved. `SpotifyAuthManager` is the *only* Spotify module that is
  inherently Electron/Windows-shaped; both `SpotifyContextProvider` and
  `SpotifyActionProvider` (Core) are handed nothing but that one function
  plus an `isAuthenticated()` check. A future Android client implements
  the same role with its platform's equivalent of "open a browser and
  catch a redirect" (typically a Custom Tab + App Link) without either
  Core class changing.
- **Actions implemented** (all under `spotify.*`, none require
  confirmation — see "Action safety" above):
  `play`, `pause`, `next`, `previous`, `setVolume` (validates
  `0 ≤ volumePercent ≤ 100` before ever calling Spotify), `playSearch`
  (searches track/artist/album — defaults to track — and plays the best
  match; returns a `not_found` failure with "I couldn't find that on
  Spotify." when nothing matches), and `playPlaylist` (searches playlists
  by name and plays the first match via its context URI).
- **Spotify Context**
  ([types.ts](src/context/providers/spotify/types.ts)): `playbackState`
  ("playing" | "paused" | "stopped"), the current `track` (name, artists,
  album, duration, artwork URL) when one exists, `progressMs`,
  `volumePercent`, and `device` info (id/name/type/active) when Spotify
  reports one. `isAvailable()` is a real, cheap check (enabled +
  connected), so "not connected yet" is `status: "unavailable"`, not an
  error — same pattern as Calendar/Email/Tasks.
- **Caching**: a 20-second default via the same
  [TtlCache](src/common/ttlCache.ts) every other provider uses — short
  enough that "what's playing" stays reasonably fresh, long enough that
  NIMBUS never polls Spotify on every single context fetch.
- **Error handling**
  (`SpotifyApiError`/`SpotifyApiErrorCategory` in `spotifyApiClient.ts`):
  every failure Spotify's API can return is mapped to one of a small set
  of categories — `not_authenticated` (401, or no token at all),
  `no_active_device` (a 404 with Spotify's own `NO_ACTIVE_DEVICE` reason
  code), `not_found` (any other 404, e.g. a search miss),
  `rate_limited` (429), `not_available` (403, including
  `PREMIUM_REQUIRED`), `network` (the request never reached Spotify at
  all), or `unknown`. `SpotifyActionProvider` turns each category into
  exactly the kind of user-safe sentence the task asked for — "I couldn't
  find that on Spotify.", "There's no active Spotify device available." —
  never a raw "Spotify API returned HTTP 404" string. None of this can
  crash NIMBUS: a Spotify failure surfaces as `status: "error"` on the
  Context tab or a structured `ActionResult` failure, exactly like every
  other provider's failure mode.
- **Settings** (`UserPreferences.spotify` in `settingsManager.ts`): a
  master `enabled` switch (off by default) and an optional
  `preferredDeviceId` — connection state itself is *not* a settings
  field; it's derived live from whether `SpotifyAuthManager` has a stored
  refresh token, so it can never drift out of sync with the actual
  tokens. Managed from the **Spotify** section of the Settings tab
  (enable toggle, Connect/Disconnect button, connection status, a "Now
  playing" readout, and basic Play/Pause/Next/Previous/volume controls —
  deliberately not a music player, per the task's own UI guidance); also
  settable via `NIMBUS_SPOTIFY_CLIENT_ID`/`NIMBUS_SPOTIFY_REDIRECT_PORT`
  in `.env`.
- **Logging**: every action execution logs `actionId`/`status`/
  `durationMs`/`error.category` only (see `ActionService.finish` in
  `actionService.ts`) — never full result data, never a raw API response,
  and (obviously) never a token. `spotifyAuthManager.ts`/
  `spotifyTokenStore.ts` log connect/disconnect/refresh-failed events by
  status only, the same discipline every other provider's auth code
  follows.

### Security boundary

The renderer never gets a Spotify token, a privileged API, or arbitrary
Node access — it can only call `window.nimbus.executeAction(actionId,
params)`, which invokes `nimbus:execute-action` in `lifecycle.ts` and
goes straight into `ActionService.executeAction`. That call validates the
action id against the registered providers and the params against the
provider's own `validate()` — there is no path from the renderer to
`SpotifyApiClient`, `SpotifyAuthManager`, or any other Node capability.
This matches the task's own example exactly: the renderer asks to
"execute Spotify pause action," never for raw API access.
`nimbus:get-spotify-settings`/`nimbus:spotify-connect`/
`nimbus:spotify-disconnect` follow the same shape as calendar/email/
tasks' settings IPC, returning only a `connected: boolean` — confirmed
live via CDP: enabling Spotify and attempting to connect without a
configured Client ID produced a clean `{ connected: false, error:
"Couldn't connect to Spotify." }` result, no token file was ever created,
and the log recorded only `Spotify client ID is not configured` at
`warn` level — no credential of any kind.

### Tests

`spotifyApiClient.test.ts` (204 "nothing playing", mapping a normal
playback response, no access token short-circuits before any network
call, 401→`not_authenticated`, 429→`rate_limited`, a 404 with
`NO_ACTIVE_DEVICE`→`no_active_device`, a plain 404→`not_found`, a 403
with `PREMIUM_REQUIRED`→`not_available`, an unmapped status→`unknown`
carrying the HTTP status, a network-level fetch failure→`network`,
volume rounding, a play request's context URI in the body, search query
parameters, and the token sent only as a `Bearer` header — never in a URL
or body), `spotifyContextProvider.test.ts` (availability with Spotify
disabled/not-authenticated/ready, no active playback → "stopped" with no
track, an actively playing track mapped fully, paused vs. playing vs.
stopped, malformed/sparse playback data — missing artists/album/device —
not crashing the provider, an authentication or API failure rejecting
`getContext()`, and cache hit within TTL),
`spotifyProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider`/`EmailProvider`/`TaskProvider` alongside a broken
Spotify context+action pairing — proves a Spotify failure affects neither
the other providers nor briefing generation, and that executing an action
against the same broken client degrades to a structured `ActionResult`),
`spotifyActionProvider.test.ts` (availability gating, play/pause/next/
previous each calling the right client method, volume validation
rejecting out-of-range and non-numeric values, a track search match
playing and naming the track/artist, no search results failing with
`not_found` and a friendly message, playlist search-and-play, an
authentication/no-active-device/rate-limited failure each mapped to the
right category and a friendly message with no raw error text leaking
through, malformed search API data not crashing execution, and
`listActions()` confirming every Spotify action declares
`requiresConfirmation: false`), and `spotifyPkce.test.ts` (verifier
length/character-set/randomness, deterministic-per-input code challenge
that differs across verifiers and is URL-safe, random state values, the
authorize URL carrying every required PKCE parameter, and — explicitly —
that it never includes a client secret parameter). All Spotify API/OAuth
calls are mocked via a fake `fetch` — no test reaches the real Spotify
API or needs a real account. This section's test files also gained
playlist retrieval/mapping coverage and the `playlistUri`-direct-play path
in a later task (see "Context-Aware Routines" below for why) — 63 tests
across `spotifyApiClient.test.ts`/`spotifyActionProvider.test.ts` today.

## Context-Aware Routines

The newest system: NIMBUS can now notice things happening on the desktop
(a configured application starting, a configured website's tab becoming
active, a configured folder being opened in Explorer) and quietly
*suggest* running a user-defined Routine — never act on its own. See
[src/events/](src/events/) and [src/routines/](src/routines/), and
ARCHITECTURE.md's "Context Events and Routines" section for the full
internal design; this section covers behavior, privacy, and setup.

- **The flow is always**: Context Event → Trigger match → cooldown/
  condition check → Suggestion, shown in a small NIMBUS-owned popup
  window (not a native OS notification — see "Suggestion & Timer
  popups" below) → the user clicks the primary/secondary button →
  *only on the primary button* does anything execute, and only the
  exact Actions the Routine was configured with, through the same
  `executeAction` the rest of NIMBUS already uses. A Routine can never
  contain a shell command or arbitrary code — its `actions` field is
  validated (`validateRoutine`) against the live list of registered
  Action ids both when saved and, redundantly, by `ActionService` itself
  when run.
- **Nothing is hard-coded**: there's no "Steam" or "SkillCert" concept
  anywhere in the code — those are just examples in this README and in
  the task that requested this feature. A Routine is entirely a trigger
  type + a plain-text pattern + a suggestion + one or more Action steps,
  all user-configured from the **Routines** tab (its own sidebar entry,
  not nested inside Settings — routines are expected to grow in number,
  so they get their own list/grid view rather than crowding Settings
  into a control panel). Clicking a routine's card opens it for editing
  in the same form used to create one; "+ New routine" opens a blank one.
- **Triggers**: `applicationOpened` (matches a running executable name),
  `websiteOpened` (matches a recognized browser's window title — see
  "Website detection" below), `folderOpened` (matches an open Explorer
  window's path). Each supports `exact` or `contains` matching, and the
  pattern field itself accepts comma-separated alternatives (e.g.
  `skillcert,nowuniversity`) so one Routine can fire from any of several
  apps/sites/folders instead of needing a near-duplicate Routine per one.
- **Conditions** (optional, `[]` by default): `timeOfDay` (a hour range,
  wraps past midnight), `weekdaysOnly`, `spotifyNotAlreadyPlaying` (skip
  the suggestion if *anything* is already playing), and
  `actionsNotAlreadyActive` (skip the suggestion specifically if *this
  routine's own* configured playlist/timer already appear to be
  running/playing — the "Skip if already active" checkbox in the Routine
  editor) — a small, genuinely useful starting set per the task's own
  "don't over-engineer" guidance, with a clean extension point
  (`RoutineCondition`/`conditionEvaluator.ts`) for adding more later
  (headphones connected, PC idle, etc.).
- **Cooldown**: each Routine has its own `cooldownMinutes` (default 30).
  Once a suggestion is made, that Routine can't suggest again until the
  cooldown elapses — regardless of whether the user accepted, dismissed,
  or just let it expire. This is what stops "open a tab, get suggested
  to, switch away, come back a minute later, get suggested to again."
- **Suggestions auto-expire** (default 60 seconds) if ignored — a
  suggestion is never left sitting around indefinitely, and dismissing
  it early has the same effect as letting it expire.
- **Website detection is a heuristic**, not real URL/domain detection —
  see ARCHITECTURE.md for why (it needs a browser extension, which is
  out of scope here). It matches against the *browser window's title*,
  which most sites set to include the page/site name. A trigger
  configured to match on `domain`/`url` simply never fires today, since
  no current detector can determine those fields — this is a known,
  documented limitation, not a silent failure.
- **Folder detection** uses Windows Explorer's own `Shell.Application`
  COM API to enumerate open folder windows — a real, supported mechanism
  rather than filesystem-watching or window-title scraping.
- **Multiple actions run in the configured order**, and one step failing
  never stops the rest (see `RoutineService.runActions`) — the same
  "structured result per step, no silent swallowing" behavior the Action
  system already guarantees elsewhere.
- **Playlist picking**: when a Routine's action is Spotify's "Play
  playlist," the Settings UI shows a dropdown of the user's actual
  playlists (fetched via `nimbus:spotify-list-playlists` — metadata only,
  id/name/artwork/owner/track count, never a playlist's tracks) so a
  Routine can be pointed at an exact playlist by URI instead of a
  free-text search. The Routine stores this stable playlist URI, not a
  name — a future Intelligence/LLM layer never has to guess *which*
  playlist "Study" means, because the Routine already knows.
- **A Routine can start a NIMBUS Timer as one of its steps** (the
  "Start timer" action), alongside or instead of a Spotify step —
  configurable duration (minutes) and type (e.g. `focus`), with an
  optional title, or a full Pomodoro study/break cycle. See "Timers"
  below.
- **A Routine can open a website as one of its steps** (the "Open
  website" action, `system.openUrl`) — opens the configured URL in your
  default browser, e.g. an app-launch Routine (`applicationOpened`
  trigger on a game's `.exe`) that also opens that game's wiki/guide
  page. Restricted to `http://`/`https://` URLs only — never a
  `file:`/custom-protocol URI — since a Routine action must never become
  a way to execute arbitrary local content.
- **Running a Routine on demand**: every Routine card in the Routines
  tab has a small ▶ button that runs its actions immediately, bypassing
  trigger match, cooldown, and conditions entirely — the same escape
  hatch the old "Test" button was, just presented as a per-card control
  instead of something you had to open a routine to reach.
- **Editing an existing Routine** reuses the same form used to create
  one — click **Edit** on a Routine row to load its name, trigger,
  suggestion text, cooldown, and ordered action list back into the form,
  change what you need, and click **Update routine** (or **Cancel** to
  discard the edit). There is no separate editor.
- **Enabling/disabling a Routine without deleting it**: the "Active"
  checkbox on each card — a disabled routine keeps its full
  configuration but its trigger never matches until re-enabled.
- **Run automatically, no confirmation** (`autoRun`, off by default):
  the one deliberate exception to "NIMBUS always asks first" — a routine
  with this on skips the suggestion popup entirely and just runs the
  moment its trigger matches. Cooldown and conditions still apply; only
  use it for actions you're fully comfortable happening unprompted (the
  Terraria-launches-so-open-its-wiki kind of thing, not anything that
  changes settings or spends money). What ran still shows up as a plain
  line in the Home Activity feed, just never as a popup.
- **Picking an action is now two steps**: a Service dropdown (Spotify,
  Timer, System, and whatever's registered later) filters the Action
  dropdown down to just that service's actions, instead of one flat list
  of every action from every provider — built entirely from each
  action's own `affectsService`, so a new provider needs no editor
  changes to show up correctly grouped.

### Privacy

Desktop activity monitoring is **off by default** and only runs while
"Enable context-aware suggestions" is checked in Settings. While on, it
reads, once every 5 seconds:

- running process **executable names** (e.g. `steam.exe`) — not window
  contents, not what the app is doing
- the **window title** of a small, fixed list of recognized browser
  processes (Chrome, Edge, Firefox, Brave, Opera) — never the page's
  actual content, never full browsing history, never anything from
  unrecognized applications
- the **folder path** of open Windows Explorer windows

It never captures screenshots, keystrokes, page content, or clipboard
data, and never sends any of this to an external service (there is no
LLM/AI involved in Routines at all — matching happens entirely with
plain string comparisons in `triggerMatcher.ts`). Turning the master
switch off immediately stops the monitor (confirmed live: the log shows
`Desktop activity monitor stopped`); no history of past activity is
retained anywhere.

### Timers

NIMBUS has a small, generic countdown timer — not tied to Spotify or
Routines. The "Start timer" action has two modes:

- **Single** (the default): one plain countdown from a configured
  duration and type (focus/pomodoro/break/custom).
- **Pomodoro**: an automatic Study → Break → Study → ... cycle, built
  from `studyMinutes` (default 45), `breakMinutes` (default 15), and
  `cycles` — the number of study sessions (default 1). A break only ever
  sits between two studies, never after the last one (2 cycles = Study →
  Break → Study, not Study → Break → Study → Break). Each phase starts
  automatically as soon as the previous one completes — no need to
  re-trigger the Routine between phases. In the Routine editor, picking
  "pomodoro" from the Start timer action's mode dropdown swaps the
  visible fields to the study/break/cycle ones.

Either way:

- Starting a timer opens a small always-on-top NIMBUS window in the
  top-right of your primary display showing the remaining time, a
  progress bar, and Pause/Resume and Stop buttons. It never steals focus
  or becomes the active window. Stop ends the whole plan, not just the
  phase in progress.
- Only one timer (or one plan) runs at a time — starting a new one
  replaces whatever was running.
- Every phase's completion (including each Pomodoro phase) records a
  `TimerCompleted` Context Event, carrying that phase's own type ("focus"
  or "break"), through the same generic Event system Routines already
  use. No Routine reacts to it yet (e.g. a "take a break?" suggestion
  triggered by a *different* routine) — the plumbing exists for a future
  task to add one without any Timer-system changes.

### Suggestion & Timer popups

Both Routine suggestions and the running-timer display use small,
NIMBUS-owned popup windows instead of native Windows notifications.
Investigating why native notifications previously showed a generic/
technical identity (rather than "NIMBUS") traced to the app never
calling `app.setAppUserModelId()` — now fixed in `main.ts` for any
simple native notification NIMBUS still uses. The suggestion prompt
itself was moved to its own window because a native toast can't render
two real buttons and a dynamic per-action summary — see
ARCHITECTURE.md's "Event → Trigger → Routine → Suggestion → Action →
Timer" section for the full design.

- Frameless, non-resizable, always-on-top, and shown with
  `showInactive()` — it never takes keyboard focus, so it's never at
  risk of becoming an accidental typing target.
- Positioned in your primary display's work area (bottom-right for
  suggestions, top-right for the timer, so they don't overlap), recomputed
  each time it's shown — unplugging or swapping the primary monitor
  doesn't leave a popup off-screen.
- Shows only what the suggestion/timer data itself carries — title,
  message, per-action labels, remaining time. No routine id, suggestion
  id, event id, or other internal identifier is ever rendered.
- The suggestion popup auto-dismisses after a timeout if ignored, exactly
  like a suggestion left un-acted-on elsewhere in NIMBUS.

### Home page

The Home tab now shows a compact "now playing" card when Spotify is
connected — artwork, title, artist, progress bar, playback state, and
Previous/Play-Pause/Next/volume controls, plus the playlist name when
Spotify reports the current context is a playlist NIMBUS already knows
the name of (matched locally against the already-fetched playlist list,
so this never costs an extra API call on every playback poll). Nothing
is playing → a plain "Nothing is playing" state, no player chrome. The
card polls context every 5 seconds, and only while the Home tab is
actually visible.

### Tests

`eventBus.test.ts` (delivery to one/many subscribers, unsubscribe,
one throwing listener never blocking others, no-subscriber safety),
`triggerMatcher.test.ts` (exact/contains matching for every trigger type,
a website trigger asking for a field — domain/url — the current detector
can't supply failing closed instead of guessing, cross-type events never
matching), `conditionEvaluator.test.ts` (every condition type, an
hour-range that wraps midnight, the Spotify condition failing open when
no signal or a throwing check is available, multiple conditions all
required to pass), `types.test.ts` (`validateRoutine` rejecting a missing
name, no actions, an unregistered action id, non-object params, a
malformed trigger of each type, an invalid `matchMode`, a negative
cooldown, an out-of-range `timeOfDay`, an empty suggestion — and
accepting a well-formed routine with multiple valid action steps),
`routineService.test.ts` (a match producing a Suggestion and *never*
calling the action provider directly, a disabled routine never
suggesting, accepting executing the routine's action(s) in the
configured order, dismissing never executing anything, a failing action
step not blocking a later one, cooldown suppressing an immediate repeat
and allowing one again after it elapses, the `spotifyNotAlreadyPlaying`
condition gating correctly, suggestion expiry, and `testRoutine` bypassing
trigger/cooldown/conditions entirely), `activitySnapshot.test.ts` (every
event type's appear/unchanged/re-change behavior, the first poll
producing no events — baseline only — proven both in isolation and across
five consecutive polls, an empty browser title never producing a bogus
event, multiple simultaneous changes each producing their own event), and
`desktopActivityMonitor.test.ts` (the first tick establishing a baseline
with no events, a later genuine change firing one, an unchanged snapshot
firing nothing further, a throwing poll function handled gracefully, and
stopping resetting the baseline so a restart requires a fresh one). All
external calls (process polling, Spotify) are mocked or injected — no
test spawns a real PowerShell process or needs a real Spotify account. 74
new tests here, plus 9 added to the Spotify test files above (playlist
retrieval/mapping, direct-URI playlist playback) — 83 new tests total that
task, alongside the 279 pre-existing ones (362 total via `npm test`).

This task (Timer + generic Suggestion/Timer popups + multi-action
verification + Routine editing) added `timerService.test.ts` (11 tests:
start/tick/pause/resume/cancel/completion, the `TimerCompleted` event's
payload, replacing an in-progress timer, and the pause/resume-with-a-
stale-id no-op case) and `timerActionProvider.test.ts` (8 tests:
`timer.start`'s param validation, successful execution, `isAvailable`,
and its registered `ActionDefinition` shape) — 19 new tests, plus 2 added
to `routineService.test.ts` for `actionSummary` generation (built from
each action's registered name, in order, never hard-coded; falling back
to the raw action id for an unregistered one) — 21 new tests total,
alongside the 379 pre-existing ones (400 total via `npm test`). The
suggestion/timer popup windows and renderers, and the Routine-editing UI,
are exercised by a scripted pipeline check and manual review rather than
automated tests, since they're Electron `BrowserWindow`/DOM code with no
existing test harness for that layer in this codebase (see "Known
limitations" — the same gap the pre-existing main-window renderer.ts UI
already had).

**Manual configuration**: none required beyond what Spotify already
needed (see "Spotify" above) — Routines and Timers have no credentials of
their own. Desktop activity monitoring requires no setup beyond checking
the one Settings toggle.

## The Briefing system

NIMBUS's first recognizable assistant behavior: it greets you and gives a
concise summary, instead of dumping raw data. This is built as a small,
separate system on top of Context — `src/context` still knows nothing
about briefings, and `src/briefing` knows nothing about IPC/UI.

- [src/briefing/types.ts](src/briefing/types.ts) — the shape. A
  `Briefing` is just `{ id, generatedAt, items: BriefingItem[] }`. Each
  `BriefingItem` has a `category` (`greeting` | `dateTime` | `weather` |
  `calendar` | `email` | `tasks` | `meals` | `other` — `email`/`tasks`/
  `meals` have no producer yet, and that's fine, see below), a
  `message`, a `timestamp`, an `importance` and `relevance` score
  (0–100 each), and an optional `action`. **The exact wording is never
  one hard-coded paragraph** — each category has its own small message
  builder that reads structured Context data, e.g. the weather line is
  assembled from `todayLowC`/`todayHighC`/`condition`/
  `precipitationProbabilityPercent`, and the calendar line picks between
  five deterministic phrasings ("nothing scheduled" / one event / several
  events / all-day / an imminent-event countdown) based on
  `CalendarContext`, never a fixed string.
- [src/briefing/briefingGenerator.ts](src/briefing/briefingGenerator.ts) —
  pure and synchronous: takes a `ContextSnapshot`, returns a `Briefing`.
  No Electron/IPC dependency, so it's plain unit-testable. For each
  category it has a `buildXItem(data)` function that returns `null` when
  that data isn't available — **a provider that doesn't exist (or that
  errored) is simply omitted, never shown as an error**. Provider
  failures are already visible on the Context tab; the briefing stays a
  calm summary, not a status dashboard.
- **Prioritization foundation, not AI**: content items (currently
  `dateTime`, `weather`, and `calendar`) are sorted by
  `importance × relevance` and capped at 5 (`MAX_CONTENT_ITEMS`) before
  the fixed greeting (always first) and a closing "Anything I can help
  you with?" item (always last) are added. `relevance` can depend on the
  actual data — the weather item scores higher when rain is likely; the
  calendar item scores low with nothing scheduled, higher with several
  events today, and very high once the next event is imminent (within 45
  minutes), regardless of how many events exist overall. That's the
  entire "smart" part today: a plain sort with real signal behind the
  numbers. A future system could re-rank without changing
  `BriefingItem`'s shape.
- [src/briefing/briefingService.ts](src/briefing/briefingService.ts) —
  owns the **lifecycle**: `generate()` produces a new briefing (fetches
  context, runs the generator, caches the result); `getCurrent()` returns
  whatever was last generated **without ever triggering generation**.
  Concurrent `generate()` calls share one in-flight generation instead of
  racing multiple context fetches. This is what guarantees a UI reload
  (or several windows) doesn't produce a new briefing, or a new weather
  API call, every time something asks.

### Startup wiring

In `src/main/lifecycle.ts`, `app.on("ready", ...)`: providers are already
registered → `generateBriefing()` is called (not awaited, so a slow
weather fetch can't delay the window/tray appearing) → it calls
`briefingService.generate()`, which pulls the context snapshot and runs
the generator → on success, every open window is notified over
`nimbus:briefing-updated` (a plain "go re-fetch" signal, no payload). The
renderer's `getBriefing()` (`nimbus:get-briefing`, pull-only) is called
once on load and again on that push — so a window that was already open
before generation finished still picks up the result, without polling.
An explicit **Regenerate** button on the Home tab calls
`nimbus:regenerate-briefing`, which is the only other thing that produces
a new briefing.

If generation itself fails unexpectedly (not just a provider — verified
by temporarily forcing `BriefingGenerator.generate()` to throw), the
`try/catch` around it in `lifecycle.ts` logs the error and leaves
`getCurrent()` at `null`; the UI shows "Preparing your briefing…" and
the rest of the app (Context tab, all providers) is completely
unaffected — confirmed live, not just by reasoning about the code.

### Tests

`briefingGenerator.test.ts`: normal snapshot (greeting → weather →
dateTime → closing, weather ranked first because its priority score is
higher), rain shifting weather above dateTime, a missing/errored weather
provider being omitted (not shown as an error), a fully empty snapshot
still producing a graceful `[greeting, closing]` result with no
error-shaped text anywhere, and id/timestamp sanity. `briefingService.test.ts`:
`getCurrent()` starts `null`, generation caches its result, `getCurrent()`
never triggers a fetch, concurrent `generate()` calls share one in-flight
promise, a throwing provider doesn't prevent a briefing from being
produced, and a second explicit `generate()` produces a new id.

## Setup

```bash
npm install
copy .env.example .env
```

## Run

```bash
npm start
```

This compiles TypeScript (`npm run build`) and launches the Electron app.

## Develop

```bash
npm run dev
```

Watches and recompiles TypeScript on change. Run `electron .` in a second
terminal to launch with the latest build.

## Logs & settings location

At runtime, logs and persisted settings are written under Electron's
per-user app data directory (Windows:
`%APPDATA%\nimbus\logs\nimbus.log` and `%APPDATA%\nimbus\settings.json`).

## Known limitations

- **Autostart identity in dev mode**: running unpackaged (`npm start` /
  `electron .`), "Launch with Windows" registers the dev `electron.exe`
  binary (with an `--autostart` flag) under
  `HKCU\...\Run\electron.app.Electron`, not a NIMBUS-branded entry. Once the
  app is packaged into a real `NIMBUS.exe` installer, `setLoginItemSettings`
  will register that instead — no code change needed, but this hasn't been
  built/tested yet since packaging is out of scope for this phase.
- **No packaged build**: there's no installer/`.exe` yet (`electron-builder`
  or similar), only `npm start` for running from source.
- **Single window**: NIMBUS supports exactly one main window; multi-window
  scenarios aren't handled.
- **Icon is a placeholder**: `src/assets/icon.png` is a generated placeholder
  (see `scripts/generate-icon.js`), not final branding.
- **IP geolocation is coarse**: automatic weather location is city-level
  accuracy at best (it's IP-based), and is wrong for VPN users — manual
  mode exists precisely for that case.
- **No location autocomplete/geocoding UI**: manual location entry is
  raw latitude/longitude; there's no "type a city name" search yet.
- **No offline queuing**: a failed weather fetch is just retried on the
  next `getSnapshot()` call (subject to the 10-minute cache) — there's no
  backoff/retry scheduling.
- **No real OAuth calendar integration (Google/Microsoft) yet** — see
  "Calendar" above for why (no ability to register a real OAuth app in
  this environment) and how the `IcsCalendarSource` boundary is designed
  so one can be added without touching `CalendarProvider`/Context/UI.
  **Needs manual configuration**: a user must obtain their own calendar's
  private ICS URL from their calendar provider's sharing settings and add
  it via the Settings tab (or `NIMBUS_CALENDAR_ICS_URL`) — nothing is
  pre-configured, and no fake/sample data is ever presented as real.
- **No recurring-event expansion**: `RRULE` is not interpreted: a
  recurring event appears once, at its literal first occurrence, not on
  every recurrence.
- **Calendar cache invalidation is time-based only**: editing/deleting an
  event in the source calendar won't be reflected until the (dynamic,
  up to 15-minute) cache expires — there's no push/webhook update path.
- **No real OAuth email integration (Gmail API/Microsoft Graph) yet** —
  see "Email" above for why and how the `ImapEmailSource` boundary is
  designed so one can be added later without touching
  `EmailProvider`/Context/UI. **Needs manual configuration**: a user must
  generate an app-specific password from their email provider's account
  security settings and add an account via the Settings tab (or the
  `NIMBUS_EMAIL_*` env vars) — nothing is pre-configured, and no fake/
  sample email data is ever presented as real.
- **Email cache invalidation is time-based only** (5 minutes, fixed —
  unlike Calendar's proximity-based TTL shrink): no IMAP IDLE/push, so a
  message that arrives or is read elsewhere won't be reflected until the
  cache expires.
- **No email actions**: this is deliberate scope, not a limitation to fix
  — NIMBUS never sends, replies to, deletes, archives, marks read, moves,
  or forwards anything; it only reads metadata and short previews.
- **No real OAuth task integration yet, and only one connector
  (Todoist)** — see "Tasks" above for why and how the
  `TodoistTaskSource`/account `provider` field are designed so a second
  connector can be added later without touching `TaskProvider`/Context/
  UI. **Needs manual configuration**: a user must generate a personal API
  token from Todoist's own Integrations settings and add an account via
  the Settings tab (or the `NIMBUS_TASKS_TODOIST_TOKEN` env var) —
  nothing is pre-configured, and no fake/sample task data is ever
  presented as real.
- **No true reminders, only due-time-as-reminder**: Todoist's REST API
  has no separate reminder concept without its (premium-gated) Sync API,
  so `reminderAt` today just mirrors a task's specific due time — see
  "Reminders" under "Tasks" above.
- **No completed-task history**: since Todoist's REST API never returns
  completed tasks, NIMBUS has no way to show "tasks you finished
  recently" today — only what's still active.
- **No task actions**: this is deliberate scope, not a limitation to fix
  — NIMBUS never creates, completes, deletes, moves, or changes the
  deadline of any task; it only reads.
- **`ActionService` doesn't enforce `requiresConfirmation` or any
  permission check** — this is deliberate, foundational scope (see "The
  Action system" above): the metadata is reported accurately so a future
  confirmation UI/permission layer can read it, but nothing today stops
  `executeAction` from running an action regardless of that flag. Every
  Spotify action happens to be safe to run without confirmation, so this
  doesn't matter yet — it will the moment a genuinely risky action
  (deleting files, sending an email) is added.
- **No natural-language command interpretation** — by design for this
  task (see its own "No LLM yet" section). `executeAction("spotify.play")`
  must be called with the exact action id and params; turning "play some
  music" into that call is the future Intelligence layer's job, not
  built here.
- **Only one Spotify device target at a time, chosen by Spotify itself**
  (or `preferredDeviceId` when set) — NIMBUS doesn't enumerate/switch
  between multiple available Spotify devices in the UI, only exposes
  whichever one Spotify reports as current via Context.
- **Spotify requires Premium for playback control** — this is a Spotify
  platform limitation, not a NIMBUS one; a non-Premium account can still
  use the Context (read) side, but write actions fail with a clear
  "Spotify playback control isn't available right now" message.
- **Token persistence depends on OS-level secure storage being
  available** — see "Token storage" under "Spotify" above. On a machine
  where Electron's `safeStorage` reports encryption unavailable (rare),
  NIMBUS fails safe by not persisting the connection at all rather than
  falling back to plaintext, so the user would need to reconnect every
  launch. **Needs manual configuration**: a user must register their own
  free Spotify Developer app, add the documented Redirect URI to it, and
  provide the Client ID via Settings or `NIMBUS_SPOTIFY_CLIENT_ID` —
  nothing is pre-configured, and no fake/sample playback data is ever
  presented as real.
- **Website triggers only match window titles, never real URLs/domains**
  — see "Website detection is a heuristic" under "Context-Aware Routines"
  above. A trigger configured with `matchField: "domain"` or `"url"`
  simply never fires today; only `"windowTitle"` can be satisfied by the
  current detector. Fixing this properly needs a browser extension, which
  is explicitly out of scope for this task.
- **Application detection can't distinguish "launched" from "brought to
  the foreground"** — `ApplicationOpenedEvent.activation` is always
  `"launched"` today (a process transitioning from not-running to
  running); `"activated"`/`"alreadyRunning"` exist in the type for a
  future, more precise detector (one using a native foreground-window
  API) to use without a shape change.
- **Desktop activity polling runs every 5 seconds** while Routines are
  enabled — a fixed interval, not configurable from the UI yet, and not
  a true push/event-driven OS hook.
- **No routine conflict/priority handling** — if two enabled routines
  both match the same event, both suggest independently (each with its
  own cooldown); there's no "only the more specific one" logic.
- **Suggestions are addressed to whichever window(s) are currently open**
  — there's no persistent suggestion history/inbox beyond the in-memory
  `getActiveSuggestions()` list (cleared on app restart); this matches
  the task's own "lightweight foundation, not a full history UI"
  guidance.

## Notes for the next development phase

- No AI/LLM, voice, TTS, meals, browsing, automation, or memory features
  exist yet — this is deliberate. Weather, calendar, email, and tasks are
  the first four external context providers (see "Weather"/"Calendar"/
  "Email"/"Tasks" above); Spotify is the first Action provider (see "The
  Action system"/"Spotify" above); Context Events and Routines are the
  first generic trigger/suggestion pipeline (see "Context-Aware Routines"
  above). AI/automation still belong under `src/services/`, publishing
  through `assistantBridge` (see Architecture).
- The morning briefing (see "The Briefing system" above) is template-based,
  not AI-generated — no LLM is involved. No voice output, no proactive
  OS-level notifications, and no scheduled/recurring re-briefing (it's
  generated once per app launch) exist yet.
- The `settings` module tracks window size and startup preferences. Extend
  `NimbusSettings` in `src/settings/settingsManager.ts` as real preferences
  are needed.
- The IPC surface between UI and main process
  (`nimbus:get-app-info`, `nimbus:get-settings`, `nimbus:update-settings`,
  `nimbus:hide-window`, `nimbus:get-context`, `nimbus:get-weather-settings`,
  `nimbus:update-weather-settings`, `nimbus:get-calendar-settings`,
  `nimbus:update-calendar-settings`, `nimbus:get-email-settings`,
  `nimbus:update-email-settings`, `nimbus:get-task-settings`,
  `nimbus:update-task-settings`, `nimbus:get-spotify-settings`,
  `nimbus:update-spotify-settings`, `nimbus:spotify-connect`,
  `nimbus:spotify-disconnect`, `nimbus:list-actions`,
  `nimbus:execute-action`, `nimbus:spotify-list-playlists`,
  `nimbus:get-routine-settings`, `nimbus:update-routine-settings`,
  `nimbus:test-routine`, `nimbus:get-active-suggestions`,
  `nimbus:accept-suggestion`, `nimbus:dismiss-suggestion`,
  `nimbus:get-briefing`, `nimbus:regenerate-briefing`,
  `nimbus:briefing-updated`, `nimbus:assistant-event`) is still minimal.
  Add new handlers in
  `src/main/lifecycle.ts` and expose them via `src/preload/preload.ts` as
  needed. Note that `nimbus:execute-action` is itself generic — a new
  Action provider needs no new IPC handler, only registration with
  `actionService` (see "The Action system" above).
- Next context providers (meals, applications, files, news, web info,
  user activity) each go under `src/context/providers/`; register
  settings-independent ones in `src/context/index.ts`, and ones needing
  live settings in `src/main/lifecycle.ts` (see the
  `WeatherProvider`/`CalendarProvider`/`EmailProvider`/`TaskProvider`
  pattern above). Each new provider that should appear in the briefing
  also gets one `buildXItem()` function in `briefingGenerator.ts` — the
  `meals` category already exists in `BriefingCategory`, just unused.
- The Context tab currently fetches on load + manual refresh only; no
  auto-polling/live-refresh timer exists yet.
