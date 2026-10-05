/**
 * Home's now-playing card: the Spotify track, playback controls, volume
 * and the playlist picker.
 */

import { formatMs } from "./uiFormat";
import type { SpotifyPlaybackContext, SpotifyPlaylistSummary } from "./rendererTypes";

/** mm:ss formatting for track progress/duration. */
const NOW_PLAYING_POLL_MS = 5000;

/**
 * A same-window custom event nudging the now-playing card to refresh
 * immediately instead of waiting for its next poll — dispatched locally
 * after this window's own "Test routine" button runs a Spotify action,
 * and also whenever the main process pushes `onNowPlayingChanged` (see
 * below), which is what covers a Spotify action accepted from the
 * separate suggestion popup window.
 */
export const NOW_PLAYING_REFRESH_EVENT = "nimbus:refresh-now-playing";

// A Spotify action can now be accepted from the suggestion popup — a
// completely separate BrowserWindow with no direct link to this one's
// DOM. Without this, the Home now-playing card only learned about it on
// its own next 5-second poll. See `onActionExecuted` in lifecycle.ts,
// which pushes this to every open window right after a Spotify action
// runs, regardless of which window (or none) triggered it.
window.nimbus.onNowPlayingChanged(() => window.dispatchEvent(new Event(NOW_PLAYING_REFRESH_EVENT)));

/**
 * The Home tab's compact "currently playing" area — makes Spotify feel
 * like part of the assistant rather than a separate app, without turning
 * Home into a music player. Reads the existing SpotifyContextProvider
 * data (already in every getContext() snapshot) and drives playback
 * through the existing generic executeAction — no Spotify-specific IPC
 * of its own beyond what Settings already added.
 */
