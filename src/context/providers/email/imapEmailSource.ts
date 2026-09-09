import { ImapFlow } from "imapflow";
import type { FetchMessageObject, MessageStructureObject } from "imapflow";

export interface ImapAccountConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Treated as a credential — never logged, never returned to the renderer. */
  password: string;
}

/** A message as read off the wire, before importance classification or context-shaping. */
export interface RawEmailMessage {
  uid: number;
  threadId: string | null;
  senderName: string | null;
  senderAddress: string | null;
  subject: string;
  receivedAt: string;
  isUnread: boolean;
  isFlagged: boolean;
  labels: string[];
  /** Short preview text — only populated for messages `shouldFetchSnippet` flagged. */
  snippet: string | null;
}

/** Given a fetched message, decide whether it's worth the extra round-trip to fetch a short body preview. */
export type SnippetPredicate = (message: RawEmailMessage) => boolean;

const MAX_SNIPPET_CHARS = 160;
const SNIPPET_FETCH_MAX_BYTES = 2048; // raw bytes before decoding/truncation — plenty for a short preview

/**
 * Reads recent message metadata over IMAP — the external-integration
 * layer for email, playing the same role `IcsCalendarSource` and
 * `OpenMeteoClient` play for calendar/weather (see ARCHITECTURE.md).
 * `EmailProvider` (Core) depends only on `fetchRecentMessages`'s return
 * shape, not on IMAP or the `imapflow` package directly — a future
 * OAuth-based source (Gmail/Graph API) would implement the same method
 * and plug in without `EmailProvider` changing.
 *
 * Always opens the mailbox **read-only** (`getMailboxLock(..., { readOnly:
 * true })`) — NIMBUS is a read-only email observer for now (see task's
 * "do not implement actions yet"), and this is what guarantees that at
 * the protocol level, not just by convention.
 *
 * Bodies are never downloaded in full. A short preview snippet is fetched
 * only for messages the caller (`EmailProvider`, using the deterministic
 * importance classifier) flags as worth it via `shouldFetchSnippet` —
 * everything else gets `snippet: null`.
 */
export class ImapEmailSource {
  constructor(
    private readonly config: ImapAccountConfig,
    private readonly clientFactory: (opts: {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
      logger: false;
    }) => ImapFlow = (opts) => new ImapFlow(opts)
  ) {}

  async fetchRecentMessages(
    sinceDate: Date,
    maxMessages: number,
    shouldFetchSnippet: SnippetPredicate = () => false
  ): Promise<RawEmailMessage[]> {
    const client = this.clientFactory({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.username, pass: this.config.password },
      logger: false, // never let imapflow's own logger print protocol/content details
    });

    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const found = await client.search({ since: sinceDate }, { uid: true });
        if (!found || found.length === 0) return [];

        const recentUids = found.slice(-maxMessages).reverse(); // most recent first

        const entries: Array<{ message: RawEmailMessage; bodyStructure?: MessageStructureObject }> = [];
        for await (const raw of client.fetch(
          recentUids,
          { uid: true, flags: true, envelope: true, threadId: true, labels: true, bodyStructure: true },
          { uid: true }
        )) {
          entries.push({ message: mapMessage(raw), bodyStructure: raw.bodyStructure });
        }

        for (const entry of entries) {
          if (!shouldFetchSnippet(entry.message)) continue;
          entry.message.snippet = await fetchSnippetSafely(client, entry.message.uid, entry.bodyStructure);
        }

        return entries.map((e) => e.message);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

function mapMessage(raw: FetchMessageObject): RawEmailMessage {
  const envelope = raw.envelope;
  const from = envelope?.from?.[0];
  const flags = raw.flags ?? new Set<string>();

  return {
    uid: raw.uid,
    threadId: raw.threadId ?? null,
    senderName: from?.name || null,
    senderAddress: from?.address || null,
    subject: envelope?.subject ?? "(No subject)",
    receivedAt: toIso(envelope?.date ?? raw.internalDate),
    isUnread: !flags.has("\\Seen"),
    isFlagged: flags.has("\\Flagged"),
    labels: raw.labels ? [...raw.labels] : [],
    snippet: null,
  };
}

function toIso(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** Finds the first text/plain (falling back to text/html) leaf part in a body structure tree. */
function findTextPart(node: MessageStructureObject | undefined): MessageStructureObject | null {
  if (!node) return null;
  if (node.type === "text/plain") return node;
  let htmlFallback: MessageStructureObject | null = node.type === "text/html" ? node : null;
  for (const child of node.childNodes ?? []) {
    const found = findTextPart(child);
    if (found?.type === "text/plain") return found;
    if (!htmlFallback && found?.type === "text/html") htmlFallback = found;
  }
  return htmlFallback;
}

async function fetchSnippetSafely(
  client: ImapFlow,
  uid: number,
  bodyStructure: MessageStructureObject | undefined
): Promise<string | null> {
  try {
    const part = findTextPart(bodyStructure);
    if (!part?.part) return null;

    const { content } = await client.download(String(uid), part.part, {
      uid: true,
      maxBytes: SNIPPET_FETCH_MAX_BYTES,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    return cleanSnippet(raw, part.type);
  } catch {
    // A snippet is a nice-to-have — never let it fail the whole fetch.
    return null;
  }
}

function cleanSnippet(raw: string, contentType: string): string {
  let text = raw;
  if (contentType === "text/html") {
    text = text.replace(/<[^>]*>/g, " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS - 1) + "…" : text;
}
