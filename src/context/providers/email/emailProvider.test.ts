import { test } from "node:test";
import assert from "node:assert/strict";
import { EmailProvider, EmailProviderConfig, EmailAccountConfig, EmailEnvFallbackAccount } from "./emailProvider";
import { ImapEmailSource, RawEmailMessage } from "./imapEmailSource";

function account(overrides: Partial<EmailAccountConfig> = {}): EmailAccountConfig {
  return {
    id: "personal",
    label: "Personal",
    host: "imap.example.com",
    port: 993,
    secure: true,
    username: "me@example.com",
    password: "secret",
    sinceDays: 0,
    enabled: true,
    ...overrides,
  };
}

function config(overrides: Partial<EmailProviderConfig> = {}): EmailProviderConfig {
  return {
    enabled: true,
    accounts: [account()],
    defaultSinceDays: 2,
    ...overrides,
  };
}

function rawMessage(overrides: Partial<RawEmailMessage> = {}): RawEmailMessage {
  return {
    uid: 1,
    threadId: null,
    senderName: "A Friend",
    senderAddress: "friend@example.com",
    subject: "Hello",
    receivedAt: new Date("2026-09-08T10:00:00Z").toISOString(),
    isUnread: false,
    isFlagged: false,
    labels: [],
    snippet: null,
    ...overrides,
  };
}

/** Builds a source factory keyed by account id, returning canned messages (or throwing). */
function stubSourceFactory(
  byAccountId: Record<string, RawEmailMessage[] | Error>
): (account: EmailAccountConfig) => ImapEmailSource {
  return (acct: EmailAccountConfig) => {
    const canned = byAccountId[acct.id];
    return {
      fetchRecentMessages: async (_since: Date, _max: number, shouldFetchSnippet?: (m: RawEmailMessage) => boolean) => {
        if (canned instanceof Error) throw canned;
        const messages = canned ?? [];
        // Mirror the real source: only "fetch" a snippet when asked.
        for (const m of messages) {
          if (shouldFetchSnippet?.(m)) m.snippet = m.snippet ?? "(stub snippet)";
        }
        return messages;
      },
    } as unknown as ImapEmailSource;
  };
}

test("isAvailable is false when email is disabled", () => {
  const provider = new EmailProvider(() => config({ enabled: false }));
  assert.equal(provider.isAvailable(), false);
});

test("isAvailable is false when enabled but no account is enabled", () => {
  const provider = new EmailProvider(() => config({ accounts: [account({ enabled: false })] }));
  assert.equal(provider.isAvailable(), false);
});

test("isAvailable is true when enabled with at least one enabled account", () => {
  const provider = new EmailProvider(() => config());
  assert.equal(provider.isAvailable(), true);
});

test("no emails in the window produces zero counts and empty lists", async () => {
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: [] }));
  const ctx = await provider.getContext();

  assert.equal(ctx.totalRecent, 0);
  assert.equal(ctx.unreadCount, 0);
  assert.deepEqual(ctx.importantMessages, []);
  assert.deepEqual(ctx.recentMessages, []);
});

