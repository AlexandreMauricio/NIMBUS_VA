import {
  ActionDefinition,
  ActionError,
  ActionProvider,
  ActionResult,
  ActionValidationResult,
} from "../types";
import {
  SpotifyApiClient,
  SpotifyApiError,
  SpotifyApiErrorCategory,
  SpotifySearchType,
  PlayOptions,
} from "../../context/providers/spotify/spotifyApiClient";

const DEFAULT_DEVICE_WAKE_WAIT_MS = 3000;

/** Stable action ids this provider owns — all namespaced "spotify.*". */
export const SPOTIFY_ACTIONS = {
  PLAY: "spotify.play",
  PAUSE: "spotify.pause",
  NEXT: "spotify.next",
  PREVIOUS: "spotify.previous",
  SET_VOLUME: "spotify.setVolume",
  PLAY_SEARCH: "spotify.playSearch",
  PLAY_PLAYLIST: "spotify.playPlaylist",
} as const;

const SEARCHABLE_TYPES: SpotifySearchType[] = ["track", "artist", "album"];

/**
 * The first Action Provider — controls Spotify playback on the user's
 * machine. Read operations ("what's playing") deliberately live in
 * SpotifyContextProvider instead (src/context/providers/spotify/) per the
 * Context-vs-Action split in ARCHITECTURE.md; this provider only ever
 * changes playback state.
 *
 * None of these actions require confirmation — play/pause/skip/volume are
 * harmless to get wrong and easy to undo, unlike a future destructive
 * action (deleting files, sending an email). `requiresConfirmation: false`
 * on every definition here is a deliberate choice, not an oversight — see
 * ActionDefinition's doc comment for how a future action would set it to
 * true instead.
 */
export class SpotifyActionProvider implements ActionProvider {
  readonly id = "spotify";
  readonly displayName = "Spotify";

  constructor(
    private readonly client: SpotifyApiClient,
    private readonly getSettings: () => { enabled: boolean },
    private readonly isAuthenticated: () => boolean | Promise<boolean>,
    private readonly now: () => Date = () => new Date(),
    /**
     * Launches (or focuses) the Spotify desktop client, e.g. via
     * `shell.openExternal("spotify:")` — its registered URI protocol —
     * the same mechanism the OAuth flow already uses to open a browser.
     * Deliberately optional/injected: this class (Core) has no Electron
     * dependency of its own, matching every other provider's device
     * boundary (see ARCHITECTURE.md). When omitted, a "no active device"
     * failure is just reported as-is, with no fallback attempted.
     */
    private readonly openSpotifyApp?: () => Promise<void>,
    private readonly deviceWakeWaitMs: number = DEFAULT_DEVICE_WAKE_WAIT_MS,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  listActions(): ActionDefinition[] {
    const base = {
      readOnly: false,
      changesExternalState: true,
      requiresConfirmation: false,
      affectsService: "spotify",
    };
    return [
      {
        id: SPOTIFY_ACTIONS.PLAY,
        name: "Play",
        description: "Start or resume Spotify playback.",
        parameters: [],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.PAUSE,
        name: "Pause",
        description: "Pause Spotify playback.",
        parameters: [],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.NEXT,
        name: "Next",
        description: "Skip to the next track.",
        parameters: [],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.PREVIOUS,
        name: "Previous",
        description: "Return to the previous track.",
        parameters: [],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.SET_VOLUME,
        name: "Set volume",
        description: "Set Spotify's playback volume.",
        parameters: [{ name: "volumePercent", type: "number", required: true, description: "0-100" }],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.PLAY_SEARCH,
        name: "Play search result",
        description: "Search Spotify for a track/artist/album and start playing the best match.",
        parameters: [
          { name: "query", type: "string", required: true },
          {
            name: "type",
            type: "string",
            required: false,
            description: "track | artist | album — defaults to track",
          },
        ],
        ...base,
      },
      {
        id: SPOTIFY_ACTIONS.PLAY_PLAYLIST,
        name: "Play playlist",
        description: "Search Spotify for a playlist by name and start playing it.",
        parameters: [
          {
            name: "playlistQuery",
            type: "string",
            required: false,
            description: "Search by name — provide this or playlistUri",
          },
          {
            name: "playlistUri",
            type: "string",
            required: false,
            description: "An exact playlist URI, e.g. from a picked playlist — provide this or playlistQuery",
          },
        ],
        ...base,
      },
    ];
  }

  async isAvailable(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    return this.isAuthenticated();
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    switch (actionId) {
      case SPOTIFY_ACTIONS.PLAY:
      case SPOTIFY_ACTIONS.PAUSE:
      case SPOTIFY_ACTIONS.NEXT:
      case SPOTIFY_ACTIONS.PREVIOUS:
        return { valid: true };

      case SPOTIFY_ACTIONS.SET_VOLUME: {
        const volume = params.volumePercent;
        if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
          return { valid: false, error: "volumePercent must be a number between 0 and 100." };
        }
        return { valid: true };
      }

      case SPOTIFY_ACTIONS.PLAY_SEARCH: {
        if (typeof params.query !== "string" || params.query.trim().length === 0) {
          return { valid: false, error: "query is required." };
        }
        if (params.type !== undefined && !SEARCHABLE_TYPES.includes(params.type as SpotifySearchType)) {
          return { valid: false, error: `type must be one of: ${SEARCHABLE_TYPES.join(", ")}.` };
        }
        return { valid: true };
      }

      case SPOTIFY_ACTIONS.PLAY_PLAYLIST: {
        const hasQuery = typeof params.playlistQuery === "string" && params.playlistQuery.trim().length > 0;
        const hasUri = typeof params.playlistUri === "string" && params.playlistUri.trim().length > 0;
        if (!hasQuery && !hasUri) {
          return { valid: false, error: "Either playlistQuery or playlistUri is required." };
        }
        return { valid: true };
      }

      default:
        return { valid: false, error: `Unknown Spotify action "${actionId}".` };
    }
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const startedAt = this.now();
    try {
      switch (actionId) {
        case SPOTIFY_ACTIONS.PLAY: {
          const outcome = await this.playWithDeviceFallback({});
          if (!outcome.success) return this.failureFromPlayOutcome(actionId, startedAt, outcome);
          return this.success(actionId, startedAt, "Resumed playback.");
        }

        case SPOTIFY_ACTIONS.PAUSE:
          await this.client.pause();
          return this.success(actionId, startedAt, "Paused playback.");

        case SPOTIFY_ACTIONS.NEXT:
          await this.client.next();
          return this.success(actionId, startedAt, "Skipped to the next track.");

        case SPOTIFY_ACTIONS.PREVIOUS:
          await this.client.previous();
          return this.success(actionId, startedAt, "Went back to the previous track.");

        case SPOTIFY_ACTIONS.SET_VOLUME: {
          const volumePercent = params.volumePercent as number;
          await this.client.setVolume(volumePercent);
          return this.success(actionId, startedAt, `Volume set to ${Math.round(volumePercent)}%.`, {
            volumePercent,
          });
        }

        case SPOTIFY_ACTIONS.PLAY_SEARCH:
          return await this.playSearch(
            actionId,
            startedAt,
            params.query as string,
            (params.type as SpotifySearchType) ?? "track"
          );

        case SPOTIFY_ACTIONS.PLAY_PLAYLIST:
          return await this.playPlaylist(
            actionId,
            startedAt,
            params.playlistQuery as string | undefined,
            params.playlistUri as string | undefined
          );

        default:
          return this.failure(actionId, startedAt, {
            category: "not_available",
            message: "That action isn't available.",
          });
      }
    } catch (err) {
      return this.failure(actionId, startedAt, mapError(err));
    }
  }

