# NIMBUS Architecture

This document describes how NIMBUS's code is organized today, and why —
with the project's long-term direction in mind: NIMBUS is meant to
eventually exist across multiple devices (a Windows PC, an Android phone,
possibly a web client) that all talk to a shared NIMBUS "core" (context,
briefings, preferences, tasks, notifications, integrations, assistant
state, authentication, device identity) rather than behaving as
independent assistants.

**Nothing here builds that backend or an Android client.** Today NIMBUS
is a single Windows Electron app. What this document tracks is that the
code doesn't quietly bake in assumptions that would make a second client
unnecessarily painful later.

## The five layers

| Layer                         | What it means                                                                                                                                 | Owns                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Core**                   | Platform-independent logic. Zero dependency on Electron or any OS API.                                                                        | Context, Actions, Events, Routines, Activity, Timers, Attention, Network, Briefing, the assistant-event contract, settings schema, generic utilities |
| **2. Device/client-specific** | Code that only makes sense because this client is "a Windows desktop app."                                                                    | Windows, tray, lifecycle, autostart, IPC wiring, desktop activity monitoring, credential/state files, Spotify's OAuth flow, popups                   |
| **3. External integrations**  | Code that talks to a third-party service. Portable in principle, organized as an implementation detail behind a Core adapter.                 | Open-Meteo, IP geolocation, ICS fetching, IMAP, Todoist, Spotify Web API, Yahoo Finance                                                              |
| **4. User data/context**      | The data itself: what NIMBUS knows and what the user has told it. A _slice_ of Core, called out because it is what would sync across devices. | Context snapshots, briefings, `UserPreferences`                                                                                                      |
| **5. UI/presentation**        | Rendering and interaction for _this_ client. A future client's UI would be a separate implementation talking to the same Core.                | `src/ui/`, the preload bridges                                                                                                                       |

## Where every module sits

