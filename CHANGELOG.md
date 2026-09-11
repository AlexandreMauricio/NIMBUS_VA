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

## Unreleased

- Stock Tracker: a Stocks tab for positions you enter by hand — current
  price and day change, estimated value, gain/loss and today's change,
  per-currency portfolio totals, and recent headlines. Prices come from
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
