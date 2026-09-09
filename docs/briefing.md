# The Briefing system

NIMBUS's first recognizable assistant behavior: it greets you and gives a
concise summary, instead of dumping raw data. This is built as a small,
separate system on top of Context — `src/context` still knows nothing
about briefings, and `src/briefing` knows nothing about IPC/UI.

- [src/briefing/types.ts](../src/briefing/types.ts) — the shape. A
  `Briefing` is just `{ id, generatedAt, items: BriefingItem[] }`. Each
  `BriefingItem` has a `category` (`greeting` | `dateTime` | `weather` |
  `calendar` | `email` | `tasks` | `meals` | `other` — `email`/`tasks`/
  `meals` have no producer yet, and that's fine, see below), a
  `message`, a `timestamp`, an `importance` and `relevance` score
  (0–100 each), and an optional `action`. **The exact wording is never
  one hard-coded paragraph** — each category has its own small message
  builder that reads structured Context data, e.g. the weather line is
  assembled from `todayLowC`/`todayHighC`/`condition`/
  `precipitationProbabilityPercent`, and the calendar line picks between
  five deterministic phrasings ("nothing scheduled" / one event / several
  events / all-day / an imminent-event countdown) based on
  `CalendarContext`, never a fixed string.
- [src/briefing/briefingGenerator.ts](../src/briefing/briefingGenerator.ts) —
  pure and synchronous: takes a `ContextSnapshot`, returns a `Briefing`.
  No Electron/IPC dependency, so it's plain unit-testable. For each
  category it has a `buildXItem(data)` function that returns `null` when
  that data isn't available — **a provider that doesn't exist (or that
  errored) is simply omitted, never shown as an error**. Provider
  failures are already visible on the Context tab; the briefing stays a
  calm summary, not a status dashboard.
- **Prioritization foundation, not AI**: content items (currently
  `dateTime`, `weather`, and `calendar`) are sorted by
  `importance × relevance` and capped at 5 (`MAX_CONTENT_ITEMS`) before
  the fixed greeting (always first) and a closing "Anything I can help
  you with?" item (always last) are added. `relevance` can depend on the
  actual data — the weather item scores higher when rain is likely; the
  calendar item scores low with nothing scheduled, higher with several
  events today, and very high once the next event is imminent (within 45
  minutes), regardless of how many events exist overall. That's the
  entire "smart" part today: a plain sort with real signal behind the
  numbers. A future system could re-rank without changing
  `BriefingItem`'s shape.
- [src/briefing/briefingService.ts](../src/briefing/briefingService.ts) —
  owns the **lifecycle**: `generate()` produces a new briefing (fetches
  context, runs the generator, caches the result); `getCurrent()` returns
  whatever was last generated **without ever triggering generation**.
  Concurrent `generate()` calls share one in-flight generation instead of
  racing multiple context fetches. This is what guarantees a UI reload
  (or several windows) doesn't produce a new briefing, or a new weather
  API call, every time something asks.

## Startup wiring

In `src/main/lifecycle.ts`, `app.on("ready", ...)`: providers are already
registered → `generateBriefing()` is called (not awaited, so a slow
weather fetch can't delay the window/tray appearing) → it calls
`briefingService.generate()`, which pulls the context snapshot and runs
the generator → on success, every open window is notified over
`nimbus:briefing-updated` (a plain "go re-fetch" signal, no payload). The
renderer's `getBriefing()` (`nimbus:get-briefing`, pull-only) is called
once on load and again on that push — so a window that was already open
before generation finished still picks up the result, without polling.
An explicit **Regenerate** button on the Home tab calls
`nimbus:regenerate-briefing`, which is the only other thing that produces
a new briefing.

If generation itself fails unexpectedly (not just a provider — verified
by temporarily forcing `BriefingGenerator.generate()` to throw), the
`try/catch` around it in `lifecycle.ts` logs the error and leaves
`getCurrent()` at `null`; the UI shows "Preparing your briefing…" and
the rest of the app (Context tab, all providers) is completely
unaffected — confirmed live, not just by reasoning about the code.

## Tests

`briefingGenerator.test.ts`: normal snapshot (greeting → weather →
dateTime → closing, weather ranked first because its priority score is
higher), rain shifting weather above dateTime, a missing/errored weather
provider being omitted (not shown as an error), a fully empty snapshot
still producing a graceful `[greeting, closing]` result with no
error-shaped text anywhere, and id/timestamp sanity. `briefingService.test.ts`:
`getCurrent()` starts `null`, generation caches its result, `getCurrent()`
never triggers a fetch, concurrent `generate()` calls share one in-flight
promise, a throwing provider doesn't prevent a briefing from being
produced, and a second explicit `generate()` produces a new id.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
