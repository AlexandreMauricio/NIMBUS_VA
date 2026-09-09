# The Action system

The [Context system](context-system.md) is NIMBUS *observing*. This is where NIMBUS
starts being able to *do* something — the foundation for that distinction
is [src/actions/](../src/actions/), a new system deliberately kept separate
from Context rather than bolted onto it:

- **Context** answers "what is happening?" — read-only, safe to fetch
  freely, and every provider's `getContext()` never changes anything
  outside NIMBUS.
- **Action** answers "do something." — may change external state (skip a
  song, eventually: send an email, lock the PC), and always returns a
  structured result instead of a value to read.

[src/actions/types.ts](../src/actions/types.ts) defines the contract, mirroring
`ContextProvider`/`ContextProviderResult` in shape and spirit:

- `ActionDefinition` — static, inspectable metadata about one action: id
  (namespaced by provider, e.g. `"spotify.play"`), name, description, a
  parameter schema, and four safety flags — `readOnly`,
  `changesExternalState`, `requiresConfirmation`, `affectsService`. This
  is what a future permission system or confirmation UI would read
  *before* calling the action — seeded now with the "harmless things don't
  need confirmation, an eventually-added destructive action would set
  `requiresConfirmation: true`" reasoning the task called for, but nothing
  in `ActionService` reads or enforces `requiresConfirmation` yet (see
  "known limitations" below).
- `ActionResult` — what every action returns regardless of provider:
  `status` ("success" | "failure"), optional `data`/`message` on success,
  a structured `error` (a coarse `category` plus a user-safe `message`,
  never a raw API error) on failure, and timing (`startedAt`/
  `finishedAt`/`durationMs`). The UI never needs to understand a
  provider's own API response shape — see "Action results" below.
- `ActionProvider` — the interface every action provider implements:
  `listActions()`, `isAvailable()`, `validate(actionId, params)`,
  `execute(actionId, params)`. A provider owns every action under its own
  id prefix (`"spotify.*"` today).
- [ActionService](../src/actions/actionService.ts) — the Action-system
  analogue of `ContextService`. Aggregates registered providers and is the
  single entry point (`executeAction(actionId, params)`): resolves the
  owning provider from the id prefix, checks `isAvailable()`, validates
  params, executes, and — critically — **never lets a provider's
  exception propagate**. A provider throwing, rejecting, or reporting
  itself unavailable always degrades to a structured `ActionResult`
  (`status: "failure"`, a coarse `error.category`), the same
  failure-isolation guarantee `ContextService` already makes for Context
  providers. Also keeps a small in-memory ring buffer (last 50 results,
  most recent first) via `getHistory()` — a lightweight foundation for
  "what did I just ask you to do?", not a full audit log/UI.
- `src/actions/index.ts` exports the application's single `actionService`
  instance — like `contextService`, no providers are pre-registered there
  (Spotify needs live settings/auth), so registration happens in
  `src/main/lifecycle.ts`.

## Action safety, today vs. later

The task was explicit that this establishes a *foundation*, not a full
permission system: `ActionDefinition` carries accurate
`changesExternalState`/`requiresConfirmation` metadata (every Spotify
action today is `changesExternalState: true`, `requiresConfirmation:
false` — playing/pausing/skipping is harmless and easy to undo), and a
caller (the future Intelligence layer, or a confirmation UI) is expected
to read that metadata before calling `executeAction`. `ActionService`
itself does not check `requiresConfirmation` or gate on any permission —
building that enforcement is explicitly future work; what exists now is
the shape it would read.

## Tests

`actionService.test.ts`: a valid/available action succeeds; an unknown
action id fails with `not_available`; an unavailable provider fails
without ever calling `execute`; invalid parameters fail validation
without ever calling `execute`; a provider's own structured failure
passes through unchanged; a provider throwing from `execute()` or
`isAvailable()` degrades to a structured failure instead of propagating;
`listActions()` surfaces each provider's permission/confirmation
metadata; `getHistory()` records executed actions most-recent-first;
registering two providers with the same id throws. No real service is
involved — a hand-built stub `ActionProvider` exercises `ActionService`
in isolation.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
