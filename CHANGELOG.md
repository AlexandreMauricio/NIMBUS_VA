# Changelog

## Versioning

NIMBUS uses `MAJOR.MINOR.PATCH`:

| Part      | Bumped when                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **MAJOR** | A full release of the app. Stays at **0** until NIMBUS is something you'd call finished — even though it's for your own use. |
| **MINOR** | A big milestone. **Alexandre decides when one has been reached** — work accumulates as patches until he calls it.            |
| **PATCH** | Everything else — fixes, features, refactors, docs.                                                                          |

The version lives in `package.json` and is shown in the sidebar, so what
you see running is what you can point at in the history. Each release is
tagged (`v0.2.0`), so `git log v0.1.0..v0.2.0` shows exactly what changed.

Dates are the day the work landed.

---

## 0.4.3 — 2026-09-12

- Fix: **Start with Windows** launched Electron's own welcome window
  instead of NIMBUS when running from source. The login item registered
  the Electron executable with no app path, so Windows started Electron
  with nothing to run. It now registers the app directory alongside the
  executable (a packaged build still needs only its own .exe). If the
  broken entry is already there, switch the setting off and on again.
- README: how to update from a clone or a ZIP without losing anything —
  settings, positions, routines and memory live in `%APPDATA%\nimbus\`,
  not in the app folder.

## 0.4.2 — 2026-09-12

- **Routine conditions are now built as field → operator → value**, with
  the value hidden when the operator doesn't need one. One catalog
  (`src/routines/conditionCatalog.ts`) describes every field and operator;
  the editor draws its two pickers from it, so a new condition is one
  entry there plus one case in the evaluator. Routines saved before this
  keep working untouched, and `weekdaysOnly` still shows while no longer
  being offered.
- **New conditions**: Time is before/after, Activity is not, Activity has
  lasted less than, Spotify playlist is/is not (by URI, from a picker of
  your playlists), Timer is running/paused/not running, and **Device is
  (or is not) on the network** — presence from the Network tab, the
  groundwork for "when my phone is home". Everything that names something
  specific fails closed when NIMBUS can't tell.
- **New actions**: `timer.pause` and `timer.resume`.

## 0.4.1 — 2026-09-12

- **Interface size**: Settings > Display scales the main window between 50%
  and 200%, for large or high-resolution screens. **Ctrl+=** and **Ctrl+-**
  step through the sizes and **Ctrl+0** returns to 100%; the picker follows
  the shortcuts. Saved per PC (`windowsClient.zoomPercent`), clamped on
  load, and applied to the main window only — the popups are sized to
  their content.

## 0.4.0 — 2026-09-11

The milestone since 0.3.0: NIMBUS now watches the local network, remembers
things across restarts, decides what deserves your attention, and tracks a
portfolio in one currency with a tax helper.

- **Routines**: new **Spotify is playing** condition, the counterpart of
  "Spotify is not already playing". Put it on the wind-down half so a
  "stop the music" suggestion only appears when something is actually
  playing.
- **Sidebar**: Network, Memory, Context and Settings are grouped under an
  **Admin** heading, apart from the tabs used day to day.
- Since 0.3.0: the Attention & Priority engine, persistent Memory, the
  Network tab with "Ask the device", "Make it an activity?" for apps and
  websites, collapsible Context boxes, and the stocks work (base currency,
  dividends, closed positions, the IRS helper).

## 0.3.10 — 2026-09-11

- Activities: "Make it an activity?" now covers websites too. A separate
  opt-in tally (`site-usage.json`, same switch as apps) counts sites by the
  name at the end of their tab title — "… - YouTube" → YouTube — never
  whole titles or addresses. A site used on 3 of 7 days or for 5 hours is
  offered like an app; "yes" opens the editor with a Website activity
  matching its name.

## 0.3.9 — 2026-09-11

- Memory: a persistent memory layer (`src/memory/`) with three tiers kept
  in separate files under `memory/` — what you saved (preferences and
  facts; fully trusted, kept until you change them), what NIMBUS learned
  (patterns whose confidence grows with evidence and fade after 90 days
  without it) and what it observed (events, kept 30 days). Nothing
  observed becomes permanent unless you press Keep.
- First recordings: recurring activities (sessions of 10+ minutes — count,
  total time, usual start hour), how you answer each routine's
  suggestions, and new devices on your network. A "Learn from what I do"
  switch turns recording off.
- New Memory tab: search, filter by kind and origin, see where each item
  came from and how sure NIMBUS is, switch items off, forget them, keep
  learned ones, and add or edit your own.
- Malformed memory files are handled item by item; an unreadable file is
  set aside rather than overwritten.

## 0.3.8 — 2026-09-11

- Network: "Ask the device" on a device's page asks that one device what it
  is — SSDP/UPnP (UDP 1900) and the description file it advertises, mDNS
  (UDP 5353) and NetBIOS (UDP 137), each sent only to its address — and
  shows its name, manufacturer, model, announced software (often the OS),
  what it offers (casting, AirPlay, printing…) and a guess of what it is,
  with "Use as nickname". Only on request, one device at a time, each at
  most every 30 s; kept with the device. Silence is shown as a hint (phones
  rarely answer).

## 0.3.7 — 2026-09-11

- Documentation checked against the code after the Network feature: the
  README's provider count and overview now include Attention and Network,
  and the Attention guide no longer calls Network a future provider.
  IPC channels, Context providers, event types, state files, settings
  groups, action ids and every test file and source path named in the
  docs were cross-checked with the code.

## 0.3.6 — 2026-09-11

- Network tab: the devices on the local network — this PC, the router and
  the rest — with name, IP, MAC, manufacturer (from the IEEE list, if you
  add it), online state and first/last seen, plus nicknames and a
  "recognized" label (NIMBUS's own note, not a security check). Devices
  are identified by MAC, so IP changes keep their history. Observation
  only: Windows' neighbor cache is read every two minutes (nothing sent),
  and "Scan network" pings the local subnet once — private addresses, at
  most a /24, in cancellable batches, once a minute. A device never seen
  before publishes `networkDeviceAppeared` on the event bus, and a new
  `network` Context provider reports the counts. Nothing on the network
  is reachable through the Action system.

## 0.3.5 — 2026-09-11

- "Make it an activity?" (opt-in: *Suggest activities for apps I use a
  lot*, in Routines → Activities). NIMBUS keeps a small local tally of
  programs with a visible window — name, Windows description and minutes
  per day, never window titles — and offers a program used on 3 of the
  last 7 days (or 5 hours) that isn't an activity yet. The Attention
  engine decides how: a popup when it's well used and you've just opened
  it, a feed line otherwise. "Make it an activity" opens the Activities
  editor with the program filled in; "Not now" rests it for a week, and a
  second "Not now" stops it for good.

## 0.3.4 — 2026-09-11

- Fix: Spotify needed reconnecting after every restart since 0.3.1. The
  Attention engine's first look at the context ran before Electron was
  ready, so Spotify's stored login was read before Windows encryption was
  available and treated as "disconnected" for the whole session. Attention
  now starts once the app is ready, and the Spotify login is re-read on
  the next request instead of settling on "disconnected" when storage
  isn't ready yet.

## 0.3.3 — 2026-09-11

- Context tab: every source is a fold-away box with a plain explanation of
  how it works (where the data comes from, how often it refreshes, what
  uses it); which boxes are open is remembered. The Attention section is a
  box too, with an item count and an explanation of the scoring.

## 0.3.2 — 2026-09-11

- Documentation brought in line with 0.3.0–0.3.1: the README (Stocks and
  Context tabs, feed producers, project structure, preferences, stock
  limitations), ARCHITECTURE (Core layers, the stocks module, guidance for
  new attention sources), and the routines, context and stocks guides
  (popup queueing, who reads the snapshot, closing, leverage, dividends,
  tests).

## 0.3.1 — 2026-09-11

- Attention & Priority engine: a deterministic layer that decides what
  deserves attention right now. Signals from the calendar (meetings within
  the hour), tasks (due soon, overdue, due today), email (unread and
  important), weather (rain likely), stocks (a big portfolio move),
  activity (long sessions) and routine suggestions are scored
  (0.40 urgency + 0.35 importance + 0.25 relevance, adjusted when you're
  busy or when an item is about what you're doing), deduplicated by a
  stable key, and surfaced through the existing suggestion popup
  (urgent/high) or the Home feed (normal). One interruption at a time:
  routine suggestions now wait instead of overwriting each other or a more
  important popup. Attention's own popups are informational and never run
  anything. The Context tab shows every item with its score, decision and
  why, plus two switches.

## 0.3.0 — 2026-09-11

- Stock Tracker: a Stocks tab for positions you enter by hand — current
  price and day change, estimated value, gain/loss and today's change,
  a portfolio total in one base currency (default EUR, converted at
  Yahoo's key-free exchange rates) alongside per-currency totals, and
  recent headlines searched by company name and filtered to the company.
  A symbol whose price hasn't changed in over a week is marked outdated,
  left out of the totals, and offered the company's live listings. A
  position can keep an alternative symbol that supplies the price whenever
  its own symbol is retired or outdated.
- Stocks: lots of the same symbol are grouped into one holding, with a
  page listing each lot. Dividends per holding: received since purchase,
  the next one estimated from the recent pattern, and a yearly estimate,
  with tax estimated for a Portugal resident (source withholding plus
  Portugal's 28%, crediting foreign tax up to the treaty rate).
- Stocks: the list can be folded away and sorted by value, today's move,
  total return, name, symbol or order added. Positions can be leveraged
  (CFDs): the margin counts as invested and the profit or loss is on the
  full exposure. eToro index names such as EUSTX50 find their market
  symbol (^STOXX50E) automatically.
- Stocks: record a sale with "Close position" (all or part of a lot) — the
  shares move to a Closed positions list with the realized gain or loss.
  An IRS helper prepares Anexo J figures for a year: foreign dividends
  (Quadro 8A, E11) by source country and closed positions (Quadro 9.2) by
  code, source and counterparty country, in euros at each day's rate. Prices come from
  Yahoo Finance's public endpoints (no key); stale and unavailable prices
  are marked, never guessed. The briefing gains a portfolio line ("Your
  portfolio is up 1.8% today."). Strictly read-only: no trading, no
  brokerage connection.
- Windows desktop actions: launch an app (`.exe` or `.lnk`), bring it to
  the front, minimize, maximize or close it; open a file or folder;
  play/pause, next and previous media keys; set the system volume, mute
  and unmute; and lock Windows. They are ordinary registered actions, so
  the routine editor offers them automatically — with a Browse… picker for
  paths. No shell is ever involved, and a step's values never become part
  of a script.
- Documentation accuracy pass: README, ARCHITECTURE and every guide in
  `docs/` now describe what the code does today — the full IPC surface,
  what is persisted where, current triggers/conditions/actions, and a
  clear split between working, limited, foundational and planned
  functionality. No code changes.
- A credential that fails to decrypt is no longer deleted. The store
  used to drop any entry it couldn't read, and the next save wrote the
  file without it — so a single failed decrypt permanently erased a
  Todoist token or IMAP password. Unreadable entries are now carried
  over untouched, and a missing OS encryption service no longer deletes
  the file. Removing an account still clears its credential.
- Quitting NIMBUS no longer counts as your activity ending. The session
  is still recorded as ended, but routines that run "when this activity
  ends" (Study Ended, a routine's wind-down) no longer fire on the way out.
- An ask-first wind-down has its own prompt ("Wrap up Study?") instead
  of reusing the start one, and no longer restarts the start cooldown.
- Calendar feeds using Windows timezone names (Outlook, Exchange) or
  quoted timezones keep their events. They used to be dropped silently;
  unrecognised zones now fall back to local time.
- An activity ends when its grace period runs out, even with the window
  hidden in the tray. It used to wait for something to ask, so the
  wind-down that stops the Pomodoro could run late.
- The timer counts time the computer spent asleep. A study interrupted
  by 20 minutes of sleep used to finish 20 minutes late.
- The Tasks tab reports errors inline and deletes with a second click,
  instead of the alert()/confirm() dialogs that could freeze the form.
- Smaller: Spotify tokens are written atomically; a restarted PowerShell
  poller can no longer be orphaned; a wind-down still owed survives a
  restart (for up to 12 hours); "once per session" for websites follows
  the browser rather than resetting on every page title; two windows of
  one browser no longer re-trigger each poll; the simpler settings
  handlers ignore unknown fields and wrongly-typed values.

- Grid view is laid out for a grid. The run control becomes a full-width
  bar along the bottom of each card instead of a circle adrift in the
  corner, cards in a row share a height, and the bars line up across the
  row whatever length each summary ran to. List view is unchanged.

- An end trigger is kept when you choose one. It was only saved if the
  end half already had actions, so picking "when Study ends" and saving
  before adding the action lost the choice with nothing said. The section
  now also says when a trigger is saved but has nothing to run.
- The sidebar shows the real version. `appInfo.ts` hard-coded 0.1.0
  while package.json said 0.2.0; it now reads package.json, so there is
  one place to change.

- The routines list matches the Claude Design mockup: each card splits
  into what the routine is and what you can change on the left, with one
  48px control for "run it now" on the right — the only thing on the card
  that acts on the world. Delete reads as accent rather than danger,
  since removing a rule you wrote is ordinary editing.
- Every on/off control is the same pill switch. Eleven were still bare
  browser checkboxes while the forms beside them used the switch.

- Activities have one home. They live under **Routines → Activities**,
  where they can now be edited rather than only added and removed, and
  the routine form's "This means I'm doing" field is gone — an activity
  is no longer something a routine owns on the side. Existing settings
  are migrated on load: each routine-declared activity becomes a
  standalone one carrying the trigger it had, and a wind-down half that
  relied on the implicit "ends when my activity ends" gets that written
  down as a real end trigger.
- The end trigger's activity can be picked freely. It no longer depends
  on the routine naming an activity of its own, and "Any activity" means
  any, rather than quietly meaning "mine".
- The Activities form reports problems inline instead of through
  `alert()`, which took keyboard focus away from the form it was asking
  you to fix.

- Briefing names the day of an upcoming event ("on Saturday") instead of
  calling everything that isn't tomorrow "soon".
- Activities are referenced rather than retyped: the activity-ended
  trigger and the new activity conditions pick from what's already
  defined, so a typo can't produce a routine that silently never matches.
- The activity conditions (`activityIs`, `activityDuration`) are
  editable in the routine form — they existed in the model with no way to
  set them.
- Activities moved out of Settings into the Routines tab, behind a
  Routines / Activities switch: they're personal definitions like
  routines, not configuration like a weather location.
- A routine is now two complete rules sharing an identity: "when it
  starts" and "when it ends", each with its own trigger, conditions and
  actions, in collapsible sections. Starting and stopping a study
  session is one routine instead of two kept in step by hand, and the
  end half isn't limited to an activity ending — a timer completing will
  do just as well.

## 0.2.0 — 2026-09-10

Everything built since the repository was created.

**Routine Engine 2.0.** Multiple conditions with ALL/ANY logic; time
windows to the minute, including across midnight; days of the week.
Cooldowns that survive a restart. Session restrictions, so returning to
an open app doesn't re-suggest. Every decision explainable by the same
code that makes it — and testing a routine no longer runs its actions,
with "Run now" doing that explicitly. A 200-entry decision history.

**Activity & Sessions.** `Event → Activity → Session`: NIMBUS knows what
you're doing and for how long, from mappings you configure — usually on
the routine itself, whose trigger doubles as the mapping. Activity is
context only; it starts nothing on its own. Routines gain `activityIs`
and `activityDuration` conditions, an `activityEnded` trigger and a
`timer.stop` action, enough to express "when I stop studying, stop the
Pomodoro" as configuration. Home shows the current activity with the
existing Spotify and timer state beside it, plus recent activity.

**Pomodoro.** A running plan can be extended by another study, for the
days you want three instead of two.

**Foundation work.** Timeouts on every outbound call and provider. IMAP
and Todoist credentials encrypted at rest. Atomic settings writes. A
persistent PowerShell session for activity polling (~16× faster). The
real Nocturne design system adopted, and the UI made testable and
bundled. ESLint, Prettier, and this changelog.

**Fixes along the way.** Credentials no longer lost on restart; the
timer popup's buttons and clipped layout; sessions ending when the app
closed rather than when NIMBUS noticed; website sessions ending when the
browser leaves the site; the routine form freezing after a failed save.

## 0.1.0 — 2026-09-09

The app as it stood when the repository was created: context providers
(weather, calendar, email, tasks, Spotify), the briefing, the event bus,
routines, actions, timers, and the Electron shell.
