/**
 * Thin wrapper over Spotify's Web API — the external-integration layer
 * for Spotify, playing the same role OpenMeteoClient/IcsCalendarSource/
 * ImapEmailSource/TodoistTaskSource play for their services (see
 * ARCHITECTURE.md). Both SpotifyContextProvider and SpotifyActionProvider
 * depend only on this class, never on `fetch`/Spotify URLs directly.
 *
 * Deliberately knows nothing about *how* an access token is obtained —
 * `getAccessToken` is injected, so this class has no OAuth/PKCE logic and
 * no Electron dependency. The actual auth flow (device-specific: opens a
 * browser, runs a local redirect listener, persists tokens) lives under
 * src/main/spotify/ and is handed to this client only as that one
 * function — see "Calendar/Email/Tasks/Spotify integration boundary" in
 * ARCHITECTURE.md for why this separation matters for a future Android
 * client.
 */

import { SpotifyPlaylistSummary } from "./types";
import { httpTimeoutSignal } from "../../../common/timeout";

const API_BASE = "https://api.spotify.com/v1";

/** Same taxonomy as ActionErrorCategory (src/actions/types.ts) minus "invalid_parameters", which is a pre-execution concern, not an API-response one. Kept as its own type so this module has no dependency on src/actions/. */
export type SpotifyApiErrorCategory =
  | "not_authenticated"
  | "not_found"
  | "no_active_device"
  | "not_available"
  | "rate_limited"
  | "network"
  | "unknown";

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public readonly category: SpotifyApiErrorCategory,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SpotifyApiError";
  }
}

export interface RawSpotifyImage {
  url: string;
}

export interface RawSpotifyArtist {
  name: string;
}

export interface RawSpotifyAlbum {
  name?: string;
  images?: RawSpotifyImage[];
}

export interface RawSpotifyTrack {
  id: string;
  name: string;
  artists?: RawSpotifyArtist[];
  album?: RawSpotifyAlbum;
  duration_ms?: number;
  uri: string;
}

export interface RawSpotifyDevice {
  id: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  volume_percent?: number | null;
  supports_volume?: boolean;
}

export interface RawSpotifyPlaybackState {
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: RawSpotifyTrack | null;
  device?: RawSpotifyDevice | null;
  context?: { type?: string; uri?: string } | null;
}

export interface RawSpotifyPlaylist {
  id?: string;
  name: string;
  uri: string;
  images?: RawSpotifyImage[];
  owner?: { display_name?: string };
  tracks?: { total?: number };
}

export interface RawSpotifySearchResult {
  tracks?: { items?: RawSpotifyTrack[] };
  playlists?: { items?: RawSpotifyPlaylist[] };
}

export type SpotifySearchType = "track" | "playlist" | "album" | "artist";

export interface PlayOptions {
  /** A single resource to play as context (e.g. a playlist/album URI) — mutually exclusive with `uris` in Spotify's own API. */
  contextUri?: string;
  /** One or more track URIs to play directly. */
  uris?: string[];
  /** Target device — falls back to the user's currently active device when omitted. */
  deviceId?: string;
}

