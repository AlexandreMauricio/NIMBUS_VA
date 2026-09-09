import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImportance } from "./emailImportance";

function input(overrides: Partial<Parameters<typeof classifyImportance>[0]> = {}) {
  return {
    subject: "Hello",
    senderName: "A Friend",
    senderAddress: "friend@example.com",
    isUnread: false,
    isFlagged: false,
    ...overrides,
  };
}

test("a newsletter-style automated sender classifies as low", () => {
  const { importance, signals } = classifyImportance(
    input({ subject: "This week's newsletter", senderAddress: "newsletter@shop.example.com", isUnread: true })
  );
  assert.equal(importance, "low");
  assert.equal(signals.looksAutomated, true);
});

test("a no-reply sender classifies as low even when unread", () => {
  const { importance } = classifyImportance(
    input({ senderAddress: "no-reply@service.example.com", isUnread: true })
  );
  assert.equal(importance, "low");
});

test("a plain read email from a person classifies as normal", () => {
  const { importance, signals } = classifyImportance(input());
  assert.equal(importance, "normal");
  assert.equal(signals.looksAutomated, false);
  assert.equal(signals.matchedKeyword, null);
});

test("a plain unread email from a person classifies as normal", () => {
  const { importance } = classifyImportance(input({ isUnread: true }));
  assert.equal(importance, "normal");
});

test("a message mentioning a financial/security keyword classifies as important", () => {
  const { importance, signals } = classifyImportance(
    input({ subject: "Your invoice is ready", isUnread: false })
  );
  assert.equal(importance, "important");
  assert.equal(signals.matchedKeyword, "invoice");
});

test("an email that looks like it's from a bank classifies as important", () => {
  const { importance, signals } = classifyImportance(
    input({ subject: "Your account update", senderAddress: "alerts@mybank.example.com" })
  );
  assert.equal(importance, "important");
  assert.equal(signals.matchedKeyword, "bank");
});

test("a flagged/starred message classifies as important even without other signals", () => {
  const { importance } = classifyImportance(input({ isFlagged: true }));
  assert.equal(importance, "important");
});

test("an unread + flagged message classifies as high", () => {
  const { importance } = classifyImportance(input({ isUnread: true, isFlagged: true }));
  assert.equal(importance, "high");
});

test("an unread message matching an attention keyword classifies as high", () => {
  const { importance } = classifyImportance(
    input({ subject: "Security alert: new sign-in", isUnread: true })
  );
  assert.equal(importance, "high");
});

test("importance signals are always returned alongside the tier, never a bare verdict", () => {
  const { signals } = classifyImportance(input({ isUnread: true, isFlagged: true }));
  assert.equal(typeof signals.isUnread, "boolean");
  assert.equal(typeof signals.isFlagged, "boolean");
  assert.equal(typeof signals.looksAutomated, "boolean");
  assert.ok(signals.matchedKeyword === null || typeof signals.matchedKeyword === "string");
});
