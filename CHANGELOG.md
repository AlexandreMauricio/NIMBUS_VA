# Changelog

## Versioning

NIMBUS uses `MAJOR.MINOR.PATCH`:

| Part | Bumped when |
| --- | --- |
| **MAJOR** | A full release of the app. Stays at **0** until NIMBUS is something you'd call finished — even though it's for your own use. |
| **MINOR** | A big milestone: a new subsystem, or an existing one substantially reworked. |
| **PATCH** | Everything else — fixes, small features, refactors, docs. |

The version lives in `package.json` and is shown in the sidebar, so what
you see running is what you can point at in the history. Each release is
tagged (`v0.3.0`), so `git log v0.2.0..v0.3.0` shows exactly what changed.

Dates are the day the work landed.

---

## 0.3.0 — 2026-09-10

**Activity & Session awareness.** NIMBUS knew what happened; it now also
knows what the user is doing and for how long.

- `Event → Activity → Session`, in a new `src/activity/`. Activity is
  context only: recognising Study starts nothing on its own.
- Detection is entirely user-configured. Either on a routine — its own
  trigger doubles as the mapping, so an app or site is configured once —
  or as a standalone mapping for activities with no routine.
- Sessions update rather than restart on repeat events, ignore unmapped
  apps, and end only on a real signal: a different activity, or the
  process they're anchored to closing (after a grace period).
- Routines gain `activityIs` and `activityDuration` conditions, an
  `activityEnded` trigger, and a `timer.stop` action — enough to express
  "when I stop studying, stop the Pomodoro" as configuration.
- Home shows the current activity with the existing Spotify and timer
  state beside it, plus recent activity.
- A running Pomodoro can be extended by another study (`timer.addStudy`
  and a "+ Study" button), for the days you want three instead of two.

Fixes in this line: sessions ending at the moment the app closed rather
than when NIMBUS noticed; website sessions ending when the browser
leaves the site instead of running until the browser closes; the routine
form freezing after a failed save (a native `alert()` stealing keyboard
focus), now inline validation with required-field markers.

## 0.2.0 — 2026-09-09

**Routine Engine 2.0.** The routine system became explainable and far
more expressive, without changing what existing routines do.

- Multiple conditions with ALL/ANY logic; time windows to the minute,
  including windows that cross midnight; days of the week.
- Cooldowns persist across restarts (`routine-state.json`).
- Session restrictions — "once per application run" — so returning to an
  open app doesn't re-suggest.
- Every decision is explainable: the same code that decides produces the
  tick/cross list the Test button shows. Testing no longer executes
  actions; "Run now" does that explicitly.
- A decision history of the last 200 routine outcomes, in memory.

## 0.1.0 — 2026-09-09

The foundation as it stood when the repository was created, plus a first
review pass over it.

- Context providers (weather, calendar, email, tasks, Spotify), the
  briefing, the event bus, routines, actions, timers, and the Electron
  shell.
- Review fixes: timeouts on every outbound call and provider, IMAP and
  Todoist credentials encrypted at rest, atomic settings writes, a
  persistent PowerShell session for activity polling (~16× faster), the
  real Nocturne design system adopted, and the UI made testable.
