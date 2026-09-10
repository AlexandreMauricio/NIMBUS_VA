# Changelog

## Versioning

NIMBUS uses `MAJOR.MINOR.PATCH`:

| Part | Bumped when |
| --- | --- |
| **MAJOR** | A full release of the app. Stays at **0** until NIMBUS is something you'd call finished — even though it's for your own use. |
| **MINOR** | A big milestone. **Alexandre decides when one has been reached** — work accumulates as patches until he calls it. |
| **PATCH** | Everything else — fixes, features, refactors, docs. |

The version lives in `package.json` and is shown in the sidebar, so what
you see running is what you can point at in the history. Each release is
tagged (`v0.2.0`), so `git log v0.1.0..v0.2.0` shows exactly what changed.

Dates are the day the work landed.

---

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
