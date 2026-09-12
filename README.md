# NIMBUS

**N**avigation & **I**ntelligent **M**onitoring **B**ase for **U**ser **S**ystems

NIMBUS is a personal desktop assistant for Windows, inspired by the idea of
JARVIS but built with its own identity and architecture. It runs as an
Electron app that lives in the system tray.

**What it does today:** it gathers context about your day — date/time,
system info, weather, calendar (ICS feeds), email (IMAP, read-only), tasks
(Todoist), Spotify playback and the stocks you track — and turns it into a template-based morning
**briefing** on the Home tab. It can **manage your Todoist tasks** (create,
edit, complete, delete) from its Tasks tab and shows your calendar in its
Calendar tab. With the opt-in desktop activity monitor switched on, it
notices configured applications, browser window titles and Explorer
folders, recognises **activities** you have defined ("Study", "Gaming") and
times them as sessions, and runs user-defined **routines**: it *suggests*
actions in a small popup (or runs them automatically, if you opt a routine
into that) — playing Spotify or other media, launching and arranging
apps, setting the system volume, starting a timer or a Pomodoro
study/break plan, opening a website, file or folder — and can wind them
down again when the activity ends. An **Attention** engine decides which of all this deserves a popup
now, the **Network** tab shows the devices on your local network, and
**Memory** keeps what you tell NIMBUS and what it learns, apart and in view.

**What it does not do:** there is no AI/LLM, no natural-language
understanding, no voice, and no multi-device sync.
Everything is deterministic and runs locally. See
[Current state](#current-state) for the precise breakdown.

NIMBUS's long-term direction is multi-device (Windows, Android, possibly
web) sharing a common backend/core rather than independent assistants.
This repo is Windows-only today, but the code is already organized along
that boundary — see **[ARCHITECTURE.md](ARCHITECTURE.md)** for exactly
which modules are portable "Core" versus Windows-specific.

## Current state

### Implemented and working