```
src/
  context/                 [1] Core — the Context system
    types.ts                     ContextProvider / ContextSnapshot contract
    contextService.ts            Aggregator: register providers, getSnapshot()
                                   (each call time-bounded, stale fallback)
    index.ts                     The contextService instance; registers the
                                   settings-independent providers
    providers/
      dateTimeProvider.ts         [1]/[4] No external calls
      systemInfoProvider.ts       [1]/[4] Node's `os` module — see caveat below
      weather/                    weatherProvider, locationResolver [1];
                                   openMeteoClient, ipGeolocation,
                                   geocoding (city search) [3];
                                   weatherCodes [1]
      calendar/                   calendarProvider [1]; icsCalendarSource [3]
                                   (http(s) or a local .ics file); icsParser,
                                   icsRecurrence,
                                   icsTimeUtils [1]
      email/                      emailProvider, emailImportance, types [1];
                                   imapEmailSource [3] (read-only IMAP)
      tasks/                      taskProvider, taskRelevance, types [1];
                                   todoistTaskSource [3] (read + write)
      spotify/                    spotifyContextProvider, types [1];
                                   spotifyApiClient [3] — shared with the
                                   Spotify Action provider
      stocks/                     stockProvider, positionMath, dividends,
                                   closed, irs, types [1];
                                   yahooFinance [3] behind the
                                   MarketDataSource / NewsSource interfaces
                                   (read-only — no trading anywhere)

  collections/decks/        [1] Core — decks: rules.ts, stats.ts (curves),
                                   builder.ts (the deck builder's playstyles
                                   and plan advice); catalogs/browse.ts [3]
                                   browses each card database for it

  actions/                  [1] Core — the Action system
    types.ts                     ActionProvider / ActionResult contract
    actionService.ts             executeAction(): resolve, check availability,
                                   validate, execute — time-bounded, never throws
    providers/
      spotifyActionProvider.ts    spotify.* (the write half of Spotify)
      timerActionProvider.ts      timer.start / stop / pause / resume /
                                   addStudy
      systemActionProvider.ts     system.openUrl (http/https only), system.lock
      appActionProvider.ts        app.launch / focus / minimize / maximize / close
      fileActionProvider.ts       files.openFile / files.openFolder
      mediaActionProvider.ts      media.* — media keys, system volume, mute
      desktopPlatform.ts          The narrow OS interface those four use (no
                                   command-line member), plus pure path and
                                   process-name validation

  events/                   [1] Core — Context events
    types.ts                     ContextEvent shapes (see "Context Events")
    eventBus.ts                  ContextEventBus — minimal pub/sub, no persistence

  routines/                 [1] Core — the Routine system
    types.ts                     Routine / TriggerConfig / RoutineCondition,
                                   validateRoutine, runtime-state types
    triggerMatcher.ts            Pure event-vs-trigger matching
    conditionCatalog.ts          What can be checked, as data: field →
                                   operator → value, and the translation
                                   both ways to a stored condition. Shared
                                   by the evaluator and the editor
    conditionEvaluator.ts        Pure condition evaluation, with per-condition
                                   explanations
    routineService.ts            Orchestrator: event → gates → suggestion /
                                   auto-run; wind-downs; history

  activity/                 [1] Core — Activity & Sessions
    types.ts                     Mappings, sessions, validation
    activityDetector.ts          Pure event → activity, with precedence
    activityService.ts           Session lifecycle; publishes activityEnded
    knownActivities.ts           Activity names routines can refer to
    appUsage.ts                  Opt-in tally of windowed programs →
                                   "make it an activity?" candidates
    siteUsage.ts                 The same for websites, by the name at
                                   the end of their tab title

  timers/                   [1] Core — the timer engine
    timerService.ts              One timer or phase plan at a time; publishes
                                   timerCompleted; wall-clock based

  attention/                [1] Core — Attention & Priority
    types.ts                     AttentionSignal / AttentionItem / settings
    signals.ts                   Pure signal builders per source (calendar,
                                   tasks, weather, email, stocks, activity,
                                   routine suggestions)
    scoring.ts                   The weighted score, bands and busy rules
    attentionEngine.ts           Dedup, expiry, escalation and conflict
                                   decisions — deterministic
    attentionService.ts          Runs it: reads Context/Activity, queues
                                   routine suggestions, hands what it
                                   surfaces to an injected presenter; has no
                                   Action service

  network/                  [1] Core — Network awareness (observation only)
    types.ts                     Devices, discovery results, the narrow
                                   NetworkScanner interface
    mac.ts, oui.ts, subnet.ts    MAC normalisation, the IEEE list, address
                                   maths and the bounded sweep targets
    networkRegistry.ts           Devices by MAC: merge, IP history,
                                   online state, labels — pure
    networkService.ts            Reads, scans, persists, publishes
                                   networkDeviceAppeared
    networkProvider.ts           The `network` Context provider
    hostnames.ts                 Reverse lookups for private addresses
    identify.ts                  "Ask the device": SSDP/UPnP, mDNS and
                                   NetBIOS packets and parsing, and the
                                   summary of what a device says — pure

  memory/                   [1] Core — Persistent memory
    types.ts                     MemoryItem (kind × origin), limits, and
                                   per-item validation of persisted data
    memoryService.ts             The three tiers: remember (explicit),
                                   reinforce (learned), observe (observed);
                                   update, promote, forget, list/search,
                                   recall, expiry — over an injected store
    recorders.ts                 What gets remembered: activity sessions,
                                   routine answers, new network devices —
                                   called only from lifecycle wiring

  presence/                 [1] Core — Presence
    presence.ts                  At the PC / home / away / idle, from idle
                                   seconds and when the chosen phone was last
                                   on the network (45 min grace) — pure
                                   judgement plus a small service

  collections/              [1] Core — Collections (trading cards first)
    types.ts                     Games, catalog cards, collection entries
    collectionService.ts         Entries: add (merging repeats), update,
                                   remove, list, stats; per-entry validation
    catalogService.ts            Searches the catalogs: validation, pacing,
                                   cache, and resolve() — the only way a
                                   card enters the collection
    catalogs/                    [3] scryfall, tcgdex, ygoprodeck, lorcast,
                                   optcg — each a pure mapper plus a fetch
    books/                       Comics collected editions and manga:
                                   runs.ts (the "Collects …" parser, shared
                                   with the renderer), coverage.ts (pure),
                                   bookService.ts, gcd.ts [3] (Grand Comics
                                   Database)

  briefing/                 [1]/[4] Core — the Briefing system
    types.ts, briefingGenerator.ts, briefingService.ts
                                   Pure functions/classes over ContextSnapshot

  common/                   [1] Core — shared helpers
    assistantEvents.ts           The AssistantEvent contract (shapes only)
    appInfo.ts                   Branding; version read from package.json
    timeout.ts                   httpTimeoutSignal() and withTimeout()
    ttlCache.ts                  Generic TTL cache used by providers
    patternMatch.ts              Comma-separated exact/contains matching,
                                   shared by triggers and activity mappings
    locale.ts                    Locale for date formatting

  config/config.ts          [1]* Reads process.env/.env — process/deployment
                                   config, not user data

  logging/logger.ts         [1] Console + optional file logging; no Electron

  settings/
    settingsSchema.ts           [1] Types, defaults, legacy migration, and the
                                   plaintext/credential split — no Electron,
                                   no filesystem
    activityMigration.ts        [1] Moves routine-declared activities into
                                   the activity list on load
    settingsManager.ts          [2] File path, atomic write, keystore wiring

  main/                     [2] Windows-specific (Electron main process)
    main.ts                       Entry point: file logging, AppUserModelID,
                                   single-instance lock
    lifecycle.ts                  Windows/tray lifecycle, every main-window
                                   IPC handler, wiring of all services
    tray.ts, autostart.ts         Tray icon/menu; login-item registration
    assistantBridge.ts            Pushes AssistantEvents to open windows
    suggestionWindow.ts           The suggestion popup window
    timerWindow.ts                The timer popup window
    desktop/
      windowsDesktop.ts            DesktopPlatform for Windows: shell.openPath,
                                   shell-less spawn, and constant PowerShell
                                   scripts (user32, Core Audio) that receive
                                   values only as environment variables
    secretStore.ts                safeStorage-encrypted credentials
                                   (secrets.json)
    routineStateStore.ts          Cooldowns and owed wind-downs
                                   (routine-state.json)
    activityStateStore.ts         Activity session history
                                   (activity-history.json)
    appUsageStore.ts              The opt-in app-usage tally
                                   (app-usage.json)
    siteUsageStore.ts             The opt-in website tally
                                   (site-usage.json)
    collectionStore.ts            The card collection (collection.json)
    deckStore.ts                  Decks (decks.json)
    bookStore.ts                  The comics and manga shelf (books.json)
    memoryStore.ts                Memory, one file per tier
                                   (memory/*.json)
    network/
      windowsNetworkScanner.ts     Two fixed PowerShell scripts: read the
                                   neighbor cache; ping validated private
                                   addresses
      neighborParsing.ts           [1]* Pure parsing of the read script
      deviceProbe.ts               Asks one device (UDP 1900/5353/137 and
                                   its own description file) on request
      networkFiles.ts              network-devices.json, and the optional
                                   oui.csv
    spotify/
      spotifyAuthManager.ts        PKCE OAuth flow (system browser + loopback
                                   server), token refresh
      spotifyPkce.ts               [1]* Pure PKCE math, unit-tested
      spotifyTokenStore.ts         safeStorage-encrypted tokens
                                   (spotify-tokens.json)
    activity/
      desktopActivityMonitor.ts    Polls processes, browser titles and Explorer
                                   folders every 5 s; publishes the diff
      powerShellSession.ts         One long-lived PowerShell fed over stdin,
                                   with a one-shot fallback
      activitySnapshot.ts          [1]* Pure diff of two polls into events

  preload/                  [2]/[5] The only bridges into the UI
    preload.ts                    Main window (window.nimbus)
    suggestionPreload.ts          Suggestion popup (window.nimbusPopup)
    timerPreload.ts               Timer popup (window.nimbusTimer)

  ui/                       [5] Renderers (main window, suggestion popup,
                                   timer popup), bundled by esbuild; styled
                                   with the vendored Nocturne design system

  services/                 Placeholder — see src/services/README.md
```

