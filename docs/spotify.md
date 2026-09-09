# Spotify

The first real Action Provider — [src/actions/providers/spotifyActionProvider.ts](../src/actions/providers/spotifyActionProvider.ts)
— plus a companion Context Provider for the read side —
[src/context/providers/spotify/](../src/context/providers/spotify/). The
split matters: **"what's playing" is Context, "play this" is an Action**
— the task was explicit that a read operation must never be forced into
the Action system, so `spotify.currentPlayback` does not exist as an
action; it's `SpotifyContextProvider.getContext()` instead, fitting the
existing Context architecture exactly like weather/calendar/email/tasks.

- **Integration chosen**: Spotify's Web API, authenticated with
  **Authorization Code + PKCE** — the flow Spotify's own docs recommend
  for installed/desktop apps specifically because it needs no client
  secret at all (unlike the classic Authorization Code flow). This was
  the deciding factor: NIMBUS can talk to Spotify with only a public
  Client ID from the user's own free Spotify Developer app registration
  (https://developer.spotify.com/dashboard) — there is no client secret
  to ever generate, store, or accidentally leak. Playback control
  (play/pause/skip/volume/search) requires a Spotify Premium account on
  Spotify's side — a `PREMIUM_REQUIRED` API response is mapped to a clear
  "Spotify playback control isn't available right now" failure rather
  than a technical error (see "Error handling" below).
- **Authentication flow**
  ([spotifyAuthManager.ts](../src/main/spotify/spotifyAuthManager.ts),
  [spotifyPkce.ts](../src/main/spotify/spotifyPkce.ts)): clicking "Connect"
  in Settings generates a PKCE code verifier/challenge and a CSRF `state`
  value, opens the user's **system browser** to Spotify's own sign-in
  page (`shell.openExternal` — NIMBUS never sees the Spotify password),
  and starts a temporary local HTTP server on `127.0.0.1:<redirect
  port>/callback` to catch the redirect. Once Spotify redirects back with
  an authorization code, it's exchanged for an access + refresh token
  (again, no client secret involved) and the local server shuts down.
  Requests only the three scopes actually needed
  (`user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`) — nothing broader like library or
  profile access.
- **Token storage**
  ([spotifyTokenStore.ts](../src/main/spotify/spotifyTokenStore.ts)): unlike
  every other provider's credential (calendar's ICS URL, email's IMAP
  password, tasks' API token — all plain strings in `settings.json`),
  Spotify's tokens are encrypted at rest using Electron's `safeStorage`
  (Windows DPAPI, tied to the OS user account) and written to their own
  file (`spotify-tokens.json` in the userData directory), never
  `settings.json`. If OS-level secure storage isn't available on a given
  machine, NIMBUS fails safe — it declines to persist tokens rather than
  falling back to plaintext — logging a warning instead (see "Known
  limitations").
- **Multi-device/Electron boundary**: `SpotifyApiClient` (Core, see
  [spotifyApiClient.ts](../src/context/providers/spotify/spotifyApiClient.ts))
  depends only on an injected `getAccessToken(): Promise<string | null>`
  function — it has no idea a browser was opened or a local HTTP server
  was involved. `SpotifyAuthManager` is the *only* Spotify module that is
  inherently Electron/Windows-shaped; both `SpotifyContextProvider` and
  `SpotifyActionProvider` (Core) are handed nothing but that one function
  plus an `isAuthenticated()` check. A future Android client implements
  the same role with its platform's equivalent of "open a browser and
  catch a redirect" (typically a Custom Tab + App Link) without either
  Core class changing.
- **Actions implemented** (all under `spotify.*`, none require
  confirmation — see "Action safety" in [The Action system](action-system.md)):
  `play`, `pause`, `next`, `previous`, `setVolume` (validates
  `0 ≤ volumePercent ≤ 100` before ever calling Spotify), `playSearch`
  (searches track/artist/album — defaults to track — and plays the best
  match; returns a `not_found` failure with "I couldn't find that on
  Spotify." when nothing matches), and `playPlaylist` (searches playlists
  by name and plays the first match via its context URI).
- **Spotify Context**
  ([types.ts](../src/context/providers/spotify/types.ts)): `playbackState`
  ("playing" | "paused" | "stopped"), the current `track` (name, artists,
  album, duration, artwork URL) when one exists, `progressMs`,
  `volumePercent`, and `device` info (id/name/type/active) when Spotify
  reports one. `isAvailable()` is a real, cheap check (enabled +
  connected), so "not connected yet" is `status: "unavailable"`, not an
  error — same pattern as Calendar/Email/Tasks.
- **Caching**: a 20-second default via the same
  [TtlCache](../src/common/ttlCache.ts) every other provider uses — short
  enough that "what's playing" stays reasonably fresh, long enough that
  NIMBUS never polls Spotify on every single context fetch.
- **Error handling**
  (`SpotifyApiError`/`SpotifyApiErrorCategory` in `spotifyApiClient.ts`):
  every failure Spotify's API can return is mapped to one of a small set
  of categories — `not_authenticated` (401, or no token at all),
  `no_active_device` (a 404 with Spotify's own `NO_ACTIVE_DEVICE` reason
  code), `not_found` (any other 404, e.g. a search miss),
  `rate_limited` (429), `not_available` (403, including
  `PREMIUM_REQUIRED`), `network` (the request never reached Spotify at
  all), or `unknown`. `SpotifyActionProvider` turns each category into
  exactly the kind of user-safe sentence the task asked for — "I couldn't
  find that on Spotify.", "There's no active Spotify device available." —
  never a raw "Spotify API returned HTTP 404" string. None of this can
  crash NIMBUS: a Spotify failure surfaces as `status: "error"` on the
  Context tab or a structured `ActionResult` failure, exactly like every
  other provider's failure mode.
- **Settings** (`UserPreferences.spotify` in `settingsManager.ts`): a
  master `enabled` switch (off by default) and an optional
  `preferredDeviceId` — connection state itself is *not* a settings
  field; it's derived live from whether `SpotifyAuthManager` has a stored
  refresh token, so it can never drift out of sync with the actual
  tokens. Managed from the **Spotify** section of the Settings tab
  (enable toggle, Connect/Disconnect button, connection status, a "Now
  playing" readout, and basic Play/Pause/Next/Previous/volume controls —
  deliberately not a music player, per the task's own UI guidance); also
  settable via `NIMBUS_SPOTIFY_CLIENT_ID`/`NIMBUS_SPOTIFY_REDIRECT_PORT`
  in `.env`.
- **Logging**: every action execution logs `actionId`/`status`/
  `durationMs`/`error.category` only (see `ActionService.finish` in
  `actionService.ts`) — never full result data, never a raw API response,
  and (obviously) never a token. `spotifyAuthManager.ts`/
  `spotifyTokenStore.ts` log connect/disconnect/refresh-failed events by
  status only, the same discipline every other provider's auth code
  follows.

## Security boundary

The renderer never gets a Spotify token, a privileged API, or arbitrary
Node access — it can only call `window.nimbus.executeAction(actionId,
params)`, which invokes `nimbus:execute-action` in `lifecycle.ts` and
goes straight into `ActionService.executeAction`. That call validates the
action id against the registered providers and the params against the
provider's own `validate()` — there is no path from the renderer to
`SpotifyApiClient`, `SpotifyAuthManager`, or any other Node capability.
This matches the task's own example exactly: the renderer asks to
"execute Spotify pause action," never for raw API access.
`nimbus:get-spotify-settings`/`nimbus:spotify-connect`/
`nimbus:spotify-disconnect` follow the same shape as calendar/email/
tasks' settings IPC, returning only a `connected: boolean` — confirmed
live via CDP: enabling Spotify and attempting to connect without a
configured Client ID produced a clean `{ connected: false, error:
"Couldn't connect to Spotify." }` result, no token file was ever created,
and the log recorded only `Spotify client ID is not configured` at
`warn` level — no credential of any kind.

## Tests

`spotifyApiClient.test.ts` (204 "nothing playing", mapping a normal
playback response, no access token short-circuits before any network
call, 401→`not_authenticated`, 429→`rate_limited`, a 404 with
`NO_ACTIVE_DEVICE`→`no_active_device`, a plain 404→`not_found`, a 403
with `PREMIUM_REQUIRED`→`not_available`, an unmapped status→`unknown`
carrying the HTTP status, a network-level fetch failure→`network`,
volume rounding, a play request's context URI in the body, search query
parameters, and the token sent only as a `Bearer` header — never in a URL
or body), `spotifyContextProvider.test.ts` (availability with Spotify
disabled/not-authenticated/ready, no active playback → "stopped" with no
track, an actively playing track mapped fully, paused vs. playing vs.
stopped, malformed/sparse playback data — missing artists/album/device —
not crashing the provider, an authentication or API failure rejecting
`getContext()`, and cache hit within TTL),
`spotifyProvider.integration.test.ts` (a real `ContextService` with
`DateTimeProvider`/`SystemInfoProvider`/`WeatherProvider`/
`CalendarProvider`/`EmailProvider`/`TaskProvider` alongside a broken
Spotify context+action pairing — proves a Spotify failure affects neither
the other providers nor briefing generation, and that executing an action
against the same broken client degrades to a structured `ActionResult`),
`spotifyActionProvider.test.ts` (availability gating, play/pause/next/
previous each calling the right client method, volume validation
rejecting out-of-range and non-numeric values, a track search match
playing and naming the track/artist, no search results failing with
`not_found` and a friendly message, playlist search-and-play, an
authentication/no-active-device/rate-limited failure each mapped to the
right category and a friendly message with no raw error text leaking
through, malformed search API data not crashing execution, and
`listActions()` confirming every Spotify action declares
`requiresConfirmation: false`), and `spotifyPkce.test.ts` (verifier
length/character-set/randomness, deterministic-per-input code challenge
that differs across verifiers and is URL-safe, random state values, the
authorize URL carrying every required PKCE parameter, and — explicitly —
that it never includes a client secret parameter). All Spotify API/OAuth
calls are mocked via a fake `fetch` — no test reaches the real Spotify
API or needs a real account. This section's test files also gained
playlist retrieval/mapping coverage and the `playlistUri`-direct-play path
in a later task (see [Context-aware routines](routines.md) for why) — 63 tests
across `spotifyApiClient.test.ts`/`spotifyActionProvider.test.ts` today.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
