import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  generateState,
  buildAuthorizeUrl,
} from "./spotifyPkce";

test("generateCodeVerifier produces a string within PKCE's required length range", () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
});

test("generateCodeVerifier only uses URL-safe characters", () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/);
});

test("generateCodeVerifier produces different values each call", () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
});

test("codeChallengeFromVerifier is deterministic for the same verifier", () => {
  const verifier = "a-fixed-verifier-value-for-this-test-1234567890";
  assert.equal(codeChallengeFromVerifier(verifier), codeChallengeFromVerifier(verifier));
});

test("codeChallengeFromVerifier differs for different verifiers", () => {
  assert.notEqual(codeChallengeFromVerifier("verifier-one"), codeChallengeFromVerifier("verifier-two"));
});

test("codeChallengeFromVerifier is URL-safe base64 with no padding", () => {
  const challenge = codeChallengeFromVerifier(generateCodeVerifier());
  assert.doesNotMatch(challenge, /[+/=]/);
});

test("generateState produces different values each call", () => {
  assert.notEqual(generateState(), generateState());
});

test("buildAuthorizeUrl includes every required PKCE parameter", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "client123",
      redirectUri: "http://127.0.0.1:8888/callback",
      codeChallenge: "challenge-value",
      state: "state-value",
      scopes: ["user-read-playback-state", "user-modify-playback-state"],
    })
  );

  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(url.searchParams.get("client_id"), "client123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8888/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("scope"), "user-read-playback-state user-modify-playback-state");
});

test("buildAuthorizeUrl never includes a client secret parameter", () => {
  const url = buildAuthorizeUrl({
    clientId: "client123",
    redirectUri: "http://127.0.0.1:8888/callback",
    codeChallenge: "x",
    state: "y",
    scopes: [],
  });
  assert.doesNotMatch(url.toLowerCase(), /secret/);
});
