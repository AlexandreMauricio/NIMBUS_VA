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
