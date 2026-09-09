# NIMBUS Architecture

This document describes how NIMBUS's code is organized today, and why —
specifically with the project's stated long-term direction in mind:
NIMBUS is meant to eventually exist across multiple devices (a Windows
PC, an Android phone, possibly a web client) that all talk to a shared
NIMBUS "core" (context, briefings, preferences, tasks, notifications,
integrations, assistant state, authentication, device identity) rather
than behaving as independent, unrelated assistants.

**Nothing here builds that backend or an Android client.** This is a
review of the current (Windows-only) implementation to make sure it
doesn't quietly bake in assumptions that would make a second client
unnecessarily painful later — and two small, contained refactors where a
real assumption like that had crept in.

## The five layers

| Layer | What it means | Owns |
|---|---|---|
| **1. Core** | Platform-independent logic. Zero dependency on Electron or any OS API. Would run the same in a future Node-based service, and is what a future backend would eventually be built around. | Context system, Briefing system, the assistant-event contract, generic utilities |
| **2. Device/client-specific** | Code that only makes sense because this client is "a Windows desktop app." Not portable, and not meant to be — a future Android client's equivalent code will look nothing like this. | Window/tray/lifecycle management, autostart, IPC wiring, Windows settings persistence |
| **3. External integrations** | Code that talks to something outside NIMBUS entirely (a third-party API). Portable in principle — any client, or a future backend, could make the same HTTP calls — but organized today as an implementation detail behind a Core context provider. | Open-Meteo client, IP geolocation client |
| **4. User data/context** | The data itself, as opposed to the code that produces it: what NIMBUS currently knows, and what the user has told it. This is a *slice* of Core (item 1), called out separately because it's the part most obviously destined to sync across devices. | Context snapshots, briefings, user preferences (e.g. weather location mode) |
| **5. UI/presentation** | Rendering and user interaction for *this* client. A future Android or web client's UI is a complete, separate implementation of this layer — it would talk to the same Core through its own equivalent of the preload/IPC bridge, not reuse this one. | `src/ui/`, the preload bridge |

## Where every module sits

