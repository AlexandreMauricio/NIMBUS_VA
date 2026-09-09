/**
 * Deterministic importance tier for a message — never a claim of certainty,
 * just a signal a future intelligence layer (or the briefing today) can
 * act on. See emailImportance.ts for how this is computed.
 */
export type EmailImportance = "low" | "normal" | "important" | "high";

/** The deterministic signals that produced an `EmailImportance` verdict — kept alongside it so the reasoning is inspectable, not just the conclusion. */
export interface EmailImportanceSignals {
  isUnread: boolean;
  isFlagged: boolean;
  /** Looks like a newsletter/notification/no-reply sender — a reason to rank *down*, not up. */
  looksAutomated: boolean;
  /** The keyword that triggered a "may need attention" signal, if any (e.g. "invoice", "security alert"). Not a claim the email truly needs a reply. */
  matchedKeyword: string | null;
}

/** One account NIMBUS is watching. Identity only — never a password/token. */
export interface EmailAccountInfo {
  id: string;
  label: string;
  /** The account's own address, if known (e.g. the configured username). */
  address: string | null;
}

/**
 * A single message's metadata — deliberately not the full body. See
 * ARCHITECTURE.md / docs/email.md for why: NIMBUS summarizes,
 * it doesn't become an email client.
 */
export interface EmailMessage {
  id: string;
  threadId: string | null;
  senderName: string | null;
  senderAddress: string | null;
  subject: string;
  /** ISO instant. */
  receivedAt: string;
  isUnread: boolean;
  isFlagged: boolean;
  labels: string[];
  /**
   * Short preview text, only fetched for messages that already look
   * important enough to be worth the extra round-trip — see
   * imapEmailSource.ts. Null for everything else, and always truncated;
   * this is never the full body.
   */
  snippet: string | null;
  accountId: string;
  importance: EmailImportance;
  signals: EmailImportanceSignals;
}

/** Structured inbox summary as exposed through the Context system. */
export interface EmailContext {
  retrievedAt: string;
  /** The "recent" window actually used, in days. */
  windowDays: number;
  accounts: EmailAccountInfo[];
  /** Count of messages within the window, across all accounts. */
  totalRecent: number;
  /** Count of unread messages within the window, across all accounts. */
  unreadCount: number;
  /** Messages classified "important" or "high" — bounded, sorted most-recent first. */
  importantMessages: EmailMessage[];
  /** A bounded sample of the most recent messages (any importance) — for the Context tab, not the briefing. */
  recentMessages: EmailMessage[];
}
