import {
  ActionDefinition,
  ActionError,
  ActionProvider,
  ActionResult,
  ActionValidationResult,
} from "../types";
import {
  APPLICATION_EXTENSIONS,
  DesktopPlatform,
  WindowCommand,
  absolutePathError,
  extensionOf,
  fileNameOf,
  normalizeProcessName,
} from "./desktopPlatform";

export const APP_ACTIONS = {
  LAUNCH: "app.launch",
  FOCUS: "app.focus",
  MINIMIZE: "app.minimize",
  MAXIMIZE: "app.maximize",
  CLOSE: "app.close",
} as const;

interface WindowActionSpec {
  command: WindowCommand;
  name: string;
  description: string;
  done: (app: string) => string;
  requiresConfirmation: boolean;
}

const WINDOW_ACTIONS: Record<string, WindowActionSpec> = {
  [APP_ACTIONS.FOCUS]: {
    command: "focus",
    name: "Bring an app to the front",
    description: "Restores the app's main window if it is minimized and brings it to the front.",
    done: (app) => `Brought ${app} to the front.`,
    requiresConfirmation: false,
  },
  [APP_ACTIONS.MINIMIZE]: {
    command: "minimize",
    name: "Minimize an app",
    description: "Minimizes the app's open main windows.",
    done: (app) => `Minimized ${app}.`,
    requiresConfirmation: false,
  },
  [APP_ACTIONS.MAXIMIZE]: {
    command: "maximize",
    name: "Maximize an app",
    description: "Maximizes the app's open main windows.",
    done: (app) => `Maximized ${app}.`,
    requiresConfirmation: false,
  },
  [APP_ACTIONS.CLOSE]: {
    command: "close",
    name: "Close an app",
    description:
      "Asks the app to close its main windows, exactly like clicking X — it can still ask to save your work. Never force-quits.",
    done: (app) => `Asked ${app} to close.`,
    // Closing can lose unsaved work in an app that doesn't prompt.
    requiresConfirmation: true,
  },
};

const PROCESS_NAME_PARAM = {
  name: "processName",
  type: "string" as const,
  required: true,
  description: "The app's process name, e.g. discord or chrome — see What NIMBUS currently sees",
};

/**
 * Starting applications and managing their windows.
 *
 * Launching takes a full path to a specific `.exe` or `.lnk` the user
 * chose — never a command line, and never arguments — so a routine can
 * start exactly the program it names and nothing else. Window commands
 * address an app by its process name, validated to exclude wildcards and
 * anything that isn't a plain name.
 *
 * The OS work is done by an injected DesktopPlatform, so this class has no
 * Electron or Windows dependency of its own.
 */
export class AppActionProvider implements ActionProvider {
  readonly id = "app";
  readonly displayName = "Applications";

  constructor(
    private readonly platform: DesktopPlatform,
    private readonly now: () => Date = () => new Date()
  ) {}

  listActions(): ActionDefinition[] {
    return [
      {
        id: APP_ACTIONS.LAUNCH,
        name: "Launch an app",
        description:
          "Starts an application from its .exe, or from a shortcut (.lnk) such as a Start menu entry.",
        parameters: [
          {
            name: "path",
            type: "string",
            required: true,
            description: "Full path to an .exe or a .lnk shortcut",
            format: "application",
          },
        ],
        readOnly: false,
        changesExternalState: true,
        // Starting a program is the kind of step a future confirmation
        // layer should ask about when it isn't the user's own routine.
        requiresConfirmation: true,
        affectsService: "applications",
      },
      ...Object.entries(WINDOW_ACTIONS).map(([id, spec]) => ({
        id,
        name: spec.name,
        description: spec.description,
        parameters: [PROCESS_NAME_PARAM],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: spec.requiresConfirmation,
        affectsService: "applications",
      })),
    ];
  }

  isAvailable(): boolean {
    return true;
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    if (actionId === APP_ACTIONS.LAUNCH) {
      const pathError = absolutePathError(params.path, "path");
      if (pathError) return { valid: false, error: pathError };
      if (!APPLICATION_EXTENSIONS.includes(extensionOf(params.path as string))) {
        return { valid: false, error: "path must point to an .exe file or a .lnk shortcut." };
      }
      return { valid: true };
    }
    if (WINDOW_ACTIONS[actionId]) {
      return normalizeProcessName(params.processName)
        ? { valid: true }
        : {
            valid: false,
            error: "processName must be a plain process name such as discord or chrome.",
          };
    }
    return { valid: false, error: `Unknown application action "${actionId}".` };
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const startedAt = this.now();

    // Validated again here: execute must be safe on its own, not only
    // when a caller happened to go through ActionService first.
    const validation = this.validate(actionId, params);
    if (!validation.valid) {
      return this.failure(actionId, startedAt, {
        category: "invalid_parameters",
        message: validation.error ?? "Invalid parameters for that action.",
      });
    }

    if (actionId === APP_ACTIONS.LAUNCH)
      return this.launch(actionId, startedAt, (params.path as string).trim());
    return this.windowAction(
      actionId,
      startedAt,
      WINDOW_ACTIONS[actionId],
      normalizeProcessName(params.processName)!
    );
  }

  private async launch(actionId: string, startedAt: Date, appPath: string): Promise<ActionResult> {
    const info = await this.platform.pathInfo(appPath);
    if (!info.exists || !info.isFile) {
      return this.failure(actionId, startedAt, {
        category: "not_found",
        message: "There's no application at that path.",
      });
    }
    try {
      await this.platform.launchApplication(appPath);
    } catch {
      return this.failure(actionId, startedAt, {
        category: "unknown",
        message: `Couldn't start ${fileNameOf(appPath)}.`,
      });
    }
    return this.success(actionId, startedAt, `Started ${fileNameOf(appPath)}.`, { path: appPath });
  }

  private async windowAction(
    actionId: string,
    startedAt: Date,
    spec: WindowActionSpec,
    processName: string
  ): Promise<ActionResult> {
    let windows: number;
    try {
      ({ windows } = await this.platform.windowCommand(processName, spec.command));
    } catch {
      return this.failure(actionId, startedAt, {
        category: "unknown",
        message: `Couldn't reach ${processName}'s window.`,
      });
    }
    if (windows === 0) {
      return this.failure(actionId, startedAt, {
        category: "not_found",
        message: `${processName} has no open window.`,
      });
    }
    return this.success(actionId, startedAt, spec.done(processName), { processName, windows });
  }

  private success(actionId: string, startedAt: Date, message: string, data: unknown): ActionResult {
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