export class SpotifyApiClient {
  constructor(
    private readonly getAccessToken: () => Promise<string | null>,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  /** Current playback state, or null when nothing is playing/no active session (Spotify's own 204 "no content"). */
  async getCurrentPlayback(): Promise<RawSpotifyPlaybackState | null> {
    const response = await this.request("/me/player", { method: "GET" });
    if (response.status === 204) return null;
    await this.throwIfError(response);
    const text = await response.text();
    if (!text) return null; // some clients also return an empty 200 body when idle
    return JSON.parse(text) as RawSpotifyPlaybackState;
  }

  async play(options: PlayOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {};
    if (options.contextUri) body.context_uri = options.contextUri;
    if (options.uris) body.uris = options.uris;

    const query = options.deviceId ? `?device_id=${encodeURIComponent(options.deviceId)}` : "";
    const response = await this.request(`/me/player/play${query}`, {
      method: "PUT",
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json" },
    });
    await this.throwIfError(response);
  }

  async pause(): Promise<void> {
    const response = await this.request("/me/player/pause", { method: "PUT" });
    await this.throwIfError(response);
  }

  async next(): Promise<void> {
    const response = await this.request("/me/player/next", { method: "POST" });
    await this.throwIfError(response);
  }

  async previous(): Promise<void> {
    const response = await this.request("/me/player/previous", { method: "POST" });
    await this.throwIfError(response);
  }

  async setVolume(volumePercent: number): Promise<void> {
    const response = await this.request(`/me/player/volume?volume_percent=${Math.round(volumePercent)}`, {
      method: "PUT",
    });
    await this.throwIfError(response);
  }

  /**
   * All of the user's currently available Spotify Connect devices —
   * distinct from "the active device" (see getCurrentPlayback). A device
   * being open/running (e.g. the desktop app was just launched) is not
   * the same as being *active*: `/me/player/play` with no explicit
   * device targets only the active one and 404s with "no active device"
   * otherwise, even while a device is sitting here available. Used to
   * find something to explicitly target right after opening the desktop
   * app — see SpotifyActionProvider's device-launch fallback.
   */
  async listDevices(): Promise<RawSpotifyDevice[]> {
    const response = await this.request("/me/player/devices", { method: "GET" });
    await this.throwIfError(response);
    const body = (await response.json()) as { devices?: RawSpotifyDevice[] };
    return body.devices ?? [];
  }

  async search(query: string, types: SpotifySearchType[], limit = 1): Promise<RawSpotifySearchResult> {
    const params = new URLSearchParams({ q: query, type: types.join(","), limit: String(limit) });
    const response = await this.request(`/search?${params.toString()}`, { method: "GET" });
    await this.throwIfError(response);
    return (await response.json()) as RawSpotifySearchResult;
  }

  /**
   * The user's own playlists — just enough metadata to list/pick one
   * (name, id, artwork, owner, track count). Never fetches a playlist's
   * actual tracks — that would mean downloading potentially hundreds of
   * items just to show a picker, which the task explicitly calls out to
   * avoid.
   */
  async listPlaylists(limit = 50): Promise<RawSpotifyPlaylist[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const response = await this.request(`/me/playlists?${params.toString()}`, { method: "GET" });
    await this.throwIfError(response);
    const body = (await response.json()) as { items?: RawSpotifyPlaylist[] };
    return body.items ?? [];
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new SpotifyApiError("Not authenticated with Spotify", "not_authenticated");
    }

    try {
      return await this.fetchFn(`${API_BASE}${path}`, {
        ...init,
        // Node's fetch has no default request timeout — without this a
        // Spotify endpoint that accepts the connection and then stalls
        // would hang the now-playing poll (and any action awaiting it)
        // indefinitely. An abort surfaces as the "network" error the
        // catch below already produces.
        signal: httpTimeoutSignal(),
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
    } catch (err) {
      throw new SpotifyApiError(`Network error contacting Spotify: ${String(err)}`, "network");
    }
  }

  private async throwIfError(response: Response): Promise<void> {
    if (response.ok) return;

    if (response.status === 401) {
      throw new SpotifyApiError("Spotify authentication expired or invalid", "not_authenticated", 401);
    }
    if (response.status === 429) {
      throw new SpotifyApiError("Spotify rate limit exceeded", "rate_limited", 429);
    }

    // Spotify signals "no active device" as a 404 with a specific reason
    // code in the body — everything else at 404 is a genuine not-found.
    if (response.status === 404) {
      const reason = await readErrorReason(response);
      if (reason === "NO_ACTIVE_DEVICE") {
        throw new SpotifyApiError("No active Spotify device", "no_active_device", 404);
      }
      throw new SpotifyApiError("Spotify resource not found", "not_found", 404);
    }

    if (response.status === 403) {
      const reason = await readErrorReason(response);
      if (reason === "PREMIUM_REQUIRED") {
        throw new SpotifyApiError(
          "Spotify playback control requires a Premium account",
          "not_available",
          403
        );
      }
      throw new SpotifyApiError("Spotify forbade this request", "not_available", 403);
    }

    throw new SpotifyApiError(
      `Spotify API request failed with status ${response.status}`,
      "unknown",
      response.status
    );
  }
}

/** Maps raw Spotify playlist objects to the minimal shape NIMBUS shows/stores — never a track list. */
export function mapPlaylists(raw: RawSpotifyPlaylist[]): SpotifyPlaylistSummary[] {
  return raw
    .filter((p) => !!p && !!p.id && !!p.uri)
    .map((p) => ({
      id: p.id!,
      name: p.name || "(Untitled playlist)",
      uri: p.uri,
      ownerName: p.owner?.display_name || null,
      imageUrl: p.images?.[0]?.url ?? null,
      trackCount: typeof p.tracks?.total === "number" ? p.tracks.total : null,
    }));
}

async function readErrorReason(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json();
    return body?.error?.reason ?? null;
  } catch {
    return null;
  }
}