export function initNowPlayingCard(): void {
  const card = document.getElementById("nowPlayingCard") as HTMLElement;
  const clickzone = document.getElementById("nowPlayingClickzone") as HTMLButtonElement;
  const artEl = document.getElementById("nowPlayingArt") as HTMLElement;
  const kickerEl = document.getElementById("nowPlayingKicker") as HTMLElement;
  const titleEl = document.getElementById("nowPlayingTitle") as HTMLElement;
  const artistEl = document.getElementById("nowPlayingArtist") as HTMLElement;
  const elapsedEl = document.getElementById("nowPlayingElapsed") as HTMLElement;
  const durationEl = document.getElementById("nowPlayingDuration") as HTMLElement;
  const progressFillEl = document.getElementById("nowPlayingProgressFill") as HTMLElement;
  const playPauseBtn = document.getElementById("nowPlayingPlayPauseBtn") as HTMLButtonElement;
  // Inline SVG (matching the sidebar nav icons) instead of a Unicode
  // glyph — Windows' Segoe UI Emoji renders ▶/⏸ in full color regardless
  // of the text-presentation variation selector, which clashed badly
  // against this button's own accent-colored background. SVG with
  // fill="currentColor" always follows the button's actual text color.
  const PLAY_ICON_SVG = `<svg width="12" height="13" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,1 3,15 15,8"/></svg>`;
  const PAUSE_ICON_SVG = `<svg width="12" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="1" width="4" height="14"/><rect x="10" y="1" width="4" height="14"/></svg>`;
  function setPlayPauseIcon(isPlaying: boolean): void {
    playPauseBtn.innerHTML = isPlaying ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
  }
  const prevBtn = document.getElementById("nowPlayingPrevBtn") as HTMLButtonElement;
  const nextBtn = document.getElementById("nowPlayingNextBtn") as HTMLButtonElement;
  const volumeSlider = document.getElementById("nowPlayingVolumeSlider") as HTMLInputElement;
  const errorEl = document.getElementById("nowPlayingError") as HTMLElement;
  const playlistDropdown = document.getElementById("nowPlayingPlaylistDropdown") as HTMLElement;

  let knownPlaylists: SpotifyPlaylistSummary[] = [];
  let playlistsLoaded = false;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let volumeSliderBeingDragged = false;
  let lastPlaybackSignature = "";
  let reconcilePollToken = 0;

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorEl.hidden = true;
    }, 4000);
  }

  function closePlaylistDropdown(): void {
    playlistDropdown.hidden = true;
    playlistDropdown.innerHTML = "";
  }

  async function openPlaylistDropdown(): Promise<void> {
    if (!playlistDropdown.hidden) {
      closePlaylistDropdown();
      return;
    }

    playlistDropdown.innerHTML = "";
    playlistDropdown.hidden = false;

    if (!playlistsLoaded) {
      const loading = document.createElement("div");
      loading.className = "now-playing-playlist-message";
      loading.textContent = "Loading playlists…";
      playlistDropdown.appendChild(loading);
      try {
        knownPlaylists = await window.nimbus.listSpotifyPlaylists();
        playlistsLoaded = true;
      } catch (err) {
        console.error("Failed to load Spotify playlists", err);
        playlistDropdown.innerHTML = "";
        const errorMsg = document.createElement("div");
        errorMsg.className = "now-playing-playlist-message";
        errorMsg.textContent = "Couldn't load playlists.";
        playlistDropdown.appendChild(errorMsg);
        return;
      }
    }

    playlistDropdown.innerHTML = "";
    if (knownPlaylists.length === 0) {
      const empty = document.createElement("div");
      empty.className = "now-playing-playlist-message";
      empty.textContent = "No playlists found.";
      playlistDropdown.appendChild(empty);
      return;
    }

    for (const playlist of knownPlaylists) {
      const item = document.createElement("div");
      item.className = "now-playing-playlist-item";

      const art = document.createElement("div");
      art.className = "now-playing-playlist-item-art";
      if (playlist.imageUrl) art.style.backgroundImage = `url("${playlist.imageUrl}")`;
      item.appendChild(art);

      const info = document.createElement("div");
      info.className = "now-playing-playlist-item-info";
      const name = document.createElement("div");
      name.className = "now-playing-playlist-item-name";
      name.textContent = playlist.name;
      info.appendChild(name);
      if (playlist.trackCount !== null) {
        const meta = document.createElement("div");
        meta.className = "now-playing-playlist-item-meta";
        meta.textContent = `${playlist.trackCount} track${playlist.trackCount === 1 ? "" : "s"}`;
        info.appendChild(meta);
      }
      item.appendChild(info);

      item.addEventListener("click", () => {
        closePlaylistDropdown();
        runAction("spotify.playPlaylist", { playlistUri: playlist.uri });
      });

      playlistDropdown.appendChild(item);
    }
  }

  document.addEventListener("click", (event) => {
    if (!playlistDropdown.hidden && !card.contains(event.target as Node)) {
      closePlaylistDropdown();
    }
  });

  function render(context: SpotifyPlaybackContext | null, connected: boolean): void {
    if (!connected) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const supportsVolume = context?.device?.supportsVolume ?? true;
    volumeSlider.disabled = !supportsVolume;
    volumeSlider.title = supportsVolume ? "Volume" : "This device doesn't support remote volume control";

    if (!context || context.playbackState === "stopped" || !context.track) {
      artEl.style.backgroundImage = "";
      titleEl.textContent = "Nothing is playing";
      artistEl.textContent = "";
      elapsedEl.textContent = "";
      durationEl.textContent = "";
      progressFillEl.style.width = "0%";
      setPlayPauseIcon(false);
      playPauseBtn.title = "Play";
      return;
    }

    artEl.style.backgroundImage = context.track.imageUrl ? `url("${context.track.imageUrl}")` : "";
    titleEl.textContent = context.track.name;
    artistEl.textContent = context.track.artists.join(", ") || "";

    const playlistName =
      context.context?.type === "playlist"
        ? knownPlaylists.find((p) => p.uri === context.context!.uri)?.name
        : null;
    kickerEl.textContent = playlistName ? `Spotify · ${playlistName}` : "Spotify";

    const progress = context.progressMs ?? 0;
    const duration = context.track.durationMs || 1;
    elapsedEl.textContent = formatMs(progress);
    durationEl.textContent = formatMs(duration);
    progressFillEl.style.width = `${Math.min(100, (progress / duration) * 100)}%`;

    const isPlaying = context.playbackState === "playing";
    setPlayPauseIcon(isPlaying);
    playPauseBtn.title = isPlaying ? "Pause" : "Play";

    if (!volumeSliderBeingDragged && context.volumePercent !== null) {
      volumeSlider.value = String(context.volumePercent);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [spotifySettings, snapshot] = await Promise.all([
        window.nimbus.getSpotifySettings(),
        window.nimbus.getContext(),
      ]);
      if (!spotifySettings.connected) {
        render(null, false);
        return;
      }
      const spotify = snapshot.providers.spotify;
      // ContextService falls back to the last known-good result (with
      // `status: "error"`, `stale: true`) on a transient fetch failure
      // rather than returning no data — treating only `status === "ok"`
      // as real data threw that stale-but-valid snapshot away on every
      // hiccup, which both blanked the card unnecessarily and (worse)
      // fed refreshUntilChanged below a bogus "" signature that looked
      // like a genuine change and made it give up early.
      const data = spotify?.data ? (spotify.data as unknown as SpotifyPlaybackContext) : null;
      lastPlaybackSignature = `${data?.context?.uri ?? ""}::${data?.track?.id ?? ""}`;
      render(data, true);
    } catch (err) {
      console.error("Failed to load Spotify now-playing", err);
    }
  }

  /**
   * Used instead of a single `refresh()` right after a Spotify action —
   * Spotify's own `/me/player` endpoint can lag behind the actual device
   * state right after a playback-changing command (most noticeably after
   * switching playlists via a Routine), sometimes by more than the ~15s
   * this used to give up after — that looked like "the Home card just
   * never updates" even though it was still quietly retrying. Keeps
   * re-fetching every 2s for up to a full minute, which is patient
   * enough to survive one of these longer stretches while still not
   * polling forever.
   */
  async function refreshUntilChanged(): Promise<void> {
    const myToken = ++reconcilePollToken; // a newer call (e.g. the user clicked Next) supersedes this one
    const before = lastPlaybackSignature;
    for (let attempt = 0; attempt < 30; attempt++) {
      await refresh();
      if (myToken !== reconcilePollToken || lastPlaybackSignature !== before) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function runAction(actionId: string, params?: Record<string, unknown>): Promise<void> {
    try {
      const result = await window.nimbus.executeAction(actionId, params);
      if (result.status !== "success") {
        console.warn(`Spotify action "${actionId}" failed`, result.error);
        showError(result.error?.message || "That didn't work — try again.");
      } else {
        errorEl.hidden = true;
      }
    } catch (err) {
      console.error(`Failed to execute action "${actionId}"`, err);
      showError("That didn't work — try again.");
    } finally {
      await refresh();
    }
  }

  clickzone.addEventListener("click", () => {
    openPlaylistDropdown();
  });
  playPauseBtn.addEventListener("click", () => {
    const isPlaying = playPauseBtn.title === "Pause";
    runAction(isPlaying ? "spotify.pause" : "spotify.play");
  });
  prevBtn.addEventListener("click", () => runAction("spotify.previous"));
  nextBtn.addEventListener("click", () => runAction("spotify.next"));
  volumeSlider.addEventListener("mousedown", () => {
    volumeSliderBeingDragged = true;
  });
  volumeSlider.addEventListener("change", () => {
    volumeSliderBeingDragged = false;
    if (volumeSlider.disabled) return;
    runAction("spotify.setVolume", { volumePercent: Number(volumeSlider.value) });
  });

  window.nimbus
    .listSpotifyPlaylists()
    .then((playlists) => {
      knownPlaylists = playlists;
      playlistsLoaded = true;
    })
    .catch(() => {}); // pre-fetched for the kicker label and a snappier first dropdown open — safe to skip if unavailable, openPlaylistDropdown re-fetches on demand otherwise

  refresh();
  // Only worth polling while the user can actually see it — the Home tab.
  setInterval(() => {
    if (document.getElementById("tab-home")?.classList.contains("active")) {
      refresh();
    }
  }, NOW_PLAYING_POLL_MS);
  window.addEventListener(NOW_PLAYING_REFRESH_EVENT, () => refreshUntilChanged());
}
