# Email

The third external context provider —
[src/context/providers/email/](../src/context/providers/email/) — following
the same adapter pattern as weather and calendar: `EmailProvider`
implements `ContextProvider<EmailContext>`, with the actual IMAP protocol
code isolated behind a small source interface. NIMBUS is aware of your
inbox for the purpose of the morning briefing — **it is not an email
client**: there's no inbox viewer, no reading individual messages, and no
send/reply/delete/archive/mark-read/move/forward actions anywhere.

- **Integration chosen**: IMAP (via the [imapflow](https://imapflow.com/)
  library), connecting **read-only**
  (`getMailboxLock(path, { readOnly: true })` — asserted in
  [imapEmailSource.ts](../src/context/providers/email/imapEmailSource.ts) and
  covered by a test that fails if that flag is ever dropped). Like
  Calendar's ICS choice, this needs no OAuth app registration: Gmail,
  Outlook, and iCloud all support connecting an IMAP client with an
  app-specific password generated from the account's own security
  settings, so there's no developer credential to provision in this
  environment. The password is a credential like the calendar feed URL —
  stored only in the local `settings.json`, never logged (log calls only
  ever include an account's `label`/`id`, see `emailProvider.ts`), and,
  unlike the calendar URL, **never sent back to the renderer at all**: the
  Settings API returns `hasPassword: boolean` instead of the value itself,
  and a saved password is only replaced when the form explicitly submits a
  `newPassword` (see `nimbus:get-email-settings`/`nimbus:update-email-settings`
  in `lifecycle.ts`) — toggling an account on/off or editing another field
  never wipes it.
- **Multi-device/OAuth boundary**: `EmailProvider` depends only on
  `ImapEmailSource.fetchRecentMessages()` — see
  [imapEmailSource.ts](../src/context/providers/email/imapEmailSource.ts). A
  future OAuth-based source (Gmail API, Microsoft Graph) would implement
  the same "give me recent messages" role and plug in without
  `EmailProvider`, `ContextService`, the briefing, or the UI changing —
  the same boundary Calendar's `IcsCalendarSource` already demonstrates.
  Real OAuth is out of scope here for the same reason as Calendar's.
- **Data model** ([types.ts](../src/context/providers/email/types.ts)):
  `EmailMessage` carries only metadata and a short preview — message and
  thread id, sender name/address, subject, received timestamp, read/
  flagged state, labels, a `snippet` (≤160 characters, HTML-stripped,
  whitespace-collapsed), the source `accountId`, and a computed
  `importance` tier with the `signals` that produced it. **Full message
  bodies are never retrieved or stored** — see "Snippet fetching" below.
  `EmailAccountInfo` (id/label/address only, never a password) keeps
  account identity separate from messages, so `EmailContext.accounts` can
  list multiple accounts without duplicating that data onto every message;
  each `EmailMessage.id` is namespaced as `${accountId}:${uid}` so UIDs
  from different accounts never collide.
- **Snippet fetching is opt-in per message**: before downloading any body
  content, `EmailProvider` runs the same deterministic classifier against
  cheap signals only (sender, subject, unread/flagged state) via
  `isPreliminarilyNoteworthy()`; a snippet is only fetched for messages
  that already look potentially important from that check. Ordinary/
  automated mail never has its body touched at all — satisfying "avoid
  unnecessarily retrieving full email bodies" while still supporting a
  preview field when one is warranted. Snippet downloads are capped at
  2048 bytes and a fetch failure returns `null` rather than failing the
  whole message.
- **Deterministic importance** ([emailImportance.ts](../src/context/providers/email/emailImportance.ts)) —
  **no LLM anywhere in this feature**. A small point-based scorer (unread
  +1, flagged +3, an attention keyword in the subject/sender +3 — invoice,
  payment, verification code, security alert, password, deadline, etc. —
  automated/newsletter sender or subject patterns −2) maps to
  `low`/`normal`/`important`/`high`. Every message keeps its raw
  `signals`, so the reasoning behind a tier is inspectable, and briefing
  language is always hedged ("may require your attention"), never a
  certainty claim.
- **Settings** (`UserPreferences.email` in `settingsManager.ts`): a master
  `enabled` switch (off by default) and an `accounts` list, each with
  `id`/`label`/`host`/`port`/`secure`/`username`/`sinceDays`/`enabled` plus
  a locally-stored `password` — supporting multiple accounts the same way
  Calendar supports multiple feeds. Managed from the **Email** section of
  the Settings tab; also settable via `NIMBUS_EMAIL_HOST`/`PORT`/`SECURE`/
  `USERNAME`/`PASSWORD`/`LABEL` in `.env` as a headless/dev default (only
  used when enabled but no account has been saved yet).
- **Caching**: a 5-minute default via the same
  [TtlCache](../src/common/ttlCache.ts) weather and calendar use — shorter
  than either, since a mailbox is more dynamic. Still simple polling (no
  IMAP IDLE/push), but the data model already carries what a future
  incremental-refresh/heartbeat system would need (per-message
  read/flagged state, `retrievedAt`) without requiring another shape
  change.
- **Relevance**: the briefing never just reports a raw inbox count. Recent
  messages are capped (`MAX_RECENT_MESSAGES_SAMPLE = 20` fetched per
  account, `MAX_IMPORTANT_MESSAGES = 5` surfaced), and the message builder
  in `briefingGenerator.ts` only escalates language when there's an actual
  unread-and-high-importance message, or at least one `important`/`high`
  message among the recent set — 30 newsletters landing overnight
  produces the same calm "nothing important came in overnight" line as an
  empty inbox, not "You have 30 emails."
- **Failure behavior**: like Calendar, `isAvailable()` treats "not enabled"
  or "no account configured" as `status: "unavailable"`, not an error.
  Each enabled account is fetched independently (`Promise.allSettled`):
  one bad account (wrong password, DNS failure, expired auth, rate
  limiting) is logged — account label/id and error message only, **never
  the password** — and skipped without affecting the others; only if
  *every* account fails does the provider throw, which `ContextService`
  turns into the standard error/stale-fallback result. Confirmed live: a
  fake IMAP host produces `[WARN] Email account "..." failed` in the log
  with no credential in it, `status: "error"` on the Context tab, and a
  briefing that still generates normally (weather/calendar/dateTime
  intact) with the email item simply omitted.

## Tests

`emailImportance.test.ts` (every scoring branch: newsletter/no-reply →
low, plain read/unread → normal, a keyword match, a bank-like sender, a
flagged message → important, unread+flagged and unread+keyword → high,
signals always present on the result), `imapEmailSource.test.ts` (empty
results, most-recent-first ordering, a `maxMessages` cap, unread/flagged
flag mapping, snippet only fetched when the predicate says so, snippet
HTML-stripping/whitespace-collapse/160-char truncation, a snippet fetch
failure returning `null` instead of throwing, no text part found, the
read-only mailbox-lock assertion, always logging out even after a search
failure, a connection failure propagating as a rejection),
`emailProvider.test.ts` (availability with 0/1 accounts enabled, no
messages, unread counting, ordering across multiple messages, an
important message via keyword, a potentially-important unread+flagged
message ranked first, a newsletter excluded from "important", thread
messages counted, malformed/sparse raw data not crashing the mapper, an
auth failure on the only account rejecting `getContext()`, one account
failing without blocking another, all accounts failing rejecting, cache
hit within TTL, multiple accounts merged with distinct namespaced message
ids, account identity in `EmailContext.accounts` never including a
password, a per-account `sinceDays` override, the default window
computation, the env-fallback account used only when no account is
saved), `emailProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider` alongside a deliberately broken `EmailProvider` —
proves email failing produces a valid `Briefing` with every other item
intact and email cleanly omitted), and email-specific cases in
`briefingGenerator.test.ts` (no recent mail, singular/plural unread-count
phrasing, the "N received / M may require attention" phrasing matched
exactly to the task's own example, the unread-and-important spotlight by
sender name and by address when no name is present, omission on missing/
unavailable/errored email data, and priority ranking against other
categories). All IMAP calls are mocked via a hand-built fake client — no
test reaches a real mail server or needs a real account. 55 new tests,
alongside the 95 pre-existing ones (150 total via `npm test`).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
