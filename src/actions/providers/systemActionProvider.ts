import {
  ActionDefinition,
  ActionErrorCategory,
  ActionProvider,
  ActionResult,
  ActionValidationResult,
} from "../types";

export const SYSTEM_ACTIONS = { OPEN_URL: "system.openUrl", LOCK: "system.lock" } as const;

/**
 * A third Action Provider, alongside Spotify and Timer — the "open a
 * website" half of "an app opened → open its companion site" (e.g.
 * launching a game and having its wiki/guide open alongside it). Opens
 * with the OS's default browser via an injected `openUrl` function
 * (Electron's `shell.openExternal`, wired in lifecycle.ts) rather than
 * this class touching Electron directly — same reason TimerService
 * doesn't know about `BrowserWindow`.
 *
 * `shell.openExternal` hands the URL to the OS's URL handler exactly
 * like clicking a link would — it does not execute arbitrary code or
 * shell commands. `validate` still restricts this to `http`/`https` URLs
 * specifically (see the task's own "never treat arbitrary URLs as
 * executable commands" guidance): a Routine's `openUrl` step can never
 * be a `file:`/custom-protocol URI, which is what would make this a
 * meaningfully different, riskier capability than "open a normal
 * webpage."
 *
 * `system.lock` is listed only when a `lockScreen` implementation is
 * supplied — a host that can't lock the machine simply doesn't offer it.
 */
export class SystemActionProvider implements ActionProvider {
  readonly id = "system";
  readonly displayName = "System";

  constructor(
    private readonly openUrl: (url: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
    private readonly lockScreen?: () => Promise<void>
  ) {}

  listActions(): ActionDefinition[] {
    const actions: ActionDefinition[] = [
      {
        id: SYSTEM_ACTIONS.OPEN_URL,
        name: "Open website",
        description: "Opens a website in your default browser.",
        parameters: [
          { name: "url", type: "string", required: true, description: "Must start with http:// or https://" },
        ],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: false,
        affectsService: "system",
      },
    ];
    if (this.lockScreen) {
      actions.push({
        id: SYSTEM_ACTIONS.LOCK,
        name: "Lock Windows",
        description: "Locks the computer, like pressing Windows+L. Nothing is closed and no work is lost.",
        parameters: [],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: false,
        affectsService: "system",
      });
    }
    return actions;
  }

  isAvailable(): boolean {
    return true; // opening a URL needs no auth/config
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    if (actionId === SYSTEM_ACTIONS.LOCK) return { valid: true };
    if (actionId !== SYSTEM_ACTIONS.OPEN_URL) {
      return { valid: false, error: `Unknown system action "${actionId}".` };
    }
    const url = params.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      return { valid: false, error: "url is required." };
    }
    const parsed = parseHttpUrl(url);
    if (!parsed) {
      return { valid: false, error: "url must be a valid http:// or https:// address." };
    }
    return { valid: true };
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const startedAt = this.now();
    if (actionId === SYSTEM_ACTIONS.LOCK) return this.lock(actionId, startedAt);
    if (actionId !== SYSTEM_ACTIONS.OPEN_URL) {
      return this.failure(actionId, startedAt, "That action isn't available.");
    }

    const parsed = parseHttpUrl(params.url as string);
    if (!parsed) {
      return this.failure(actionId, startedAt, "url must be a valid http:// or https:// address.");
    }

    try {
      await this.openUrl(parsed.toString());
    } catch (err) {
      return this.failure(actionId, startedAt, `Couldn't open that website: ${String(err)}`);
    }

    const finishedAt = this.now();
    return {
      actionId,
      status: "success",
      message: `Opened ${parsed.hostname}.`,
      data: { url: parsed.toString() },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  private async lock(actionId: string, startedAt: Date): Promise<ActionResult> {
    if (!this.lockScreen) {
      return this.failure(actionId, startedAt, "Locking isn't available here.", "not_available");
    }
    try {
      await this.lockScreen();
    } catch {
      return this.failure(actionId, startedAt, "Couldn't lock Windows.", "unknown");
    }
    const finishedAt = this.now();
    return {
      actionId,
      status: "success",
      message: "Locked Windows.",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  private failure(
    actionId: string,
    startedAt: Date,
    message: string,
    category: ActionErrorCategory = "invalid_parameters"
  ): ActionResult {
    const finishedAt = this.now();
    return {
      actionId,
      status: "failure",
      error: { category, message },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}
