import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyApiClient, SpotifyApiError, mapPlaylists } from "./spotifyApiClient";

function fakeResponse(opts: { status: number; body?: unknown; ok?: boolean }): Response {
  const { status, body, ok = status >= 200 && status < 300 } = opts;
  const text = body === undefined ? "" : JSON.stringify(body);
  const response = {
    ok,
    status,
    text: async () => text,
    json: async () => (body === undefined ? undefined : JSON.parse(text)),
    clone(): Response {
      return response;
    },
  } as unknown as Response;
  return response;
}

function fakeFetch(response: Response | (() => Response), capturedRequests?: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capturedRequests?.push({ url: String(url), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
}

function clientWithToken(token: string | null, response: Response | (() => Response), captured?: Array<{ url: string; init: RequestInit }>) {
  return new SpotifyApiClient(async () => token, fakeFetch(response, captured));
}

test("getCurrentPlayback returns null on a 204 (nothing playing)", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 204 }));
  const result = await client.getCurrentPlayback();
  assert.equal(result, null);
});

test("getCurrentPlayback maps a normal response into the raw playback shape", async () => {
  const body = {
    is_playing: true,
    progress_ms: 42000,
    item: { id: "t1", name: "Song", artists: [{ name: "Artist" }], duration_ms: 200000, uri: "spotify:track:t1" },
    device: { id: "d1", name: "Laptop", is_active: true, volume_percent: 70 },
  };
  const client = clientWithToken("tok", fakeResponse({ status: 200, body }));
  const result = await client.getCurrentPlayback();
  assert.equal(result?.item?.name, "Song");
  assert.equal(result?.device?.name, "Laptop");
});

test("no access token throws not_authenticated without making a network call", async () => {
  let called = false;
  const client = new SpotifyApiClient(
    async () => null,
    (async () => {
      called = true;
      return fakeResponse({ status: 200 });
    }) as unknown as typeof fetch
  );

  await assert.rejects(() => client.getCurrentPlayback(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "not_authenticated");
    return true;
  });
  assert.equal(called, false);
});

test("a 401 response maps to not_authenticated", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 401 }));
  await assert.rejects(() => client.pause(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "not_authenticated");
    return true;
  });
});

test("a 429 response maps to rate_limited", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 429 }));
  await assert.rejects(() => client.next(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "rate_limited");
    return true;
  });
});

test("a 404 with reason NO_ACTIVE_DEVICE maps to no_active_device", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 404, body: { error: { reason: "NO_ACTIVE_DEVICE" } } }));
  await assert.rejects(() => client.play(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "no_active_device");
    return true;
  });
});

test("a plain 404 (no known reason) maps to not_found", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 404, body: {} }));
  await assert.rejects(() => client.search("xyz", ["track"]), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "not_found");
    return true;
  });
});

test("a 403 with reason PREMIUM_REQUIRED maps to not_available", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 403, body: { error: { reason: "PREMIUM_REQUIRED" } } }));
  await assert.rejects(() => client.play(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "not_available");
    return true;
  });
});

test("an unexpected status maps to unknown, carrying the HTTP status", async () => {
  const client = clientWithToken("tok", fakeResponse({ status: 503 }));
  await assert.rejects(() => client.previous(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "unknown");
    assert.equal(err.status, 503);
    return true;
  });
});

test("a network-level fetch failure maps to network", async () => {
  const client = new SpotifyApiClient(
    async () => "tok",
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch
  );
  await assert.rejects(() => client.getCurrentPlayback(), (err: unknown) => {
    assert.ok(err instanceof SpotifyApiError);
    assert.equal(err.category, "network");
    return true;
  });
});

test("setVolume sends the rounded percentage as a query parameter", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const client = clientWithToken("tok", fakeResponse({ status: 200 }), captured);
  await client.setVolume(42.6);
  assert.match(captured[0].url, /volume_percent=43/);
});

test("play with a context URI sends it in the request body", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const client = clientWithToken("tok", fakeResponse({ status: 200 }), captured);
  await client.play({ contextUri: "spotify:playlist:abc" });
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.context_uri, "spotify:playlist:abc");
});

test("search sends the query, types, and limit as query parameters", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const client = clientWithToken("tok", fakeResponse({ status: 200, body: {} }), captured);
  await client.search("Iron Maiden", ["track", "artist"], 5);
  assert.match(captured[0].url, /q=Iron\+Maiden|q=Iron%20Maiden/);
  assert.match(captured[0].url, /type=track%2Cartist/);
  assert.match(captured[0].url, /limit=5/);
});

test("listPlaylists returns the raw playlist items from /me/playlists", async () => {
  const body = { items: [{ id: "p1", name: "Study", uri: "spotify:playlist:p1" }] };
  const client = clientWithToken("tok", fakeResponse({ status: 200, body }));
  const playlists = await client.listPlaylists();
  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].name, "Study");
});

test("listPlaylists never downloads track contents — only requests the playlists endpoint", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const client = clientWithToken("tok", fakeResponse({ status: 200, body: { items: [] } }), captured);
  await client.listPlaylists();
  assert.match(captured[0].url, /\/me\/playlists/);
  assert.doesNotMatch(captured[0].url, /tracks/);
});

test("mapPlaylists maps raw playlists to the minimal display shape", () => {
  const raw = [
    {
      id: "p1",
      name: "Study Playlist",
      uri: "spotify:playlist:p1",
      owner: { display_name: "Alex" },
      images: [{ url: "https://img/study.jpg" }],
      tracks: { total: 42 },
    },
  ];
  const result = mapPlaylists(raw);
  assert.deepEqual(result[0], {
    id: "p1",
    name: "Study Playlist",
    uri: "spotify:playlist:p1",
    ownerName: "Alex",
    imageUrl: "https://img/study.jpg",
    trackCount: 42,
  });
});

test("mapPlaylists handles missing optional fields (owner/images/tracks) without crashing", () => {
  const raw = [{ id: "p2", name: "Bare", uri: "spotify:playlist:p2" }];
  const result = mapPlaylists(raw);
  assert.equal(result[0].ownerName, null);
  assert.equal(result[0].imageUrl, null);
  assert.equal(result[0].trackCount, null);
});

test("mapPlaylists filters out entries missing an id or uri (malformed API data)", () => {
  const raw = [{ name: "No id", uri: "" } as never, { id: "p3", name: "Fine", uri: "spotify:playlist:p3" }];
  const result = mapPlaylists(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "p3");
});

test("getCurrentPlayback maps the playback context (e.g. a playlist) when Spotify reports one", async () => {
  const body = {
    is_playing: true,
    item: { id: "t1", name: "Song", uri: "spotify:track:t1" },
    context: { type: "playlist", uri: "spotify:playlist:p1" },
  };
  const client = clientWithToken("tok", fakeResponse({ status: 200, body }));
  const result = await client.getCurrentPlayback();
  assert.deepEqual(result?.context, { type: "playlist", uri: "spotify:playlist:p1" });
});

test("the access token is sent only as a Bearer header, never in the URL or body", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const client = clientWithToken("super-secret-token", fakeResponse({ status: 200, body: {} }), captured);
  await client.search("test", ["track"]);

  assert.ok(!captured[0].url.includes("super-secret-token"));
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer super-secret-token");
});
