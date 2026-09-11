import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyAuthManager } from "./spotifyAuthManager";
import { SpotifyTokenStore, StoredSpotifyTokens } from "./spotifyTokenStore";

type AuthConfig = ConstructorParameters<typeof SpotifyAuthManager>[0];
const config = (() => ({ clientId: "client", redirectPort: 8888 })) as unknown as AuthConfig;

function fakeStore(tokens: StoredSpotifyTokens | null) {
  let readable = false;
  let reads = 0;
  const store = {
    isReadable: () => readable,
    read: () => {
      reads++;
      return tokens;
    },
    write: () => {},
    clear: () => {},
  } as unknown as SpotifyTokenStore;
  return { store, makeReadable: () => (readable = true), reads: () => reads };
}

const STORED: StoredSpotifyTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60 * 60_000,
};

test("asking before secure storage is ready doesn't settle on 'disconnected' for the session", () => {
  const fake = fakeStore(STORED);
  const auth = new SpotifyAuthManager(config, fake.store, fetch, async () => {});

  // Something asks during startup, before the app is ready.
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(fake.reads(), 0, "nothing read, nothing concluded");

  fake.makeReadable();
  assert.equal(auth.isAuthenticated(), true, "the stored login is found once storage is ready");
  assert.equal(auth.isAuthenticated(), true);
  assert.equal(fake.reads(), 1, "read once, then kept");
});

test("once readable, nothing stored simply means disconnected", async () => {
  const fake = fakeStore(null);
  fake.makeReadable();
  const auth = new SpotifyAuthManager(config, fake.store, fetch, async () => {});

  assert.equal(auth.isAuthenticated(), false);
  assert.equal(await auth.getAccessToken(), null);
  assert.equal(fake.reads(), 1);
});

test("a valid stored access token is used as it is", async () => {
  const fake = fakeStore(STORED);
  fake.makeReadable();
  const auth = new SpotifyAuthManager(config, fake.store, fetch, async () => {});

  assert.equal(await auth.getAccessToken(), "access");
});
