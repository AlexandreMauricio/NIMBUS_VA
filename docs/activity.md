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
start music or a timer. Routines decide what to do, and they still ask
before doing it. Nothing in `src/activity/` can invoke an Action — the
only route from an activity to something happening is a Routine
condition, which produces a Suggestion the user accepts:

```
Context → Event → Activity → Routine evaluation → Suggestion → Action
```

## Where activities are defined

**Routines → Activities.** One place, one list. An activity says "when
this is open, I am doing that", and NIMBUS times it. Editing one edits it
everywhere it is referenced, because references are by name and there is
only ever one definition.

Activities were briefly declared on the routine that implied them (a
`"This means I'm doing"` field, whose trigger doubled as the mapping).
That saved retyping an application or website, but it meant an activity
had no home of its own: it could not be edited without opening whichever
routine happened to own it, and a routine that merely _referred_ to an
activity looked no different from one that defined it. Settings files
from that period are migrated on load — see
`src/settings/activityMigration.ts` — so each routine-declared activity
becomes a standalone one carrying the trigger it had.

Routines relate to activities in one direction only, as readers: a
routine can start or end on one (`activityEnded`) and test one
(`activityIs`, `activityDuration`). Recognising an activity still does
nothing on its own — activity is context, and the routine still asks
before acting.

## Mappings

NIMBUS has no built-in belief that any application means anything.
"Study" is a string you typed, not a case in a switch. A mapping says
"when this is open, I am doing that":

| Field      | Meaning                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity` | What to call it — "Study", "Gaming", "Coding". Free text.                                                                                   |
| `icon`     | Optional emoji, shown beside it. Never matched on.                                                                                          |
| `source`   | `application`, `website` (window title) or `folder`.                                                                                        |
| `value`    | What to match. Comma-separated for alternatives, exactly like a Routine trigger — they share the implementation (`common/patternMatch.ts`). |
| `priority` | Higher wins when several mappings match at once.                                                                                            |

Activities live under **Routines → Activities**, off by default: NIMBUS
should not be interpreting what you are doing until you ask it to. The
switch is kept separately from the list, so turning detection off keeps
the activities you defined.

### Precedence

Chrome might be Browsing, but Chrome on your course site is Study. Give
the narrower rule a higher priority and it wins. When priorities tie,
the more specific pattern wins (the longest alternative that could have
matched), then the mapping id — so the answer never depends on the order
the list happens to be stored in.

## How sessions live and die

Three rules make sessions useful rather than noise:

1. **An event matching the activity already running updates that
   session — it never starts a second one.** Re-opening or re-reporting
   the same app is the common case; a new session per event would reduce
   every duration to zero.
2. **An event matching no mapping is ignored entirely.** Opening an
   unmapped app mid-session does not end the session. Alt-tabbing to a
   chat app is not "stopped studying".
3. **A session ends only on a signal that genuinely means it** — a
   different activity starting, or the process it is anchored to
   closing. Never on a timer, and never because nothing happened for a
   while: sustained work produces no events at all, so treating silence
   as "finished" would end every real session.

**Anchor process.** Each session is anchored to the executable whose
running-or-not decides whether it is still alive — the app itself, or
the _browser_ for a website session. A folder session has no anchor and
ends only when another activity begins.

**Websites are the exception to rule 2.** NIMBUS cannot see tabs:
closing the study tab or navigating away simply makes that browser
report a different window title. So for a website session, its _own_
browser reporting a title that no longer matches counts as the site
going away, and starts the grace period. Waiting for the whole browser
to close would leave a study session running all day. Another browser
doing the same is ignored, as is any unmapped application — rule 2
stands everywhere else.

**Grace period.** When the anchor closes, the session does not end
immediately. Reopening within the grace period (default 5 minutes,
configurable) continues the same session, so a crash, a restart, or
closing something by accident does not fragment an afternoon into
several sessions. It is resolved lazily when the session is next read,
so it needs no timer and gives the same answer whenever it is asked.

**Duration** is always computed from `startedAt`, never accumulated, so
it cannot drift. A session that ends after its anchor closed is dated
from the _close_, not from when NIMBUS noticed — so closing a study app
and starting a game two minutes later records 30 minutes of study, not 32.

## Restarts

A session left active when NIMBUS stops is closed out at its last known
activity — never resumed. NIMBUS cannot know whether the app kept
running, whether the machine slept, or how long any of it lasted, and
inventing that time would put fabricated durations into your own
history. Sessions are ended at shutdown for the same reason.

## Using activity in routines

### Reacting to an activity _ending_

An `activityEnded` **trigger** fires when a session finishes — the one
thing no other event can say, since every other event announces
something starting. `activity` limits it to one activity (empty matches
any), and `minMinutes` ignores blips, so "when I finish studying" does
not fire because a tab was open for ninety seconds.

This is how "stop the Pomodoro when I stop studying" is expressed:

|                   |                                               |
| ----------------- | --------------------------------------------- |
| Trigger           | Activity ended → `Study`, ignore under 20 min |
| Action            | Stop the timer (`timer.stop`)                 |
| Run automatically | on                                            |

Note what is _not_ in that routine: anything about music. Stopping the
timer and stopping playback are separate actions, so leaving music
playing is simply the result of not adding that step — you may well have
moved on to listening to something else.

### Conditions

Two conditions:

| Condition          | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| `activityIs`       | The current activity is this one (case-insensitive).    |
| `activityDuration` | The current activity has been going at least N minutes. |

Together they express "you have been studying for 90 minutes — break?".
Both **fail closed** when NIMBUS has no idea what you are doing, unlike
the Spotify checks which fail open: "only while studying" must not fire
when there is no activity at all.

## Privacy

Activity detection adds **no new observation**. It reads the same
event stream Routines already use — the desktop activity monitor's
process names, known-browser window titles and open folder paths (see
[docs/routines.md](routines.md) for exactly what that collects, and what
it does not).

What gets _stored_ is narrower still. A session records the activity
name, the **configured pattern that matched**, and timestamps — never
the raw observed value. For an application those are much the same; for
a website they are very much not, because a window title carries
whatever page you happen to be on. Storing titles would turn the session
list into a browsing log, so it stores `myschool`, the fragment you put
in the mapping, and not "MySchool — Bank statement for March". A test
asserts this.

No keystrokes, screenshots, screen recording, page contents, browser
history or clipboard — none of which NIMBUS collects anywhere.

History is capped at 200 sessions in `activity-history.json`, alongside
the other machine state (`routine-state.json`), not in `settings.json`.

## Where it lives

| File                               | Role                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `src/activity/types.ts`            | The model, and mapping validation                       |
| `src/activity/activityDetector.ts` | Pure event → activity, including precedence             |
| `src/activity/activityService.ts`  | Session lifecycle; subscribes to the shared event bus   |
| `src/main/activityStateStore.ts`   | Persistence (Windows-specific path, so under `main/`)   |
| `src/activity/routineMappings.ts`  | Derives mappings from routines that declare an activity |
| `src/common/patternMatch.ts`       | Matching shared with Routine triggers                   |

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
