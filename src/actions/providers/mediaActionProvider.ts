import {
  ActionDefinition,
  ActionError,
  ActionProvider,
  ActionResult,
  ActionValidationResult,
} from "../types";
import { DesktopPlatform, MediaKey } from "./desktopPlatform";

export const MEDIA_ACTIONS = {
  PLAY_PAUSE: "media.playPause",
  NEXT: "media.next",
  PREVIOUS: "media.previous",
  SET_VOLUME: "media.setVolume",
  MUTE: "media.mute",
  UNMUTE: "media.unmute",
} as const;

const KEY_ACTIONS: Record<string, { key: MediaKey; name: string; description: string; done: string }> = {
  [MEDIA_ACTIONS.PLAY_PAUSE]: {
    key: "playPause",
    name: "Play/pause media",
    description:
      "Presses the play/pause media key — works for whatever is playing: Spotify, a browser, a video player.",
    done: "Pressed play/pause.",
  },
  [MEDIA_ACTIONS.NEXT]: {
    key: "next",
    name: "Next track (any player)",
    description: "Presses the next-track media key.",
    done: "Skipped to the next track.",
  },
  [MEDIA_ACTIONS.PREVIOUS]: {
    key: "previous",
    name: "Previous track (any player)",
    description: "Presses the previous-track media key.",
    done: "Went back a track.",
  },
};

/**
 * System-wide media and sound: the media keys, and the Windows master
 * volume and mute. Distinct from the spotify.* actions, which control one
 * Spotify device through its Web API — these act on the computer itself,
 * whatever app is playing.
 */
export class MediaActionProvider implements ActionProvider {
  readonly id = "media";
  readonly displayName = "Media & sound";

  constructor(
    private readonly platform: DesktopPlatform,
    private readonly now: () => Date = () => new Date()
  ) {}

  listActions(): ActionDefinition[] {
    const base = {
      readOnly: false,
      changesExternalState: true,
      requiresConfirmation: false,
      affectsService: "media",
    };
    return [
      ...Object.entries(KEY_ACTIONS).map(([id, spec]) => ({
        ...base,
        id,
        name: spec.name,
        description: spec.description,
        parameters: [],
      })),
      {
        ...base,
        id: MEDIA_ACTIONS.SET_VOLUME,
        name: "Set system volume",
        description: "Sets the Windows master volume of the default speakers or headphones.",
        parameters: [{ name: "volumePercent", type: "number", required: true, description: "0 to 100" }],
      },
      {
        ...base,
        id: MEDIA_ACTIONS.MUTE,
        name: "Mute sound",
        description: "Mutes the default speakers or headphones.",
        parameters: [],
      },
      {
        ...base,
        id: MEDIA_ACTIONS.UNMUTE,
        name: "Unmute sound",
        description: "Unmutes the default speakers or headphones.",
        parameters: [],
      },
    ];
  }

  isAvailable(): boolean {
    return true;
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    if (KEY_ACTIONS[actionId] || actionId === MEDIA_ACTIONS.MUTE || actionId === MEDIA_ACTIONS.UNMUTE) {
      return { valid: true };
    }
    if (actionId === MEDIA_ACTIONS.SET_VOLUME) {
      const volume = params.volumePercent;
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
        return { valid: false, error: "volumePercent must be a number between 0 and 100." };
      }
      return { valid: true };
    }
    return { valid: false, error: `Unknown media action "${actionId}".` };
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const startedAt = this.now();
    const validation = this.validate(actionId, params);
    if (!validation.valid) {
      return this.failure(actionId, startedAt, {
        category: "invalid_parameters",
        message: validation.error ?? "Invalid parameters for that action.",
      });
    }

    try {
      const keyAction = KEY_ACTIONS[actionId];
      if (keyAction) {
        await this.platform.sendMediaKey(keyAction.key);
        return this.success(actionId, startedAt, keyAction.done);
      }
      if (actionId === MEDIA_ACTIONS.SET_VOLUME) {
        const volumePercent = Math.round(params.volumePercent as number);
        await this.platform.setVolume(volumePercent);
        return this.success(actionId, startedAt, `System volume set to ${volumePercent}%.`, {
          volumePercent,
        });
      }
      const muted = actionId === MEDIA_ACTIONS.MUTE;
      await this.platform.setMuted(muted);
      return this.success(actionId, startedAt, muted ? "Sound muted." : "Sound unmuted.", { muted });
    } catch {
      return this.failure(actionId, startedAt, {
        category: "not_available",
        message: "Couldn't control the system's sound right now.",
      });
    }
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
