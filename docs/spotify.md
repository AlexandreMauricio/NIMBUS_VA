# Spotify

An Action Provider —
[src/actions/providers/spotifyActionProvider.ts](../src/actions/providers/spotifyActionProvider.ts)
— plus a companion Context Provider for the read side —
[src/context/providers/spotify/](../src/context/providers/spotify/). The
split matters: **"what's playing" is Context, "play this" is an Action**,
and both share one `SpotifyApiClient`.

- **Integration**: Spotify's Web API, authenticated with **Authorization
  Code + PKCE**, which needs no client secret — only a Client ID from your
  own free Spotify Developer app (https://developer.spotify.com/dashboard).
  The Client ID and redirect port come from `.env`
  (`NIMBUS_SPOTIFY_CLIENT_ID`, `NIMBUS_SPOTIFY_REDIRECT_PORT`, default
  8888); there is no field for them in the UI. Add
  `http://127.0.0.1:<port>/callback` as a Redirect URI in your Spotify app.
  Playback control requires Spotify **Premium**; a `PREMIUM_REQUIRED`
  response becomes a clear "isn't available right now" failure.
- **Authentication flow**
  ([spotifyAuthManager.ts](../src/main/spotify/spotifyAuthManager.ts),
  [spotifyPkce.ts](../src/main/spotify/spotifyPkce.ts)): **Connect** in
  Settings generates a PKCE verifier/challenge and a `state` value, opens
  your **system browser** on Spotify's sign-in page (NIMBUS never sees the
  password), and listens on `127.0.0.1:<port>/callback` for up to 5
  minutes. The returned code (checked against `state`) is exchanged for
  access and refresh tokens, and the listener closes. Scopes requested:
  `user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`, `playlist-read-private` and
  `playlist-read-collaborative` — playback plus reading (never editing)
  your playlist list.
- **Tokens** ([spotifyTokenStore.ts](../src/main/spotify/spotifyTokenStore.ts)):
  encrypted with Electron's `safeStorage` (Windows DPAPI) into
  `spotify-tokens.json`, written atomically — the same protection
  `secretStore.ts` gives IMAP passwords and Todoist tokens. Nothing is
  ever in `settings.json`. Without OS encryption, tokens are not
  persisted (you'd reconnect each launch). The access token is refreshed
  shortly before it expires. If a refresh is rejected (e.g. access
  revoked in Spotify), NIMBUS still shows "connected" but every call fails
  as not authenticated until you disconnect and reconnect.
- **Multi-device/Electron boundary**: `SpotifyApiClient` depends only on an
  injected `getAccessToken()`; `SpotifyAuthManager` is the only
  Electron-shaped Spotify module.
- **Actions** (all `spotify.*`, none flagged as needing confirmation):
  `play` (resume), `pause`, `next`, `previous`, `setVolume`
  (`0 ≤ volumePercent ≤ 100`), `playSearch` (plays the best search match —
  tracks by default — or fails with "I couldn't find that on Spotify."),
  and `playPlaylist` (plays an exact `playlistUri` when given — which is
  what routines store — otherwise searches by `playlistQuery`). When
  playback fails because there is **no active device**, NIMBUS opens the
  Spotify desktop app (`spotify:` protocol), waits briefly and retries
  once against a newly available device.
- **Context** ([types.ts](../src/context/providers/spotify/types.ts)):
  `playbackState` (`playing` | `paused` | `stopped`), the current `track`
  (name, artists, album, duration, artwork), progress, volume, device, and
  the playing context (e.g. a playlist URI). `isAvailable()` is enabled +
  connected, so "not connected" is `status: "unavailable"`. Cached for 20
  seconds; any Spotify action invalidates the cache.
- **Error handling**: every API failure maps to a category —
  `not_authenticated` (401 or no token), `no_active_device` (404 with
  `NO_ACTIVE_DEVICE`), `not_found` (other 404s), `rate_limited` (429),
  `not_available` (403, including `PREMIUM_REQUIRED`), `network`, or
  `unknown` — and each becomes a user-safe sentence, never raw API text.
  Every request has a 10-second timeout.
- **Settings** (`UserPreferences.spotify`): `enabled` (off by default) and
  `preferredDeviceId`. **`preferredDeviceId` is stored and passed through
  the settings API, but nothing sets it from the UI and playback never
  reads it** — Spotify's own active device is always used. Connection
  state isn't a setting; it's derived from whether a refresh token is
  stored. Settings → Spotify has the enable switch, the connection
  status, and Connect/Disconnect.

## Where it shows up

- The **Home now-playing card** (while Spotify is connected): artwork,
  title, artist, progress, Previous/Play-Pause/Next, a volume slider, and a
  playlist dropdown of your playlists. It polls every 5 seconds while the
  Home tab is visible, and refreshes right after any Spotify action —
  including one run from a routine or the suggestion popup.
- The **current activity card** on Home names the playing track.
- **Routines**: Spotify actions as steps, the `spotifyNotAlreadyPlaying`
  condition, and "Skip if already active" (compares the playing context
  with the routine's playlist URI).

## Security boundary

The renderer never gets a Spotify token or client. It can only call
`window.nimbus.executeAction(actionId, params)`, which goes through
`ActionService` — the id is checked against registered providers and the
params against the provider's `validate()`. `nimbus:get-spotify-settings`,
`nimbus:spotify-connect` and `nimbus:spotify-disconnect` return only a
`connected` boolean. `nimbus:spotify-list-playlists` returns playlist
metadata only (id, name, artwork, owner, track count) — never a
playlist's tracks.

## Tests

`spotifyApiClient.test.ts` (status mapping, the token only in a `Bearer`
header, request shapes, playlists), `spotifyContextProvider.test.ts`
(availability, playback mapping, sparse data, failures, caching),
`spotifyActionProvider.test.ts` (each action, validation, search,
playlists by URI and by query, the no-active-device retry, friendly error
messages), `spotifyProvider.integration.test.ts` (a broken Spotify never
breaks other providers or the briefing), and `spotifyPkce.test.ts`
(verifier, challenge, state, the authorize URL, never a client secret).
All Spotify calls use a fake `fetch`.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
