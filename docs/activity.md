# Activity & Sessions

NIMBUS knows what happened — "SkillCert was opened". Activity is the
layer that says what that _means_ and how long it has been going on:
"Study, for 47 minutes."

```
Event      something happened          ApplicationOpened
   ↓
Activity   what that means             Study
   ↓
Session    a continuous period of it   Study, since 09:00
```

**Activity is context, never a decision.** Recognising Study does not
start music or a timer. Nothing in `src/activity/` can invoke an Action —
the only route from an activity to something happening is a Routine that
reads it (a trigger or a condition):

```
Context → Event → Activity → Routine evaluation → Suggestion → Action
```

## Where activities are defined

**Routines → Activities.** One list, where each activity can be added,
edited, toggled on/off and removed. Routines refer to an activity by
name, so there is only ever one definition.

Activities were briefly declared on the routine that implied them (a
`"This means I'm doing"` field). Settings files from that period are
migrated on load by `src/settings/activityMigration.ts`: each
routine-declared activity becomes a standalone one carrying the trigger it
had, and a routine whose wind-down relied on that activity gets an
explicit end trigger.

Routines relate to activities in one direction only, as readers: a
routine can start or end on one (`activityEnded`) and test one
(`activityIs`, `activityDuration`).

## Mappings

NIMBUS has no built-in belief that any application means anything.
"Study" is a string you typed. A mapping says "when this is open, I am
doing that":