```
src/
  context/                 [1] Core — the Context system
    types.ts                     ContextProvider / ContextSnapshot contract
    contextService.ts            Aggregator: register providers, getSnapshot()
    providers/
      dateTimeProvider.ts         [1]/[4] Core provider — no external calls
      systemInfoProvider.ts       [1]/[4] Core provider — reads local OS info via Node's
                                   `os` module (available in any Node runtime, not
                                   Electron-specific) — see caveat below
      weather/
        weatherProvider.ts         [1]/[4] Core — the ContextProvider adapter
        locationResolver.ts        [1]/[4] Core — auto/manual location policy
        openMeteoClient.ts         [3] External integration
        ipGeolocation.ts           [3] External integration
        weatherCodes.ts            [1] Core — pure data mapping
      calendar/
        calendarProvider.ts        [1]/[4] Core — the ContextProvider adapter
        icsCalendarSource.ts       [3] External integration (HTTP fetch or
                                   local file — see "Calendar integration
                                   boundary" below for the OAuth note)
        icsParser.ts                [1] Core — pure RFC 5545 parsing
        icsTimeUtils.ts             [1] Core — timezone-correct date/time math
      email/
        emailProvider.ts            [1]/[4] Core — the ContextProvider adapter
        imapEmailSource.ts          [3] External integration (IMAP, read-only —
                                   see "Calendar/Email integration boundary"
                                   below for the OAuth note)
        emailImportance.ts          [1] Core — pure deterministic scoring, no LLM
        types.ts                    [1] Core — metadata-only data model
      tasks/
        taskProvider.ts              [1]/[4] Core — the ContextProvider adapter
        todoistTaskSource.ts         [3] External integration (Todoist REST API —
                                   see "Calendar/Email/Tasks integration
                                   boundary" below for the OAuth note)
        taskRelevance.ts             [1] Core — pure deterministic scoring, no LLM
        types.ts                     [1] Core — generic task/reminder data model
      spotify/
        spotifyContextProvider.ts    [1]/[4] Core — the ContextProvider adapter
                                   ("what's playing" — the read half; see
                                   spotifyActionProvider.ts under actions/
                                   for the write half, and "Context vs.
                                   Action" below)
        spotifyApiClient.ts          [3] External integration (Spotify Web API —
                                   see "Calendar/Email/Tasks/Spotify
                                   integration boundary" below for the
                                   OAuth note). Shared by both the Context
                                   and Action providers.
        types.ts                     [1] Core — metadata-only playback data model

  actions/                  [1] Core — the Action system — see "Context vs.
                                   Action" below
    types.ts                     ActionProvider / ActionResult contract
    actionService.ts             Aggregator: register providers, executeAction()
    providers/
      spotifyActionProvider.ts    [1]/[4] Core — the ActionProvider adapter
                                   ("play this" — the write half of Spotify;
                                   depends on the same SpotifyApiClient as
                                   the Context provider above)

  events/                   [1] Core — the Context Event system (new this
                                   task) — see "Context Events and Routines"
                                   below
    types.ts                     ContextEvent shapes (ApplicationOpened,
                                   WebsiteOpened, FolderOpened, and three
                                   reserved-for-later types)
    eventBus.ts                  ContextEventBus — a minimal pub/sub hub;
                                   no Electron dependency, no persistence

  routines/                 [1] Core — the Routine system (new this task)
    types.ts                     Routine/TriggerConfig/RoutineCondition data
                                   model + validateRoutine — no Spotify (or
                                   any service) specifics anywhere
    triggerMatcher.ts            Pure ContextEvent-vs-TriggerConfig matching
    conditionEvaluator.ts        Pure RoutineCondition evaluation (extension
                                   point — see its own doc comment)
    routineService.ts            Orchestrator: Context Event → Trigger match
                                   → cooldown/condition check → Suggestion
                                   (never a direct Action call) → on accept,
                                   runs the Routine's actions through the
                                   existing ActionService

  briefing/                 [1]/[4] Core — the Briefing system
    types.ts, briefingGenerator.ts, briefingService.ts
                                   Pure functions/classes over ContextSnapshot;
                                   no Electron, no IPC, no UI knowledge

  common/
    assistantEvents.ts       [1] Core — the AssistantEvent contract (shape only)
    ttlCache.ts               [1] Core — generic utility (used by weather today)
    appInfo.ts                [1] Core — branding constants

  config/config.ts           [1]* Core-adjacent — reads process.env/.env.
                                   Deliberately not Electron-specific (any Node
                                   host can supply env vars), but its *content*
                                   today (weatherManualLocation fallback, log
                                   level) is process/deployment config, not user
                                   data — see "config vs settings" below.

  logging/logger.ts          [1] Core — console + *optional* file logging.
                                   Takes no Electron dependency; a host calls
                                   `configureFileLogging(dirProvider)` to enable
                                   file output. Without that call, it still
                                   works (console-only) — this is what makes it
                                   safe for Core to depend on.

  settings/settingsManager.ts [2] Windows-specific — persists `NimbusSettings`
                                   to a JSON file via `electron.app.getPath`.
                                   Defines `WindowsClientSettings` (device-only:
                                   window bounds, launch-with-Windows,
                                   start-minimized) separately from
                                   `UserPreferences` (`weather`, `calendar`,
                                   `email`, `tasks`, `spotify`) — see "Settings
                                   split" below. Spotify's *tokens* are
                                   deliberately NOT here — see spotify/
                                   under main/ below.

  main/                      [2] Windows-specific (Electron main process)
    main.ts                       Entry point; configures file logging
    lifecycle.ts                  App/window/tray lifecycle, all IPC handlers,
                                   wires WeatherProvider + CalendarProvider +
                                   EmailProvider + TaskProvider +
                                   SpotifyContextProvider + SpotifyActionProvider +
                                   BriefingService into the running app
    tray.ts                        System tray icon/menu
    autostart.ts                   Windows login-item registration
    assistantBridge.ts              Pushes AssistantEvents to this device's
                                   renderer window(s)
    spotify/
      spotifyAuthManager.ts          [2] Windows-specific — runs the PKCE OAuth
                                   flow (opens the system browser via
                                   `shell.openExternal`, runs a temporary
                                   loopback HTTP server to catch the
                                   redirect). The *only* Spotify module
                                   that's inherently Electron-shaped — see
                                   "Context vs. Action" below.
      spotifyPkce.ts                 [1]* Pure PKCE math (verifier/challenge/
                                   state generation, authorize URL
                                   building) — no Electron dependency, kept
                                   separate so it's plain-unit-testable.
      spotifyTokenStore.ts           [2] Windows-specific — encrypts tokens via
                                   Electron's `safeStorage` (OS-level,
                                   Windows DPAPI) into their own file,
                                   never `settings.json`.
    activity/                  (new this task) The only producer of
                                   ApplicationOpened/WebsiteOpened/FolderOpened
                                   Context Events today
      desktopActivityMonitor.ts    [2] Windows-specific — polls running
                                   processes, known-browser window titles, and
                                   open Explorer folder paths (via the
                                   `Shell.Application` COM object) on an
                                   interval, publishing the diff onto
                                   ContextEventBus. Only runs while Routines'
                                   "Enable context-aware suggestions" is on.
      activitySnapshot.ts          [1]* Pure diff logic (no process-spawning) —
                                   turns two consecutive polls into events,
                                   with no Electron dependency; unit-tested
                                   directly. Kept separate from the monitor
                                   above for exactly that testability.

  preload/preload.ts         [2]/[5] Windows-specific bridge — the *only* thing
                                   `src/ui` is allowed to call into. A future
                                   Android/web client implements its own
                                   equivalent of this file, talking to Core
                                   however makes sense for that platform
                                   (in-process calls, HTTP, IPC) — `src/ui`'s
                                   counterpart on that platform never imports
                                   Electron either.

  ui/                        [5] UI/presentation — HTML/CSS/TS renderer.
                                   Talks only to `window.nimbus.*` (preload).
                                   Would be entirely replaced, not reused, by
                                   an Android or web client.

  services/                  Placeholder — see src/services/README.md for the
                                   distinction between this and `context/providers/`.
```

