import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyActionProvider, SPOTIFY_ACTIONS } from "./spotifyActionProvider";
import { SpotifyApiClient, SpotifyApiError } from "../../context/providers/spotify/spotifyApiClient";

function stubClient(overrides: Partial<Record<keyof SpotifyApiClient, (...args: unknown[]) => unknown>> = {}): SpotifyApiClient {
  return {
    play: async () => undefined,
    pause: async () => undefined,
    next: async () => undefined,
    previous: async () => undefined,
    setVolume: async () => undefined,
    search: async () => ({}),
    getCurrentPlayback: async () => null,
    listDevices: async () => [],
    ...overrides,
  } as unknown as SpotifyApiClient;
}

function provider(client: SpotifyApiClient, enabled = true, authenticated = true): SpotifyActionProvider {
  return new SpotifyActionProvider(client, () => ({ enabled }), () => authenticated);
}

test("isAvailable is false when Spotify actions are disabled", async () => {
  const p = provider(stubClient(), false, true);
  assert.equal(await p.isAvailable(), false);
});

test("isAvailable is false when enabled but not authenticated", async () => {
  const p = provider(stubClient(), true, false);
  assert.equal(await p.isAvailable(), false);
});

test("play calls the client and returns a success result", async () => {
  let called = false;
  const p = provider(stubClient({ play: async () => { called = true; } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(called, true);
  assert.equal(result.status, "success");
  assert.equal(result.actionId, SPOTIFY_ACTIONS.PLAY);
});

test("pause calls the client and returns a success result", async () => {
  let called = false;
  const p = provider(stubClient({ pause: async () => { called = true; } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PAUSE, {});
  assert.equal(called, true);
  assert.equal(result.status, "success");
});

test("next calls the client and returns a success result", async () => {
  let called = false;
  const p = provider(stubClient({ next: async () => { called = true; } }));
  const result = await p.execute(SPOTIFY_ACTIONS.NEXT, {});
  assert.equal(called, true);
  assert.equal(result.status, "success");
});

test("previous calls the client and returns a success result", async () => {
  let called = false;
  const p = provider(stubClient({ previous: async () => { called = true; } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PREVIOUS, {});
  assert.equal(called, true);
  assert.equal(result.status, "success");
});

test("setVolume validation rejects an out-of-range value", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.SET_VOLUME, { volumePercent: 150 });
  assert.equal(result.valid, false);
});

test("setVolume validation rejects a non-numeric value", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.SET_VOLUME, { volumePercent: "loud" });
  assert.equal(result.valid, false);
});

test("setVolume validation accepts an in-range value", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.SET_VOLUME, { volumePercent: 50 });
  assert.equal(result.valid, true);
});

test("setVolume executes and reports the volume set", async () => {
  let receivedVolume: number | undefined;
  const p = provider(stubClient({ setVolume: async (v: unknown) => { receivedVolume = v as number; } }));
  const result = await p.execute(SPOTIFY_ACTIONS.SET_VOLUME, { volumePercent: 42 });
  assert.equal(receivedVolume, 42);
  assert.equal(result.status, "success");
  assert.match(result.message!, /42/);
});

test("playSearch with a track match plays the track and reports its name/artist", async () => {
  let playedUris: string[] | undefined;
  const p = provider(
    stubClient({
      search: async () => ({
        tracks: { items: [{ id: "t1", name: "The Trooper", artists: [{ name: "Iron Maiden" }], uri: "spotify:track:t1" }] },
      }),
      play: async (opts: unknown) => {
        playedUris = (opts as { uris?: string[] }).uris;
      },
    })
  );
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_SEARCH, { query: "The Trooper" });
  assert.equal(result.status, "success");
  assert.deepEqual(playedUris, ["spotify:track:t1"]);
  assert.match(result.message!, /The Trooper/);
  assert.match(result.message!, /Iron Maiden/);
});

test("playSearch with no results returns a not_found failure with a friendly message", async () => {
  const p = provider(stubClient({ search: async () => ({ tracks: { items: [] } }) }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_SEARCH, { query: "asdkfjaslkdfj" });
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_found");
  assert.match(result.error!.message, /couldn't find/i);
});

test("playSearch validation rejects an empty query", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.PLAY_SEARCH, { query: "" });
  assert.equal(result.valid, false);
});

