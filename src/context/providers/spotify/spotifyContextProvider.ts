import { ContextProvider } from "../../types";
import { TtlCache } from "../../../common/ttlCache";
import { SpotifyApiClient, RawSpotifyPlaybackState } from "./spotifyApiClient";
import { SpotifyPlaybackContext, SpotifyTrackInfo, SpotifyDeviceInfo } from "./types";

const DEFAULT_CACHE_TTL_MS = 20 * 1000; // playback state changes quickly, but "what's playing" doesn't need to be polled on every context fetch

export interface SpotifyContextProviderConfig {
  enabled: boolean;
}

/**
 * Context provider for "what's currently playing on Spotify" — the
 * read-only half of Spotify awareness. Deliberately separate from
 * SpotifyActionProvider (src/actions/providers/spotifyActionProvider.ts):
 * "what's playing" is Context, "play this" is an Action — see
 * ARCHITECTURE.md's Context-vs-Action split.
 *
 * `isAuthenticated` is injected rather than checked directly against a
 * token store, so this class (Core) has no dependency on how Spotify auth
 * is actually implemented (device-specific, see src/main/spotify/).
 *
 * Like Calendar/Email/Tasks, `isAvailable()` is a real, cheap check:
 * Spotify awareness is opt-in and requires having connected an account,
 * so "not connected" reads as `status: "unavailable"` rather than a
 * failed fetch attempt.
 */
export class SpotifyContextProvider implements ContextProvider<SpotifyPlaybackContext> {
  readonly id = "spotify";
  readonly displayName = "Spotify";

  private readonly cache: TtlCache<SpotifyPlaybackContext>;

  constructor(
    private readonly getSettings: () => SpotifyContextProviderConfig,
    private readonly client: SpotifyApiClient,
    private readonly isAuthenticated: () => boolean | Promise<boolean>,
    private readonly now: () => Date = () => new Date(),
    cacheClock: () => number = Date.now
  ) {
    this.cache = new TtlCache(DEFAULT_CACHE_TTL_MS, cacheClock);
  }

  async isAvailable(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    return this.isAuthenticated();
  }

  async getContext(): Promise<SpotifyPlaybackContext> {
    const cached = this.cache.get();
    if (cached) return cached;

    const raw = await this.client.getCurrentPlayback();
    const context = buildContext(raw, this.now());
    this.cache.set(context);
    return context;
  }

  /**
   * Forces the next `getContext()` to fetch fresh data instead of
   * returning the cached snapshot. Called after a Spotify action changes
   * playback (see `nimbus:execute-action` in lifecycle.ts) — without
   * this, "Next" genuinely skips the track on Spotify's side, but the UI
   * keeps showing the old track for up to the cache's full TTL
   * afterward, which looks exactly like the button doing nothing.
   */
  invalidateCache(): void {
    this.cache.clear();
  }
}

function buildContext(raw: RawSpotifyPlaybackState | null, now: Date): SpotifyPlaybackContext {
  if (!raw || !raw.item) {
    return {
      retrievedAt: now.toISOString(),
      isAuthenticated: true,
      playbackState: "stopped",
      track: null,
      progressMs: null,
      volumePercent: null,
      device: raw?.device ? mapDevice(raw.device) : null,
      context: null,
    };
  }

  return {
    retrievedAt: now.toISOString(),
    isAuthenticated: true,
    playbackState: raw.is_playing ? "playing" : "paused",
    track: mapTrack(raw.item),
    progressMs: raw.progress_ms ?? null,
    volumePercent: raw.device?.volume_percent ?? null,
    device: raw.device ? mapDevice(raw.device) : null,
    context: raw.context?.uri && raw.context?.type ? { type: raw.context.type, uri: raw.context.uri } : null,
  };
}

function mapTrack(item: NonNullable<RawSpotifyPlaybackState["item"]>): SpotifyTrackInfo {
  return {
    id: item.id,
    name: item.name,
    artists: (item.artists ?? []).map((a) => a.name),
    album: item.album?.name ?? null,
    durationMs: item.duration_ms ?? 0,
    imageUrl: item.album?.images?.[0]?.url ?? null,
  };
}

function mapDevice(device: NonNullable<RawSpotifyPlaybackState["device"]>): SpotifyDeviceInfo {
  return {
    id: device.id,
    name: device.name ?? null,
    type: device.type ?? null,
    isActive: !!device.is_active,
    // Fail open (assume supported) unless Spotify explicitly says
    // otherwise — some device payloads omit this field, and hiding a
    // working control is worse than occasionally letting a genuinely
    // unsupported one be attempted (which still fails gracefully).
    supportsVolume: device.supports_volume !== false,
  };
}