`*` = see the note below; `config.ts` is categorized loosely because its
role is closer to "process configuration" than either pure Core logic or
a device capability.

## What changed in this task

Reviewing the above against the five layers surfaced exactly two places
where a Windows/Electron assumption had leaked into code that should be
portable. Both were fixed with small, contained changes — not a rewrite.

### 1. `logger.ts` no longer imports `electron`

**Before**: `src/logging/logger.ts` called `electron.app.getPath("userData")`
directly to decide where to write its log file. `contextService.ts` and
`briefingService.ts` (both Core) import `logger` — so Core code had a
transitive hard dependency on the `electron` package. In a future world
where Core is extracted into its own package for an Android or backend
build, `require("electron")` would either resolve to the wrong thing or
fail outright.

**After**: `logger.ts` has no Electron import. File logging is opt-in via
`configureFileLogging(directoryProvider: () => string)`; until a host
calls that, `logger` still works (console output only — this is also why
it never broke in tests, which never called it). `src/main/main.ts` —
the Windows entry point — calls
`configureFileLogging(() => path.join(app.getPath("userData"), "logs"))`
once, at startup. A future Android client would call the same function
with its own path (or not call it at all, and rely on console/native
logging instead).

### 2. Settings split into `WindowsClientSettings` vs. `UserPreferences`

**Before**: `NimbusSettings` was one flat object — `windowBounds` and
`startup` (Windows window/login-item state) sat alongside `weather`
(a genuine user preference) with no distinction between them. Nothing
technically broke, but the *shape* of the data actively obscured which
parts are "this installation's window size" versus "something the user
would reasonably expect to follow them to their phone."

**After**: `src/settings/settingsManager.ts` now defines
`WindowsClientSettings` (window bounds, launch-with-Windows,
start-minimized) and `UserPreferences` (weather) as separate types, both
still persisted in one local `settings.json` — there is no sync backend,
and building one is out of scope here. What matters is that the type
boundary now exists: adding sync later means giving `UserPreferences` a
transport, not re-deciding what counts as shared user data. A migration
path (`migrateLegacyShape`) reads old flat `settings.json` files from
before this change so existing installs don't silently lose saved
preferences.