  private async playSearch(
    actionId: string,
    startedAt: Date,
    query: string,
    type: SpotifySearchType
  ): Promise<ActionResult> {
    const results = await this.client.search(query, [type], 1);
    const item = type === "track" ? results.tracks?.items?.[0] : undefined;
    // Artist/album search results share the same "playable context" shape
    // (id/name/uri) as a playlist for our purposes — Spotify itself only
    // ever returns typed arrays, so this narrows to whichever the caller asked for.
    const contextItem =
      type !== "track"
        ? (results as unknown as Record<string, { items?: { name: string; uri: string }[] }>)[`${type}s`]
            ?.items?.[0]
        : undefined;

    if (type === "track") {
      if (!item) {
        return this.failure(actionId, startedAt, {
          category: "not_found",
          message: "I couldn't find that on Spotify.",
        });
      }
      const outcome = await this.playWithDeviceFallback({ uris: [item.uri] });
      if (!outcome.success) return this.failureFromPlayOutcome(actionId, startedAt, outcome);
      const artist = item.artists?.[0]?.name;
      const message = artist ? `Playing "${item.name}" by ${artist}.` : `Playing "${item.name}".`;
      return this.success(actionId, startedAt, message, {
        id: item.id,
        name: item.name,
        artist: artist ?? null,
      });
    }

    if (!contextItem) {
      return this.failure(actionId, startedAt, {
        category: "not_found",
        message: "I couldn't find that on Spotify.",
      });
    }
    const outcome = await this.playWithDeviceFallback({ contextUri: contextItem.uri });
    if (!outcome.success) return this.failureFromPlayOutcome(actionId, startedAt, outcome);
    return this.success(actionId, startedAt, `Playing "${contextItem.name}".`, { name: contextItem.name });
  }

