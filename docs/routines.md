# Context-Aware Routines

NIMBUS can notice things happening on the desktop — a configured
application starting, a configured website's title appearing in a
browser, a configured folder opening in Explorer, an activity ending, a
timer finishing — and *suggest* running a user-defined Routine. See
[src/events/](../src/events/) and [src/routines/](../src/routines/), and
ARCHITECTURE.md's "Context Events and Routines" section for the internal
design; this guide covers behaviour, privacy and setup.

## The flow

Context Event → Trigger match → gates (enabled, cooldown, session,
conditions) → **Suggestion**, shown in a small NIMBUS-owned popup →
*only on the primary button* do the routine's configured Actions run,
through the same `ActionService` the rest of NIMBUS uses.

Two deliberate, opt-in exceptions run without a popup:

- **Run automatically** (`autoRun`, off by default) runs a routine's
  actions the moment it matches. Cooldown and conditions still apply.
  What ran appears as a line in the Home activity feed.
- **The end half** of a routine (see below) runs without asking by
  default, because it only ever winds down what an accepted routine
  started. It can be switched to ask instead.

A Routine can never contain a shell command or arbitrary code — its
actions are validated (`validateRoutine`) against the registered action
ids when saved, and again by `ActionService` when run.

## Building a routine

Routines live in the **Routines** tab (list or grid). Click a card to edit
it; **+ New routine** opens a blank one. Each card has an **Active**
switch, **Test**, **Delete**, and a **Run now** (▶) button.

A routine has:

- **Name** (required), an optional **description**, and a **suggestion**
  title and message (required) — the text of the popup.
- **When it starts**: a trigger, optional conditions, and one or more
  actions.
- **When it ends** (optional): an end trigger, its own conditions, and
  its own actions.
- **Cooldown** (minutes, default 30), **Only once per session**, **Skip if
  already active**, **Enabled**, and **Run automatically**.

### Triggers

| Trigger | Matches | In the editor |
| --- | --- | --- |
| `applicationOpened` | A running executable name | Start and end |
| `websiteOpened` | A recognized browser's window title | Start and end |
| `folderOpened` | An open Explorer window's path | Start and end |
| `activityEnded` | An activity session ending (one activity or any), optionally ignoring short sessions | Start and end |
| `timerCompleted` | A timer phase finishing (optionally of one timer type) | End only |

`timerCompleted` is accepted as a start trigger by the model and the
validator, but the editor offers it only for the end half.

Application, website and folder patterns support `exact` or `contains`
matching, and accept comma-separated alternatives
(`skillcert,nowuniversity`), so one routine can cover several apps or
sites.

### Conditions

Conditions decide *whether* a matched routine fires. They are structured
data, combined with `conditionLogic` — `"all"` (default) or `"any"`. An
empty list always passes.

The editor builds each row as **field → operator → value**, where the
value disappears when the operator doesn't need one ("Spotify — is
playing"). One catalog
([conditionCatalog.ts](../src/routines/conditionCatalog.ts)) lists every
field, its operators and the kind of value each needs; the editor draws
its pickers from it, and it translates both ways between a picker row and
the stored condition. Adding a condition means one entry there and one
case in the evaluator.

| Field | Operators | Value | Notes |
| --- | --- | --- | --- |
| **Time** | is between | two times | A local-time window, e.g. 18:30–23:15. May cross midnight; the end is exclusive; start == end means always. |
| **Time** | is before, is after | a time | The one-sided form. "after" includes the minute itself. |
| **Day** | is one of | days | 0 (Sunday) to 6 (Saturday). |
| **Activity** | is, is not | an activity | "is" fails closed with no activity; "is not" treats nothing running as a real answer. |
| **Activity** | has lasted at least, has lasted less than | minutes | Fails closed with no activity. |
| **Spotify** | is playing, is not playing | — | Fails open if Spotify can't be checked. |
| **Spotify playlist** | is, is not | a playlist | Compares what playback reports as its context, by URI. Nothing playing answers "is not"; an uncheckable Spotify fails closed. |
| **Timer** | is running, is paused, is not running | — | NIMBUS's own timer. Fails closed if the timer can't be read. |
| **Device** | is on the network, is not on the network | a device | Presence from the Network tab, by MAC. NIMBUS's own observation, **not** a security check; phones drop off while asleep. A device it has never seen, or network watching being off, fails closed both ways. |

Two conditions aren't rows in that list:

| Condition | What it checks |
| --- | --- |
| `actionsNotAlreadyActive` | This routine's own playlist (by exact URI) or timer isn't already running. Set with the **Skip if already active** switch. Fails open. |
| `weekdaysOnly` | Monday–Friday. Legacy: still honoured and still shown, but new routines get **Day is one of** instead. |

**Fail open vs fail closed.** The Spotify playing checks fail *open* — a
broken playback check shouldn't silence every suggestion. Everything that
names something specific (an activity, a playlist, a timer state, a
device) fails *closed*: "only while my phone is home" must not fire when
NIMBUS has no idea where the phone is.

### Actions

Actions are chosen in two steps — a service (Spotify, Timer, System),
then one of its actions — and run in the configured order. One step
failing never stops the rest; every step's result is returned.

- **Spotify**: play, pause, next, previous, set volume, play a search
  result, play a playlist. "Play playlist" shows a dropdown of your actual
  playlists and stores the exact playlist URI.
- **Timer**: start a single countdown or a Pomodoro plan, stop the timer,
  pause or resume it, add another study. Pause and resume report a failure
  when there is nothing in that state, rather than a quiet success. See
  [Timers](#timers).
- **System**: open a website (`http://`/`https://` only), lock Windows.
- **Applications**: launch an app from its `.exe` or a `.lnk` shortcut;
  bring an app to the front, minimize, maximize or close it by process
  name (close asks politely — never a force-quit).
- **Files**: open a file (programs, scripts and shortcuts are refused) or a
  folder.
- **Media**: play/pause, next and previous track (the media keys, whatever
  is playing), set the system volume, mute, unmute.

Path parameters have a **Browse…** button, and every text field shows what
it expects as a hint. See [the Action system](action-system.md#desktop-actions)
for how the desktop actions are implemented and what they refuse.

## Gates: cooldown and sessions

**Cooldown** (`cooldownMinutes`) is the minimum gap between firings. It
starts the moment a routine fires — suggests or auto-runs — not when the
user answers, so a dismissed suggestion cannot immediately return.
Cooldowns are saved in `routine-state.json` and survive restarts.

**Only once per session** (`sessionRestriction: "oncePerSession"`) limits
a routine to once per *thing that triggered it*:

- an **application**: one run of that executable, ending when it closes;
- a **website**: while that browser stays open — page and tab changes do
  not start a new session, closing the browser does;
- a **folder**: that folder path;
- a completed **timer**: each one is its own occurrence, so this never
  suppresses a timer trigger.

Sessions are kept in memory only and start fresh after a restart.

## Suggestions

A suggestion carries the routine's title and message, its two button
labels, and one line per action (built from each action's registered
name and service). It **expires after 60 seconds** if ignored — the popup
dismisses itself at that moment. Dismissing has the same effect as
letting it expire; the cooldown already started either way.

Active suggestions are held in memory only.

The popup shows one suggestion at a time, and the Attention engine
decides the order (see [attention.md](attention.md)): a lone suggestion
appears at once, as it always did; if something more important is on
screen, it waits and appears as soon as the popup frees, rather than
overwriting it. One that expires while waiting isn't shown late. The Home
feed line is published immediately either way. With Attention switched
off, every suggestion goes straight to the popup.

## Why did this trigger?

`RoutineService.evaluate` runs the gates in order — enabled, cooldown,
session, conditions — and records a pass/fail line for each. The card's
**Test** button shows exactly that, with a first line noting that the
trigger itself can only be judged live:

```
Study Mode
Would not match
  ✓ Trigger not evaluated here: a browser window matching "Halo" decides that live
  ✓ Has not run yet, so no cooldown applies
  ✗ Time is outside 18:00-23:00
```

**Test never executes anything.** **Run now** (▶) is the explicit way to
run a routine's start actions immediately, bypassing trigger, cooldown and
conditions.

## One routine, both halves

A routine is two rules that share a name, an identity and a cooldown:

| | **When it starts** | **When it ends** |
| --- | --- | --- |
| Trigger | `trigger` | `stopTrigger` |
| Conditions | `conditions` | `stopConditions` |
| Actions | `actions` | `stopActions` |

- **End actions need an end trigger.** Saving end actions without one is
  rejected. The editor defaults the end trigger to "Activity ended — any
  activity"; an end trigger you chose is kept even before you add its
  actions (the section says it has nothing to run yet).
- **End conditions are separate.** "Only start between 18:00 and 23:00"
  must not also mean "only stop then".
- **They only run if the routine actually started** — its start actions
  ran (accepted, auto-run, or Run now). The owed wind-down is saved in
  `routine-state.json`, so it survives a restart, but is dropped after 12
  hours.
- **They ignore the start half's conditions and cooldown**, and never
  reset the start cooldown.
- **They run without asking by default.** With "Run these without asking"
  off, the wind-down becomes a suggestion with its own wording ("Wrap up
  *routine name*?") rather than the start prompt.

## Decision history

`RoutineService.getHistory()` returns recent decisions, newest first —
matched, suggested, accepted, dismissed, expired, auto-ran, actions
completed, and each kind of block. It is capped at 200 entries, held in
memory, and exposed over `nimbus:get-routine-history`, but **no screen
displays it yet**. It records NIMBUS's own decisions only — never window
titles, page content or anything typed; a test asserts that.

## Privacy

Desktop activity monitoring is **off by default**. It runs while
"Enable context-aware suggestions" (Routines tab) **or** activity tracking
(Activities view) is on. While on, it reads, every 5 seconds, through one
long-lived PowerShell process:

- running process **executable names** (e.g. `steam.exe`);
- the **main window title** of recognized browser processes only
  (Chrome, Edge, Firefox, Brave, Opera);
- the **folder path** of open Explorer windows (via the
  `Shell.Application` COM object);
- the **names and Windows descriptions of programs with a visible
  window** — read on every poll, but only kept while the opt-in
  *Suggest activities for apps I use a lot* is on (see
  [activity.md](activity.md#suggested-activities)).

It never captures screenshots, keystrokes, page content, clipboard or
browsing history, and never sends anything to an external service —
matching is plain string comparison. Turning both switches off stops the
monitor and its PowerShell process.

The first poll only establishes a baseline for processes and folders
(so everything already open doesn't fire as "just launched"); browser
titles are eligible from the first poll, so a site that was already open
can still trigger.

The Routines tab has a **What NIMBUS currently sees** panel showing the
monitor's most recent raw snapshot, for checking a pattern against
reality.

## Timers

A small, generic countdown engine (`src/timers/`), driven by actions.

- **`timer.start`, single** (default): one countdown with a duration,
  type (focus/pomodoro/break/custom) and optional title.
- **`timer.start`, Pomodoro**: a Study → Break → Study plan from
  `studyMinutes` (default 45), `breakMinutes` (default 15) and `cycles`
  (studies, default 1). A break only sits between studies. Each phase
  starts automatically when the previous one completes.
- **`timer.stop`**: stops the timer and the rest of its plan; succeeds
  quietly when nothing is running.
- **`timer.addStudy`**: adds one or more studies (and the breaks before
  them) to the running plan, renumbering titles ("Study 1 of 3"). Also
  the **+ Study** button in the timer popup.

Behaviour:

- A successful `timer.start` opens a small always-on-top window in the
  top-right of the primary display: title, remaining time, progress bar,
  Pause/Resume, Stop, and + Study. It never takes focus. It closes 4
  seconds after the last phase completes, or when stopped. It does not
  reopen itself on a phase change.
- Only one timer (or plan) runs at a time; starting another replaces it.
- Remaining time follows the wall clock, so time the computer spends
  asleep still counts down.
- Every phase completion publishes a `timerCompleted` event carrying that
  phase's type, which routines can use as an end trigger.

## Popups

Both the suggestion prompt and the timer use small NIMBUS-owned windows
rather than native Windows notifications (which can't render two buttons
and a per-action list). Both are frameless, always-on-top and shown
without taking focus, positioned in the primary display's work area
(suggestions bottom-right, timer top-right) and repositioned each time
they are shown. They render only what their data carries — no internal
ids. The suggestion popup also shows Attention's own informational
suggestions ("Got it" / "Dismiss", nothing to run), with a one-line
"Why".

## Tests

`eventBus.test.ts`, `triggerMatcher.test.ts`, `conditionEvaluator.test.ts`,
`types.test.ts` (`validateRoutine`), `routineService.test.ts` and
`routineEngine.test.ts` (matching, suggestions, accept/dismiss, cooldowns,
sessions, conditions, Test never executing, auto-run, history),
`activityRoutines.test.ts` (activities and routines together, both halves,
wind-down wording, restart persistence), `activitySnapshot.test.ts` and
`desktopActivityMonitor.test.ts` (detection and diffing),
`timerService.test.ts` and `timerActionProvider.test.ts`. No test spawns a
real PowerShell process or needs a real Spotify account. The popups and
the routine editor are Electron/DOM code without automated UI tests.

**Setup**: no credentials of their own. Spotify actions need Spotify set
up (see [spotify.md](spotify.md)); desktop monitoring needs only its
switch.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