test("playSearch validation rejects an unknown type", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.PLAY_SEARCH, { query: "x", type: "podcast" });
  assert.equal(result.valid, false);
});

test("playPlaylist with a match plays it via context URI", async () => {
  let playedContext: string | undefined;
  const p = provider(
    stubClient({
      search: async () => ({ playlists: { items: [{ name: "Gaming Mix", uri: "spotify:playlist:p1" }] } }),
      play: async (opts: unknown) => {
        playedContext = (opts as { contextUri?: string }).contextUri;
      },
    })
  );
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_PLAYLIST, { playlistQuery: "Gaming Mix" });
  assert.equal(result.status, "success");
  assert.equal(playedContext, "spotify:playlist:p1");
  assert.match(result.message!, /Gaming Mix/);
});

test("playPlaylist with an exact playlistUri plays it directly, without searching", async () => {
  let searchCalled = false;
  let playedContext: string | undefined;
  const p = provider(
    stubClient({
      search: async () => {
        searchCalled = true;
        return {};
      },
      play: async (opts: unknown) => {
        playedContext = (opts as { contextUri?: string }).contextUri;
      },
    })
  );
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_PLAYLIST, { playlistUri: "spotify:playlist:p1" });
  assert.equal(result.status, "success");
  assert.equal(playedContext, "spotify:playlist:p1");
  assert.equal(searchCalled, false);
});

test("playPlaylist validation accepts playlistUri alone (no playlistQuery needed)", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.PLAY_PLAYLIST, { playlistUri: "spotify:playlist:p1" });
  assert.equal(result.valid, true);
});

test("playPlaylist validation rejects when neither playlistQuery nor playlistUri is given", () => {
  const p = provider(stubClient());
  const result = p.validate(SPOTIFY_ACTIONS.PLAY_PLAYLIST, {});
  assert.equal(result.valid, false);
});

