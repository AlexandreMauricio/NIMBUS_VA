import * as http from "http";
import { shell } from "electron";
import { logger } from "../../logging/logger";
import { SpotifyTokenStore, StoredSpotifyTokens } from "./spotifyTokenStore";
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  generateState,
  buildAuthorizeUrl,
} from "./spotifyPkce";
import { httpTimeoutSignal } from "../../common/timeout";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

// The minimum scopes needed for the actions/context NIMBUS implements —
// reading and controlling playback, and reading (never editing) the
// user's playlist list so a Routine or the Home card can offer one to
// play. No broader access (e.g. library editing, user profile, follows)
// is requested. `playlist-read-collaborative` covers playlists the user
// collaborates on but doesn't own, which `playlist-read-private` alone
// does not include.
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
];

const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000; // refresh slightly before actual expiry
const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface SpotifyAuthConfig {
  clientId: string | null;
  redirectPort: number;
}

/**
 * Runs Spotify's Authorization Code + PKCE flow and manages the resulting
 * tokens. This is the *only* Spotify module that is inherently
 * Electron/Windows-shaped (it opens the system browser and runs a
 * loopback HTTP server) — everything downstream (SpotifyApiClient,
 * SpotifyContextProvider, SpotifyActionProvider) only ever sees this
 * class's `getAccessToken`/`isAuthenticated` functions, never its
 * internals. A future Android client implements this same role with
 * whatever its platform's equivalent of "open a browser and catch a
 * redirect" is (a Custom Tab + App Link, typically) — see
 * ARCHITECTURE.md's integration-boundary sections for the established
 * pattern this follows.
 *
 * No client secret is ever used or stored — PKCE's whole point is that a
 * public, installed app doesn't need one (see spotifyPkce.ts).
 */
export class SpotifyAuthManager {
  private tokens: StoredSpotifyTokens | null = null;
  private tokensLoaded = false;
  private refreshPromise: Promise<string | null> | null = null;

  constructor(
    private readonly getConfig: () => SpotifyAuthConfig,
    private readonly tokenStore: SpotifyTokenStore = new SpotifyTokenStore(),
    private readonly fetchFn: typeof fetch = fetch,
    private readonly openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url)
  ) {}

  /**
   * Tokens are read lazily on first use rather than in the constructor.
   * `SpotifyAuthManager` is constructed during `startApp()`, before
   * Electron's `app.on("ready", ...)` fires — and `safeStorage` (which
   * `SpotifyTokenStore` depends on) is not reliably available that
   * early. Reading here instead means the first real read only ever
   * happens once something actually asks (isAvailable()/getContext()
   * calls, which only happen after the app is fully started), by which
   * point `app` is always ready. Caught via a real "reconnect needed
   * every restart" bug report — see README's Spotify section.
   */
  private ensureTokensLoaded(): void {
    if (this.tokensLoaded) return;
    this.tokensLoaded = true;
    this.tokens = this.tokenStore.read();
  }

  /** Whether a Spotify connection exists — a stored refresh token, not necessarily a currently-valid access token (that's refreshed lazily by getAccessToken). */
  isAuthenticated(): boolean {
    this.ensureTokensLoaded();
    return !!this.tokens?.refreshToken;
  }

  async getAccessToken(): Promise<string | null> {
    this.ensureTokensLoaded();
    if (!this.tokens) return null;
    if (this.tokens.expiresAt - TOKEN_EXPIRY_SAFETY_MS > Date.now()) {
      return this.tokens.accessToken;
    }
    return this.refreshAccessToken();
  }

  /** Opens the system browser for the user to approve access, waits for the local redirect, then exchanges the code for tokens. */
  async startAuthFlow(): Promise<void> {
    const config = this.getConfig();
    if (!config.clientId) {
      throw new Error("Spotify client ID is not configured");
    }

    const verifier = generateCodeVerifier();
    const challenge = codeChallengeFromVerifier(verifier);
    const state = generateState();
    const redirectUri = this.redirectUri(config.redirectPort);

    const codePromise = this.listenForRedirect(config.redirectPort, state);
    const authorizeUrl = buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri,
      codeChallenge: challenge,
      state,
      scopes: SCOPES,
    });
    await this.openExternal(authorizeUrl);

    const code = await codePromise;
    await this.exchangeCode(code, verifier, redirectUri, config.clientId);
  }

  disconnect(): void {
    this.tokens = null;
    this.tokensLoaded = true;
    this.tokenStore.clear();
    logger.info("Spotify disconnected");
  }

  private redirectUri(port: number): string {
    return `http://127.0.0.1:${port}/callback`;
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (this.refreshPromise) return this.refreshPromise;

    const config = this.getConfig();
    if (!config.clientId) return null;
    const clientId = config.clientId;
    const refreshToken = this.tokens.refreshToken;

    this.refreshPromise = (async () => {
      try {
        const response = await this.fetchFn(TOKEN_URL, {
          // See httpTimeoutSignal — a stalled token exchange must not
          // hang the auth flow (or the refresh every API call awaits).
          signal: httpTimeoutSignal(),
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: clientId,
          }),
        });
        if (!response.ok) {
          logger.warn("Spotify token refresh failed", { status: response.status });
          return null;
        }
        const body = (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        const updated: StoredSpotifyTokens = {
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? refreshToken,
          expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        };
        this.tokens = updated;
        this.tokenStore.write(updated);
        return updated.accessToken;
      } catch (err) {
        logger.warn("Spotify token refresh errored", { error: String(err) });
        return null;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  private listenForRedirect(port: number, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>You can close this window and return to NIMBUS.</body></html>");
        server.close();

        if (error) {
          settle(() => reject(new Error(`Spotify authorization was denied: ${error}`)));
        } else if (!code || state !== expectedState) {
          settle(() => reject(new Error("Spotify authorization response was invalid")));
        } else {
          settle(() => resolve(code));
        }
      });

      server.on("error", (err) => settle(() => reject(err)));
      server.listen(port, "127.0.0.1");

      const timeout = setTimeout(() => {
        server.close();
        settle(() => reject(new Error("Timed out waiting for Spotify authorization")));
      }, AUTH_FLOW_TIMEOUT_MS);
      timeout.unref();
    });
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
    clientId: string
  ): Promise<void> {
    const response = await this.fetchFn(TOKEN_URL, {
      // See httpTimeoutSignal — a stalled token exchange must not hang
      // the auth flow (or the refresh that every API call awaits).
      signal: httpTimeoutSignal(),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`Spotify token exchange failed with status ${response.status}`);
    }

    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };
    const tokens: StoredSpotifyTokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    this.tokens = tokens;
    this.tokensLoaded = true;
    this.tokenStore.write(tokens);
    logger.info("Spotify connected");
  }
}
