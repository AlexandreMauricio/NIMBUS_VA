# Tasks

An external context provider —
[src/context/providers/tasks/](../src/context/providers/tasks/) —
following the same adapter pattern as weather, calendar and email:
`TaskProvider` implements `ContextProvider<TaskContext>` for the briefing,
with the Todoist API code isolated behind a small source class. NIMBUS
also has a **Tasks tab** for managing tasks — list/grid, sorting, and
create/edit/complete/delete — see "The Tasks tab" below. Everything
written there goes straight to Todoist; NIMBUS keeps no copy of a task.

- **Integration**: [Todoist](https://todoist.com)'s unified API v1
  (`api.todoist.com/api/v1`; list endpoints are paginated with
  `{ results, next_cursor }`, followed for up to 20 pages), authenticated
  with a personal API token (Todoist → Settings → Integrations →
  Developer). No OAuth app registration is needed. Every request has a
  10-second timeout.
- **Token handling**: sent only as a `Bearer` header; encrypted at rest in
  `secrets.json` (Windows DPAPI via `safeStorage`), never in
  `settings.json`; never logged; and **never sent to the renderer** — the
  Settings API returns `hasApiToken: boolean` and replaces the token only
  when a `newApiToken` is submitted (see
  `nimbus:get-task-settings`/`nimbus:update-task-settings`). A token that
  fails to decrypt is kept as stored rather than erased.
- **Multi-device/OAuth boundary**: `TaskProvider` depends only on
  `TodoistTaskSource`. The account shape carries a `provider` field for a
  future second connector, though only `"todoist"` exists.
- **Data model** ([types.ts](../src/context/providers/tasks/types.ts)):
  `TaskItem` carries id (namespaced `${accountId}:${rawId}`), title,
  description, due date/time (with `dueIsDateOnly`), completed state,
  `priority`, `reminderAt`, `source`/`listName`, timestamps, a computed
  `category` (`overdue` / `dueToday` / `upcoming` / `noDeadline`) and a
  computed `urgency` with its `signals`.
- **Completed tasks are never shown**: Todoist's `/tasks` endpoint doesn't
  return them, and `TaskProvider` filters defensively as well.
- **Reminders**: there is no separate reminder concept without Todoist's
  Sync API, so `reminderAt` is simply a task's specific due time. No
  notification is ever raised from it.
- **Timezones**: categories compare each due date, converted to your
  local calendar date, against "today" in the same zone.
- **Deterministic urgency** ([taskRelevance.ts](../src/context/providers/tasks/taskRelevance.ts)) —
  **no LLM**. A point scorer (overdue, due today, due within 2 hours,
  high source priority, an approaching reminder, a small staleness nudge)
  maps to `low`/`normal`/`important`/`high`.
- **Settings** (`UserPreferences.tasks`): a master `enabled` switch (off by
  default) and an `accounts` list (`id`/`label`/`provider`/`enabled`; the
  token lives in the encrypted store). Managed in Settings → Tasks; a
  default account can come from `NIMBUS_TASKS_TODOIST_TOKEN` /
  `NIMBUS_TASKS_LABEL` in `.env` (used only when enabled and no account is
  saved).
- **Caching** (briefing only): 5 minutes, dropping to 1 minute when a task
  is due within 2 hours. The Tasks tab always re-fetches.
- **Failure behavior**: "not enabled" or "no account" is `status:
  "unavailable"`. Accounts are fetched independently; a failing one is
  logged (label/id only) and skipped, and only if every account fails
  does the provider throw.

## The Tasks tab

- **List/grid view** (remembered in `localStorage`) and a **sort**
  dropdown (due date / priority / title / recently added), applied
  client-side.
- **The full active task list**, from `TaskProvider.listAllTasks()` — not
  the briefing's bucketed, capped view.
- **Create/edit** form: title (required), description, due date (a plain
  date), priority (none/low/medium/high, translated to Todoist's numeric
  scale on write), and a project (loaded from Todoist).
- **Complete** is a checkbox on each card; the task disappears on the next
  refresh.
- **Delete** takes two clicks: the first arms the button ("Click again to
  delete"), the second deletes, and it disarms after 4 seconds.
- **Errors show inline** (a failed save, complete or delete) — never as a
  native dialog.
- **Write endpoints**: `POST /tasks`, `POST /tasks/{id}` (only changed
  fields are sent), `POST /tasks/{id}/close`, `POST /tasks/{id}/reopen`,
  `DELETE /tasks/{id}`.
- **Multiple accounts**: new tasks go to the **first** configured account
  (there is no account picker); update/complete/reopen/delete route to the
  right account from the task's namespaced id. The project dropdown also
  comes from the first account.

## Tests

`taskRelevance.test.ts`, `todoistTaskSource.test.ts` (mapping, pagination,
failure handling, the token only in the header), `taskProvider.test.ts`
(availability, bucketing and boundaries, urgency, per-account failure,
caching, multiple accounts, no token in account info, the env fallback),
`taskProvider.integration.test.ts` (a broken task provider never breaks
the briefing), and task cases in `briefingGenerator.test.ts`. All Todoist
calls use a fake `fetch`. The Tasks tab itself has no automated UI tests.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