test("playPlaylist with no results returns a not_found failure", async () => {
  const p = provider(stubClient({ search: async () => ({ playlists: { items: [] } }) }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_PLAYLIST, { playlistQuery: "nonexistent" });
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_found");
});

test("an authentication failure from the client maps to a not_authenticated ActionError", async () => {
  const p = provider(stubClient({ play: async () => { throw new SpotifyApiError("expired", "not_authenticated"); } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_authenticated");
  assert.notEqual(result.error!.message, "expired"); // the raw API error string never leaks through unmodified
  assert.match(result.error!.message, /Spotify/i);
});

test("a no-active-device failure maps to a friendly, specific message", async () => {
  const p = provider(stubClient({ play: async () => { throw new SpotifyApiError("no device", "no_active_device"); } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(result.error?.category, "no_active_device");
  assert.match(result.error!.message, /no active Spotify device/i);
});

test("a no-active-device failure with no app-launcher configured behaves exactly as before (no retry attempted)", async () => {
  let playCalls = 0;
  const p = provider(
    stubClient({
      play: async () => {
        playCalls++;
        throw new SpotifyApiError("no device", "no_active_device");
      },
    })
  );
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(playCalls, 1);
  assert.equal(result.error?.category, "no_active_device");
});

test("a no-active-device failure opens Spotify and retries once, succeeding if a device becomes available", async () => {
  let playCalls = 0;
  let appOpened = false;
  const client = stubClient({
    play: async () => {
      playCalls++;
      if (playCalls === 1) throw new SpotifyApiError("no device", "no_active_device");
      // second call (the retry) succeeds — simulates Spotify registering a device after launch
    },
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {
      appOpened = true;
    },
    0, // no real wait in tests
    async () => {} // instant wait
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(appOpened, true);
  assert.equal(playCalls, 2);
  assert.equal(result.status, "success");
});

test("the retry after opening Spotify explicitly targets a newly-available device — being open isn't the same as being active", async () => {
  const playCalls: Array<Record<string, unknown> | undefined> = [];
  const client = stubClient({
    play: async (opts?: unknown) => {
      playCalls.push(opts as Record<string, unknown> | undefined);
      if (playCalls.length === 1) throw new SpotifyApiError("no device", "no_active_device");
    },
    listDevices: async () => [
      { id: "phone-1", type: "Smartphone" },
      { id: "desktop-1", type: "Computer" },
    ],
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {},
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(result.status, "success");
  assert.equal(playCalls.length, 2);
  // Prefers the "Computer" device (the one openSpotifyApp just launched) over other available devices.
  assert.equal(playCalls[1]?.deviceId, "desktop-1");
});

test("when no device has a usable id, the retry still attempts a plain play rather than erroring out early", async () => {
  let playCalls = 0;
  const client = stubClient({
    play: async () => {
      playCalls++;
      if (playCalls === 1) throw new SpotifyApiError("no device", "no_active_device");
    },
    listDevices: async () => [],
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {},
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(playCalls, 2);
  assert.equal(result.status, "success");
});

test("a no-active-device failure that persists after opening Spotify reports a clear 'try again' message, not a raw failure", async () => {
  let playCalls = 0;
  const client = stubClient({
    play: async () => {
      playCalls++;
      throw new SpotifyApiError("no device", "no_active_device");
    },
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {},
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(playCalls, 2); // original attempt + the one retry
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "no_active_device");
  assert.match(result.error!.message, /opened Spotify/i);
});

test("if opening Spotify itself fails (e.g. not installed), the original no-active-device error is reported, not a secondary one", async () => {
  const client = stubClient({
    play: async () => {
      throw new SpotifyApiError("no device", "no_active_device");
    },
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {
      throw new Error("spotify: protocol not registered");
    },
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "no_active_device");
  assert.doesNotMatch(result.error!.message, /opened Spotify/i);
});

test("the device fallback only triggers for no_active_device — a different failure never launches Spotify", async () => {
  let appOpened = false;
  const client = stubClient({
    play: async () => {
      throw new SpotifyApiError("expired", "not_authenticated");
    },
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {
      appOpened = true;
    },
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY, {});
  assert.equal(appOpened, false);
  assert.equal(result.error?.category, "not_authenticated");
});

test("the device fallback also applies to playPlaylist and playSearch, not just play", async () => {
  let playCalls = 0;
  const client = stubClient({
    search: async () => ({ playlists: { items: [{ name: "Gaming", uri: "spotify:playlist:p1" }] } }),
    play: async () => {
      playCalls++;
      if (playCalls === 1) throw new SpotifyApiError("no device", "no_active_device");
    },
  });
  const p = new SpotifyActionProvider(
    client,
    () => ({ enabled: true }),
    () => true,
    () => new Date(),
    async () => {},
    0,
    async () => {}
  );

  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_PLAYLIST, { playlistQuery: "Gaming" });
  assert.equal(playCalls, 2);
  assert.equal(result.status, "success");
});

test("a rate-limited failure maps to rate_limited", async () => {
  const p = provider(stubClient({ next: async () => { throw new SpotifyApiError("429", "rate_limited"); } }));
  const result = await p.execute(SPOTIFY_ACTIONS.NEXT, {});
  assert.equal(result.error?.category, "rate_limited");
});

test("an unexpected error is never leaked raw — it maps to a generic unknown failure", async () => {
  const p = provider(stubClient({ pause: async () => { throw new Error("some raw stack trace detail"); } }));
  const result = await p.execute(SPOTIFY_ACTIONS.PAUSE, {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "unknown");
  assert.doesNotMatch(result.error!.message, /stack trace/);
});

test("malformed search API data (missing items array) does not crash execution", async () => {
  const p = provider(stubClient({ search: async () => ({}) }));
  const result = await p.execute(SPOTIFY_ACTIONS.PLAY_SEARCH, { query: "test" });
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_found");
});

test("listActions declares every Spotify action with no confirmation required", () => {
  const p = provider(stubClient());
  const actions = p.listActions();
  assert.equal(actions.length, 7);
  assert.ok(actions.every((a) => a.requiresConfirmation === false));
  assert.ok(actions.every((a) => a.changesExternalState === true));
  assert.ok(actions.every((a) => a.affectsService === "spotify"));
});

test("validate rejects an unknown action id", () => {
  const p = provider(stubClient());
  const result = p.validate("spotify.doesNotExist", {});
  assert.equal(result.valid, false);
});
