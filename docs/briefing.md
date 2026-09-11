# The Briefing system

NIMBUS greets you and gives a concise summary instead of dumping raw
data. It is a small system on top of Context — `src/context` knows
nothing about briefings, and `src/briefing` knows nothing about IPC/UI.
It is **template-based, not AI-generated**: no LLM is involved.

- [src/briefing/types.ts](../src/briefing/types.ts) — the shape. A
  `Briefing` is `{ id, generatedAt, items: BriefingItem[] }`. Each
  `BriefingItem` has a `category` (`greeting` | `dateTime` | `weather` |
  `calendar` | `email` | `tasks` | `stocks` | `meals` | `other`), a `message`, a
  `timestamp`, an `importance` and a `relevance` score (0–100 each), and
  an optional `action`. **`meals` has no producer**, and **`action` is
  never set or handled** — both are reserved for later.
- [src/briefing/briefingGenerator.ts](../src/briefing/briefingGenerator.ts) —
  pure and synchronous: takes a `ContextSnapshot`, returns a `Briefing`.
  Each category has a builder that reads structured Context data and
  picks between deterministic phrasings; it returns `null` when that data
  isn't available, so **a missing or failed provider is simply omitted,
  never shown as an error**. Builders exist for greeting, date/time,
  weather, calendar, email, tasks and stocks, plus a fixed closing line.
  - The **calendar** line covers nothing scheduled, one or several events,
    all-day events and an imminent-event countdown, and names the day of
    an upcoming event ("today", "tomorrow", "on Saturday", or a date
    beyond a week).
  - The **email** line only escalates when something may need attention;
    a pile of newsletters reads the same as an empty inbox.
  - The **tasks** line spotlights an imminent task, otherwise combines
    overdue and due-today counts, naming a task where it helps.
  - The **stocks** line reads only the portfolio's per-currency totals:
    "Your portfolio is up 1.8% today.", or "…at the last close." when
    the prices are from an earlier session (see [stocks.md](stocks.md)).
- **Prioritization, not AI**: content items are sorted by
  `importance × relevance` and capped at 5, between the greeting (always
  first) and the closing "Anything I can help you with?" (always last).
  `relevance` depends on the data — rain makes weather more relevant, an
  imminent event makes calendar very relevant.
- [src/briefing/briefingService.ts](../src/briefing/briefingService.ts) —
  owns the lifecycle: `generate()` produces a new briefing and caches it;
  `getCurrent()` returns the last one **without ever triggering
  generation**. Concurrent `generate()` calls share one in-flight
  generation.

## When a briefing is generated

Exactly twice, never on a schedule:

1. **At startup**, from `app.on("ready")` in `src/main/lifecycle.ts` — not
   awaited, so a slow provider can't delay the window or tray. When it
   finishes, open windows get a payload-less `nimbus:briefing-updated`
   push and re-fetch with `nimbus:get-briefing`.
2. **On demand**, from the Home tab's **Regenerate** button
   (`nimbus:regenerate-briefing`).

If generation itself fails unexpectedly, the error is logged,
`getCurrent()` stays at the previous value (or `null`), and the rest of
the app is unaffected.

## Tests

`briefingGenerator.test.ts` covers ordering and ranking, every category's
message branches (weather, calendar including day naming, email, tasks),
omission of missing/errored data, and a fully empty snapshot still
producing `[greeting, closing]`. `briefingService.test.ts` covers caching,
`getCurrent()` never fetching, shared in-flight generation, and a
throwing provider not preventing a briefing.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