The public IPC contract (`nimbus:get-settings`, `nimbus:get-weather-settings`,
etc.) and everything in `src/preload/` and `src/ui/` are **unchanged** —
this was purely an internal reorganization in the Windows client layer.

## Context vs. Action

Added this task, alongside Spotify — the first thing NIMBUS can *do*
rather than only observe. `src/actions/` is a deliberately separate
system from `src/context/`, not a mode/flag on `ContextProvider`, because
the two answer fundamentally different questions with different safety
properties:

| | Context | Action |
|---|---|---|
| Question | "What is happening?" | "Do something." |
| Side effects | None — read-only by contract | May change state outside NIMBUS |
| Failure mode | Degrades to `status: "error"`/`"unavailable"` in a snapshot | Degrades to a structured `ActionResult` with `status: "failure"` |
| Safety metadata | None needed | `readOnly`/`changesExternalState`/`requiresConfirmation`/`affectsService` |

Spotify is the clearest illustration: "what's playing" is
`SpotifyContextProvider` (Core, `src/context/providers/spotify/`);
"play this" is `SpotifyActionProvider` (Core,
`src/actions/providers/`). Both depend on the exact same
`SpotifyApiClient` and are handed the exact same `getAccessToken`/
`isAuthenticated` functions from `SpotifyAuthManager` — the split is
purely about which question is being answered, not about which
credentials or API surface is involved. A future provider (e.g. a
generic "open application" action, or a "what's running" context
provider) would draw the same line: if it only reads, it's Context; the
moment it changes something, it's an Action — never both from the same
class.

`ActionService` (the Action-system analogue of `ContextService`) makes
the same failure-isolation promise `ContextService` already made for
Context: a provider throwing, rejecting, or reporting unavailable can
never propagate past `executeAction`, and always produces a structured
result instead. This is what let the existing IPC/renderer security model
extend cleanly — see "Security boundary" below — without adding a second
failure-handling convention alongside the one Context already
established.

## Context Events and Routines

Added this task — a third generic system alongside Context and Action,
completing the pipeline the task's own diagram describes:

```
Context Event → Trigger Matcher → Routine → Suggestion → Action
```

- **`src/events/`** is the smallest of the three: `ContextEventBus` is a
  bare pub/sub hub (`publish`/`subscribe`), and `ContextEvent` is a closed
  union of shapes (`ApplicationOpenedEvent`, `WebsiteOpenedEvent`,
  `FolderOpenedEvent`, plus three reserved-but-unemitted types —
  `playbackChanged`, `calendarEventApproaching`, `emailReceived` — so a
  future producer can adopt this same mechanism without a shape change).
  Nothing about it knows Routines exist; a future consumer entirely
  unrelated to Routines could subscribe to the same bus.
