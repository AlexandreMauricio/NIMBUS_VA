# The Action system

The [Context system](context-system.md) is NIMBUS *observing*.
[src/actions/](../src/actions/) is where it *does* something — a system
deliberately kept separate from Context rather than bolted onto it:

- **Context** answers "what is happening?" — read-only; a provider's
  `getContext()` never changes anything outside NIMBUS.
- **Action** answers "do something." — may change external state, and
  always returns a structured result instead of a value to read.

[src/actions/types.ts](../src/actions/types.ts) defines the contract:

- `ActionDefinition` — static, inspectable metadata about one action: id
  (namespaced by provider, e.g. `"spotify.play"`), name, description, a
  parameter schema, and four safety flags — `readOnly`,
  `changesExternalState`, `requiresConfirmation`, `affectsService`.
- `ActionResult` — what every action returns regardless of provider:
  `status` (`"success"` | `"failure"`), optional `data`/`message` on
  success, a structured `error` (a coarse `category` plus a user-safe
  `message`, never a raw API error) on failure, and timing
  (`startedAt`/`finishedAt`/`durationMs`).
- `ActionProvider` — the interface every provider implements:
  `listActions()`, `isAvailable()`, `validate(actionId, params)`,
  `execute(actionId, params)`.
- [ActionService](../src/actions/actionService.ts) — the single entry
  point, `executeAction(actionId, params)`: resolves the owning provider
  from the id prefix, checks `isAvailable()`, validates params, executes,
  and **never lets a provider's exception propagate** — throwing,
  rejecting, reporting unavailable, or **hanging** (both `isAvailable()`
  and `execute()` are bounded by a 30-second timeout) always degrades to a
  `status: "failure"` result. It keeps the last 50 results in memory
  (`getHistory()`) and logs each execution's id, status and duration only.
- `src/actions/index.ts` exports the single `actionService` instance;
  providers are registered in `src/main/lifecycle.ts`.

## Registered actions

| Provider | Actions |
| --- | --- |
| `SpotifyActionProvider` | `spotify.play`, `spotify.pause`, `spotify.next`, `spotify.previous`, `spotify.setVolume`, `spotify.playSearch`, `spotify.playPlaylist` — see [spotify.md](spotify.md) |
| `TimerActionProvider` | `timer.start` (a single countdown or a Pomodoro plan), `timer.stop` (stops the timer and the rest of its plan; succeeds quietly when nothing is running), `timer.addStudy` (adds studies to the running plan) — see [routines.md](routines.md#timers) |
| `SystemActionProvider` | `system.openUrl` — opens an `http://`/`https://` URL in the default browser; any other scheme is rejected by `validate()` |

## Who calls it

- The renderer, through the generic `nimbus:execute-action` IPC channel —
  a new provider needs no new IPC handler.
- The Routine engine, when a suggestion is accepted, a routine runs
  automatically or on demand (**Run now**), or a wind-down runs.
- The timer popup's **+ Study** button, through `nimbus:timer-add-study`,
  which runs `timer.addStudy`.

After any action runs, `onActionExecuted` in `lifecycle.ts` refreshes the
Spotify now-playing state for `spotify.*` actions and opens the timer
popup when `timer.start` succeeds.

## Action safety, today vs. later

`ActionDefinition` carries accurate metadata (every registered action is
`changesExternalState: true`, `requiresConfirmation: false`), but
**`ActionService` does not read or enforce `requiresConfirmation` or any
permission**. The only safety gates today are id and parameter
validation, and the Routine system's "suggest first" flow. Enforcement is
future work.

## Tests

`actionService.test.ts` (success, unknown id, unavailable provider,
invalid parameters, a provider's own failure passed through, throwing and
hanging providers degrading to structured failures, metadata surfaced by
`listActions()`, history ordering, duplicate registration) plus
`spotifyActionProvider.test.ts`, `timerActionProvider.test.ts` and
`systemActionProvider.test.ts`. No real service is involved.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
