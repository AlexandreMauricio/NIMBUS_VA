# Attention & Priority

NIMBUS knows about many things at once — meetings, tasks, email, weather,
stocks, what you're doing, and what your routines want to suggest. The
Attention engine decides **what deserves your attention right now**, and
explains why. It is deterministic: a transparent weighted score and a few
rules, no learning and no AI.

```
Context (calendar, tasks, email, weather, stocks) ─┐
Activity (what you're doing, how long) ────────────┼─→ Signals ─→ Engine ─→ Items ─→ Suggestion popup / Home feed
Routine suggestions ───────────────────────────────┘              (score, dedupe, decide, explain)
```

Code: `src/attention/` (Core, no Electron). Wiring: `src/main/lifecycle.ts`.

## The safety boundary

Attention decides *what matters and whether it is shown*. The existing
Suggestion infrastructure decides *how it is shown and what you can do*.

```
Attention → Suggestion → your acceptance → Action
```

Attention never runs an Action. Structurally, nothing in `src/attention/`
imports the Action system (a test checks the compiled module). Attention's
own popups are informational — "Got it" only acknowledges them. A routine's
suggestion is shown exactly as RoutineService made it, and accepting it is
still RoutineService's job.

## Signals

A signal is one real-world thing that might matter, rebuilt on every
evaluation by a pure builder in `signals.ts`. Each has a **stable key**
(the same meeting always gives `calendar:<id>:<start>`), importance,
urgency and relevance (0–100), reasons in words, and an expiry.

| Source | Signal | Importance | Urgency | Relevance | Key / expiry |
| --- | --- | --- | --- | --- | --- |
| Calendar | Timed event starting within the reminder lead time or 60 min, whichever is longer (or started ≤ 5 min ago) | 70 | 35 before the reminder, **70 from the reminder** (default 60 min before), 85 (≤ 15), 100 (≤ 5) | 70 | per event and start; 5 min after the start |
| Tasks | Task with a due *time* in the next 2 h | 60 (70 if high priority) | 55, 70 (≤ 60 min), 90 (≤ 15 min) | 60 | per task; at the due time |
| Tasks | Overdue tasks (one summary) | 55 | 60 | 60 | per day; end of day |
| Tasks | Tasks due today (one summary) | 55 | 45 | 55 | per day; end of day |
| Email | Unread important email from the last 12 h (max 3) | 60 high / 45 important | 45 | 60 | per message; 12 h after arrival |
| Weather | Rain chance ≥ 50% today (before 21:00) | 35 | 30 (40 at ≥ 80%) | the rain chance, max 90 | per day; end of day |
| Stocks | Portfolio moved ≥ 3% today | 35 | 35 | 40 + 5 × the move, max 90 | per day and direction; end of day |
| Activity | One activity for ≥ 3 h | 40 | 40, +10 per extra hour, max 60 | 60, about that activity | per session; rolls forward while it lasts |
| Activity | A program or website used often that isn't an activity yet (opt-in, see [activity.md](activity.md#suggested-activities)) | 45 | 70 when just opened, else 40 | 30 + 10 per day + 2 per hour, max 90 | per program (`frequentApp:<exe>`) or site (`frequentApp:site:<name>`); rolls forward while it qualifies |
| Routines | A routine's suggestion | 50 | 80 | 70 | per suggestion; its own 60 s expiry |

A provider that is off or failing contributes nothing.

## Scoring

```
score = 0.40 × urgency + 0.35 × importance + 0.25 × relevance
        − 15  while you're busy (an activity is on, or a timer runs),
              for anything with urgency under 70
        + 10  when the item is about the activity you're doing
```

Clamped to 0–100 and rounded, then banded: **urgent ≥ 80**, **high ≥ 65**,
**normal ≥ 40**, **low** below. Every term is kept as a factor, so "why"
is the calculation itself.

Examples:

| Situation | Score | Priority |
| --- | --- | --- |
| Meeting in 12 min | 34 + 24.5 + 17.5 = 76 | High — pops up |
| Same meeting in 4 min | 40 + 24.5 + 17.5 = 82 | Urgent — pops up again if not answered |
| Meeting in 45 min (reminder: 60 min) | 28 + 24.5 + 17.5 = 70 | High — pops up |
| Meeting in 45 min (reminder: 30 min) | 14 + 24.5 + 17.5 = 56 | Normal — Home feed |
| Rain 80% | 16 + 12.25 + 20 = 48 | Normal |
| Rain 80% while studying | 48 − 15 = 33 | Low — kept quiet until you're free |
| 3 h of gaming (busy with it) | 16 + 14 + 15 − 15 + 10 = 40 | Normal — never high by itself |
| Routine suggestion | 32 + 17.5 + 17.5 = 67 | High — pops up, as before |

## Decisions

On each evaluation, in order (`attentionEngine.ts`):

