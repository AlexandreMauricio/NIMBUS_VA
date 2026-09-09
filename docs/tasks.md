# Tasks

The fourth external context provider —
[src/context/providers/tasks/](../src/context/providers/tasks/) — following
the same adapter pattern as weather, calendar, and email: `TaskProvider`
implements `ContextProvider<TaskContext>` for the morning briefing, with
the actual Todoist REST API code isolated behind a small source class.
NIMBUS also has a full **Tasks tab** (its own sidebar entry, mirroring
the Routines tab's list/grid/create-edit pattern) for actually managing
tasks — list/grid view, sorting, and creating/editing/completing/
deleting — see "The Tasks tab" below. Everything written there goes
straight to Todoist; NIMBUS keeps no separate copy of a task.

- **Integration chosen**: [Todoist](https://todoist.com)'s unified API v1
  (`api.todoist.com/api/v1` — Todoist retired the old `/rest/v2` API,
  which now returns `410 Gone`; see `todoistTaskSource.ts`'s pagination
  handling for the other consequence of that migration: v1 list
  endpoints return a paginated `{ results, next_cursor }` envelope
  instead of a plain array), authenticated with a personal API token
  (Settings > Integrations > Developer in Todoist) — the same reasoning
  as Calendar's ICS URL and
  Email's IMAP app password: no OAuth app registration needed, since the
  user generates the credential themselves. Todoist was picked over
  building a CalDAV/VTODO source (the other no-OAuth option, mirroring
  Calendar's approach) because it's a plain JSON REST API with clean due
  date/priority/project fields, keeping the source module small and easy
  to test against a fake `fetch`. The token is sent only as a `Bearer`
  auth header ([todoistTaskSource.ts](../src/context/providers/tasks/todoistTaskSource.ts)),
  stored only in the local `settings.json`, never logged (log calls only
  ever include an account's `label`/`id`, see `taskProvider.ts`), and —
  like the email password, unlike the calendar URL — **never sent back to
  the renderer at all**: the Settings API returns `hasApiToken: boolean`
  instead of the value itself, using the exact same write-only merge
  pattern as `nimbus:update-email-settings` (see
  `nimbus:get-task-settings`/`nimbus:update-task-settings` in
  `lifecycle.ts`).
- **Multi-device/OAuth boundary**: `TaskProvider` depends only on
  `TodoistTaskSource.fetchActiveTasks()` — see
  [todoistTaskSource.ts](../src/context/providers/tasks/todoistTaskSource.ts).
  A future second connector (a different task app, a local list, a
  CalDAV/VTODO source) implements the same method and plugs in without
  `TaskProvider`, `ContextService`, the briefing, or the UI changing —
  the account shape already carries a `provider` field for exactly this,
  even though only `"todoist"` exists today.
- **Data model** ([types.ts](../src/context/providers/tasks/types.ts)):
  `TaskItem` carries id, title, an optional description, an optional due
  date/time (with a `dueIsDateOnly` flag distinguishing an all-day due
  date from a specific time), completed state, an explicit `priority`
  (the source app's own marking, when available), a `reminderAt`, the
  originating `source`/`listName`, timestamps, and both a computed
  `category` (`overdue` / `dueToday` / `upcoming` / `noDeadline`) and a
  computed `urgency` tier with its raw `signals` — see "Relevance" below.
  `TaskAccountInfo` (id/label/provider only, never a token) keeps account
  identity separate from tasks, the same way `EmailAccountInfo` does;
  each `TaskItem.id` is namespaced as `${accountId}:${rawId}` so two
  accounts' ids never collide.
- **Completed tasks are never surfaced**: Todoist's REST API simply
  doesn't return completed tasks from its `/tasks` endpoint, which
  already satisfies "don't normally show completed tasks" at the source
  level rather than needing a filter after the fact — `TaskProvider`
  still filters defensively (`buildContext` drops any `completed: true`
  item from every bucket), so a future source that *does* return
  completed tasks stays correct too.
- **Reminders**: Todoist's REST API has no separate "reminder" concept
  without its separate Sync API (a premium feature at that), so
  `reminderAt` is populated from a task's own specific due *time* when it
  has one — the closest honest equivalent available without a second API
  surface. This is intentionally just data exposure (per the task's own
  scope): the architecture is ready for NIMBUS to eventually say
  "Reminder: you wanted to call John" or "you have a reminder in 20
  minutes," but no autonomous notification/heartbeat system is built
  here — that's a separate future feature.
- **Timezone correctness**: category bucketing (`overdue`/`dueToday`/
  `upcoming`) is computed by comparing each task's due date, converted to
  the user's actual local calendar date via
  [icsTimeUtils.localCalendarDate](../src/context/providers/calendar/icsTimeUtils.ts)
  (the same timezone-aware helper Calendar uses — reused rather than
  duplicated), against "today" in that same zone — never a raw UTC date
  comparison.
- **Deterministic urgency** ([taskRelevance.ts](../src/context/providers/tasks/taskRelevance.ts)) —
  **no LLM/AI anywhere in this feature**. A small point-based scorer
  (overdue, due today, due within 2 hours, the source's own high-priority
  marking, an approaching reminder, and a small "still open after 2+
  weeks" staleness nudge) maps to `low`/`normal`/`important`/`high`,
  weighted so that an overdue task and a task due very soon each reach
  `high` on their own — matching the task's own examples ("an overdue
  task should have high relevance," "a task due in 30 minutes should have
  very high relevance") without needing another signal stacked on top.
  Every task keeps its raw `signals`, so the reasoning behind a tier is
  inspectable by a future Intelligence layer, not just a bare verdict.
- **Settings** (`UserPreferences.tasks` in `settingsManager.ts`): a master
  `enabled` switch (off by default) and an `accounts` list, each with
  `id`/`label`/`provider`/`enabled` plus a locally-stored `apiToken` —
  supporting multiple accounts the same way Calendar/Email support
  multiple feeds/mailboxes. Managed from the **Tasks** section of the
  Settings tab; also settable via `NIMBUS_TASKS_TODOIST_TOKEN`/
  `NIMBUS_TASKS_LABEL` in `.env` as a headless/dev default (only used
  when enabled but no account has been saved yet).
- **Caching**: a 5-minute default via the same
  [TtlCache](../src/common/ttlCache.ts) weather/calendar/email use, dropping
  to 1 minute once some task's due time is within the 2-hour "imminent"
  window — the same proximity-based TTL-shrink idea as Calendar's, just
  with different thresholds. Still simple polling (no push/webhook), but
  the data model (per-task `category`/`urgency`, `retrievedAt`) already
  carries what a future incremental-refresh/heartbeat system would need.
- **Relevance**: the briefing never just reports a raw task count without
  regard for what actually matters. A task due imminently is spotlighted
  by itself regardless of how many other tasks exist; otherwise overdue
  and due-today counts are combined into one message, and a single named
  task is called out when there's exactly one or when highlighting the
  first of several — see "Briefing behavior" in `briefingGenerator.ts`'s
  `buildTasksItem`.
- **Failure behavior**: like Calendar/Email, `isAvailable()` treats "not
  enabled" or "no account configured" as `status: "unavailable"`, not an
  error. Each enabled account is fetched independently
  (`Promise.allSettled`): one bad account (invalid token, Todoist down,
  rate limiting) is logged — account label/id and error message only,
  **never the API token** — and skipped without affecting the others;
  only if *every* account fails does the provider throw, which
  `ContextService` turns into the standard error/stale-fallback result.
  Confirmed live: a fake API token produces `[WARN] Task account "..."
  failed` in the log with no credential in it, `status: "error"` on the
  Context tab, and a briefing that still generates normally (weather/
  calendar/dateTime intact) with the task item simply omitted.

## The Tasks tab

Its own sidebar entry, not nested inside Settings — same reasoning as
the Routines tab getting one: a growing task list shouldn't crowd
Settings into a control panel. Mirrors the Routines tab's own
list/grid-toggle and one-form-for-create-and-edit pattern, applied to a
completely unrelated concept (no code is shared beyond that shape).

- **List/grid view** (remembered per-browser via `localStorage`, same as
  Routines') and a **sort** dropdown (due date / priority / title /
  recently added) — all client-side over whatever `nimbus:list-tasks`
  returns, so switching sort order never re-fetches.
- **This is the full active task list**, not the briefing's
  bucketed-and-capped-at-20-per-category view — `TaskProvider.listAllTasks()`
  is a separate method from `getContext()` precisely because a management
  view and a briefing summary have different shapes and different
  freshness needs (this always re-fetches; the briefing stays cached).
- **Create/edit** form: title, optional description, optional due date
  (a plain date — no natural-language recurrence parsing, matching the
  "don't over-engineer" scope elsewhere in this app), priority
  (none/low/medium/high — NIMBUS's own read-side labels, translated to
  Todoist's numeric scale on write so the form and the task cards speak
  the same vocabulary instead of exposing Todoist's own P1-P4 UI
  inversion), and an optional project/list (fetched live from Todoist via
  `nimbus:list-task-projects`).
- **Complete** is a checkbox on each card — Todoist's `/tasks` endpoint
  never returns completed tasks at all, so a completed task simply
  disappears from the list on the next refresh rather than needing a
  "show completed" toggle anywhere.
- **Delete asks for confirmation** (a plain `confirm()` — this is the one
  genuinely irreversible action in the tab) before calling through.
- **Write endpoints**: `POST /tasks` (create), `POST /tasks/{id}` (update
  — only the fields actually changed are sent, so an edit never silently
  clears an untouched field), `POST /tasks/{id}/close` /
  `POST /tasks/{id}/reopen`, `DELETE /tasks/{id}` — all in
  [todoistTaskSource.ts](../src/context/providers/tasks/todoistTaskSource.ts),
  same Bearer-token auth as every read.
- **Multi-account note**: `TaskProvider.createTask` writes to the first
  configured account (most setups have exactly one); `updateTask`/
  `completeTask`/`reopenTask`/`deleteTask` resolve the right account from
  a task's own namespaced id (`${accountId}:${rawId}`) instead, so those
  four already work correctly across multiple accounts even without a
  picker in the create form.

## Tests

`taskRelevance.test.ts` (every scoring branch: no signals → low, a
completed task always low regardless of other signals, overdue alone →
high, due-today alone → normal-or-higher, the imminent-window boundary at
exactly 120/121 minutes, overdue+due-today+high-priority combined → high,
explicit priority/reminder-approaching/staleness signals each reflected
and nudging urgency up, signals always present on the result),
`todoistTaskSource.test.ts` (empty results, a task with a specific due
time mapped with a matching reminder, a date-only due date mapped with no
reminder, no due field at all, a missing `content` field defaulting to a
placeholder title, a task in an unknown project getting a null list name,
a failed projects request still letting tasks through, a non-ok tasks
response throwing descriptively, the token sent only as a `Bearer`
header — never a query parameter or body — and malformed/sparse task
objects not crashing the mapper), `taskProvider.test.ts` (availability
with 0/1 accounts enabled, no tasks, completed tasks excluded from every
bucket and from the active total, a task with no due date bucketed as
`noDeadline`, multiple tasks correctly bucketed across all four
categories, overdue vs. due-today vs. tomorrow-is-upcoming boundary
correctness, a far-future task at low urgency, a reminder carried through
to context, an explicit high priority mapped and reflected in signals, a
due-soon task reaching high urgency, malformed/sparse data not crashing
the provider, an auth failure on the only account rejecting
`getContext()`, one account failing without blocking another, all
accounts failing rejecting, cache hit within TTL, multiple accounts
merged with distinct namespaced task ids, account identity never
including the API token, timezone-aware bucketing using the resolved
local zone, and the env-fallback account used only when no account is
saved), `taskProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider`/`EmailProvider` alongside a deliberately broken
`TaskProvider` — proves tasks failing produces a valid `Briefing` with
every other item intact and the tasks item cleanly omitted), and
task-specific cases in `briefingGenerator.test.ts` (no active tasks,
multiple/single tasks due today with and without naming one, singular/
plural overdue phrasing, the overdue-and-due-today mixed message matched
exactly to the task's own example, an imminent task spotlighted with a
time estimate and taking priority over the count messages, a date-only
(all-day) task never treated as imminent, omission on missing/
unavailable/errored task data, and priority ranking against other
categories). All Todoist API calls are mocked via a fake `fetch` — no
test reaches the real Todoist API or needs a real account. 62 new tests,
alongside the 150 pre-existing ones (212 total via `npm test`).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
