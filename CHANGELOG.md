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

## 0.5.5 — 2026-09-13

- **Fix: websites in a second browser window weren't counted.** NIMBUS
  read one title per browser (Windows' "main window"), so a site open in
  another Chrome or Edge window was missed that day — a site used three
  days in a row could show two. Every visible browser window is read now,
  still by title only.
- **Fix: Edge profile names in Portuguese** ("Pessoal", "Perfil 1") and
  other languages are no longer mistaken for the site's name.

## 0.5.4 — 2026-09-13

- **Home redesign.** The day on the left (briefing, current activity,
  feed); the week on the right. **Your week** adds up the last 7 days —
  time per activity with a bar per day, the most-used apps and websites,
  what you added to Cards, Books and Decks, and what's coming up — in
  plain sentences built from those numbers (`src/summary/`).
- **In-app updates.** An installed NIMBUS checks the project's GitHub
  Releases 30 seconds after starting and every 6 hours, downloads a newer
  version in the background, and offers **Restart to update** in
  Settings → Updates (or installs it when NIMBUS next quits). Data in
  %APPDATA%
  imbus is kept. `npm run release` builds and publishes a
  release (needs a `GH_TOKEN`); `npm run package` still only builds.
  Running from source doesn't update itself.
- **"What NIMBUS has counted this week"** in Settings → Activity: every
  app and website the tally has seen, days and time, and why each is or
  isn't being suggested — already an activity, declined, resting, not
  enough yet, or "will be suggested". It also says when the switch is
  off, which stops all counting.

## 0.5.3 — 2026-09-13

- **Card pages.** Click a card in Cards or Decks to open its page: the
  large image, rules text, stats, format legality (Magic), the Yu-Gi-Oh!
  banlist status, price, artist, how many you own and which decks use it,
  with add to collection, wishlist or a deck. Data comes from each game's
  database, fetched and cached for an hour in the main process.
- **Decks**, a new tab in the Collections group. Decks per game and
  format, checked against that game's rules — Magic constructed and
  Commander (size, copies, sideboard, commander colours), Pokémon (60,
  4 copies, a Basic), Yu-Gi-Oh! (40–60, extra deck, banlist), Lorcana
  (60+, two inks), One Piece (a leader, 50, colours). Shows what you're
  missing from your collection, and imports and exports plain-text
  decklists.

## 0.5.2 — 2026-09-13

- **Collections is a sidebar group**, like Admin, with **Cards** and
  **Books** as their own tabs — room for decks to come.
- **Presence**: NIMBUS judges whether you're at the PC (input in the last
  5 minutes), home but away from it, or out. Idle time comes from the OS;
  "home" versus "out" comes from your phone on the network, chosen in
  Settings → Presence, and only counts as gone after 45 minutes unseen,
  since phones drop off Wi-Fi while asleep. Changes are logged.
- **App and site time only counts while you're at the PC.** Left open
  while you're out, an app no longer piles up hours towards "Make it an
  activity?", and coming back doesn't count as opening it again.
- New routine condition: **You are at the PC / away from the PC / out**.

## 0.5.1 — 2026-09-13

- **Comics & manga** in the Collections tab. A book carries the issue
  runs it collects, and the shelf shows **coverage per series**: issues
  held once, held twice, only in part, and the gaps — with the wishlist
  book that would fill each. Built around a real shelf: Thor Epic
  Collection 1 overlapping Omnibus 1, Omnibuses 2–3 completing the run.
- **Looked up in the Grand Comics Database** (free, no key): pick a series
  and volume, and the title, ISBN and — when GCD's note lists them — the
  contents fill themselves in. Checked live: Epic Collections and
  Masterworks usually list contents, many omnibuses don't, and then you
  type them. Metron and Comic Vine need accounts, Google Books was out of
  anonymous quota, and Open Library had nothing for Devir PT-PT manga,
  which is entered by hand — volumes as runs, so the first gap is the next
  volume to buy.
- Contents are typed as `Series (year) #from-to; Annual #1`, previewed
  live with the parser the main process saves with, and anything
  unreadable is shown rather than guessed. Stored in `books.json`.
- Verified end to end in the running app: GCD search, a volume filled in
  from its note, a hand-typed omnibus, and the overlap shown as duplicates.

## 0.5.0 — 2026-09-13

The milestone since 0.4.0: NIMBUS installs like a normal app, reminds you
in time to leave, answers questions where it asks them, and has its first
hobby — trading card collections.

- **Weather tab**: current conditions and a card per day for the week
  ahead (the forecast now covers 7 days), from the same weather result the
  briefing uses.
- **Sidebar groups fold.** Routines and Weather join Network, Memory,
  Context and Settings in the **Admin** group, which folds away and
  remembers it; opening one of its tabs from elsewhere unfolds it.
- Since 0.4.0:
  - **Installable**: a per-user Windows installer (`npm run package`),
    Electron 33 → 44 with a clean `npm audit`, "Start with Windows" fixed
    for both source and installed runs, and a clear message when
    dependencies aren't installed.
  - **Routines**: conditions as field → operator → value, with new ones
    (time before/after, activity is not, Spotify playlist, timer state,
    a device on the network) and `timer.pause` / `timer.resume`.
  - **Calendar and Attention**: reminders pop up at a lead time you choose
    (default an hour), the Calendar tab looks 90 days ahead, feed questions
    have answer buttons, and popups are logged.
  - **Collections**: trading cards for Magic, Pokémon, Yu-Gi-Oh!, Lorcana
    and One Piece, from free card databases.
  - **Quieter suggestions**: Windows helpers, NIMBUS itself and non-site
    tabs no longer count towards "Make it an activity?".
  - **Interface size**: 50–200%, with Ctrl+= / Ctrl+- / Ctrl+0.

