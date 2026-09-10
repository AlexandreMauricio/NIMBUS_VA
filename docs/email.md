# Email

An external context provider —
[src/context/providers/email/](../src/context/providers/email/) —
following the same adapter pattern as weather and calendar: `EmailProvider`
implements `ContextProvider<EmailContext>`, with the IMAP code isolated
behind a small source class. NIMBUS is aware of your inbox for the
briefing — **it is not an email client**: there is no inbox viewer, no
reading individual messages, and no send/reply/delete/archive/mark-read/
move/forward action anywhere. That is deliberate scope.

- **Integration**: IMAP via [imapflow](https://imapflow.com/), opening the
  mailbox **read-only** (`getMailboxLock(path, { readOnly: true })`,
  covered by a test). No OAuth app registration is needed: Gmail, Outlook
  and iCloud accept an app-specific password generated in the account's
  security settings.
- **Password handling**: the password is encrypted at rest in
  `secrets.json` (Windows DPAPI via Electron's `safeStorage`), never in
  `settings.json`. It is never logged, and **never sent to the renderer**:
  the Settings API returns `hasPassword: boolean`, and a saved password is
  replaced only when the form submits a `newPassword` (see
  `nimbus:get-email-settings`/`nimbus:update-email-settings` in
  `lifecycle.ts`), so editing another field never wipes it. A password
  that fails to decrypt is kept as stored rather than erased.
- **Multi-device/OAuth boundary**: `EmailProvider` depends only on
  `ImapEmailSource.fetchRecentMessages()`. A future Gmail API/Microsoft
  Graph source would fill the same role without `EmailProvider`,
  `ContextService`, the briefing or the UI changing. **OAuth is not
  implemented.**
- **Data model** ([types.ts](../src/context/providers/email/types.ts)):
  `EmailMessage` carries only metadata and a short preview — message and
  thread id, sender name/address, subject, received time, read/flagged
  state, labels, a `snippet` (≤160 characters, HTML-stripped), the
  `accountId`, and an `importance` tier with the `signals` behind it.
  **Full bodies are never retrieved or stored.** Message ids are
  namespaced `${accountId}:${uid}`; `EmailAccountInfo` holds account
  identity (id/label/address only).
- **Snippets are opt-in per message**: a snippet (capped at 2048 bytes
  downloaded) is fetched only for messages that already look noteworthy
  from cheap signals (sender, subject, unread/flagged). A failed snippet
  fetch returns `null`.
- **Deterministic importance** ([emailImportance.ts](../src/context/providers/email/emailImportance.ts)) —
  **no LLM**. A point scorer (unread, flagged, attention keywords such as
  invoice/payment/security alert, minus automated/newsletter patterns)
  maps to `low`/`normal`/`important`/`high`. Briefing wording is always
  hedged ("may require your attention").
- **Settings** (`UserPreferences.email`): a master `enabled` switch (off by
  default), a `defaultSinceDays` window, and an `accounts` list
  (`id`/`label`/`host`/`port`/`secure`/`username`/`sinceDays`/`enabled`;
  the password lives in the encrypted store). Managed in Settings → Email;
  a default account can come from `NIMBUS_EMAIL_*` in `.env` (used only
  when enabled and no account is saved).
- **Caching**: 5 minutes. No IMAP IDLE/push.
- **Limits**: up to 200 recent messages per account are read; the context
  keeps the 20 most recent and the 5 most important.
- **Failure behavior**: "not enabled" or "no account" is `status:
  "unavailable"`. Accounts are fetched independently; a failing one is
  logged (label/id and error only, never the password) and skipped, and
  only if every account fails does the provider throw.

## Tests

`emailImportance.test.ts`, `imapEmailSource.test.ts` (ordering, caps,
flags, snippet fetching and cleaning, the read-only lock, always logging
out), `emailProvider.test.ts` (availability, counting, importance,
per-account failure, caching, multiple accounts, no password in account
info, the env fallback), `emailProvider.integration.test.ts` (a broken
email provider never breaks the briefing), and email cases in
`briefingGenerator.test.ts`. All IMAP calls use a fake client.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
