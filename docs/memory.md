# Memory

What NIMBUS keeps knowing across restarts — and, just as important, how it
came to know it. Code: [src/memory/](../src/memory/), stored by
[src/main/memoryStore.ts](../src/main/memoryStore.ts), shown in the
**Memory** tab.

## Three tiers, trusted differently

| Origin | Where it comes from | Confidence | Forgotten | Who changes it |
| --- | --- | --- | --- | --- |
| **Saved by you** (`explicit`) | The Memory tab's "Remember something" form, or **Keep** on another item | Always 100% | Never, unless you set a "Forget on" date | Only you: edit, switch off, forget |
| **Learned** (`learned`) | Repeated evidence of a pattern | `n / (n + 3)`, capped at 95% — 25% after one, 50% after three, 75% after nine | 90 days after the last new evidence | NIMBUS updates it; you can switch it off, keep or forget it |
| **Observed** (`observed`) | Something that happened once | Set by the recorder (0.9 for a new device) | 30 days after it was last seen | NIMBUS updates it; you can switch it off, keep or forget it |

Each tier is its own file, so a problem in one never costs the others, and
the user's own memories never share a file with what NIMBUS worked out.

**Nothing becomes permanent on its own.** A learned pattern or an
observation fades unless it keeps being reinforced; only **Keep** turns it
into a saved memory (100%, no expiry, no longer changed by NIMBUS).

**Switched off** items are kept but neither used nor updated — a pattern
you switched off stops learning, too.

## Each item

`id`, `kind` (preference / fact / pattern / history), `origin`, `key` (a
stable identity for things NIMBUS keeps up to date, such as
`activity:study`), `title`, `value` (text, a number, true/false, or one flat
set of those), `detail`, `source` (`user`, `activity`, `routines`,
`network`), `confidence`, `evidence` (times seen), `createdAt`,
`updatedAt`, `expiresAt`, `disabled`.

## What is recorded today

Deliberately little, and only by the app's wiring (`lifecycle.ts` calling
[recorders.ts](../src/memory/recorders.ts)) — no provider or service
writes to memory itself:

- **Recurring activities** (learned): every finished activity session of
  10 minutes or more — sessions, total time, and the hour it usually
  starts ("Study — usually around 20:00").
- **Routine answers** (learned): per routine, how many suggestions you
  accepted and dismissed. A popup that simply ran out is not an answer.
- **New network devices** (observed): each device the network watcher sees
  for the first time.

Not copied into memory, because they already have their own persistence:
network nicknames and "recognized", the frequent-apps tally, settings.

"Learn from what I do" (Memory tab; `userPreferences.memory.learning`) off
stops all recording. What is already remembered stays, and your own saved
memories work either way.

## Operations

`MemoryService`: `remember` (explicit), `reinforce` (learned), `observe`
(observed), `update` (explicit fields; `disabled` for any), `promote`
(Keep), `forget`, `get`, `list` (filter by kind, origin, source, text;
most trusted first), `recall(key)` (the most trusted enabled item for a
key) and `prune` (expiry, run on every read).

## Storage and damaged files

`memory/explicit.json`, `memory/learned.json`, `memory/observed.json`
under the data folder, each `{ "version": 1, "items": [...] }`, written
atomically (temp file, fsync, rename). On load every item is checked field
by field: a malformed one, or one found in the wrong tier's file, is
skipped and logged. A file that isn't JSON at all is renamed
`<tier>.unreadable-<time>.json` rather than overwritten. Tiers are capped
(1000 saved, 500 learned, 500 observed; the least recently updated
learned/observed items go first).

## Not yet

- Nothing reads memory back into decisions — Attention, the briefing and
  routines don't consult it yet. `recall()` is the intended way in.
- No sync between devices; memory lives on this PC.
- No chat or natural-language access, by design for now.