## 0.4.11 — 2026-09-12

- **Collections**: a new tab for trading cards. Search a game's card
  database by name and add a printing to what you own or your wishlist,
  with quantity, foil and the database's market price. Five games, each
  from a free database needing no key: **Magic** (Scryfall), **Pokémon**
  (TCGdex), **Yu-Gi-Oh!** (YGOPRODeck), **Lorcana** (Lorcast) and **One
  Piece** (OPTCG API). Every source was checked live while building;
  pokemontcg.io was passed over after it returned a 502.
- Only the search text leaves the PC; the collection is
  `collection.json`. Cards are added by game and catalog id, with their
  data taken from the main process's own search, so the page can't insert
  cards or image addresses of its own. Card image hosts are listed by
  name in the Content Security Policy.
- Verified end to end in the running app over the DevTools protocol:
  search, images, add, the collection list, and a forged add refused.

## 0.4.10 — 2026-09-12

- **Calendar reminders pop up in time to leave.** An event's reminder used
  to pop up 15 minutes before it — fine for a call at your desk, too late
  for an appointment you travel to: a 9:30 massage popped up at 9:15, and
  the only earlier sign was a Home feed line at 8:30. Reminders now pop up
  at a lead time you choose (Context → Attention → _Calendar reminders_,
  default **an hour**, 15 minutes to 4 hours), and once more five minutes
  before. From the lead time on they are high priority and ignore the
  busy rule, so a game or a running timer can't silence them.

## 0.4.9 — 2026-09-12

- Attention's decisions to interrupt are now logged at info level
  ("Attention popup shown", with the item, priority, score and how long it
  stays), as are Home feed posts, and the popup window logs when it is
  actually put on screen. A reported missing reminder was replayed through
  the real calendar provider and Attention service and did pop up at
  T-15 and T-5 minutes; without these lines the log could not show whether
  the app was running or the popup simply went unseen.

## 0.4.8 — 2026-09-12

- **Calendar**: the Calendar tab's "Upcoming" now looks **90 days** ahead
  (up to 100 events) instead of 7, so an event next month appears. The
  briefing and Attention still reason about the coming week only. Events
  from earlier today stay in "Today" but are dimmed and marked "Ended".
  The guide now explains that a calendar's own iCal feed can lag behind
  the calendar by hours (Google's especially).
- **"Make it an activity?" in the Home feed can be answered.** A question
  not pressing enough for a popup was posted to the feed as plain text,
  with no way to answer it. It now carries its two buttons, which take
  the same path as the popup's.
- **The usage tallies ignore what nobody does**: Windows helpers such as
  `svchost.exe` and `msedgewebview2.exe`, NIMBUS itself (window,
  installer, uninstaller), and tabs that aren't a site — a loading tab
  titled with its address, new tabs in several languages, and search
  results pages. All of these showed up in a real tally.

## 0.4.7 — 2026-09-12

- A build in a folder where `npm install` has not been run now says so —
  "dependencies are not installed in this folder", with the folder and
  what to run — instead of `'tsc' is not recognized as an internal or
external command`, which named the wrong problem.

## 0.4.6 — 2026-09-12

- **Electron 33 → 44.** Electron 33 is end-of-life and `npm audit`
  reported three advisories against it, which pushed towards
  `npm audit fix --force` — a command that installs breaking major
  versions and had silently put one machine on a different Electron from
  the one the tests run against. `npm audit` now reports nothing, so the
  normal `npm install` is all anyone needs.
- Renderer console logging moved to Electron's details object; the
  positional arguments it replaced are deprecated.
- The packaged build was run end to end on 44: window and tray created,
  settings and credentials read from the same `%APPDATA%\nimbus\`, the
  briefing generated from live providers, and the login item registered
  as a packaged app.

## 0.4.5 — 2026-09-12

- **NIMBUS can be installed.** `npm run package` builds
  `release\NIMBUS-Setup-<version>.exe` with electron-builder: a per-user
  install (no admin prompt), Start-menu and desktop shortcuts, a real
  `NIMBUS.exe`, and no terminal window. Data stays in `%APPDATA%\nimbus\`,
  so installing, updating or uninstalling never touches it. Unsigned, so
  SmartScreen warns on first run.
- An installed build now finds an optional `.env` beside its executable,
  at `%APPDATA%\nimbus\.env`, or via `NIMBUS_ENV_FILE` — its code lives
  inside `app.asar`, where the old project-root lookup could never find
  one, which would have left a packaged NIMBUS unable to take a Spotify
  Client ID.
- A 256px app icon, used by the installer, the shortcuts and the window.

## 0.4.4 — 2026-09-12

- Fix, following 0.4.3: the app path in the login item was quoted here as
  well as by Electron, so the quotes became part of the argument and
  Windows reported "Unable to find Electron app at
  C:\WINDOWS\system32\...". The path is now passed raw, which is what
  Electron expects — it quotes the command line it writes. Switch **Start
  with Windows** off and on again to rewrite the entry.

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

- "Make it an activity?" (opt-in: _Suggest activities for apps I use a
  lot_, in Routines → Activities). NIMBUS keeps a small local tally of
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
