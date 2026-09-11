import {
  ActionDefinition,
  ActionError,
  ActionProvider,
  ActionResult,
  ActionValidationResult,
} from "../types";
import {
  BLOCKED_OPEN_EXTENSIONS,
  DesktopPlatform,
  absolutePathError,
  extensionOf,
  fileNameOf,
} from "./desktopPlatform";

export const FILE_ACTIONS = {
  OPEN_FILE: "files.openFile",
  OPEN_FOLDER: "files.openFolder",
} as const;

/**
 * Opening files and folders, the way double-clicking them would.
 *
 * files.openFile refuses anything whose default handler would *run* it
 * (see BLOCKED_OPEN_EXTENSIONS): starting a program is app.launch's job,
 * where the step says so. Both actions take a full local path and check it
 * exists — and is the right kind of thing — before anything is opened.
 */
export class FileActionProvider implements ActionProvider {
  readonly id = "files";
  readonly displayName = "Files";

  constructor(
    private readonly platform: DesktopPlatform,
    private readonly now: () => Date = () => new Date()
  ) {}

  listActions(): ActionDefinition[] {
    return [
      {
        id: FILE_ACTIONS.OPEN_FILE,
        name: "Open a file",
        description:
          "Opens a document, image or other file with its default app. Programs and scripts are refused.",
        parameters: [
          {
            name: "path",
            type: "string",
            required: true,
            description: "Full path to the file",
            format: "file",
          },
        ],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: false,
        affectsService: "files",
      },
      {
        id: FILE_ACTIONS.OPEN_FOLDER,
        name: "Open a folder",
        description: "Opens a folder in File Explorer.",
        parameters: [
          {
            name: "path",
            type: "string",
            required: true,
            description: "Full path to the folder",
            format: "folder",
          },
        ],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: false,
        affectsService: "files",
      },
    ];
  }

  isAvailable(): boolean {
    return true;
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    if (actionId !== FILE_ACTIONS.OPEN_FILE && actionId !== FILE_ACTIONS.OPEN_FOLDER) {
      return { valid: false, error: `Unknown file action "${actionId}".` };
    }
    const pathError = absolutePathError(params.path, "path");
    if (pathError) return { valid: false, error: pathError };
    if (
      actionId === FILE_ACTIONS.OPEN_FILE &&
      BLOCKED_OPEN_EXTENSIONS.has(extensionOf(params.path as string))
    ) {
      return {
        valid: false,
        error: 'That file would run a program when opened. Use "Launch an app" to start programs.',
      };
    }
    return { valid: true };
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

    const target = (params.path as string).trim();
    const wantFolder = actionId === FILE_ACTIONS.OPEN_FOLDER;
    const info = await this.platform.pathInfo(target);
    if (!info.exists || (wantFolder ? !info.isDirectory : !info.isFile)) {
      return this.failure(actionId, startedAt, {
        category: "not_found",
        message: wantFolder ? "There's no folder at that path." : "There's no file at that path.",
      });
    }

    try {
      await this.platform.openPath(target);
    } catch {
      return this.failure(actionId, startedAt, {
        category: "unknown",
        message: `Couldn't open ${fileNameOf(target)}.`,
      });
    }

    const finishedAt = this.now();
    return {
      actionId,
      status: "success",
      message: `Opened ${fileNameOf(target)}.`,
      data: { path: target },
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