`*` = pure logic living beside the Windows code that uses it, kept separate
precisely so it can be unit-tested without Electron. `config.ts` is
categorized loosely: it is process configuration rather than Core logic or
a device capability.

## The UI/preload bridge and IPC surface

Every window runs with `contextIsolation: true`, `nodeIntegration: false`,
and a Content Security Policy limiting scripts to the app itself. A
renderer can only call what its preload exposes.

**Main window** (`preload.ts` → `window.nimbus`), handled in `lifecycle.ts`:

| Area                   | Channels                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App & window           | `nimbus:get-app-info`, `nimbus:get-settings`, `nimbus:update-settings`, `nimbus:get-zoom`, `nimbus:set-zoom`, `nimbus:hide-window`                                                                                                                                                                                                                                                                     |
| Context & briefing     | `nimbus:get-context`, `nimbus:get-briefing`, `nimbus:regenerate-briefing`                                                                                                                                                                                                                                                                                                                              |
| Weather / calendar     | `nimbus:get-weather-settings`, `nimbus:update-weather-settings`, `nimbus:get-calendar-settings`, `nimbus:update-calendar-settings`                                                                                                                                                                                                                                                                     |
| Email                  | `nimbus:get-email-settings`, `nimbus:update-email-settings`                                                                                                                                                                                                                                                                                                                                            |
| Tasks                  | `nimbus:get-task-settings`, `nimbus:update-task-settings`, `nimbus:list-tasks`, `nimbus:list-task-projects`, `nimbus:create-task`, `nimbus:update-task`, `nimbus:complete-task`, `nimbus:reopen-task`, `nimbus:delete-task`                                                                                                                                                                            |
| Spotify                | `nimbus:get-spotify-settings`, `nimbus:update-spotify-settings`, `nimbus:spotify-connect`, `nimbus:spotify-disconnect`, `nimbus:spotify-list-playlists`                                                                                                                                                                                                                                                |
| Stocks                 | `nimbus:get-stock-settings`, `nimbus:update-stock-settings`, `nimbus:refresh-stocks`, `nimbus:get-stock-news`, `nimbus:find-stock-listings` (tracked symbols only), `nimbus:get-stock-dividends`, `nimbus:close-stock-position`, `nimbus:get-stock-irs-report`                                                                                                                                         |
| Actions                | `nimbus:list-actions`, `nimbus:execute-action`, `nimbus:pick-path` (a file/folder dialog for path parameters)                                                                                                                                                                                                                                                                                          |
| Routines & suggestions | `nimbus:get-routine-settings`, `nimbus:update-routine-settings`, `nimbus:test-routine`, `nimbus:run-routine-now`, `nimbus:get-routine-history`, `nimbus:get-routine-last-triggered`, `nimbus:get-active-suggestions`, `nimbus:accept-suggestion`, `nimbus:dismiss-suggestion`, `nimbus:get-attention`, `nimbus:update-attention-settings`                                                              |
| Network                | `nimbus:get-network-state`, `nimbus:refresh-network`, `nimbus:scan-network`, `nimbus:cancel-network-scan`, `nimbus:update-network-device`, `nimbus:forget-network-device`, `nimbus:identify-network-device`, `nimbus:update-network-settings`                                                                                                                                                          |
| Presence               | `nimbus:get-presence`, `nimbus:set-presence-phone` (a Network tab device id, checked against the list)                                                                                                                                                                                                                                                                                                 |
| Decks                  | `nimbus:get-card-detail` (game and catalog id only), `nimbus:get-decks`, `nimbus:get-deck`, `nimbus:create-deck`, `nimbus:update-deck`, `nimbus:remove-deck`, `nimbus:add-deck-card` (catalog id only — the card is fetched in the main process), `nimbus:set-deck-card-quantity`, `nimbus:move-deck-card`, `nimbus:import-decklist` (text, capped); pushes `nimbus:decks-changed`                     |
| Books                  | `nimbus:get-books`, `nimbus:search-comic-series` (a series name only), `nimbus:get-comic-volume` (a numeric GCD volume id only — the URL is built in the main process), `nimbus:add-book`, `nimbus:update-book`, `nimbus:remove-book`, `nimbus:get-comic-issue` (series name, year and number only), `nimbus:open-comic-link` (League of Comic Geeks or GCD; the address is built in the main process) |
| Collections            | `nimbus:get-collection`, `nimbus:search-card-catalog` (a game id and search text only), `nimbus:add-to-collection` (a game and catalog id — the card's data comes from the main process's own search), `nimbus:update-collection-card`, `nimbus:remove-collection-card`                                                                                                                                |
| Memory                 | `nimbus:list-memories`, `nimbus:remember-memory`, `nimbus:update-memory`, `nimbus:promote-memory`, `nimbus:forget-memory`, `nimbus:get-memory-settings`, `nimbus:update-memory-settings`                                                                                                                                                                                                               |
| Activity & timer       | `nimbus:get-current-activity`, `nimbus:get-activity-sessions`, `nimbus:get-known-activities`, `nimbus:get-activity-settings`, `nimbus:update-activity-settings`, `nimbus:get-activity-snapshot`, `nimbus:get-timer-state`                                                                                                                                                                              |

