# Services

Placeholder for future NIMBUS capabilities that are broader than a single
piece of structured data — AI/LLM, voice recognition, text-to-speech,
web browsing, etc. None of those exist yet. (Two that were once listed
here were built elsewhere: memory is `src/memory/`, and desktop
automation is the Action system's `app.*`/`files.*`/`media.*` providers
in `src/actions/`.)

**This is distinct from `src/context/providers/`.** Weather turned out to
be the first concrete example of the pattern this project actually uses
for "information sources": a `ContextProvider` under
`src/context/providers/weather/`, registered with `ContextService`, so
its data flows through the same `getContext()`/briefing pipeline as
everything else — see [ARCHITECTURE.md](../../ARCHITECTURE.md). Anything
that is fundamentally "here is a structured fact about the user's
situation" (email summaries, calendar events, task lists, meals, system
status, ...) almost certainly belongs there, following the weather
provider as a template, not here.

`services/` is for things that don't fit that shape — a capability that
_acts_ rather than _reports_ (e.g. a future automation engine, an LLM
service that drafts responses), or that doesn't map onto "one snapshot's
worth of data" at all. If and when something like that is built, per the
architecture doc:

- If it's platform-independent logic (Core), it lives here and is
  imported by whichever client(s) need it — no Electron/Windows
  dependency, importable from a future Android/web client too.
- If it's inherently Windows-specific (e.g. driving another desktop app),
  it belongs under `src/main/` instead, not here.

Nothing in this directory should be imported by `src/ui` directly.
