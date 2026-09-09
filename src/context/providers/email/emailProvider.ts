import { ContextProvider } from "../../types";
import { TtlCache } from "../../../common/ttlCache";
import { logger } from "../../../logging/logger";
import { ImapEmailSource, ImapAccountConfig, RawEmailMessage } from "./imapEmailSource";
import { classifyImportance } from "./emailImportance";
import { EmailContext, EmailMessage, EmailAccountInfo, EmailImportance } from "./types";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — email is more dynamic than weather/calendar
const MAX_MESSAGES_PER_ACCOUNT = 200; // safety cap so an active inbox can't trigger an unbounded fetch
const MAX_IMPORTANT_MESSAGES = 5;
const MAX_RECENT_MESSAGES_SAMPLE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EmailAccountConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Treated as a credential — never logged, never returned to the renderer. */
  password: string;
  /** Per-account override of the recent-messages window, in days. 0 = use the provider default. */
  sinceDays: number;
  enabled: boolean;
}

/** What EmailProvider needs from settings — structurally matches `EmailSettings` in settingsManager.ts. */
export interface EmailProviderConfig {
  enabled: boolean;
  accounts: EmailAccountConfig[];
  defaultSinceDays: number;
}

const IMPORTANCE_RANK: Record<EmailImportance, number> = { high: 3, important: 2, normal: 1, low: 0 };

/** Minimal shape for an environment-sourced default account — see config.ts's `emailAccount`. */
export interface EmailEnvFallbackAccount {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

/**
 * Context provider for the user's inbox(es). Implements the same
 * ContextProvider contract as every other provider — nothing outside
 * this module (and briefingGenerator.ts) knows email involves IMAP,
 * multiple accounts, or a deterministic importance model at all.
 *
 * Like CalendarProvider, `isAvailable()` is a real, cheap check: email
 * awareness is opt-in and requires at least one configured account, so
 * "not set up" reads as `status: "unavailable"` rather than a fetch
 * attempt that failed.
 *
 * Multiple accounts are read independently (`Promise.allSettled`) — one
 * broken account (bad password, server down) never blocks the others.
 * Only when *every* account fails does this throw, which ContextService
 * turns into the standard error/stale-fallback result.
 */
export class EmailProvider implements ContextProvider<EmailContext> {
  readonly id = "email";
  readonly displayName = "Email";

  private readonly cache: TtlCache<EmailContext>;

  constructor(
    private readonly getSettings: () => EmailProviderConfig,
    private readonly sourceFactory: (account: EmailAccountConfig) => ImapEmailSource = (account) =>
      new ImapEmailSource(toImapConfig(account)),
    private readonly now: () => Date = () => new Date(),
    cacheClock: () => number = Date.now,
    /** Optional default account sourced from the environment — same role as calendar/weather's env fallbacks. */
    private readonly envFallbackAccount: EmailEnvFallbackAccount | null = null
  ) {
    this.cache = new TtlCache(DEFAULT_CACHE_TTL_MS, cacheClock);
  }

  /** Convenience constructor for real usage — production wiring only needs `getSettings` + the env fallback. */
  static withDefaults(
    getSettings: () => EmailProviderConfig,
    envFallbackAccount: EmailEnvFallbackAccount | null = null
  ): EmailProvider {
    return new EmailProvider(getSettings, undefined, undefined, undefined, envFallbackAccount);
  }

  isAvailable(): boolean {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    return this.effectiveAccounts(settings).length > 0;
  }