**Suggestion popup** (`suggestionPreload.ts`): `nimbus:get-popup-suggestion`,
`nimbus:accept-suggestion`, `nimbus:dismiss-suggestion`,
`nimbus:close-suggestion-popup`.

**Timer popup** (`timerPreload.ts`): `nimbus:get-timer-state`,
`nimbus:pause-timer`, `nimbus:resume-timer`, `nimbus:cancel-timer`,
`nimbus:timer-add-study`, `nimbus:close-timer-window`.

**Pushes from main to renderer**: `nimbus:briefing-updated`,
`nimbus:assistant-event`, `nimbus:activity-changed`,
`nimbus:now-playing-changed`, `nimbus:network-changed`, `nimbus:memory-changed`, `nimbus:collection-changed`, `nimbus:books-changed`, `nimbus:presence-changed`, `nimbus:zoom-changed`, `nimbus:open-activity-editor` (main window) and
`nimbus:popup-suggestion-updated` (suggestion popup).

Rules the handlers follow:

- **Credentials are write-only.** Email passwords and Todoist tokens never
  reach a renderer — the API returns `hasPassword`/`hasApiToken` and
  accepts `newPassword`/`newApiToken`. Spotify tokens never leave the main
  process; the renderer sees only `connected`. Calendar feed addresses do
  round-trip, and are shown masked.
