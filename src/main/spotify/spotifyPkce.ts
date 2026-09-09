import * as crypto from "crypto";

/**
 * Pure helpers for Spotify's Authorization Code + PKCE flow — the flow
 * NIMBUS uses specifically because it never requires a client secret,
 * only a public Client ID (see config.ts's SpotifyConfig doc comment and
 * docs/spotify.md for why this was chosen over the older
 * Authorization Code flow, which does need a secret).
 *
 * Kept separate from SpotifyAuthManager (the stateful class that actually
 * runs the flow — opens a browser, listens for the redirect, exchanges
 * tokens) so this math is unit-testable without any Electron dependency.
 */

const VERIFIER_LENGTH = 64; // within PKCE's required 43-128 char range

/** A cryptographically random string used as the PKCE code verifier. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(VERIFIER_LENGTH)).slice(0, VERIFIER_LENGTH);
}

/** The S256 PKCE code challenge derived from a verifier. */
export function codeChallengeFromVerifier(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

/** A random, unguessable value to protect the redirect against CSRF — must be echoed back and checked on callback. */
export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16));
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string[];
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scopes.join(" "));
  return url.toString();
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
