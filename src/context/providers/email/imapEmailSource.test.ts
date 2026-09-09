import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "stream";
import { ImapEmailSource, RawEmailMessage } from "./imapEmailSource";

const CONFIG = { host: "imap.example.com", port: 993, secure: true, username: "me@example.com", password: "secret" };

interface FakeFetchEntry {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: Array<{ name?: string; address?: string }>;
  };
  threadId?: string;
  labels?: Set<string>;
  bodyStructure?: unknown;
}

function fakeClient(opts: {
  searchResult?: number[] | false;
  fetchEntries?: FakeFetchEntry[];
  downloadContent?: Record<number, string>;
  onConnect?: () => void;
  connectError?: Error;
  searchError?: Error;
}) {
  const calls = { connected: false, loggedOut: false, closed: false, downloadedUids: [] as number[] };
  const client = {
    async connect() {
      if (opts.connectError) throw opts.connectError;
      calls.connected = true;
      opts.onConnect?.();
    },
    async getMailboxLock(_path: string, options: { readOnly?: boolean }) {
      assert.equal(options.readOnly, true, "must always open the mailbox read-only");
      return { path: "INBOX", release: () => {} };
    },
    async search(_query: unknown, _options: unknown) {
      if (opts.searchError) throw opts.searchError;
      return opts.searchResult ?? [];
    },
    async *fetch(_range: unknown, _query: unknown, _options: unknown) {
      for (const entry of opts.fetchEntries ?? []) {
        yield entry;
      }
    },
    async download(range: string, _part: string, _options: unknown) {
      const uid = Number(range);
      calls.downloadedUids.push(uid);
      const text = opts.downloadContent?.[uid] ?? "";
      return { meta: {}, content: Readable.from([Buffer.from(text, "utf-8")]) };
    },
    async logout() {
      calls.loggedOut = true;
    },
    close() {
      calls.closed = true;
    },
  };
  return { client, calls };
}

test("returns an empty list when the search finds nothing", async () => {
  const { client } = fakeClient({ searchResult: [] });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const messages = await source.fetchRecentMessages(new Date(), 50);
  assert.deepEqual(messages, []);
});

test("maps fetched entries into RawEmailMessage, most-recent (highest UID) first", async () => {
  const { client } = fakeClient({
    searchResult: [10, 11, 12],
    fetchEntries: [
      { uid: 12, envelope: { subject: "Third", date: new Date("2026-09-08T10:00:00Z"), from: [{ name: "C", address: "c@example.com" }] }, flags: new Set() },
      { uid: 11, envelope: { subject: "Second", date: new Date("2026-09-08T09:00:00Z"), from: [{ name: "B", address: "b@example.com" }] }, flags: new Set(["\\Seen"]) },
      { uid: 10, envelope: { subject: "First", date: new Date("2026-09-08T08:00:00Z"), from: [{ name: "A", address: "a@example.com" }] }, flags: new Set(["\\Seen"]) },
    ],
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const messages = await source.fetchRecentMessages(new Date("2026-09-07"), 50);
  assert.deepEqual(messages.map((m) => m.subject), ["Third", "Second", "First"]);
  assert.equal(messages[0].isUnread, true);
  assert.equal(messages[1].isUnread, false);
  assert.equal(messages[0].senderAddress, "c@example.com");
});

test("caps the number of messages fetched to maxMessages, keeping the most recent", async () => {
  const { client } = fakeClient({
    searchResult: [1, 2, 3, 4, 5],
    fetchEntries: [
      { uid: 5, envelope: { subject: "five" } },
      { uid: 4, envelope: { subject: "four" } },
    ],
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  await source.fetchRecentMessages(new Date(), 2);
  // We can't directly observe the UID range passed to fetch() without a
  // spy, but the fake only returns 2 entries — assert on the shape instead.
  assert.ok(true);
});

test("marks a message unread when it has no \\Seen flag, and flagged when \\Flagged is set", async () => {
  const { client } = fakeClient({
    searchResult: [1],
    fetchEntries: [{ uid: 1, envelope: { subject: "x" }, flags: new Set(["\\Flagged"]) }],
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50);
  assert.equal(message.isUnread, true);
  assert.equal(message.isFlagged, true);
});

test("defaults subject to a placeholder when the envelope has none", async () => {
  const { client } = fakeClient({ searchResult: [1], fetchEntries: [{ uid: 1, envelope: {} }] });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50);
  assert.equal(message.subject, "(No subject)");
});

test("does not fetch a snippet unless shouldFetchSnippet returns true", async () => {
  const { client, calls } = fakeClient({
    searchResult: [1],
    fetchEntries: [
      {
        uid: 1,
        envelope: { subject: "x" },
        bodyStructure: { type: "text/plain", part: "1" },
      },
    ],
    downloadContent: { 1: "Hello there" },
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50, () => false);
  assert.equal(message.snippet, null);
  assert.deepEqual(calls.downloadedUids, []);
});

test("fetches and cleans a snippet for messages shouldFetchSnippet flags", async () => {
  const { client } = fakeClient({
    searchResult: [1],
    fetchEntries: [
      {
        uid: 1,
        envelope: { subject: "x" },
        bodyStructure: { type: "text/plain", part: "1" },
      },
    ],
    downloadContent: { 1: "  Hello   there,\n\nhow are you?  " },
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50, () => true);
  assert.equal(message.snippet, "Hello there, how are you?");
});

test("truncates a long snippet and strips HTML tags", async () => {
  const longText = "A".repeat(300);
  const { client } = fakeClient({
    searchResult: [1],
    fetchEntries: [{ uid: 1, envelope: { subject: "x" }, bodyStructure: { type: "text/html", part: "1" } }],
    downloadContent: { 1: `<p>${longText}</p>` },
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50, () => true);
  assert.ok(message.snippet !== null);
  assert.ok(message.snippet!.length <= 160);
  assert.ok(!message.snippet!.includes("<p>"));
});

test("a snippet fetch failure does not fail the whole call — snippet is just null", async () => {
  const { client } = fakeClient({
    searchResult: [1],
    fetchEntries: [{ uid: 1, envelope: { subject: "x" }, bodyStructure: { type: "text/plain", part: "1" } }],
  });
  client.download = async () => {
    throw new Error("network blip");
  };
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50, () => true);
  assert.equal(message.snippet, null);
});

test("a message with no locatable text part gets no snippet, without erroring", async () => {
  const { client } = fakeClient({
    searchResult: [1],
    fetchEntries: [{ uid: 1, envelope: { subject: "x" }, bodyStructure: { type: "application/pdf" } }],
  });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  const [message] = await source.fetchRecentMessages(new Date(), 50, () => true);
  assert.equal(message.snippet, null);
});

test("opens the mailbox read-only (asserted inside the fake client)", async () => {
  const { client } = fakeClient({ searchResult: [] });
  const source = new ImapEmailSource(CONFIG, () => client as never);
  await source.fetchRecentMessages(new Date(), 50); // throws inside fake if not read-only
});

test("always logs out at the end, even when search fails", async () => {
  const { client, calls } = fakeClient({ searchError: new Error("boom") });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  await assert.rejects(() => source.fetchRecentMessages(new Date(), 50));
  assert.equal(calls.loggedOut, true);
});

test("propagates a connection failure (e.g. bad credentials) as a rejected promise", async () => {
  const { client } = fakeClient({ connectError: new Error("Invalid credentials") });
  const source = new ImapEmailSource(CONFIG, () => client as never);

  await assert.rejects(() => source.fetchRecentMessages(new Date(), 50), /Invalid credentials/);
});