- **Routines and activity mappings are validated** before saving
  (`validateRoutine`, `validateActivityMapping`); an invalid one is
  rejected with an error.
- **The simpler settings groups** (startup, weather, calendar, Spotify)
  keep only fields the group already has, with values of the same type;
  weather's `locationMode` and calendar feed entries are checked.
- **`nimbus:execute-action` is generic**: a new action provider needs no
  new channel, and there is no path from a renderer to a provider's
  client or credentials.

## What is persisted where

All under Electron's `userData` directory (`%APPDATA%\nimbus\`), each
written atomically (temp file, fsync, rename):

| File                                                                  | Owner                     | Contents                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.json`                                                       | `settingsManager.ts`      | `WindowsClientSettings` + `UserPreferences`, with credentials stripped out                                                                       |
| `secrets.json`                                                        | `secretStore.ts`          | IMAP passwords and Todoist tokens, DPAPI-encrypted, keyed by account id                                                                          |
| `spotify-tokens.json`                                                 | `spotifyTokenStore.ts`    | Spotify tokens, DPAPI-encrypted                                                                                                                  |
| `routine-state.json`                                                  | `routineStateStore.ts`    | Cooldown timestamps; wind-downs still owed (dropped after 12 h)                                                                                  |
| `activity-history.json`                                               | `activityStateStore.ts`   | Up to 200 activity sessions                                                                                                                      |
| `network-devices.json`                                                | `network/networkFiles.ts` | Devices seen on the local network: MAC, nickname, recognized, names, first/last seen, recent IPs                                                 |
| `app-usage.json`                                                      | `appUsageStore.ts`        | Opt-in: per program with a window, minutes per day (two weeks) and your answers to "make it an activity?"                                        |
| `site-usage.json`                                                     | `siteUsageStore.ts`       | Opt-in: per website (the name at the end of its tab title), minutes per day (two weeks) and your answers                                         |
| `memory/explicit.json`, `memory/learned.json`, `memory/observed.json` | `memoryStore.ts`          | Memory, one tier per file: `{version: 1, items}`. Validated item by item on load; an unparseable file is renamed `<tier>.unreadable-<time>.json` |
| `books.json`                                                          | `bookStore.ts`            | The comics and manga shelf: `{version: 1, books}`, each with its issue runs; validated per book and per run                                      |
| `decks.json`                                                          | `deckStore.ts`            | Decks: validated deck by deck and card by card; an unparseable file is renamed `decks.unreadable-<time>.json`                                    |
| `collection.json`                                                     | `collectionStore.ts`      | The card collection: `{version: 1, cards}`, validated per entry; an unparseable file is renamed `collection.unreadable-<time>.json`              |
| `logs/nimbus.log`                                                     | `logger.ts`               | Log lines; never credentials                                                                                                                     |

**Credential lifecycle.** `loadSettings()` runs before Electron is ready
and deliberately reads no credentials (`safeStorage` reports itself
unavailable that early). `hydrateCredentials()` fills them in on `ready`,
and only a hydrated settings object may write the credential store. On
save, `extractSecrets` lists every account's key (empty when it has no
value); `SecretStore.writeAll` deletes keys for removed accounts but
**keeps an entry it could not decrypt** rather than erasing it. Without OS
encryption, credentials are not persisted, and nothing already stored is
deleted.

**Migrations on load**: a pre-split flat `settings.json`
(`migrateLegacyShape`), plaintext credentials from before the secret store
(moved into it on the first save), and routine-declared activities
(`activityMigration.ts`).

## Context vs. Action

`src/actions/` is deliberately separate from `src/context/`:

|                 | Context                                         | Action                                                                    |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Question        | "What is happening?"                            | "Do something."                                                           |
| Side effects    | None — read-only by contract                    | May change state outside NIMBUS                                           |
| Failure mode    | `status: "error"`/`"unavailable"` in a snapshot | A structured `ActionResult` with `status: "failure"`                      |
| Safety metadata | None needed                                     | `readOnly`/`changesExternalState`/`requiresConfirmation`/`affectsService` |

Spotify is the clearest illustration: "what's playing" is
`SpotifyContextProvider`, "play this" is `SpotifyActionProvider`, and both
share one `SpotifyApiClient`. If something only reads, it's Context; the
moment it changes something, it's an Action — never both from one class.
Both services make the same promise: a provider throwing, rejecting,
reporting unavailable or hanging degrades to a structured result.

`ActionService` does **not** enforce `requiresConfirmation`; the metadata
is accurate for a future confirmation layer to read.

## Context Events and Routines

```
Context/OS → Event → Event Bus → Trigger Matcher → Routine gates
                                                        │
                                   Suggestion (popup) ──┼── or auto-run (opt-in)
                                                        │
                                               Action(s), in order
                                                        │
                                          (timer.start) → Timer → timerCompleted
