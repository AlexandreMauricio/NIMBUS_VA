import { EmailImportance, EmailImportanceSignals } from "./types";

/**
 * Deterministic (no LLM) importance classification. This is intentionally
 * simple — a small point-scoring system over a handful of signals — and
 * intentionally NOT confident: the resulting tier and any briefing text
 * built from it should always read as "may need attention", never "does
 * need attention". See emailImportance.test.ts for the exact boundaries.
 *
 * This produces a *signal*, not a verdict — the structured
 * `EmailImportanceSignals` are kept on the message specifically so a
 * future, smarter layer can re-weigh them without this function needing
 * to change.
 */

/** Sender local-parts/keywords that strongly suggest an automated/bulk sender, not a person. */
const AUTOMATED_SENDER_PATTERNS = [
  /no-?reply/i,
  /^notifications?@/i,
  /^newsletter/i,
  /^digest@/i,
  /^updates?@/i,
  /^mailer-?daemon/i,
  /^bounce/i,
  /^marketing@/i,
  /^promo(tions?)?@/i,
];

/** Subject phrases that suggest bulk/promotional content — pushes importance down. */
const AUTOMATED_SUBJECT_PATTERNS = [/newsletter/i, /unsubscribe/i, /% off/i, /weekly digest/i];

/**
 * Keywords in the subject *or* sender that suggest a message worth a second
 * look — financial, security, or time-sensitive language. Deliberately a
 * broad, conservative net (better to under-claim than over-claim) — this
 * is a "may be worth attention" signal, never a "this needs a reply" one.
 */
const ATTENTION_KEYWORDS = [
  "invoice",
  "payment",
  "receipt",
  "statement",
  "past due",
  "overdue",
  "security alert",
  "verify your",
  "verification code",
  "suspicious sign-in",
  "password",
  "action required",
  "urgent",
  "deadline",
  "due date",
  "expir", // matches "expiring"/"expired"
  "suspended",
  "bank",
  "tax",
  "contract",
  "legal notice",
];

function findMatchedKeyword(...fields: Array<string | null | undefined>): string | null {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  for (const keyword of ATTENTION_KEYWORDS) {
    if (haystack.includes(keyword)) return keyword;
  }
  return null;
}

function looksAutomated(subject: string, senderAddress: string | null): boolean {
  if (senderAddress && AUTOMATED_SENDER_PATTERNS.some((re) => re.test(senderAddress))) return true;
  return AUTOMATED_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

export interface ImportanceInput {
  subject: string;
  senderName: string | null;
  senderAddress: string | null;
  isUnread: boolean;
  isFlagged: boolean;
}

export function classifyImportance(input: ImportanceInput): {
  importance: EmailImportance;
  signals: EmailImportanceSignals;
} {
  const automated = looksAutomated(input.subject, input.senderAddress);
  const matchedKeyword = findMatchedKeyword(input.subject, input.senderName, input.senderAddress);

  const signals: EmailImportanceSignals = {
    isUnread: input.isUnread,
    isFlagged: input.isFlagged,
    looksAutomated: automated,
    matchedKeyword,
  };

  let score = 0;
  if (input.isUnread) score += 1;
  if (input.isFlagged) score += 3;
  if (matchedKeyword) score += 3;
  if (automated) score -= 2;

  let importance: EmailImportance;
  if (score <= -1) importance = "low";
  else if (score <= 1) importance = "normal";
  else if (score <= 3) importance = "important";
  else importance = "high";

  return { importance, signals };
}
