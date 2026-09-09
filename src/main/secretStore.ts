import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import { logger } from "../logging/logger";

/**
 * A general key/value store for credentials, encrypted with the OS-level
 * secure storage Electron exposes via `safeStorage` (Windows DPAPI, tied
 * to the logged-in user account).
 *
 * This is the generalization of what `SpotifyTokenStore` already does for
 * OAuth tokens, extended to the other credentials NIMBUS holds — IMAP
 * passwords and Todoist API tokens — which were previously written in
 * plaintext into `settings.json` alongside window bounds. The IPC layer
 * was already careful with them (write-only to the renderer, never
 * logged); this closes the same gap on disk.
 *
 * Kept in its own file (`secrets.json`) rather than mixed into
 * `settings.json` for the same reason Spotify's tokens are: encrypted
 * blobs have no business sitting in a file a user might reasonably
 * expect to be plain, readable preferences — and it means `settings.json`
 * stays safe to inspect, diff, or paste into a bug report.
 *
 * Spotify keeps its own dedicated store rather than moving here: its
 * value is a structured token triple with refresh semantics, not a bare
 * string, and that module is deliberately the single place that touches
 * Spotify tokens.
 *
 * Windows-specific (Electron `safeStorage`), so it lives under
 * `src/main/` rather than in Core — a future client supplies its own
 * platform equivalent.
 */

/** A stable identifier for one secret, e.g. `email.<accountId>.password`. */
export type SecretKey = string;

interface EncryptedSecretFile {
  /** key -> base64 of the safeStorage-encrypted value. */
  secrets: Record<string, string>;
}

function secretFilePath(): string {
  return path.join(app.getPath("userData"), "secrets.json");
}

export class SecretStore {
  /**
   * Reads every stored secret. Returns an empty map — never throws — when
   * the file is missing, unreadable, or encryption isn't available, so a
   * caller can always treat "no secret for this key" as the normal
   * not-configured case.
   */
  readAll(): Record<SecretKey, string> {
    const filePath = secretFilePath();
    if (!fs.existsSync(filePath)) return {};

    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn("OS secure storage unavailable — cannot read stored credentials");
      return {};
    }

    let parsed: EncryptedSecretFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as EncryptedSecretFile;
    } catch (err) {
      logger.warn("Failed to read secrets file — treating all credentials as unset", {
        error: String(err),
      });
      return {};
    }

    const out: Record<SecretKey, string> = {};
    for (const [key, encrypted] of Object.entries(parsed.secrets ?? {})) {
      try {
        out[key] = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      } catch (err) {
        // One undecryptable entry (e.g. copied from another machine, where
        // DPAPI can't unwrap it) must not take the rest down with it —
        // that account simply reads as "no credential saved".
        logger.warn("Failed to decrypt a stored credential — treating it as unset", {
          key,
          error: String(err),
        });
      }
    }
    return out;
  }

  /**
   * Replaces the stored set with exactly `secrets` — keys absent here are
   * deleted. Callers always hold the full picture (settings own the list
   * of accounts), so a whole-file write keeps the store from accumulating
   * orphans when an account is removed.
   *
   * Fails safe rather than falling back to plaintext, matching
   * SpotifyTokenStore: without OS secure storage, credentials just don't
   * persist across restarts.
   */
  writeAll(secrets: Record<SecretKey, string>): void {
    const filePath = secretFilePath();
    const entries = Object.entries(secrets).filter(([, value]) => value.length > 0);

    if (entries.length === 0) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (err) {
        logger.warn("Failed to remove empty secrets file", { error: String(err) });
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn("OS secure storage unavailable — credentials will not persist across restarts");
      return;
    }

    const encrypted: EncryptedSecretFile = { secrets: {} };
    for (const [key, value] of entries) {
      encrypted.secrets[key] = safeStorage.encryptString(value).toString("base64");
    }

    // Same temp-file-then-rename dance as settings.json — a torn write
    // here would read back as "all credentials gone".
    const tempPath = `${filePath}.tmp`;
    try {
      const fd = fs.openSync(tempPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(encrypted), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.error("Failed to persist credentials", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the write already failed and was logged above.
      }
    }
  }
}
