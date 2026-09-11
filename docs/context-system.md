# The Context system

A way to ask "what is the current context?" and get back structured,
self-describing data — the information layer everything else reads. No
AI/LLM is involved at this layer.

- [src/context/types.ts](../src/context/types.ts) — the contract.
  `ContextProvider` is deliberately tiny: `id`, `displayName`,
  `isAvailable()`, `getContext()`. `ContextProviderResult` is what every
  provider call resolves to, win or lose — `status` (`ok` / `error` /
  `unavailable`), `data`, an optional `error` message, a `timestamp`, and
  a `stale` flag.
- [src/context/contextService.ts](../src/context/contextService.ts) — the
  aggregator. `register(provider)` adds a provider; `getSnapshot()`
  queries all of them concurrently and returns one `ContextSnapshot`
  (`{ generatedAt, providers: { [id]: result } }`).
- [src/context/providers/](../src/context/providers/) — the providers:

  | Provider | Data | Registered in |
  | --- | --- | --- |
  | `DateTimeProvider` | Date, time, IANA timezone, day of week | `src/context/index.ts` |
  | `SystemInfoProvider` | Platform, OS release, CPU count, memory, uptime | `src/context/index.ts` |
  | `WeatherProvider` | Current conditions and a short forecast ([weather.md](weather.md)) | `src/main/lifecycle.ts` |
  | `CalendarProvider` | Today's and the next 7 days' events ([calendar.md](calendar.md)) | `src/main/lifecycle.ts` |
  | `EmailProvider` | Recent message metadata and importance ([email.md](email.md)) | `src/main/lifecycle.ts` |
  | `TaskProvider` | Active tasks bucketed by deadline ([tasks.md](tasks.md)) | `src/main/lifecycle.ts` |
  | `SpotifyContextProvider` | What's playing ([spotify.md](spotify.md)) | `src/main/lifecycle.ts` |
  | `StockProvider` | Tracked positions, estimates and per-currency totals ([stocks.md](stocks.md)) | `src/main/lifecycle.ts` |

  Providers that need no runtime settings are registered in
  `context/index.ts`; the ones that read live settings are registered in
  `lifecycle.ts`, where the settings object exists.

**Failure isolation is the load-bearing design constraint.**
`ContextService` wraps every `isAvailable()`/`getContext()` call so a
provider can never throw past the service boundary:

- `isAvailable()` returning `false` (or throwing) → `status: "unavailable"`,
  and `getContext()` is never called.
- `getContext()` throwing/rejecting → logged, and the result falls back to
  the **last known-good data** for that provider if one exists, marked
  `stale: true`; otherwise `data: null` with the error message attached.
- Both calls are **time-bounded** (30 seconds by default, see
  `src/common/timeout.ts`), so a provider that never settles degrades to
  the same result as one that throws instead of hanging the snapshot.
- One provider failing never affects another's result.

## Who reads it

- The **briefing** (see [briefing.md](briefing.md)).
- The **Context** tab, via `nimbus:get-context`, which renders whatever
  snapshot it is handed (status badges, a "stale" badge, the fields). It
  refreshes on load and on its Refresh button only.
- The **Calendar** tab, the Home **now-playing** card and the current
  activity card read the relevant provider's result out of the same
  snapshot.
- The **Routine engine** reads Spotify's playback state for the
  `spotifyNotAlreadyPlaying` and "skip if already active" conditions.

## Context events

Distinct from providers: a provider answers "what is the state?" when
asked, while a **Context event** is pushed the moment something changes.
Events travel on the in-process `ContextEventBus`
([src/events/](../src/events/)) and feed Activities and Routines.

| Event | Emitted by |
| --- | --- |
| `applicationOpened`, `applicationClosed`, `websiteOpened`, `folderOpened` | The desktop activity monitor (`src/main/activity/`) |
| `timerCompleted` | `TimerService`, at the end of every timer phase |
| `activityEnded` | `ActivityService`, when an activity session ends |

`playbackChanged`, `calendarEventApproaching` and `emailReceived` are
reserved in `ContextEventType` for future producers; nothing emits them
today, and they are not part of the `ContextEvent` union yet.

## Tests

`npm test` compiles the project and runs every `dist/**/*.test.js` under
Node's built-in test runner (`node:test`). For this system:
`contextService.test.ts` (aggregation, error/unavailable/stale handling,
isolation between providers, timeouts, duplicate-id registration),
`dateTimeProvider.test.ts`, `systemInfoProvider.test.ts`, and each
provider's own tests described in its guide.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