  async getContext(): Promise<EmailContext> {
    const cached = this.cache.get();
    if (cached) return cached;

    const settings = this.getSettings();
    const enabledAccounts = this.effectiveAccounts(settings);
    if (enabledAccounts.length === 0) {
      throw new Error("Email is enabled but no accounts are configured");
    }

    const now = this.now();

    const results = await Promise.allSettled(
      enabledAccounts.map((account) => this.fetchAccountMessages(account, settings.defaultSinceDays, now))
    );

    const allMessages: EmailMessage[] = [];
    const accounts: EmailAccountInfo[] = [];
    let successCount = 0;

    results.forEach((result, i) => {
      const account = enabledAccounts[i];
      accounts.push({ id: account.id, label: account.label, address: account.username || null });
      if (result.status === "fulfilled") {
        successCount++;
        allMessages.push(...result.value);
      } else {
        // Never log account credentials — label/id only.
        logger.warn(`Email account "${account.label}" failed`, {
          accountId: account.id,
          error: String(result.reason),
        });
      }
    });

    if (successCount === 0) {
      throw new Error("All configured email accounts failed to load");
    }

    const context = buildContext(allMessages, accounts, settings.defaultSinceDays, now);
    this.cache.set(context);
    return context;
  }

  private effectiveAccounts(settings: EmailProviderConfig): EmailAccountConfig[] {
    const enabled = settings.accounts.filter((account) => account.enabled);
    if (enabled.length > 0 || !this.envFallbackAccount) return enabled;
    return [{ id: "env-default", sinceDays: 0, enabled: true, ...this.envFallbackAccount }];
  }

  private async fetchAccountMessages(
    account: EmailAccountConfig,
    defaultSinceDays: number,
    now: Date
  ): Promise<EmailMessage[]> {
    const sinceDays = account.sinceDays > 0 ? account.sinceDays : defaultSinceDays;
    const sinceDate = new Date(now.getTime() - sinceDays * DAY_MS);

    const source = this.sourceFactory(account);
    const raw = await source.fetchRecentMessages(sinceDate, MAX_MESSAGES_PER_ACCOUNT, (message) =>
      isPreliminarilyNoteworthy(message)
    );

    return raw.map((message) => toEmailMessage(message, account.id));
  }
}

/** Cheap pre-check (no snippet needed) mirroring classifyImportance's signals — decides if a snippet round-trip is worth it. */
function isPreliminarilyNoteworthy(message: RawEmailMessage): boolean {
  const { importance } = classifyImportance({
    subject: message.subject,
    senderName: message.senderName,
    senderAddress: message.senderAddress,
    isUnread: message.isUnread,
    isFlagged: message.isFlagged,
  });
  return importance === "important" || importance === "high";
}

function toEmailMessage(raw: RawEmailMessage, accountId: string): EmailMessage {
  const { importance, signals } = classifyImportance({
    subject: raw.subject,
    senderName: raw.senderName,
    senderAddress: raw.senderAddress,
    isUnread: raw.isUnread,
    isFlagged: raw.isFlagged,
  });

  return {
    id: `${accountId}:${raw.uid}`,
    threadId: raw.threadId,
    senderName: raw.senderName,
    senderAddress: raw.senderAddress,
    subject: raw.subject,
    receivedAt: raw.receivedAt,
    isUnread: raw.isUnread,
    isFlagged: raw.isFlagged,
    labels: raw.labels,
    snippet: raw.snippet,
    accountId,
    importance,
    signals,
  };
}

function buildContext(
  messages: EmailMessage[],
  accounts: EmailAccountInfo[],
  windowDays: number,
  now: Date
): EmailContext {
  const byRecency = messages.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  const importantMessages = byRecency
    .filter((m) => m.importance === "important" || m.importance === "high")
    .sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] || b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, MAX_IMPORTANT_MESSAGES);

  return {
    retrievedAt: now.toISOString(),
    windowDays,
    accounts,
    totalRecent: messages.length,
    unreadCount: messages.filter((m) => m.isUnread).length,
    importantMessages,
    recentMessages: byRecency.slice(0, MAX_RECENT_MESSAGES_SAMPLE),
  };
}

function toImapConfig(account: EmailAccountConfig): ImapAccountConfig {
  return {
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    password: account.password,
  };
}
