import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  EmailAccount,
  NimbusSettings,
  TaskAccount,
  applyDefaults,
  emailPasswordKey,
  extractSecrets,
  hasInlineCredentials,
  isLegacyShape,
  migrateLegacyShape,
  restoreSecrets,
  taskApiTokenKey,
} from "./settingsSchema";

function emailAccount(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: "acct-1",
    label: "Work",
    host: "imap.example.com",
    port: 993,
    secure: true,
    username: "someone@example.com",
    password: "hunter2",
    sinceDays: 0,
    enabled: true,
    ...overrides,
  };
}

function taskAccount(overrides: Partial<TaskAccount> = {}): TaskAccount {
  return {
    id: "task-1",
    label: "Personal",
    provider: "todoist",
    apiToken: "tok_secret",
    enabled: true,
    ...overrides,
  };
}

function settingsWith(email: EmailAccount[], tasks: TaskAccount[]): NimbusSettings {
  const base = structuredClone(DEFAULT_SETTINGS);
  base.userPreferences.email.accounts = email;
  base.userPreferences.tasks.accounts = tasks;
  return base;
}

// ---------------------------------------------------------------- defaults

test("applyDefaults fills an empty object out with the full default shape", () => {
  const settings = applyDefaults({});

  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

test("applyDefaults keeps saved values while filling in missing ones", () => {
  const settings = applyDefaults({
    windowsClient: { startup: { launchWithWindows: true } },
  });

  assert.equal(settings.windowsClient.startup.launchWithWindows, true);
  assert.equal(settings.windowsClient.startup.startMinimized, false);
  assert.equal(settings.windowsClient.windowBounds.width, DEFAULT_SETTINGS.windowsClient.windowBounds.width);
});

test("applyDefaults supplies defaults for a preference group the saved file predates", () => {
  // A settings.json written before the tasks group existed at all.
  const settings = applyDefaults({
    userPreferences: { weather: { locationMode: "manual", manualLocation: null } },
  });

  assert.deepEqual(settings.userPreferences.tasks, DEFAULT_SETTINGS.userPreferences.tasks);
  assert.deepEqual(settings.userPreferences.routines, DEFAULT_SETTINGS.userPreferences.routines);
  assert.equal(settings.userPreferences.weather.locationMode, "manual");
});

test("applyDefaults does not share mutable default state between calls", () => {
  const first = applyDefaults({});
  first.userPreferences.email.accounts.push(emailAccount());

  const second = applyDefaults({});

  assert.equal(second.userPreferences.email.accounts.length, 0);
  assert.equal(DEFAULT_SETTINGS.userPreferences.email.accounts.length, 0);
});

// --------------------------------------------------------------- migration

test("migrateLegacyShape lifts pre-split top-level keys into their new homes", () => {
  const migrated = migrateLegacyShape({
    windowBounds: { width: 1234, height: 567 },
    startup: { launchWithWindows: true, startMinimized: true },
    weather: { locationMode: "manual", manualLocation: null },
  });
  const settings = applyDefaults(migrated);

  assert.deepEqual(settings.windowsClient.windowBounds, { width: 1234, height: 567 });
  assert.equal(settings.windowsClient.startup.launchWithWindows, true);
  assert.equal(settings.userPreferences.weather.locationMode, "manual");
});

test("migrateLegacyShape leaves an already-current file untouched", () => {
  const current = { windowsClient: { windowBounds: { width: 900, height: 600 } } };

  assert.equal(migrateLegacyShape(current), current);
  assert.equal(isLegacyShape(current), false);
});

test("isLegacyShape only reports true for a recognizable pre-split file", () => {
  assert.equal(isLegacyShape({ windowBounds: { width: 1, height: 2 } }), true);
  assert.equal(isLegacyShape({ userPreferences: {} }), false);
  assert.equal(isLegacyShape({}), false);
});

test("an unrecognizable file falls through to defaults rather than throwing", () => {
  const settings = applyDefaults(migrateLegacyShape({ somethingElse: true }));

  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

// ------------------------------------------------------------- credentials

test("extractSecrets strips credentials out of the settings written to disk", () => {
  const settings = settingsWith([emailAccount()], [taskAccount()]);

  const { sanitized, secrets } = extractSecrets(settings);

  assert.equal(sanitized.userPreferences.email.accounts[0].password, "");
  assert.equal(sanitized.userPreferences.tasks.accounts[0].apiToken, "");
  assert.equal(secrets[emailPasswordKey("acct-1")], "hunter2");
  assert.equal(secrets[taskApiTokenKey("task-1")], "tok_secret");
});

test("no credential ever appears in the serialized settings file", () => {
  const settings = settingsWith([emailAccount()], [taskAccount()]);

  const serialized = JSON.stringify(extractSecrets(settings).sanitized);

  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("tok_secret"), false);
  // Non-credential account fields still round-trip normally.
  assert.equal(serialized.includes("imap.example.com"), true);
});

test("extractSecrets does not mutate the live in-memory settings", () => {
  const settings = settingsWith([emailAccount()], [taskAccount()]);

  extractSecrets(settings);

  assert.equal(settings.userPreferences.email.accounts[0].password, "hunter2");
  assert.equal(settings.userPreferences.tasks.accounts[0].apiToken, "tok_secret");
});

test("an account with no credential still gets a key, with an empty value", () => {
  // Present-but-empty is how the store tells "this account's value
  // couldn't be read, keep what's stored" from "this account was removed,
  // delete it" — see SecretStore.writeAll.
  const settings = settingsWith([emailAccount({ password: "" })], []);

  const { secrets } = extractSecrets(settings);

  assert.deepEqual(Object.values(secrets), [""]);
});

test("extract then restore round-trips to the original settings", () => {
  const settings = settingsWith([emailAccount()], [taskAccount()]);

  const { sanitized, secrets } = extractSecrets(settings);
  const restored = restoreSecrets(sanitized, secrets);

  assert.deepEqual(restored, settings);
});

test("restoreSecrets keeps a plaintext credential from a pre-SecretStore file", () => {
  // The upgrade path: settings.json still has the password inline and the
  // encrypted store has nothing for it yet.
  const settings = settingsWith([emailAccount()], [taskAccount()]);

  const restored = restoreSecrets(settings, {});

  assert.equal(restored.userPreferences.email.accounts[0].password, "hunter2");
  assert.equal(restored.userPreferences.tasks.accounts[0].apiToken, "tok_secret");
});

test("the stored credential wins over a stale inline one", () => {
  const settings = settingsWith([emailAccount({ password: "old-plaintext" })], []);

  const restored = restoreSecrets(settings, { [emailPasswordKey("acct-1")]: "current" });

  assert.equal(restored.userPreferences.email.accounts[0].password, "current");
});

test("an account with no stored and no inline credential reads as unset", () => {
  const settings = settingsWith([emailAccount({ password: "" })], [taskAccount({ apiToken: "" })]);

  const restored = restoreSecrets(settings, {});

  assert.equal(restored.userPreferences.email.accounts[0].password, "");
  assert.equal(restored.userPreferences.tasks.accounts[0].apiToken, "");
});

test("secret keys are derived from the account id, so renaming an account keeps its credential", () => {
  const settings = settingsWith([emailAccount({ label: "Renamed", password: "" })], []);

  const restored = restoreSecrets(settings, { [emailPasswordKey("acct-1")]: "hunter2" });

  assert.equal(restored.userPreferences.email.accounts[0].password, "hunter2");
  assert.equal(restored.userPreferences.email.accounts[0].label, "Renamed");
});

test("hasInlineCredentials detects a file that still needs migrating", () => {
  assert.equal(hasInlineCredentials(settingsWith([emailAccount()], [])), true);
  assert.equal(hasInlineCredentials(settingsWith([], [taskAccount()])), true);
  assert.equal(hasInlineCredentials(settingsWith([emailAccount({ password: "" })], [])), false);
  assert.equal(hasInlineCredentials(structuredClone(DEFAULT_SETTINGS)), false);
});
