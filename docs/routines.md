# Context-Aware Routines

The newest system: NIMBUS can now notice things happening on the desktop
(a configured application starting, a configured website's tab becoming
active, a configured folder being opened in Explorer) and quietly
*suggest* running a user-defined Routine — never act on its own. See
[src/events/](../src/events/) and [src/routines/](../src/routines/), and
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
  anywhere in the code — those are just examples in these docs and in
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

## Conditions, time windows, sessions and cooldowns

A routine's trigger decides *when it is considered*; its conditions decide
*whether it should actually fire*. Conditions are structured data, never
expressions or code — each is a small typed object, and adding a new kind
means one variant in `RoutineCondition` plus one case in
`conditionEvaluator.ts`.

| Condition | What it checks |
| --- | --- |
| `timeOfDay` | A local-time window, e.g. 18:30–23:15. Minutes are optional and default to `:00`, so an older whole-hour condition means exactly what it always did. A window may cross midnight (22:00–02:00); the end is exclusive. |
| `daysOfWeek` | Specific days, 0 (Sunday) to 6 (Saturday). |
| `weekdaysOnly` | Monday–Friday. Superseded by `daysOfWeek` and no longer offered for new routines, but still honoured so existing ones keep working. |
| `spotifyNotAlreadyPlaying` | Nothing is already playing — don't talk over music the user started. |
| `actionsNotAlreadyActive` | This routine's own configured effects don't already appear to be in place. Edited through the "Skip if already active" switch rather than the condition list. |

`conditionLogic` combines them: `"all"` (the default, and what every
routine written before the field existed does) or `"any"`. It is one flat
list plus an operator rather than a nested boolean tree — that covers the
cases people actually write, stays editable in a simple form, and being
structured data leaves room to grow into groups later without
invalidating anything already saved.

**Cooldown** (`cooldownMinutes`) is the minimum gap between firings. It
starts the moment a routine fires — not when the user answers — so a
dismissed suggestion cannot immediately return. Cooldowns are written to
`routine-state.json` in the user data directory and reloaded at startup,
because a cooldown that resets on restart is exactly the spam it exists
to prevent.

**Session restriction** (`sessionRestriction: "oncePerSession"`) limits a
routine to once per *thing that triggered it* — one application run, one
page, one folder. A session belongs to that thing rather than to NIMBUS:
switching away from an application and back is the same session, while a
different application is a different one. An application's session ends
when it closes, which the activity monitor reports as an
`applicationClosed` event (nothing triggers on that event; it exists only
to close sessions). Sessions are deliberately not persisted — after a
restart NIMBUS cannot know whether the application it saw is still the
same run, so it starts fresh rather than guessing.

## Why did this trigger?

Every decision the engine makes is explainable. `RoutineService.evaluate`
runs the gates in order — enabled, cooldown, session, conditions — and
records a pass/fail line for each. The Routines tab's **Test** button
shows exactly that:

```
Study Mode
Would not match
  ✓ Has not run yet, so no cooldown applies
  ✓ Not already triggered this session
  ✗ Time is outside 18:00-23:00
  ✓ Today is one of Monday, Tuesday, Wednesday, Thursday, Friday
```

Live event handling and Test call the same method, so what a user reads
while testing is produced by the code that actually decides, not a
description of it that could drift.

**Test never executes anything.** Asking whether a rule matches is not
asking for its effects, so testing will not start playback, start a
timer, or open a page. The play button beside it — **Run now** — is the
explicit way to run a routine's actions on demand, and is what the old
"Test" button used to do.

## One routine, both halves

A routine is two rules that share a name, an identity and a cooldown.
Each half is complete on its own — something happens, some conditions
hold, some actions run:

| | **When it starts** | **When it ends** |
| --- | --- | --- |
| Trigger | `trigger` | `stopTrigger` |
| Conditions | `conditions` | `stopConditions` |
| Actions | `actions` | `stopActions` |

The end half's trigger defaults to "the activity this routine names has
ended", which is what it meant before it could be chosen — so a routine
saved without one behaves identically. But it need not be an activity at
all: a focus timer completing, or another application opening, can just
as well be what winds a routine down.

Conditions are deliberately separate rather than shared. "Only start
between 18:00 and 23:00" must not also mean "only stop between 18:00 and
23:00" — a routine that began at 22:00 still has to wind down afterwards.

End actions need something able to fire them — an end trigger, or an
activity for this routine to name — and the editor says so rather than
letting you configure steps that can never run.

Two rules make them safe:

- **They only run if the routine actually started.** If you dismissed the
  suggestion and studied with your own music, winding down would stop
  something this routine never started.
- **They ignore conditions and cooldown.** Those decide whether a routine
  should *start*. A routine that began at 22:00 must still stop the timer
  at 23:30, not fail to because its time window closed.

They run without asking by default, unlike the start half. You already
approved the routine when you accepted its suggestion, and winding down
what it started is the end of that same decision rather than a new one —
being asked "shall I stop the timer?" after you have stopped studying is
a question with one sensible answer. The toggle turns it back into a
suggestion if you'd rather be asked.

## Decision history

`RoutineService.getHistory()` returns the recent decisions, newest first:
matched, suggested, accepted, dismissed, expired, auto-ran, and each kind
of block (cooldown, session, conditions). It is capped at 200 entries and
held in memory only.

It records **NIMBUS's own decisions and nothing else** — a routine id, a
name, a kind, and at most a short count like "2 actions, 1 failed". There
is no field for page content, window titles, keystrokes, or anything the
user typed or read, and a test asserts that a routine triggered by a
browser window records nothing of that window's title.

## Privacy

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

## Timers

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

## Suggestion & Timer popups

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

## Home page

The Home tab now shows a compact "now playing" card when Spotify is
connected — artwork, title, artist, progress bar, playback state, and
Previous/Play-Pause/Next/volume controls, plus the playlist name when
Spotify reports the current context is a playlist NIMBUS already knows
the name of (matched locally against the already-fetched playlist list,
so this never costs an extra API call on every playback poll). Nothing
is playing → a plain "Nothing is playing" state, no player chrome. The
card polls context every 5 seconds, and only while the Home tab is
actually visible.

## Tests

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
new tests here, plus 9 added to the Spotify test files (playlist
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
needed (see [Spotify](spotify.md)) — Routines and Timers have no credentials of
their own. Desktop activity monitoring requires no setup beyond checking
the one Settings toggle.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
