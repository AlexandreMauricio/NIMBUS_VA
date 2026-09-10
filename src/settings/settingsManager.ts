import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { SecretStore } from "../main/secretStore";
import {
  DEFAULT_SETTINGS,
  NimbusSettings,
  applyDefaults,
  extractSecrets,
  hasInlineCredentials,
  isLegacyShape,
  migrateLegacyShape,
  restoreSecrets,
} from "./settingsSchema";

/**
 * The Windows-client half of settings: where the file lives, how it is
 * written, and where credentials go. Everything about the *shape* of
 * settings — the types, the defaults, legacy migration, and the
 * plaintext/credential split — lives in `settingsSchema.ts`, which has no
 * Electron or filesystem dependency and is therefore unit-testable under
 * plain `node --test` (the same Core-vs-client boundary the logger and
 * context providers already follow).
 *
 * Credentials (IMAP passwords, Todoist API tokens) are not written to
 * settings.json at all — they go to the OS-encrypted `SecretStore`, and
 * are merged back in on load so every consumer still sees one plain
 * `NimbusSettings`. See settingsSchema's extractSecrets/restoreSecrets.
 */

// Re-exported so existing importers (lifecycle.ts, providers, tests)
// keep getting the settings types from the same module they always have.
export * from "./settingsSchema";

const secretStore = new SecretStore();

/**
 * The settings objects whose credentials have been filled in from the
 * store. Only these may write credentials back: any other object's
 * credential fields are blanks (see `loadSettings`), and writing those
 * would erase what is stored.
 *
 * Tracked per object rather than as a single "hydration has happened"
 * flag, so the guard states the property that actually matters — this
 * object is safe to write — instead of a global that a second settings
 * object silently inherits.
 */
const hydratedSettings = new WeakSet<NimbusSettings>();

function getSettingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/**
 * Reads settings.json. Safe to call before Electron's `app` is ready —
 * and it deliberately does NOT touch the credential store, because that
 * is not: `safeStorage.isEncryptionAvailable()` returns a silent `false`
 * before the ready event, so reading credentials here would report every
 * one of them as unset.
 *
 * Credentials are filled in afterwards by `hydrateCredentials`. This is
 * the same lazy-until-ready discipline SpotifyTokenStore's caller
 * already follows (see SpotifyAuthManager.ensureLoaded).
 */
export function loadSettings(): NimbusSettings {
  const filePath = getSettingsFilePath();

  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (isLegacyShape(parsed)) {
      logger.info("Migrating settings.json from pre-split legacy shape");
    }
    return applyDefaults(migrateLegacyShape(parsed));
  } catch (err) {
    logger.warn("Failed to read settings.json, falling back to defaults", {
      error: String(err),
    });
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * Fills the credentials into an already-loaded settings object. MUST be
 * called after Electron's `app` is ready and before anything reads or
 * writes a credential — `startApp` calls it first thing on ready.
 *
 * Until this runs, `saveSettings` refuses to touch the credential store
 * at all (see `credentialsHydrated`). That guard is what makes the
 * split safe: without it, a save in the window between load and
 * hydration would strip the in-memory blanks into the store and delete
 * every stored credential.
 */
export function hydrateCredentials(settings: NimbusSettings): NimbusSettings {
  // A settings.json written before credentials moved into the store
  // still has them inline. restoreSecrets keeps those, and the save
  // below moves them into the store and strips the plaintext, so it
  // stops sitting on disk from the first launch after the upgrade.
  const migratingCredentials = hasInlineCredentials(settings);
  const hydrated = restoreSecrets(settings, secretStore.readAll());
  hydratedSettings.add(hydrated);

  if (migratingCredentials) {
    logger.info("Moving credentials out of settings.json into OS-encrypted storage");
    saveSettings(hydrated);
  }

  return hydrated;
}

/**
 * Writes settings atomically: serialize to a temp file in the same
 * directory, flush it to disk, then `rename` over the real one (an
 * atomic replace on NTFS as long as both paths share a volume, which a
 * sibling temp file always does).
 *
 * A plain `writeFileSync` to the real path truncates it first, so a
 * crash or power loss mid-write leaves a half-written file. `loadSettings`
 * cannot tell that from corruption — it catches the parse error and
 * falls back to defaults, silently discarding every routine, account and
 * credential the user had configured. The rename dance means the real
 * file is only ever the old complete version or the new complete one.
 */
export function saveSettings(settings: NimbusSettings): void {
  const filePath = getSettingsFilePath();
  const tempPath = `${filePath}.tmp`;

  // Credentials are peeled off here and never reach settings.json.
  const { sanitized, secrets } = extractSecrets(settings);

  if (hydratedSettings.has(settings)) {
    secretStore.writeAll(secrets);
  } else {
    // This object's credentials are blanks, so writing them would clear
    // the store — the exact bug this guard exists for. Nothing should
    // save this early; if something does, settings.json is still
    // written and the stored credentials are left alone.
    logger.warn("Settings saved before credentials were hydrated — leaving the credential store untouched");
  }

  try {
    const serialized = JSON.stringify(sanitized, null, 2);
    // Written through an explicit fd so the contents can be fsync'd before
    // the rename — without that, the rename can land ahead of the data on
    // a crash, which produces exactly the empty/truncated file this is
    // meant to prevent.
    const fd = fs.openSync(tempPath, "w");
    try {
      fs.writeFileSync(fd, serialized, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    // Logged at debug so a normal session isn't noisy, but it names the
    // resolved path: "settings.json is stale" was impossible to diagnose
    // without knowing which settings.json the running app meant, and
    // silence here was indistinguishable from a save that never ran.
    logger.debug("settings.json written", { path: filePath, bytes: serialized.length });
  } catch (err) {
    logger.error("Failed to write settings.json", { error: String(err) });
    // Never leave a stray temp file behind to be mistaken for real state.
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best effort — the write already failed and was logged above.
    }
  }
}