```

- **`src/events/`**: `ContextEventBus` is a bare pub/sub hub, and
  `ContextEvent` is a closed union. Every event has a `source`.

  | Event                                                                     | Producer                                                                                |
  | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
  | `applicationOpened`, `applicationClosed`, `websiteOpened`, `folderOpened` | `DesktopActivityMonitor`                                                                |
  | `timerCompleted`                                                          | `TimerService` (every phase)                                                            |
  | `activityEnded`                                                           | `ActivityService` (not on shutdown); also recorded to memory as a pattern               |
  | `networkDeviceAppeared`                                                   | `NetworkService` (not for the first-run baseline); recorded to memory as an observation |

  `playbackChanged`, `calendarEventApproaching` and `emailReceived` are
  reserved names in `ContextEventType`; nothing emits them.

- **`src/routines/`**: a `Routine` is generic — triggers, conditions, a
  suggestion, and ordered `{actionId, params}` steps for its start and
  end halves — with no service-specific field. `triggerMatcher.ts` and
  `conditionEvaluator.ts` are pure. `RoutineService` subscribes to the
  bus and runs the gates (enabled, cooldown, session, conditions) through
  one `evaluate()` method, which the editor's **Test** also calls —
  **Test executes nothing**. `ActionService.executeAction` is reached only
  through: accepting a suggestion, an opted-in auto-run, **Run now**, and
  a wind-down (its end half), which only runs for a routine whose start
  actions ran.
- **Suggestions reuse the assistant-event seam**: each is published
  through `assistantBridge` (a line in the Home feed) and shown in the
  suggestion popup, which calls the same accept/dismiss channels as the
  main window. Suggestions expire after 60 s. The popup is gated by
  Attention (below): a suggestion waits, rather than overwriting or being
  overwritten, while something more important is on screen.
- **Detection**: `DesktopActivityMonitor` is the only producer of desktop
  events. An impure poller hands raw data to `diffActivitySnapshot`, a
  pure function that emits events only for what changed. It runs while
  Routines or activity tracking is enabled.
- **Website detection is a heuristic**: the monitor reads recognized
  browsers' main window titles; `WebsiteOpenedEvent.url`/`domain` are
  always `null` from this detector, and `matchesTrigger` fails closed for
  a trigger that asks for them. Real URL detection needs a browser
  extension — not implemented.
- **Folder detection** uses Explorer's own COM API
  (`Shell.Application.Windows()`).

## Attention & Priority

```
Context ─┐
Activity ├─→ Signals ─→ AttentionEngine ─→ AttentionItems ─→ Suggestion popup / Home feed
Routines ┘              (score, dedupe, decide, explain)      (existing presentation)
```

`src/attention/` decides what deserves attention right now. Pure signal
builders turn Context, Activity and routine suggestions into scored
signals with stable keys; the engine deduplicates, expires, and decides
per item — surface, hold (with a reason), keep quiet, or already shown —
allowing one interruption at a time. `AttentionService` runs it every
30 s (reusing a Context snapshot for 5 minutes) and hands surfaced items
to a presenter injected by `lifecycle.ts`: the existing suggestion popup
for urgent/high, the Home feed for normal.

The Action boundary is kept structurally: Attention has no Action service
(a test checks the compiled module). Routine suggestions still come from
RoutineService and are accepted there; Attention's own suggestions are
informational, and answering them only acknowledges. See
[docs/attention.md](docs/attention.md).

## Memory

`src/memory/` is what NIMBUS keeps knowing across restarts, in three
tiers that are stored and trusted apart: **explicit** (the user saved it —
confidence 1, no expiry unless they set one, only they edit it),
**learned** (patterns — confidence `n/(n+3)` capped at 0.95, forgotten 90
days after the last reinforcement) and **observed** (single events —
forgotten after 30 days). Only the user's **Keep** turns a learned or
observed item into an explicit one. `recall(key)` returns the most
trusted enabled item.

Nothing writes to memory on its own behalf: `recorders.ts` translates what
services already publish (`activityEnded`, `networkDeviceAppeared`, a
routine suggestion's answer), and only `lifecycle.ts` calls it. The
renderer can save its own memories and switch off, keep or forget any —
never write a learned or observed one. The "Learn from what I do" setting
(`userPreferences.memory.learning`) stops all recording. Nothing reads
memory back into decisions yet. See [docs/memory.md](docs/memory.md).

## Activity & Sessions

`src/activity/` sits between Events and Routines: `ActivityService`
subscribes to the same bus, turns events into sessions using the user's
mappings, and publishes `activityEnded` when a session ends. It never
invokes an action; Routines read it through the `activityEnded` trigger
and the `activityIs`/`activityDuration` conditions. See
[docs/activity.md](docs/activity.md).

## Timers

`TimerService` is generic: it knows nothing about Spotify, Routines or the
word "Pomodoro". It runs one timer at a time, optionally as a **plan** of
phases that chain automatically, and publishes `timerCompleted` at the end
of every phase. `TimerActionProvider` is the part that knows what a
Pomodoro is (building Study/Break phases, adding studies to a running
plan). Remaining time is clamped to the wall clock, so sleep doesn't
extend a countdown.

`onActionExecuted` in `lifecycle.ts` is the one place reacting to "an
action just ran": `spotify.*` refreshes the now-playing state, and a
successful `timer.start` opens the timer popup.

## Popups

The suggestion popup (`suggestionWindow.ts`, `suggestion.html`,
`suggestionRenderer.ts`, `suggestionPreload.ts`) and the timer popup
(`timerWindow.ts`, `timer.html`, `timerRenderer.ts`, `timerPreload.ts`)
are NIMBUS-owned `BrowserWindow`s rather than native notifications — a
native toast can't render two real buttons and a dynamic action list.
Both are frameless, always-on-top, shown with `showInactive()` and
positioned in the primary display's work area. The timer popup polls
`nimbus:get-timer-state` once a second. `main.ts` still sets
`app.setAppUserModelId()` so any simple native notification carries the
NIMBUS identity.

## Calendar/Email/Tasks/Spotify integration boundary

Each Core provider depends on a narrow source: `CalendarProvider` on
`IcsCalendarSource.fetchRaw()`, `EmailProvider` on
`ImapEmailSource.fetchRecentMessages()`, `TaskProvider` on
`TodoistTaskSource`, and both Spotify providers on `SpotifyApiClient`,
which depends only on an injected `getAccessToken()`. None knows whether
its data came over HTTP, IMAP, a file or OAuth. A future Google/Microsoft
Graph calendar, Gmail/Graph mail source, or second task connector fills
the same role without `ContextService`, the briefing, IPC or the UI
changing; tasks carry a `provider` field for exactly that.

Spotify is the one integration that uses real OAuth. `SpotifyAuthManager`
(a loopback redirect listener, `safeStorage` token storage, refresh) lives
entirely under `src/main/`, and uses Authorization Code + PKCE, so there
is no client secret — only a Client ID from `.env`. A future Android
client would implement that role with its own browser/redirect mechanism
and hand the Core providers the same two functions.

## Settings split

`UserPreferences` (weather, calendar, email, tasks, Spotify, routines,
activity, stocks, attention) is data that conceptually belongs to the user and would follow
them to another device; `WindowsClientSettings` (window bounds, startup
behaviour, network watching) only makes sense on this Windows install. Both live in one
local `settings.json` — there is no sync backend — but the type boundary
means adding sync later is a transport for `UserPreferences`, not a
re-decision of what counts as shared data.

## Boundary refactors (history)

Two early refactors established the boundary this document describes:

1. **`logger.ts` no longer imports `electron`.** It used to call
   `electron.app.getPath("userData")`, giving Core a transitive Electron
   dependency. File logging is now opt-in via
   `configureFileLogging(directoryProvider)`, called once from `main.ts`.
2. **Settings were split into `WindowsClientSettings` and
   `UserPreferences`**, with `migrateLegacyShape` reading the older flat
   files. At the time `UserPreferences` held only weather; it has since
   grown to the groups listed above.

## Things reviewed and deliberately left alone

- **`context/`, `briefing/` directory layout**: already Electron-free.
  Moving Core into a `src/core/` folder would touch many import paths for
  no benefit until Core is actually extracted into its own package.
- **`tray.ts` / `autostart.ts`**: correctly Windows-specific.
- **`systemInfoProvider.ts`**: uses Node's `os` module, so it would run on
  any Node runtime — but it is not a substitute for a native Android
  "device info" provider.
- **`assistantBridge.ts`**: stays Windows-specific; the portable part is
  `common/assistantEvents.ts`.
- **`randomUUID()` from Node's `crypto`**: fine under Node/Electron; worth
  checking if Core ever runs on a restricted JS engine.

## Guidance for adding the next feature

- **A new fact about the user's situation**: a `ContextProvider` under
  `src/context/providers/`, registered in `src/context/index.ts` (no live
  settings) or `src/main/lifecycle.ts` (live settings). Add a builder in
  `briefingGenerator.ts` if it belongs in the briefing — `meals` already
  exists in `BriefingCategory`, unused.
- **Something NIMBUS should _do_**: an `ActionProvider` under
  `src/actions/providers/`, registered in `lifecycle.ts`. No IPC change is
  needed. Set `requiresConfirmation: true` for anything genuinely risky —
  it isn't enforced yet, but the metadata should be accurate.
- **Something that should get the user's attention**: a signal builder
  in `src/attention/signals.ts` reading its provider from the snapshot
  (see [docs/attention.md](docs/attention.md)). The engine, scoring and
  presentation need no change.
- **Something new to react to**: a new `ContextEvent` shape published on
  the bus, plus a trigger type in `routines/types.ts` and a case in
  `triggerMatcher.ts`.
- **A new external API**: an integration client behind a Core adapter,
  never called directly from `src/main` or `src/ui`.
- **A new Windows-only capability**: under `src/main/`, a small module
  with a narrow interface, wired in `lifecycle.ts`.
- **Anything that should work identically on Android**: keep it free of
  `electron` imports and out of `src/main`/`src/preload`/`src/ui`; take
  device capabilities as injected functions, like `configureFileLogging`.