test("counts unread emails correctly among a mix of read/unread", async () => {
  const messages = [
    rawMessage({ uid: 1, isUnread: true }),
    rawMessage({ uid: 2, isUnread: false }),
    rawMessage({ uid: 3, isUnread: true }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.totalRecent, 3);
  assert.equal(ctx.unreadCount, 2);
});

test("multiple recent emails are all present in recentMessages, most recent first", async () => {
  const messages = [
    rawMessage({ uid: 1, subject: "Old", receivedAt: new Date("2026-09-06T10:00:00Z").toISOString() }),
    rawMessage({ uid: 2, subject: "New", receivedAt: new Date("2026-09-08T10:00:00Z").toISOString() }),
    rawMessage({ uid: 3, subject: "Mid", receivedAt: new Date("2026-09-07T10:00:00Z").toISOString() }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.deepEqual(ctx.recentMessages.map((m) => m.subject), ["New", "Mid", "Old"]);
});

test("an important email (keyword match) is classified and included in importantMessages", async () => {
  const messages = [rawMessage({ uid: 1, subject: "Your invoice is ready" })];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.importantMessages.length, 1);
  assert.equal(ctx.importantMessages[0].importance, "important");
  assert.equal(ctx.importantMessages[0].signals.matchedKeyword, "invoice");
});

test("a potentially important (flagged + unread) email is classified high and prioritized first", async () => {
  const messages = [
    rawMessage({ uid: 1, subject: "Newsletter", senderAddress: "newsletter@shop.example.com", isUnread: true }),
    rawMessage({ uid: 2, subject: "Please review", isFlagged: true, isUnread: true }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.importantMessages[0].importance, "high");
  assert.equal(ctx.importantMessages[0].subject, "Please review");
});

test("a newsletter/promotional email is classified low and excluded from importantMessages", async () => {
  const messages = [
    rawMessage({ uid: 1, subject: "This week's newsletter", senderAddress: "newsletter@shop.example.com", isUnread: true }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.totalRecent, 1);
  assert.equal(ctx.importantMessages.length, 0);
});

test("multiple messages in the same thread are all counted, tagged with the shared threadId", async () => {
  const messages = [
    rawMessage({ uid: 1, threadId: "thread-abc", subject: "Re: Project" }),
    rawMessage({ uid: 2, threadId: "thread-abc", subject: "Re: Re: Project" }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.totalRecent, 2);
  assert.ok(ctx.recentMessages.every((m) => m.threadId === "thread-abc"));
});

test("malformed/sparse email data (missing sender/subject) does not crash the provider", async () => {
  const messages = [
    rawMessage({ uid: 1, senderName: null, senderAddress: null, subject: "(No subject)" }),
  ];
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: messages }));
  const ctx = await provider.getContext();

  assert.equal(ctx.totalRecent, 1);
  assert.equal(ctx.recentMessages[0].senderAddress, null);
});

test("an authentication failure on the only account rejects getContext (for ContextService to catch)", async () => {
  const provider = new EmailProvider(
    () => config(),
    stubSourceFactory({ personal: new Error("Invalid credentials (AUTHENTICATIONFAILED)") })
  );
  await assert.rejects(() => provider.getContext(), /failed to load/);
});

test("an API/rate-limit failure on one account does not prevent messages from a working account", async () => {
  const messages = [rawMessage({ uid: 1, subject: "Still works" })];
  const provider = new EmailProvider(
    () =>
      config({
        accounts: [
          account({ id: "broken", label: "Broken" }),
          account({ id: "good", label: "Good" }),
        ],
      }),
    stubSourceFactory({
      broken: new Error("Rate limited (try again later)"),
      good: messages,
    })
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.totalRecent, 1);
  assert.equal(ctx.recentMessages[0].subject, "Still works");
});

test("all accounts failing rejects getContext", async () => {
  const provider = new EmailProvider(
    () => config({ accounts: [account({ id: "a" }), account({ id: "b" })] }),
    stubSourceFactory({ a: new Error("offline"), b: new Error("offline") })
  );
  await assert.rejects(() => provider.getContext(), /failed to load/);
});

test("getContext caches results within the TTL instead of re-fetching", async () => {
  let fetchCount = 0;
  const provider = new EmailProvider(
    () => config(),
    () =>
      ({
        fetchRecentMessages: async () => {
          fetchCount++;
          return [];
        },
      }) as unknown as ImapEmailSource,
    () => new Date(),
    Date.now
  );

  await provider.getContext();
  await provider.getContext();
  assert.equal(fetchCount, 1);
});

test("multiple accounts are merged, each message tagged with its own accountId", async () => {
  const provider = new EmailProvider(
    () =>
      config({
        accounts: [
          account({ id: "work", label: "Work" }),
          account({ id: "personal", label: "Personal" }),
        ],
      }),
    stubSourceFactory({
      work: [rawMessage({ uid: 1, subject: "Work thing" })],
      personal: [rawMessage({ uid: 1, subject: "Personal thing" })],
    })
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.accounts.length, 2);
  const byId = Object.fromEntries(ctx.recentMessages.map((m) => [m.accountId, m]));
  assert.equal(byId.work.subject, "Work thing");
  assert.equal(byId.personal.subject, "Personal thing");
  // ids are namespaced by account so two accounts' UID 1 never collide
  assert.notEqual(byId.work.id, byId.personal.id);
});

test("account identity never includes the password", async () => {
  const provider = new EmailProvider(() => config(), stubSourceFactory({ personal: [] }));
  const ctx = await provider.getContext();

  assert.deepEqual(Object.keys(ctx.accounts[0]).sort(), ["address", "id", "label"]);
});

test("a per-account sinceDays override changes the window used for that account", async () => {
  let capturedSince: Date | null = null;
  const provider = new EmailProvider(
    () => config({ accounts: [account({ sinceDays: 7 })], defaultSinceDays: 2 }),
    () =>
      ({
        fetchRecentMessages: async (since: Date) => {
          capturedSince = since;
          return [];
        },
      }) as unknown as ImapEmailSource,
    () => new Date("2026-09-10T00:00:00Z")
  );

  await provider.getContext();
  assert.equal(capturedSince!.toISOString(), "2026-09-03T00:00:00.000Z"); // 7 days back
});

test("with no per-account override, the provider's default window is used (excluding older mail)", async () => {
  let capturedSince: Date | null = null;
  const provider = new EmailProvider(
    () => config({ defaultSinceDays: 2 }), // account() defaults sinceDays: 0 -> falls back to default
    () =>
      ({
        fetchRecentMessages: async (since: Date) => {
          capturedSince = since;
          return []; // the actual excluding-old-mail filtering happens server-side via this "since" boundary
        },
      }) as unknown as ImapEmailSource,
    () => new Date("2026-09-10T00:00:00Z")
  );

  await provider.getContext();
  assert.equal(capturedSince!.toISOString(), "2026-09-08T00:00:00.000Z"); // 2 days back
});

test("an env fallback account is used when enabled but no account is saved yet", async () => {
  const fallback: EmailEnvFallbackAccount = {
    label: "Env Default",
    host: "imap.env.example.com",
    port: 993,
    secure: true,
    username: "env@example.com",
    password: "env-secret",
  };
  const messages = [rawMessage({ uid: 1, subject: "From env account" })];
  const provider = new EmailProvider(
    () => config({ accounts: [] }),
    stubSourceFactory({ "env-default": messages }),
    () => new Date(),
    Date.now,
    fallback
  );

  assert.equal(provider.isAvailable(), true);
  const ctx = await provider.getContext();
  assert.equal(ctx.totalRecent, 1);
  assert.equal(ctx.accounts[0].label, "Env Default");
});

test("a saved account takes priority over the env fallback account", async () => {
  const fallback: EmailEnvFallbackAccount = {
    label: "Env Default",
    host: "imap.env.example.com",
    port: 993,
    secure: true,
    username: "env@example.com",
    password: "env-secret",
  };
  const provider = new EmailProvider(
    () => config(), // has a real "personal" account configured
    stubSourceFactory({ personal: [] }),
    () => new Date(),
    Date.now,
    fallback
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.accounts.length, 1);
  assert.equal(ctx.accounts[0].id, "personal");
  assert.notEqual(ctx.accounts[0].label, "Env Default");
});