| Field      | Meaning                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity` | What to call it — "Study", "Gaming", "Coding". Free text.                                                                                   |
| `icon`     | Optional emoji, shown beside it. Never matched on.                                                                                          |
| `source`   | `application`, `website` (window title) or `folder`.                                                                                        |
| `value`    | What to match. Comma-separated for alternatives, exactly like a Routine trigger — they share the implementation (`common/patternMatch.ts`). |
| `priority` | Higher wins when several mappings match at once.                                                                                            |

Application mappings match the executable name exactly; website and folder
mappings match by "contains". Detection is off by default: the **Track
what I'm doing** switch in the Activities view turns it on, and turning it
off keeps the activities you defined. The grace period is set in the same
view.

### Precedence

Chrome might be Browsing, but Chrome on your course site is Study. Give
the narrower rule a higher priority and it wins. When priorities tie,
the more specific pattern wins (the longest alternative that could have
matched), then the mapping id — so the answer never depends on list
order.

## How sessions live and die

1. **An event matching the activity already running updates that
   session — it never starts a second one.**
2. **An event matching no mapping is ignored.** Opening an unmapped app
   mid-session does not end the session.
3. **A session ends only on a signal that genuinely means it** — a
   different activity starting, or the process it is anchored to closing
   (after the grace period). Never because nothing happened for a while.

**Anchor process.** Each session is anchored to the executable whose
running-or-not decides whether it is still alive — the app itself, or
the _browser_ for a website session. A folder session has no anchor and
ends only when another activity begins.

**Websites are the exception to rule 2.** NIMBUS cannot see tabs, so for a
website session, its _own_ browser reporting a title that no longer
matches counts as the site going away and starts the grace period.

**Grace period.** When the anchor closes (or the site goes away), the
session does not end immediately; reopening within the grace period
(default 5 minutes) continues the same session. Starting the grace period
arms a timer for its deadline, so the session — and any routine reacting
to it ending — finishes on time even if nothing else is happening. It is
also checked whenever the current activity is read. A second "gone"
signal never pushes the deadline back.

**Duration** is computed from `startedAt`, never accumulated. A session
that ends after its anchor closed is dated from the _close_, not from
when NIMBUS noticed.

## Restarts and shutdown

A session left active when NIMBUS stopped is closed out at its last known
activity on the next start — never resumed with invented time.

When NIMBUS quits, the current session is recorded as ended but **not
announced**: no `activityEnded` event is published, so "when this activity
ends" routines do not run on the way out.

## Using activity in routines

### Reacting to an activity _ending_

`ActivityService` publishes an `activityEnded` event (with the activity
name and duration) when a session ends. A routine can use it:

- as its **start trigger** — "when Study ends, do X". The editor offers an
  activity (or any activity) and "ignore sessions shorter than N minutes"
  (`minMinutes`), so a ninety-second tab doesn't count;
- as its **end trigger** — the usual way to wind down what the routine
  started, e.g. a Study routine whose end half stops the timer
  (`timer.stop`) when Study ends.

Stopping the timer and stopping playback are separate actions, so leaving
music playing is simply the result of not adding that step.

### Conditions

| Condition          | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| `activityIs`       | The current activity is this one (case-insensitive).    |
| `activityDuration` | The current activity has been going at least N minutes. |

Both **fail closed** when NIMBUS has no idea what you are doing, unlike
the Spotify checks, which fail open.

## Suggested activities

Optional — **Suggest activities for apps and websites I use a lot**, off
by default. While it's on (and the desktop monitor runs), NIMBUS keeps two
small local tallies, each with minutes open per day for the last two weeks
and when it was last opened:

- **Programs with a visible window** (`app-usage.json`,
  `src/activity/appUsage.ts`): the program name and the description
  Windows gives it ("Halo Infinite"). Never window titles and nothing
  inside the program. Background processes, Windows' own shell windows,
  browsers and NIMBUS itself aren't counted.
- **Websites** (`site-usage.json`, `src/activity/siteUsage.ts`): NIMBUS
  sees tab titles, never addresses, so a site is known by the name at the
  **end** of its title, where most sites put it — "(12) Some video -
  YouTube" → YouTube, "Pull requests · user/repo · GitHub" → GitHub. The
  browser's own name (and Edge's profile and "and 3 more pages") is
  removed first. Only that last part is kept — never the whole title; a
  part that looks like an email address, a number or a blank tab is
  ignored. It's a heuristic: a site that puts its name first or leaves it
  out is counted under whatever comes last, which usually never recurs
  enough to be offered.

A program or site used on 3 of the last 7 days, or for 5 hours in them,
that isn't already an activity is offered to the Attention engine, which
decides how to ask: a **popup** when you've used it a lot and have just
opened it, a **Home feed line** otherwise (see [attention.md](attention.md)).
A site counts as already covered when a website activity would match its
name.

- **Make it an activity** opens this form with the program (or, for a
  site, a **Website** activity matching its name) filled in; nothing is
  saved until you save it. If you don't, it may ask again in a week.
- **Not now** rests that program or site for a week; a second **Not now**
  means it is never suggested again.
- A popup that runs out unanswered counts as neither.

## Privacy

Activity detection adds **no new observation**. It reads the same event
stream Routines use — the desktop activity monitor's process names,
known-browser window titles and open folder paths (see
[routines.md](routines.md#privacy)). The monitor runs while **either**
Routines ("Enable context-aware suggestions") **or** activity tracking is
switched on.

A session stores the activity name, the **configured pattern that
matched**, and timestamps — never the raw observed value, so a window
title's page name never reaches the history. A test asserts this.

History is capped at 200 sessions in `activity-history.json`, not in
`settings.json`. The Home tab shows the current activity (refreshed every
10 seconds and on change) and the last 8 sessions.

## Where it lives

| File                                  | Role                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `src/activity/types.ts`               | The model, and mapping validation                     |
| `src/activity/activityDetector.ts`    | Pure event → activity, including precedence           |
| `src/activity/activityService.ts`     | Session lifecycle; subscribes to the shared event bus |
| `src/activity/knownActivities.ts`     | The activity names routines can refer to              |
| `src/settings/activityMigration.ts`   | Moves routine-declared activities into the list       |
| `src/main/activityStateStore.ts`      | Persistence (Windows-specific path, so under `main/`) |
| `src/common/patternMatch.ts`          | Matching shared with Routine triggers                 |

Tests: `activityDetector.test.ts`, `activityService.test.ts` (session
rules, grace, restarts, quiet shutdown, privacy) and
`activityRoutines.test.ts` (activity and routines together).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