1. Expired signals are ignored; signals with the same key are one item.
2. Items you answered (Got it / Dismiss) are never shown again.
3. Low priority is **quiet**: visible in the debug view, not shown.
4. An item already shown is shown again only if its priority **rose**
   (a meeting going from high to urgent). A popup that simply ran out
   unanswered isn't an answer, so escalation can bring it back.
5. High and urgent items **interrupt** (the suggestion popup); normal
   items go to the **Home feed**. With "Pop up urgent items" off, only
   routine suggestions still interrupt.
6. At most **one interruption per evaluation** — the highest score. The
   others are **held**, with the name of what outranked them.
7. While the popup shows something, only an **urgent** item with a higher
   score may replace it.
8. No two interruptions within **2 minutes**, unless the second is urgent
   or a routine's suggestion (which only lasts a minute).
9. At most **3 feed posts** per evaluation; the rest follow next time.

Nothing is discarded: held and quiet items stay in the list with their
reason and are reconsidered every time until they expire.

## How it runs

`AttentionService` evaluates every 30 s, immediately when a routine makes
a suggestion, and when the popup closes. It re-reads the Context snapshot
at most every 5 minutes (a failed read also waits), so it adds little to
what providers fetch. Activity and timer state are read live.

## Suggestions, before and after

Routine suggestions are still created by RoutineService and still appear
in the Home feed immediately. What changed is the popup:

- A lone routine suggestion pops up at once — unchanged.
- If something more important is on screen, it **waits** and appears as
  soon as the popup frees, instead of overwriting it (or being
  overwritten). If it expires while waiting, it isn't shown late.
- With Attention switched off, every routine suggestion goes straight to
  the popup exactly as before, and nothing proactive is raised.

The accept/dismiss channels route Attention's own suggestions to
`AttentionService` (acknowledge/dismiss, nothing runs) and everything else
to RoutineService, which then tells Attention the suggestion was resolved.

## Questions

Some items ask something rather than inform. Today that is "Make … an
activity?": it carries its own button labels and a **follow-up** (which
program or website to fill in). Attention reports the answer through `onAnswer`, and
the app carries it out — opening the Activities editor on "yes",
remembering "Not now" — so the navigation lives in the client, and
nothing is created or run by Attention. A popup that runs out isn't an
answer.

A question that isn't pressing enough to interrupt goes to the **Home
feed** instead of a popup, and carries its two answers there as buttons
(`AttentionService.answerItem`, over `nimbus:answer-attention-item`). It
takes the same `onAnswer` path as the popup, and each item can be answered
once. A feed line from before a restart is no longer current — its buttons
say so.

## Calendar reminders

A reminder is for **leaving on time**, not for the moment itself. The
first version popped up 15 minutes before an event, which is right for a
call at your desk and useless for a 9:30 appointment you have to travel
to — by 9:15 you're out the door, and the only earlier signal was a Home
feed line.

Now an event's reminder pops up at the **reminder lead time** (Context →
Attention → *Calendar reminders*, default **an hour before**, 15 minutes to
4 hours). Its urgency is 70 from then on, which makes it high priority and
exempt from the busy rule, so gaming or a running timer doesn't silence
it. It pops up once more, as urgent, 5 minutes before the start.

## Debug view

The **Context** tab has a fold-away *Attention* box: every current item with
its priority, score, source, decision and reason, and a "Why" list of the
score's factors and facts. It also has the two switches: **Notice what
matters** (`attention.enabled`) and **Pop up urgent items**
(`attention.popups`). The popup shows a one-line "Why" for Attention's
own items.

## Limitations

- Rules and weights are fixed in code; there are no per-user weights yet.
- Decisions are in memory: after a restart, an item still current may be
  shown once more. Answers (Got it / Dismiss) are not persisted.
- Busy is "an activity is on, or a timer runs" — there is no calendar
  "in a meeting" state, idle detection or do-not-disturb schedule.
- Calendar timing depends on a snapshot up to 5 minutes old; the minutes
  are recomputed each evaluation, but a newly added event can take up to
  5 minutes to appear.
- "End of day" is computed from the local clock and can be an hour off
  on DST changeover days.
- Email and tasks use the importance their providers already assign.

## Feeding Attention from a new source

A provider feeds Attention by adding a builder to `signals.ts` that reads
its context from the snapshot and returns signals — nothing else changes:

- **Stocks** already does: a big portfolio move. More could follow the
  same shape, e.g. an outdated listing (`stocks:outdated:<symbol>`,
  importance 30) or an estimated ex-dividend date tomorrow.
- The **Network** provider ([network.md](network.md)) doesn't feed
  Attention yet; it could emit "Internet connection lost"
  (importance 60, urgency 80 while it lasts, key `network:offline:<since>`,
  expiring when the connection returns) — urgent enough to pop up, and
  gone as soon as the condition clears.

Something that happens rather than persists (an event on the bus) can
also be offered directly, as routine suggestions are, through a method on
`AttentionService` that turns it into a signal.
