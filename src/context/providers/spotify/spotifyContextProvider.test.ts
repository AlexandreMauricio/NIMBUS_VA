import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyContextProvider } from "./spotifyContextProvider";
import { SpotifyApiClient, SpotifyApiError, RawSpotifyPlaybackState } from "./spotifyApiClient";

function stubClient(impl: () => Promise<RawSpotifyPlaybackState | null>): SpotifyApiClient {
  return { getCurrentPlayback: impl } as unknown as SpotifyApiClient;
}

test("isAvailable is false when Spotify is disabled", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: false }),
    stubClient(async () => null),
    () => true
  );
  assert.equal(await provider.isAvailable(), false);
});

test("isAvailable is false when enabled but not authenticated", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => null),
    () => false
  );
  assert.equal(await provider.isAvailable(), false);
});

test("isAvailable is true when enabled and authenticated", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => null),
    () => true
  );
  assert.equal(await provider.isAvailable(), true);
});

test("no active playback maps to a stopped state with no track", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => null),
    () => true
  );
  const ctx = await provider.getContext();
  assert.equal(ctx.playbackState, "stopped");
  assert.equal(ctx.track, null);
});

test("an actively playing track maps to a full playback context", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => ({
      is_playing: true,
      progress_ms: 30000,
      item: {
        id: "t1",
        name: "The Trooper",
        artists: [{ name: "Iron Maiden" }],
        album: { name: "Piece of Mind", images: [{ url: "https://img/1.jpg" }] },
        duration_ms: 240000,
        uri: "spotify:track:t1",
      },
      device: { id: "d1", name: "Desktop", type: "Computer", is_active: true, volume_percent: 65 },
    })),
    () => true
  );

  const ctx = await provider.getContext();
  assert.equal(ctx.playbackState, "playing");
  assert.equal(ctx.track?.name, "The Trooper");
  assert.deepEqual(ctx.track?.artists, ["Iron Maiden"]);
  assert.equal(ctx.track?.album, "Piece of Mind");
  assert.equal(ctx.progressMs, 30000);
  assert.equal(ctx.volumePercent, 65);
  assert.equal(ctx.device?.name, "Desktop");
  assert.equal(ctx.device?.supportsVolume, true);
});

test("a device that explicitly reports supports_volume:false maps to supportsVolume:false", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => ({
      is_playing: true,
      item: { id: "t1", name: "Song", artists: [{ name: "Someone" }], uri: "spotify:track:t1" },
      device: { id: "d1", name: "Shared Speaker", is_active: true, supports_volume: false },
    })),
    () => true
  );
  const ctx = await provider.getContext();
  assert.equal(ctx.device?.supportsVolume, false);
});

test("a device with no supports_volume field defaults to supported (fail open)", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => ({
      is_playing: true,
      item: { id: "t1", name: "Song", artists: [{ name: "Someone" }], uri: "spotify:track:t1" },
      device: { id: "d1", name: "Unknown Device", is_active: true },
    })),
    () => true
  );
  const ctx = await provider.getContext();
  assert.equal(ctx.device?.supportsVolume, true);
});

test("a paused track maps playbackState to paused, not playing or stopped", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => ({
      is_playing: false,
      item: { id: "t1", name: "Paused Song", artists: [{ name: "Someone" }], uri: "spotify:track:t1" },
    })),
    () => true
  );
  const ctx = await provider.getContext();
  assert.equal(ctx.playbackState, "paused");
});

test("malformed/sparse playback data (missing artists/album/device) does not crash the provider", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => ({ is_playing: true, item: { id: "t1", name: "Bare", uri: "spotify:track:t1" } })),
    () => true
  );
  const ctx = await provider.getContext();
  assert.deepEqual(ctx.track?.artists, []);
  assert.equal(ctx.track?.album, null);
  assert.equal(ctx.device, null);
});

test("an authentication failure while fetching rejects getContext (for ContextService to catch)", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => {
      throw new SpotifyApiError("expired", "not_authenticated");
    }),
    () => true
  );
  await assert.rejects(() => provider.getContext());
});

test("an API failure rejects getContext (for ContextService to catch)", async () => {
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => {
      throw new SpotifyApiError("down", "unknown", 503);
    }),
    () => true
  );
  await assert.rejects(() => provider.getContext());
});

test("getContext caches results within the TTL instead of re-fetching", async () => {
  let fetchCount = 0;
  const provider = new SpotifyContextProvider(
    () => ({ enabled: true }),
    stubClient(async () => {
      fetchCount++;
      return null;
    }),
    () => true,
    () => new Date(),
    Date.now
  );

  await provider.getContext();
  await provider.getContext();
  assert.equal(fetchCount, 1);
});
