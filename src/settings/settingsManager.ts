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

function getSettingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): NimbusSettings {
  const filePath = getSettingsFilePath();
  let settings: NimbusSettings;

  try {
    if (!fs.existsSync(filePath)) {
      settings = structuredClone(DEFAULT_SETTINGS);
    } else {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (isLegacyShape(parsed)) {
        logger.info("Migrating settings.json from pre-split legacy shape");
      }
      settings = applyDefaults(migrateLegacyShape(parsed));
    }
  } catch (err) {
    logger.warn("Failed to read settings.json, falling back to defaults", {
      error: String(err),
    });
    settings = structuredClone(DEFAULT_SETTINGS);
  }

  // A pre-SecretStore settings.json still has credentials inline;
  // restoreSecrets keeps those, and the save below moves them into the
  // encrypted store and strips them from settings.json. Doing it here
  // (rather than waiting for the user's next settings edit) means the
  // plaintext stops sitting on disk from the first launch after upgrade.
  const migratingCredentials = hasInlineCredentials(settings);
  settings = restoreSecrets(settings, secretStore.readAll());

  if (migratingCredentials) {
    logger.info("Moving credentials out of settings.json into OS-encrypted storage");
    saveSettings(settings);
  }

  return settings;
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
  secretStore.writeAll(secrets);

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
