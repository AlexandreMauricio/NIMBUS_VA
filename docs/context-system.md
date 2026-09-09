# The Context system

NIMBUS's first real capability: a way to ask "what is the current
context?" and get back structured, self-describing data — the
information layer the future intelligence layer will eventually reason
over. No AI/LLM is involved at this layer; it's plumbing.

- [src/context/types.ts](../src/context/types.ts) — the contract.
  `ContextProvider` is deliberately tiny: `id`, `displayName`,
  `isAvailable()`, `getContext()`. `ContextProviderResult` is what every
  provider call resolves to, win or lose — `status` (`ok` / `error` /
  `unavailable`), `data`, an optional `error` message, a `timestamp`, and
  a `stale` flag.
- [src/context/contextService.ts](../src/context/contextService.ts) — the
  aggregator. `ContextService.register(provider)` adds a provider;
  `getSnapshot()` queries all of them concurrently and returns one
  `ContextSnapshot` (`{ generatedAt, providers: { [id]: result } }`).
- [src/context/providers/](../src/context/providers/) — the implementations
  shipped so far: `DateTimeProvider` (date, time, IANA timezone, day of
  week — clock is injectable for deterministic tests), `SystemInfoProvider`
  (platform, OS release, CPU count, memory, uptime; read-only, nothing
  leaves the machine), and `WeatherProvider` (see below).
- [src/context/index.ts](../src/context/index.ts) — the single
  `contextService` instance the app uses, pre-registered with the
  providers that don't need runtime settings (`DateTimeProvider`,
  `SystemInfoProvider`). `WeatherProvider` is registered separately, in
  `src/main/lifecycle.ts`, because it needs live settings access — see
  below. A future *settings-independent* provider (news, system status,
  ...) is a new file under `providers/` plus one `.register(...)` call in
  `context/index.ts`; one that needs live settings follows the weather
  pattern instead.

**Failure isolation is the load-bearing design constraint.** `collect()`
inside `ContextService` wraps every `isAvailable()`/`getContext()` call so
a provider can never throw past the service boundary:

- `isAvailable()` returning `false` (or throwing) → `status: "unavailable"`,
  `getContext()` is never called.
- `getContext()` throwing/rejecting → logged via `logger.error`, and the
  result falls back to the **last known-good data** for that provider if
  one exists, marked `stale: true`; otherwise `data: null` with the error
  message attached.
- One provider failing never affects another's result — each is collected
  independently and the snapshot is assembled from whatever each returned.

This is why "if WeatherProvider eventually fails, NIMBUS should still
function normally" holds: a failing provider degrades to a structured
error entry in the snapshot, not an exception that propagates.

The main process exposes this via `nimbus:get-context`
(`src/main/lifecycle.ts`) → `window.nimbus.getContext()`
(`src/preload/preload.ts`) → the **Context** tab in the UI, which just
renders whatever `ContextSnapshot` it's handed (status badges, a "stale"
badge when relevant, and the provider's fields) — it doesn't know how any
of that data was produced.

## Tests

```bash
npm test
```

Compiles the project and runs `src/context/**/*.test.ts` (compiled to
`dist/context/**/*.test.js`) under Node's built-in test runner (`node:test`
— no test framework dependency added). Coverage: `ContextService`
aggregation, error/unavailable/stale handling, isolation between
providers, duplicate-id registration, plus `DateTimeProvider` (fixed-clock
date/time/day-of-week correctness) and `SystemInfoProvider` (plausible
system values).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
