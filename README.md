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
  context/         The Context system — providers + aggregator
  activity/        Activity & Sessions — what the user is doing now
  actions/         The Action system — providers + executor
  routines/        Trigger to Suggestion to Action rules
  timers/          Generic timer engine (no UI or Spotify knowledge)
  events/          The in-process Context event bus
  briefing/        The Briefing system — turns Context into a concise,
                   structured morning briefing
  common/          Shared constants (branding, app info), the
                   assistant-event contract, and shared timeout helpers
```

See **[Documentation](#documentation)** below for a guide to each of
these subsystems.

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
- **Credentials never touch `settings.json`.** IMAP passwords, Todoist
  API tokens and Spotify OAuth tokens are encrypted with the OS keystore
  (Windows DPAPI, via Electron's `safeStorage`) and kept in separate
  files — `src/main/secretStore.ts` and
  `src/main/spotify/spotifyTokenStore.ts`. `settings.json` stays safe to
  open, diff or paste into a bug report.
- **`settingsSchema.ts` vs `settingsManager.ts`**: the schema module holds
  the types, defaults, migration and credential split with no Electron or
  filesystem dependency, so it is unit-testable under plain `node --test`.
  The manager is the thin Windows layer around it (file path, atomic
  write, keystore wiring).
- **The UI is bundled, not just compiled.** `scripts/bundle-ui.js` runs
  esbuild over the three renderer entry points, so the renderers can be
  split into real modules while the browser still gets one plain script
  per window (there is no `require` in a renderer with
  `nodeIntegration: false`).
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

## Documentation

The sections below used to live in this README. They are the reference
material for each subsystem — read them when you are working on that
subsystem, not to get started.

| Guide | What it covers |
| --- | --- |
| [The Context system](docs/context-system.md) | How ContextProviders are registered, aggregated and isolated from each other's failures |
| [The Action system](docs/action-system.md) | ActionProviders, the execute/validate contract, and the Context-vs-Action split |
| [The Briefing system](docs/briefing.md) | How a context snapshot becomes the briefing the Home tab shows |
| [Activity & Sessions](docs/activity.md) | What the user is doing now and for how long — mappings, session lifecycle, and how routines read it |
| [Context-aware routines](docs/routines.md) | Trigger to Suggestion to Action, desktop activity monitoring, and its privacy boundary |
| [Weather](docs/weather.md) | Location resolution and the Open-Meteo integration |
| [Calendar](docs/calendar.md) | ICS feeds, how to obtain one, and the parser's limits |
| [Email](docs/email.md) | IMAP setup, app passwords, and what NIMBUS does and does not read |
| [Tasks](docs/tasks.md) | Todoist setup and the read/write task surface |
| [Spotify](docs/spotify.md) | Registering a Spotify app, the PKCE flow, and playback control |

Architecture-level decisions — what counts as portable Core versus
Windows-specific, and how to keep that boundary — live in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Versions

`MAJOR.MINOR.PATCH` — major for a full release (still 0), minor for a big
milestone, patch for everything else. See
**[CHANGELOG.md](CHANGELOG.md)** for what each version contains, and the
git tags (`git log v0.2.0..v0.3.0`) for exactly what changed between two.

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

If you are changing renderer code, also run the UI bundler in watch mode
— `npm run dev` type-checks the renderers but no longer produces what the
app loads (see "The UI is bundled" above):

```bash
npm run dev:ui
```

### Checks

```bash
npm run check
```

Runs the linter, the formatter check and the test suite together. They
are also available individually as `npm run lint`, `npm run format:check`
(`npm run format` rewrites) and `npm test`.

Tests run on the compiled output under `dist/`, so `npm test` compiles
first. It runs `tsc` only, not the UI bundler — which is why the bundler
writes `dist/ui/*.bundle.js` rather than over tsc's own output for those
files. The two build steps are independent and can run in any order.

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
