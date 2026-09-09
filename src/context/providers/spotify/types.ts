/** Data model for NIMBUS's Spotify playback awareness — metadata about what's playing, never Spotify's raw API shape. */

export type SpotifyPlaybackState = "playing" | "paused" | "stopped";

export interface SpotifyTrackInfo {
  id: string;
  name: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  imageUrl: string | null;
}

export interface SpotifyDeviceInfo {
  id: string | null;
  name: string | null;
  type: string | null;
  isActive: boolean;
  /** Some Spotify Connect devices (notably shared/venue speakers) don't support remote volume control at all — Spotify reports this per device. */
  supportsVolume: boolean;
}

/** Just enough to list/pick a playlist — never its tracks. See SpotifyApiClient.listPlaylists. */
export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  uri: string;
  ownerName: string | null;
  imageUrl: string | null;
  trackCount: number | null;
}

export interface SpotifyPlaybackContext {
  retrievedAt: string;
  isAuthenticated: boolean;
  playbackState: SpotifyPlaybackState;
  track: SpotifyTrackInfo | null;
  progressMs: number | null;
  volumePercent: number | null;
  device: SpotifyDeviceInfo | null;
  /**
   * What's driving playback (a playlist/album/artist), when Spotify
   * reports one. Only the URI/type are available from the playback
   * endpoint itself — resolving `uri` to a human-readable name (e.g. a
   * playlist's title) is left to the caller (matched against
   * SpotifyPlaylistSummary[] the UI already has from listPlaylists,
   * rather than spending an extra API call on every playback poll).
   */
  context: { type: string; uri: string } | null;
}