- **`src/routines/`** owns the rest of the pipeline. `Routine` (in
  `types.ts`) is deliberately generic — a trigger, some conditions, a
  suggestion, and an ordered list of `{actionId, params}` steps — with
  **no Spotify-specific (or any other service-specific) field anywhere**.
  `triggerMatcher.ts` and `conditionEvaluator.ts` are pure functions
  (Context Event/condition in, boolean out); `RoutineService` is the
  stateful orchestrator that subscribes to `ContextEventBus`, matches
  routines, tracks per-routine cooldown, and — critically — **only ever
  produces a Suggestion, never calls `ActionService.executeAction`
  itself**. The only two things that ever do are `acceptSuggestion`
  (a suggestion the user actually clicked) and `testRoutine` (the
  Settings UI's explicit "Test" button) — both one line each in
  `routineService.ts`, both trivially auditable.
- **Suggestions reuse the existing assistant-event seam** — see
  `AssistantSuggestion` in `src/common/assistantEvents.ts` and
  `assistantBridge.publish()` in `lifecycle.ts` — rather than a second
  push channel. That seam was built in an earlier task specifically for
  "a future subsystem wants to reach the UI without knowing about
  windows/IPC," which is exactly what a Routine suggestion needs — the
  main window's Activity feed still gets a plain log line from this. The
  interactive prompt itself (buttons, action summary) now goes through
  the NIMBUS-owned suggestion popup window instead of a native
  `Notification` — see the "Event → Trigger → Routine → Suggestion →
  Action → Timer" section below for why. The popup, like the native
  notification it replaced, works with NIMBUS's window hidden in the
  tray (it's its own `BrowserWindow`, independent of the main window).
- **Detection**: `src/main/activity/DesktopActivityMonitor` is the only
  producer of `ApplicationOpened`/`WebsiteOpened`/`FolderOpened` events
  today. It polls on an interval (Node's built-in `child_process`, no new
  dependency) and hands the raw result to `diffActivitySnapshot` — a pure
  function in `activitySnapshot.ts` that compares this poll to the last
  one and emits events only for what actually *changed*. This two-layer
  design (impure poller + pure diff) is what makes the detection logic
  fully unit-testable without ever spawning a real process, and is also
  what prevents duplicate-trigger spam: a process that's still running
  produces no event on the next nine polls, only the one where it first
  appeared. **The very first poll after starting is treated specially**:
  with no prior snapshot to diff against, it establishes a baseline and
  emits nothing — without this, every application already open the
  moment a user turns Routines on would incorrectly fire as "just
  launched." (Caught during live testing on real Windows process data —
  see the task's own development report for how.)
- **Website detection is a heuristic, not true URL detection.** Real
  domain/URL matching needs a browser extension talking back to NIMBUS,
  which is out of scope for this task (the task itself allows deferring
  it: "unless genuinely required for reliable website detection"). What
  exists instead: the monitor reads a recognized browser's window title
  (most browsers show the page/site name there) and `WebsiteOpenedEvent`
  carries it as `windowTitle`, with `url`/`domain` present in the type
  but always `null` from this detector — `WebsiteTriggerConfig.matchField`
  already supports `"domain"`/`"url"` for when a more precise detector
  (e.g. a browser extension) is added later, it just can't be satisfied
  yet. `matchesTrigger` fails closed (no match) rather than guessing when
  a trigger asks for a field the current detector can't provide.
- **Folder detection uses Explorer's own COM API**
  (`Shell.Application.Windows()`), not filesystem watching or window-title
  scraping — the task's own guidance to prefer "a more appropriate
  Windows-specific mechanism ... rather than fragile polling" for this
  specific trigger type.

## Event → Trigger → Routine → Suggestion → Action → Timer (this task)

Extends the pipeline above without collapsing any of its layers — each
still means exactly one thing:

```
Context/OS → Event → Event Bus → Trigger Matcher → Routine → Suggestion
                                                                  │
                                                     user decision (popup)
                                                                  │
                                                        Action(s), in order
                                                                  │
                                                    (timer.start) → Timer
                                                                  │
                                                        TimerCompleted Event
```

- **Events gained a required `source` field** (`ContextEventBase.source`)
  identifying the producer (`"desktopActivityMonitor"`, `"timerService"`,
  test fixtures use `"test"`) — a deliberately small addition, not a
  redesign: every existing event producer already knew what it was: this
  just makes that explicit and inspectable rather than collapsing
  Event/Trigger/Routine together to infer it.
- **A fourth event type, `TimerCompletedEvent`, and a matching
  `timerCompleted` trigger** (`src/routines/types.ts`,
  `triggerMatcher.ts`) exist so a *future* Routine could react to "a
  timer just finished" (e.g. a break suggestion) the exact same way it
  reacts to an app opening — through the generic Event → Trigger →
  Routine path, not a special case. No Routine ships using it yet; this
  task only establishes the seam (see the task's own instruction not to
  build the break-routine behavior itself).
- **`src/timers/`** is a new, entirely generic countdown engine —
  `TimerService` knows nothing about Spotify, Routines, or focus/break
  cycles. It tracks one current timer at a time (starting a new one
  cancels/replaces the old — a deliberate simplification, not a missing
  feature: nothing in this task asked for concurrent timers), exposes
  `start/pause/resume/cancel/getState`, and publishes a
  `TimerCompletedEvent` onto the *same* `ContextEventBus` every other
  event producer uses when a countdown reaches zero. "Pomodoro" today is
  just `type: "focus"` with a configurable duration — no automatic
  focus/break cycling, per the task's explicit "do not over-engineer"
  guidance.
- **`timer.start` is a normal registered Action**
  (`src/actions/providers/timerActionProvider.ts`), proving the Action
  system was never Spotify-specific: it implements the same
  `ActionProvider` interface as `SpotifyActionProvider`, takes
  `duration`/`type`/optional `title` params, and returns a structured
  `ActionResult` like every other action. A Routine's action list can mix
  Spotify and Timer steps in any order (`actions: RoutineActionStep[]`
  already supported an ordered multi-step list before this task — the
  gap this task closed was having a *second* real action type to prove
  it, not the data model itself).
- **`AssistantSuggestion.actionSummary`** (`src/common/assistantEvents.ts`)
  is generated by `RoutineService.summarizeActions()` from each
  configured step's registered `ActionDefinition.name`/`affectsService` —
  never a hand-written string like "Spotify + Timer". This is what lets
  one popup renderer show the right icon/label for any action
  combination without knowing what "Spotify" or "Timer" are; adding a
  fifth service later needs no popup changes, just an
  `ActionDefinition.affectsService` value and (optionally) an icon in
  `SERVICE_ICONS`.
- **Suggestions are now delivered through a NIMBUS-owned popup window**
  (`src/main/suggestionWindow.ts` + `src/ui/suggestion.html` +
  `src/ui/suggestionRenderer.ts` + `src/preload/suggestionPreload.ts`),
  not the native Windows `Notification`. Investigating *why* native
  notifications were showing a generic/technical identity instead of
  "NIMBUS" traced to the app never calling `app.setAppUserModelId()` — an
  unpackaged Electron app (`electron .`) has no real Windows app identity
  without it, so Windows falls back to a generic one. `main.ts` now sets
  this, which fixes identity for any *simple* native notification NIMBUS
  still uses elsewhere. But the suggestion popup itself was replaced
  rather than patched, because the underlying need — two real buttons, a
  per-action summary, NIMBUS branding — isn't something the native toast
  API renders well regardless of identity; CSS on a native notification
  can't add a second button or a dynamic action list. This is **one**
  popup implementation shared by every kind of suggestion (app-triggered,
  website-triggered, and any future timer/calendar/email-triggered
  routine) — it renders whatever `AssistantSuggestion` it's given, with
  no per-feature branching.
  - The popup's preload calls the *same* `nimbus:accept-suggestion` /
    `nimbus:dismiss-suggestion` IPC channels the main window already
    used — deliberately not a second set of channels, so
    `RoutineService`'s accept/dismiss logic has exactly one caller path
    regardless of which window triggered it.
  - It never steals focus (`showInactive()`, not `show()`), is
    frameless/non-resizable/always-on-top, positions itself in the
    primary display's bottom-right work area (recomputed on every show,
    so a display change or unplugged monitor doesn't leave it
    off-screen), and auto-dismisses after a timeout — the same "small
    assistant notification, not a modal" shape the task asked for.
  - It shows only what the `AssistantSuggestion`/`actionSummary` carry —
    title, message, per-action labels/icons, two buttons. No routine id,
    suggestion id, or other internal identifier ever reaches the
    renderer's DOM.
- **A second, separate popup window for the running timer**
  (`src/main/timerWindow.ts` + `src/ui/timer.html` +
  `src/ui/timerRenderer.ts` + `src/preload/timerPreload.ts`) — kept
  distinct from the suggestion popup because its lifecycle is completely
  different (stays open and interactive for the timer's whole duration,
  not a few seconds), not because timers are conceptually special. Same
  frameless/always-on-top/non-focus-stealing shape, positioned top-right
  to avoid overlapping the suggestion popup's bottom-right spot. Its
  renderer polls `nimbus:get-timer-state` once a second rather than being
  pushed updates — simple, and sufficient for one small window with one
  viewer.
- **`onActionExecuted(actionId)`** in `lifecycle.ts` (renamed this task
  from `invalidateContextCacheForAction`, which is still exactly half of
  what it does) is the one place that reacts to "an action of this id
  just ran," regardless of whether it ran via direct
  `nimbus:execute-action` or a Routine's `acceptSuggestion`/`testRoutine`.
  It stays a flat list of unrelated `actionId`-keyed branches — Spotify
  actions invalidate the Context cache, `timer.start` opens the timer
  window — rather than growing into a shared abstraction; the two
  concerns only share this seam because they share the same trigger
  condition, not because they're related.
- **Routine editing reuses the create form** (`initRoutinesSettings()` in
  `src/ui/renderer.ts`) rather than a second editor: an `editingRoutineId`
  variable (null when creating) is the only state that changes what
  "Save routine" does — append vs. replace-by-id — and an Edit button per
  routine row calls `populateFormForEdit()` to fill the same fields
  (name, trigger + its type-specific inputs, suggestion title/message,
  cooldown, the ordered action list) that creation already used.

## Calendar/Email/Tasks/Spotify integration boundary

Added after the two refactors above, calendar, email, tasks, and Spotify
are modules built *with* this document's guidance already in mind,
rather than the reason for it. Worth calling out explicitly since the
tasks that added them named the multi-device concern directly:
`CalendarProvider` (Core) depends only on
`IcsCalendarSource.fetchRaw(): Promise<string>`, `EmailProvider` (Core)
depends only on
`ImapEmailSource.fetchRecentMessages(...): Promise<RawEmailMessage[]>`,
`TaskProvider` (Core) depends only on
`TodoistTaskSource.fetchActiveTasks(): Promise<RawTaskItem[]>`, and both
`SpotifyContextProvider` and `SpotifyActionProvider` (Core) depend only
on `SpotifyApiClient`, itself depending only on an injected
`getAccessToken(): Promise<string | null>` function — none of these has
any idea whether the data came from an HTTP request, a local file, an
IMAP connection, a REST API call, or an OAuth-authenticated one. A future
Google/Microsoft Graph source (calendar), Gmail API/Graph mail source
(email), or a second task connector (a different app, a local list,
CalDAV/VTODO) implements that same narrow shape and is passed to the
provider the same way; nothing about `ContextService`, `ActionService`,
`BriefingGenerator`, IPC, or the UI needs to know or change — Tasks
additionally carries this forward explicitly via each account's own
`provider` field (only `"todoist"` exists today), so a second connector
doesn't even need a shape change to the settings model, just a new case
in `TaskProvider`'s `sourceFactory`.

Spotify is where this boundary stopped being hypothetical: it's the
first integration in NIMBUS that actually needs real OAuth (Calendar and
Email's "real OAuth" so far was always future work, deferred in favor of
a URL/app-password). `SpotifyAuthManager`
(`src/main/spotify/spotifyAuthManager.ts`) is exactly the
device-flavored module this section always said such a thing would live
in — a local redirect listener (a temporary loopback `http.createServer`),
`safeStorage`-based token storage, and refresh scheduling — and it lives
entirely under `src/main/`, not inside Core. It uses Authorization Code +
PKCE specifically because that flow needs no client secret at all (see
README's "Spotify" section), so unlike a hypothetical future
Calendar/Email OAuth integration, there was never a secret to keep out of
Core in the first place — only a Client ID, which still isn't hardcoded
(see config.ts's `SpotifyConfig`). A future Android client would
implement `SpotifyAuthManager`'s role with its platform's own "open a
browser, catch a redirect" mechanism (typically a Custom Tab + App Link)
and hand `SpotifyContextProvider`/`SpotifyActionProvider` the same two
functions, unchanged.

All four integrations also show the boundary's credential-exposure
asymmetry in practice: a calendar feed URL round-trips to the renderer
(masked) for the Settings form to display, while an email account's
password, a task account's API token, and Spotify's tokens never do — the
renderer only ever sees `hasPassword`/`hasApiToken`/`connected` booleans
— since a stolen ICS URL only exposes read access to free/busy calendar
data, while a stolen mail password, task-app token, or Spotify token is
far more sensitive. Spotify goes one step further than email/tasks:
where their credentials are plaintext strings in `settings.json` (still
never sent to the renderer, but readable by anything with filesystem
access to that file), Spotify's tokens are encrypted at rest via
`safeStorage` in their own file — see README's "Token storage" under
"Spotify" for why the stakes are different enough to justify that extra
step.

## Things reviewed and deliberately left alone

- **`context/`, `briefing/` directory names and structure**: already
  Electron-free before this task (aside from the logger issue above).
  Physically moving them into a `src/core/` folder was considered and
  rejected — it would touch ~15 import paths for no behavioral or
  portability benefit beyond what's already true today. If/when Core is
  actually extracted into a separate package (e.g. for a backend or a
  shared library consumed by an Android build), that's the point to do
  the move, informed by real constraints instead of a guess made now.
- **`tray.ts` / `autostart.ts`**: correctly Windows-specific already, and
  map directly onto the task's own examples of what a Windows client
  should own. No change.
- **`systemInfoProvider.ts`**: uses Node's `os` module, not an
  Electron/Windows-only API — so in principle it would build on Android
  too *if* Android NIMBUS runs on a Node-based runtime. Left as a Core
  provider as-is; flagged here so it isn't assumed identical to a native
  Android "device info" capability (battery, sensors, etc.), which will
  need its own provider.
- **`assistantBridge.ts`**: stays Windows-specific. It answers "how do I
  push an event to *this device's* open window(s)" — an Android client
  needs an analogous mechanism, not this one. The portable part is
  already separated out (`common/assistantEvents.ts`, the event shapes).
- **`randomUUID()` from Node's `crypto`** (used in `briefingGenerator.ts`):
  fine for the current Node/Electron runtime; flagged as a thing to check
  if Core ever runs under a restricted JS engine (e.g. Hermes/React
  Native) that lacks it — not an issue today.

## Guidance for adding the next feature

- **A new fact about the user's situation** (meals, more system status): a
  new `ContextProvider` under `src/context/providers/`, registered either
  in `src/context/index.ts` (if it needs no runtime settings, like
  `dateTime`/`system`) or in `src/main/lifecycle.ts` (if it needs live
  settings, like `weather`/`calendar`/`email`/`tasks`/`spotify`). Give it
  a `buildXItem()` in `briefingGenerator.ts` if it should appear in the
  morning briefing — the category already exists in `BriefingCategory`.
- **Something NIMBUS should be able to *do*** (open an application, close
  an application, open a file, control volume, lock the PC, a second
  Spotify capability): a new `ActionProvider` under
  `src/actions/providers/`, registered in `src/main/lifecycle.ts` the same
  way `SpotifyActionProvider` is — see "Context vs. Action" above for how
  to tell whether something belongs here or in Context instead. No new IPC
  handler is needed; `nimbus:execute-action` already routes to any
  registered provider by action id. Set `requiresConfirmation: true` on
  its `ActionDefinition` for anything genuinely risky (deleting data,
  sending something, shutting down) — `ActionService` doesn't enforce it
  yet, but the metadata should be accurate for when it does.
- **A new external API**: an integration client (see
  `openMeteoClient.ts`/`ipGeolocation.ts`/`icsCalendarSource.ts`/
  `imapEmailSource.ts`/`todoistTaskSource.ts`/`spotifyApiClient.ts`)
  behind a Core-side adapter, the same way weather, calendar, email,
  tasks, and Spotify are structured. Never called directly from
  `src/main` or `src/ui`.
- **A new Windows-only capability** (running applications, filesystem
  access, desktop notifications, PC automation): lives under `src/main/`,
  following `tray.ts`/`autostart.ts`/`spotify/` as the pattern — a small
  module with a narrow interface, wired up in `lifecycle.ts`.
- **Anything that should eventually work identically on Android**: keep
  it free of `electron` imports and out of `src/main`/`src/preload`/`src/ui`.
  If it needs a device capability (a file path, a directory to write to,
  whether login-item registration exists at all), take that capability
  as an injected function/interface — exactly like `configureFileLogging`
  — rather than importing `electron` to get it directly.