- **Desktop presence** — tray icon, close-to-tray, launch with Windows,
  start minimized (see [Desktop presence](#desktop-presence)).
- **Context system** with nine providers: date/time, system info,
  weather (Open-Meteo), calendar (ICS feeds), email (IMAP, read-only),
  tasks (Todoist), Spotify playback, stocks (Yahoo Finance) and the local
  network. Each is failure-isolated and
  time-bounded.
- **Briefing** — generated once at startup and on demand (Home →
  Regenerate), from greeting, date/time, weather, calendar, email, tasks
  and portfolio items, ranked by a deterministic score.
- **Home tab** — the briefing, a Spotify now-playing card with playback
  controls and a playlist picker, the current activity (with the running
  timer and track), recent activity sessions, and an activity feed of
  routine suggestions, automatic runs and Attention notices.
- **Calendar tab** — today's events (finished ones marked) and the next
  90 days from your feeds.
- **Weather tab** — now, and a card per day for the week ahead.
- **Sidebar** — everyday tabs on top; Weather, Routines, Network, Memory,
  Context and Settings in a foldable **Admin** group, which opens itself
  when one of its tabs is opened from elsewhere.
- **Tasks tab** — the full active Todoist list (list/grid, sorting) with
  create, edit, complete and delete, written straight to Todoist.
- **Stocks tab** — positions you enter by hand, grouped into holdings,
  with current prices and estimated value, gain/loss and today's change,
  one total in a base currency (default EUR), recent headlines,
  alternative symbols for retired listings, leveraged CFDs, dividends with
  Portuguese tax estimates, a list of closed positions, and an IRS
  (Anexo J) helper. Read-only: no trading and no brokerage connection —
  "closing" records a sale you already made. See
  [docs/stocks.md](docs/stocks.md).
- **Collections tab** — your trading cards: search Magic (Scryfall),
  Pokémon (TCGdex), Yu-Gi-Oh! (YGOPRODeck), Lorcana (Lorcast) and One Piece
  (OPTCG API) by name, then add a printing to what you own or your
  wishlist, with quantity, foil and the database's market price. Only
  your search text is sent out; the collection stays on this PC. See
  [docs/collections.md](docs/collections.md).
- **Network tab** — the devices on your local network (this PC, the
  router, everything else) with name, IP, MAC, manufacturer (with the IEEE
  list), online state and first/last seen; nickname them and mark the ones
  you recognize. Observation first: it reads Windows' neighbor list, pings the local
  subnet once on request, and on a device's page can ask that one device
  what it is (name, model, software). See [docs/network.md](docs/network.md).
- **Memory tab** — what NIMBUS remembers, kept in three tiers: what you
  saved (preferences and facts, kept until you change them), what it
  learned (recurring activities, how you answer each routine — more
  certain with each repeat, forgotten after 90 days without one) and what
  it observed (new network devices, kept 30 days). Search, filter, switch
  off, forget, or **Keep** a learned item to make it yours. Nothing becomes
  permanent on its own. See [docs/memory.md](docs/memory.md).
- **Context tab** — one fold-away box per source, each explaining how that
  source works and showing what it returned, plus the Attention box: what
  NIMBUS thinks deserves attention, and why.
- **Routines** — triggers, conditions built as field → operator → value
  (time, day, activity, Spotify, the playing playlist, the timer, and
  whether a known device is on the network), cooldowns, once-per-session
  limits, an explainable **Test**, **Run now**, optional run-automatically,
  and an end half ("when it ends") with its own trigger, conditions and
  actions. See [docs/routines.md](docs/routines.md).
- **Attention & Priority** — a deterministic engine that scores what NIMBUS
  knows (meetings, tasks, email, weather, stocks, long sessions, routine
  suggestions), interrupts only for what matters most, queues the rest, and
  explains every decision in the Context tab. See
  [docs/attention.md](docs/attention.md).
- **Activities & sessions** — user-defined mappings from apps/sites/folders
  to activities, with precedence, a grace period, and a session history.
  See [docs/activity.md](docs/activity.md).
- **Actions** — `spotify.*` (play, pause, next, previous, volume, search,
  playlist), `timer.start` (single countdown or Pomodoro plan),
  `timer.stop`, `timer.pause`, `timer.resume`, `timer.addStudy`,
  `system.openUrl` (http/https only), and
  Windows desktop actions: `app.*` (launch, focus, minimize, maximize,
  close), `files.*` (open a file or folder), `media.*` (media keys, system
  volume, mute) and `system.lock`.
- **Timer popup** and **suggestion popup** — small always-on-top windows
  that never steal focus.
- **Credential storage** — IMAP passwords, Todoist tokens and Spotify
  tokens are encrypted with Windows DPAPI via Electron's `safeStorage`,
  never written to `settings.json`.

### Implemented but limited

- Website detection reads **browser window titles only** — never URLs or
  domains; a trigger set to match `domain`/`url` never fires.
- Application detection sees processes **starting and stopping**, not
  which window is in the foreground. Polling is every 5 seconds.
- Calendar does **not expand recurring events** (`RRULE`); a recurring
  event appears once, at its first occurrence. Only common Windows
  timezone names are mapped; unknown ones fall back to local time.
- Calendar, email and task data refresh on a **cache timer** (no push).
- Todoist "reminders" are just a task's specific due time; completed
  tasks are never shown; new tasks always go to the first account.
- Routine decision history is kept (in memory, 200 entries) and exposed
  over IPC, but **no screen shows it** yet.
- The routine model accepts `timerCompleted` as a start trigger, but the
  editor only offers it for the end half.
- Only **one timer** (or Pomodoro plan) runs at a time.
- Desktop window actions find an app by process name and act on its main
  window only; Microsoft Store apps can't be launched by path; volume and
  mute act on the default output device. See
  [docs/action-system.md](docs/action-system.md#desktop-actions).
- Stock prices, exchange rates and dividends come from Yahoo Finance's
  **unofficial** public endpoints (no key needed, but undocumented and
  possibly delayed); there are no dividend payment dates, so upcoming
  dividends are estimates. Tax figures are estimates, not advice.
- Spotify playback control needs **Spotify Premium**; the Client ID can
  only be supplied through `.env`.
- `ActionService` reports each action's `requiresConfirmation` flag but
  **does not enforce it**.

### Architectural foundation for future functionality

These exist in the code as shapes or seams, but nothing uses them yet:

- Assistant event types `message`, `briefing` and `actionRequest`
  (`notification` and `suggestion` are live).
- Context event types `playbackChanged`, `calendarEventApproaching` and
  `emailReceived` (reserved, never emitted).
- `WebsiteOpenedEvent.url`/`domain` and trigger `matchField: "domain" | "url"`
  — for a future browser extension.
- `ApplicationOpenedEvent.activation` values `"activated"` and
  `"alreadyRunning"` — for a future foreground-window detector.
- `BriefingItem.action` and the `meals` briefing category.
- `src/services/` — an empty placeholder for broader capabilities.
- The `UserPreferences` / `WindowsClientSettings` split — the boundary a
  future sync backend would use.

### Planned / not implemented

AI/LLM reasoning, natural-language commands, voice/TTS, code signing for
the installer, multi-device sync or a backend, Android/web clients, OAuth-based
calendar/email integrations, a browser extension for real URL detection,
and any confirmation/permission enforcement for actions. Email is
deliberately read-only: NIMBUS never sends, replies, deletes, moves or
marks anything.

## Technology

- **Electron** — desktop shell: a Chromium UI and a Node.js main process.
- **TypeScript** — typed source for both the main process and the UI.
- **esbuild** — bundles each renderer into one plain script per window.
- **dotenv** — loads `.env` for environment-driven configuration.
- **imapflow** — the IMAP client behind the email provider.

## Project structure

```
src/
  main/            Electron entry point + lifecycle (windows, tray, autostart,
                   IPC handlers), the desktop activity monitor, the Windows
                   side of the desktop actions, the suggestion and timer
                   popups, credential and state stores, Spotify auth
  preload/         The only bridges into the UI (main, suggestion and timer
                   windows)
  ui/              Renderer UI — HTML/CSS/TS for the main window and popups,
                   styled with the vendored Nocturne design system
  config/          Environment/deployment configuration (.env-driven)
  settings/        Persisted settings: schema, defaults, migrations, file I/O
  logging/         File + console logger
  context/         The Context system — providers + aggregator
  activity/        Activity & Sessions — what the user is doing now
  actions/         The Action system — providers + executor
  routines/        Trigger → Suggestion → Action rules
  attention/       Attention & Priority — what deserves attention now
  network/         Network awareness — local devices, observation only
  memory/          Persistent memory — saved, learned and observed, apart
  collections/     Trading card collections and the card databases they use
  timers/          Generic timer engine (single countdowns and phase plans)
  events/          The in-process Context event bus
  briefing/        Turns a context snapshot into the Home briefing
  common/          Shared helpers: app info, assistant-event contract,
                   timeouts, TTL cache, pattern matching, locale
  services/        Placeholder for future capabilities (empty)
```

See **[Documentation](#documentation)** below for a guide to each
subsystem.

- **UI never talks to Node/Electron directly.** It only calls the small
  APIs exposed by `src/preload/` (context isolation is on,
  `nodeIntegration` is off, and a Content Security Policy only allows the
  app's own scripts; the main window also blocks inline styles, while the
  two popups allow them). The full IPC surface is listed in
  [ARCHITECTURE.md](ARCHITECTURE.md#the-uipreload-bridge-and-ipc-surface).
- **`config` vs `settings`**: `config` is environment/deployment config
  (log level, environment name, dev defaults for integrations) read from
  `.env`. `settings` is persisted, user-editable state — split into
  `WindowsClientSettings` (window bounds, startup behaviour; Windows-only)
  and `UserPreferences` (weather, calendar, email, tasks, Spotify,
  routines, activities, stocks, attention, memory; conceptually cross-device
  data).
- **`logging/logger.ts` has no Electron dependency.** File output is
  opt-in via `configureFileLogging(...)`, called once from
  `src/main/main.ts`, so Core can depend on the logger without dragging
  in Electron. A failing file write is reported once on the console.
- **Credentials never touch `settings.json`.** See
  [Logs, settings and data](#logs-settings-and-data).
- **`settingsSchema.ts` vs `settingsManager.ts`**: the schema module holds
  the types, defaults, migrations and credential split with no Electron or
  filesystem dependency, so it is unit-testable under plain `node --test`.
  The manager is the thin Windows layer around it (file path, atomic
  write, keystore wiring).
- **The UI is bundled, not just compiled.** `scripts/bundle-ui.js` runs
  esbuild over the three renderer entry points and writes
  `dist/ui/*.bundle.js`.

## Desktop presence

NIMBUS behaves like a background assistant, not an ordinary window-based app:

- **System tray icon** ([src/main/tray.ts](src/main/tray.ts)) — always
  present while NIMBUS is running. Click it (or "Open NIMBUS" in its menu)
  to show the main window; "Quit NIMBUS" is the only thing that exits.
- **Close-to-tray**: closing the window hides it
  ([src/main/lifecycle.ts](src/main/lifecycle.ts)); NIMBUS keeps running.
- **Single instance**: launching NIMBUS again focuses the running window
  instead of starting a second copy.
- **Launch with Windows** ([src/main/autostart.ts](src/main/autostart.ts))
  — wraps Electron's `app.setLoginItemSettings`. Toggle it in Settings.
- **Start minimized** — start with only the tray icon visible.
- **Interface size** (Settings > Display) — scales the window from 50% to
  200% for a large or high-resolution screen; **Ctrl+=**, **Ctrl+-** and
  **Ctrl+0** do the same. Saved per PC.

## The assistant-event seam

`src/ui` never needs to know *how* a message, notification or suggestion
was produced — only that it received one:

- [src/common/assistantEvents.ts](src/common/assistantEvents.ts) — the
  shared event contract (`AssistantEvent`).
- [src/main/assistantBridge.ts](src/main/assistantBridge.ts) — the publish
  point, pushed to windows over `nimbus:assistant-event`.
- `window.nimbus.onAssistantEvent(callback)` in the preload lets the
  renderer subscribe without any Electron/Node access.

Two producers use it today. The Routine engine publishes every
suggestion and every automatic run; the Attention engine posts its
normal-priority notices. Each appears as a line in the Home activity
feed. The interactive prompt itself is the separate suggestion popup
window, whose order Attention decides.

## Documentation

Reference material for each subsystem — read it when you are working on
that subsystem.

| Guide | What it covers |
| --- | --- |
| [The Context system](docs/context-system.md) | Context providers, the aggregator, failure isolation, and Context events |
| [The Action system](docs/action-system.md) | ActionProviders, the validate/execute contract, and the Context-vs-Action split |
| [The Briefing system](docs/briefing.md) | How a context snapshot becomes the briefing the Home tab shows |
| [Activity & Sessions](docs/activity.md) | Activity mappings, session lifecycle, and how routines read it |
| [Attention & Priority](docs/attention.md) | What deserves attention now: signals, scoring, conflicts, and the debug view |
| [Context-aware routines](docs/routines.md) | Triggers, conditions, suggestions, timers, desktop monitoring, and its privacy boundary |
| [Weather](docs/weather.md) | Location resolution and the Open-Meteo integration |
| [Calendar](docs/calendar.md) | ICS feeds, the Calendar tab, and the parser's limits |
| [Email](docs/email.md) | IMAP setup, app passwords, and what NIMBUS does and does not read |
| [Tasks](docs/tasks.md) | Todoist setup and the read/write Tasks tab |
| [Spotify](docs/spotify.md) | Registering a Spotify app, the PKCE flow, and playback control |
| [Network](docs/network.md) | Local devices: how discovery works, identity by MAC, labels, and what is deliberately excluded |
| [Collections](docs/collections.md) | Trading card collections: the catalog per game, entries, and the add-by-id boundary |
| [Memory](docs/memory.md) | The three memory tiers, trust and expiry, what is recorded, and the Memory tab |
| [Stocks](docs/stocks.md) | Tracked positions, the estimates, market data and news, and their limits |

Architecture-level decisions — what counts as portable Core versus
Windows-specific, the IPC surface, and what is persisted where — live in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Versions

`MAJOR.MINOR.PATCH` — major for a full release (still 0), minor for a big
milestone (called by hand), patch for everything else. The version lives
in `package.json` and is shown in the sidebar. See
**[CHANGELOG.md](CHANGELOG.md)** for what each version contains.

## Setup

Two ways to run NIMBUS: **install it** from a built installer, or **run it
from source**. Building anything needs [Node.js](https://nodejs.org) 20 or
newer (which includes npm) and Git.

### Install it (no Node needed on that PC)

In the project folder, install the dependencies once, then build the
installer:

```bash
npm install
```

```bash
npm run package
```

Every copy of the project needs its own `npm install` — a freshly
extracted ZIP or a new clone has no `node_modules`, and the build stops
with a message saying so.

Writes `release\NIMBUS-Setup-<version>.exe` — a per-user installer (no
admin prompt), with Start-menu and desktop shortcuts. Copy it to any
Windows PC and run it; updating later means running a newer installer over
it. Your data is untouched by install, update or uninstall: it lives in
`%APPDATA%\nimbus\`.

The installer is **not code-signed**, so SmartScreen shows "Windows
protected your PC" the first time — More info → Run anyway.

An installed NIMBUS looks for an optional `.env` (Spotify's Client ID)
beside its own `NIMBUS.exe`, at `%APPDATA%\nimbus\.env`, or wherever
`NIMBUS_ENV_FILE` points.

### Run from source

```bash
npm install
copy .env.example .env
```

### On another PC

```bash
git clone https://github.com/AlexandreMauricio/NIMBUS_VA.git
cd NIMBUS_VA
npm install
npm start
```

Everything you configure lives in that machine's own
`%APPDATA%\nimbus\`, so a second PC starts empty: re-enter your calendar
feeds, email and Todoist accounts, stock positions, routines and
activities, and connect Spotify again (its Client ID goes in `.env`).
Nothing syncs between machines.

### Updating

**Your data is not in the app folder.** Settings, stock positions,
routines, activities, memory, network devices and credentials all live in
`%APPDATA%\nimbus\`, so replacing the code never touches them.

From a clone:

```bash
git pull
npm install
npm start
```

From a downloaded ZIP: extract the new one **next to** the old folder
(don't overwrite it while NIMBUS is running), then in the new folder run
`npm install` and `npm start`. It picks up everything you had. Keep the
old folder until the new one starts cleanly, then delete it — and copy
your `.env` across if you made one.

Two things worth knowing: quit NIMBUS from the tray before updating, and
if **Start with Windows** is on, switch it off and on again after moving
to a new folder — the login item points at the folder it was set from.

`.env` is optional for normal use; it supplies the log level, the
environment name, the Spotify Client ID, and headless/dev defaults for
weather, calendar, email and tasks. See `.env.example`.

## Run

```bash
npm start
```

Builds (`tsc`, the UI bundler and asset copy) and launches the Electron app.

## Develop

```bash
npm run dev
```

Watches and recompiles TypeScript. Run `electron .` in a second terminal
to launch with the latest build. If you are changing renderer code, also
run the UI bundler in watch mode:

```bash
npm run dev:ui
```

### Checks

```bash
npm run check
```

Runs, in order: `npm run lint` (ESLint over `src`), `npm run format:check`
(Prettier over `src/**/*.{ts,css,html}`), `npm test` (compiles, then runs
every `dist/**/*.test.js` under Node's built-in test runner), and
`npm run test:credentials` (an end-to-end check that drives real Electron
processes through credential save/load cycles in a throwaway data
directory). There is no separate check for Markdown.

## Logs, settings and data

Everything is written under Electron's per-user data directory
(Windows: `%APPDATA%\nimbus\`):

| File | Contents | Protection |
| --- | --- | --- |
| `settings.json` | Window/startup settings and all user preferences, including calendar feed addresses, stock positions and closed positions | Plain JSON, atomic write |
| `secrets.json` | IMAP passwords and Todoist API tokens, keyed by account | Encrypted (DPAPI via `safeStorage`), atomic write |
| `spotify-tokens.json` | Spotify access/refresh tokens | Encrypted (DPAPI via `safeStorage`), atomic write |
| `routine-state.json` | Routine cooldown timestamps and wind-downs still owed | Plain JSON, atomic write |
| `activity-history.json` | Up to 200 activity sessions | Plain JSON, atomic write |
| `network-devices.json` | Devices seen on your local network: MAC, nickname, recognized, names, first/last seen, recent IPs | Plain JSON, atomic write |
| `oui.csv` | Optional: the IEEE manufacturer list, if you put it there — NIMBUS only reads it | Your file |
| `app-usage.json` | Opt-in: programs with a window, minutes per day for two weeks, and your "make it an activity?" answers | Plain JSON, atomic write |
| `site-usage.json` | Opt-in: websites by the name at the end of their tab title (never whole titles or addresses), minutes per day for two weeks, and your answers | Plain JSON, atomic write |
| `memory\explicit.json`, `memory\learned.json`, `memory\observed.json` | What NIMBUS remembers, one file per tier (see [docs/memory.md](docs/memory.md)) | Plain JSON, atomic write; an unreadable file is set aside, not overwritten |
| `collection.json` | Your card collection: printings, quantities, foil, status, notes | Plain JSON, atomic write; an unreadable file is set aside, not overwritten |
| `logs\nimbus.log` | The application log | Plain text; never contains credentials |

If OS-level encryption is unavailable, credentials are not persisted at
all rather than written in plaintext.

## Known limitations

Beyond the "implemented but limited" list above:

- **The installer is unsigned**: Windows SmartScreen warns on first run
  until enough people install it, which for a personal build is never.
  Code signing needs a paid certificate.
- **No auto-update**: a new version means running the new installer.
  Running from source, "Start with Windows" registers `electron.exe` with
  the app folder as its argument rather than a NIMBUS-branded entry — so
  moving the folder means switching that setting off and on again.
- **Single main window**; multi-window scenarios aren't handled.
- **Icon is a placeholder** (`src/assets/icon.png`, generated by
  `scripts/generate-icon.js`).
- **Weather location**: automatic mode is IP-based (city-level at best,
  wrong behind a VPN); manual mode takes raw latitude/longitude, with no
  city search.
- **No OAuth integrations**: calendar needs a private ICS URL, email an
  app-specific password, tasks a personal Todoist token, and Spotify your
  own developer app's Client ID. Nothing is pre-configured, and no sample
  data is ever presented as real.
- **No routine conflict handling**: two routines matching the same event
  both act independently, each with its own cooldown.
- **Suggestions are in memory only**: active suggestions and routine
  history are lost on restart (cooldowns and owed wind-downs are kept).
- **The Context tab and Calendar tab refresh on demand**; only the Home
  now-playing card (every 5 s, while Home is visible) and the current
  activity card (every 10 s, and on change) poll.
- **No proactive notifications**: nothing announces a timer phase change
  or an upcoming event outside NIMBUS's own windows, and the briefing is
  not regenerated on a schedule.
- **UI code has limited automated tests**: renderer behaviour is covered
  by `uiFormat.test.ts` and manual/scripted checks, not a DOM test suite.
