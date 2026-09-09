import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import { logger } from "../../logging/logger";

/**
 * Persists Spotify OAuth tokens using the OS-level secure storage Electron
 * exposes via `safeStorage` (Windows DPAPI, tied to the logged-in user
 * account) rather than writing them in plaintext to `settings.json` like
 * a URL or username. This module is intentionally the *only* place in
 * NIMBUS that touches Spotify tokens directly — SpotifyAuthManager reads/
 * writes through it, and everything above that (SpotifyApiClient,
 * SpotifyContextProvider, SpotifyActionProvider) only ever sees an opaque
 * "get me a current access token" function.
 *
 * Stored in its own file (not settings.json) so the encrypted blobs never
 * get mixed into a file a user might otherwise reasonably expect to be
 * plain, readable preferences.
 */

export interface StoredSpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when `accessToken` expires. */
  expiresAt: number;
}

interface EncryptedTokenFile {
  accessTokenEnc: string; // base64
  refreshTokenEnc: string; // base64
  expiresAt: number;
}

function tokenFilePath(): string {
  return path.join(app.getPath("userData"), "spotify-tokens.json");
}

export class SpotifyTokenStore {
  read(): StoredSpotifyTokens | null {
    const filePath = tokenFilePath();
    if (!fs.existsSync(filePath)) return null;

    if (!safeStorage.isEncryptionAvailable()) {
      // Fail safe rather than falling back to plaintext — see module doc.
      // A user on a system without OS-level secure storage available
      // simply can't have Spotify connection persisted across restarts.
      logger.warn("OS secure storage unavailable — cannot read stored Spotify tokens");
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as EncryptedTokenFile;
      return {
        accessToken: safeStorage.decryptString(Buffer.from(parsed.accessTokenEnc, "base64")),
        refreshToken: safeStorage.decryptString(Buffer.from(parsed.refreshTokenEnc, "base64")),
        expiresAt: parsed.expiresAt,
      };
    } catch (err) {
      logger.warn("Failed to read/decrypt stored Spotify tokens — treating as disconnected", {
        error: String(err),
      });
      return null;
    }
  }

  write(tokens: StoredSpotifyTokens): void {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn("OS secure storage unavailable — Spotify connection will not persist across restarts");
      return;
    }

    const encrypted: EncryptedTokenFile = {
      accessTokenEnc: safeStorage.encryptString(tokens.accessToken).toString("base64"),
      refreshTokenEnc: safeStorage.encryptString(tokens.refreshToken).toString("base64"),
      expiresAt: tokens.expiresAt,
    };

    try {
      fs.writeFileSync(tokenFilePath(), JSON.stringify(encrypted), "utf-8");
    } catch (err) {
      logger.error("Failed to persist Spotify tokens", { error: String(err) });
    }
  }

  clear(): void {
    try {
      const filePath = tokenFilePath();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn("Failed to remove stored Spotify tokens", { error: String(err) });
    }
  }
}