  private async playPlaylist(
    actionId: string,
    startedAt: Date,
    query: string | undefined,
    playlistUri: string | undefined
  ): Promise<ActionResult> {
    // An exact URI (e.g. from a Routine configured against a picked
    // playlist — see src/routines/) is preferred when present: it's
    // unambiguous and needs no search round-trip at all. Falls back to a
    // name search for the manual "play my Gaming playlist" case.
    if (playlistUri) {
      const outcome = await this.playWithDeviceFallback({ contextUri: playlistUri });
      if (!outcome.success) return this.failureFromPlayOutcome(actionId, startedAt, outcome);
      return this.success(actionId, startedAt, "Playing your playlist.", { uri: playlistUri });
    }

    const results = await this.client.search(query!, ["playlist"], 1);
    const playlist = results.playlists?.items?.[0];
    if (!playlist) {
      return this.failure(actionId, startedAt, {
        category: "not_found",
        message: "I couldn't find that playlist on Spotify.",
      });
    }
    const outcome = await this.playWithDeviceFallback({ contextUri: playlist.uri });
    if (!outcome.success) return this.failureFromPlayOutcome(actionId, startedAt, outcome);
    return this.success(actionId, startedAt, `Playing playlist "${playlist.name}".`, { name: playlist.name });
  }

  /**
   * Calls `client.play(options)`, and — only when it fails specifically
   * with "no active device" and an `openSpotifyApp` launcher was
   * provided — launches Spotify and retries once after a short wait for
   * it to register a device with Spotify Connect. This is the one retry
   * anywhere in the Action system, scoped narrowly to this one, common,
   * recoverable failure; every other failure category is returned as-is
   * on the first attempt.
   */
  private async playWithDeviceFallback(
    options: PlayOptions
  ): Promise<{ success: true } | { success: false; openedApp: boolean; error: unknown }> {
    try {
      await this.client.play(options);
      return { success: true };
    } catch (err) {
      const isNoActiveDevice = err instanceof SpotifyApiError && err.category === "no_active_device";
      if (!isNoActiveDevice || !this.openSpotifyApp) {
        return { success: false, openedApp: false, error: err };
      }

      try {
        await this.openSpotifyApp();
      } catch (openErr) {
        // Opening Spotify itself failed (e.g. no protocol handler
        // registered — Spotify isn't installed) — report the original
        // "no active device" failure, not this secondary one.
        return { success: false, openedApp: false, error: err };
      }

      await this.wait(this.deviceWakeWaitMs);

      try {
        // A device the app just registered isn't automatically "active"
        // from the Web API's point of view — `/me/player/play` with no
        // device still 404s otherwise, even though the device is now
        // sitting in the available list. Explicitly target it so the
        // retry actually has something to play to. Prefers a "Computer"
        // device (the desktop app we just opened) since that's what
        // `openSpotifyApp` launched; falls back to whatever else showed
        // up if that particular type isn't reported.
        const devices = await this.client.listDevices();
        const target = devices.find((d) => d.type === "Computer" && d.id) ?? devices.find((d) => d.id);
        const retryOptions = target?.id ? { ...options, deviceId: target.id } : options;

        await this.client.play(retryOptions);
        return { success: true };
      } catch (retryErr) {
        return { success: false, openedApp: true, error: retryErr };
      }
    }
  }

  private failureFromPlayOutcome(
    actionId: string,
    startedAt: Date,
    outcome: { success: false; openedApp: boolean; error: unknown }
  ): ActionResult {
    if (outcome.openedApp) {
      return this.failure(actionId, startedAt, {
        category: "no_active_device",
        message: "I opened Spotify for you — give it a few seconds to start, then try again.",
      });
    }
    return this.failure(actionId, startedAt, mapError(outcome.error));
  }

  private success(actionId: string, startedAt: Date, message: string, data?: unknown): ActionResult {
    const finishedAt = this.now();
    return {
      actionId,
      status: "success",
      message,
      data,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  private failure(actionId: string, startedAt: Date, error: ActionError): ActionResult {
    const finishedAt = this.now();
    return {
      actionId,
      status: "failure",
      error,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
}

/** Turns a SpotifyApiError into a user-safe ActionError — never the raw HTTP/API text (see task's error-handling section). */
function mapError(err: unknown): ActionError {
  if (err instanceof SpotifyApiError) {
    const messages: Record<SpotifyApiErrorCategory, string> = {
      not_authenticated: "Spotify isn't connected, or the connection has expired.",
      not_found: "I couldn't find that on Spotify.",
      no_active_device: "There's no active Spotify device available.",
      not_available: "Spotify playback control isn't available right now.",
      rate_limited: "Spotify is temporarily rate-limiting requests — try again shortly.",
      network: "Couldn't reach Spotify — check your network connection.",
      unknown: "Something went wrong talking to Spotify.",
    };
    return { category: err.category, message: messages[err.category] };
  }
  return { category: "unknown", message: "Something went wrong talking to Spotify." };
}
