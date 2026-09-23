import * as path from "path";
import { dialog } from "electron";
import type { OpenDialogOptions } from "electron";
import { actionService } from "../../actions";
import { handle } from "./handle";
import { asRecord, idArg } from "./input";
import type { IpcContext } from "./context";

/** Actions: the generic execute surface and the path picker. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerActionsIpc(ctx: IpcContext): void {
  // The generic Action-execution surface (see src/actions/). The renderer
  // never gets direct access to a provider or its credentials — it can
  // only ask for a specific, already-registered action id with plain
  // JSON params, exactly like "execute Spotify pause action" in the
  // task's own security-boundary example. ActionService validates the id
  // and params itself; there is no way to reach arbitrary Node/API access
  // through this handler.
  handle("nimbus:list-actions", () => actionService.listActions());
  // A file/folder picker for action parameters that are local paths (see
  // ActionParameterSchema.format). It only ever returns a path for the
  // renderer to put in a text field — the action still validates that
  // path itself when it runs.
  handle("nimbus:pick-path", async (_event, format: unknown) => {
    if (format !== "file" && format !== "folder" && format !== "application") return null;
    const options: OpenDialogOptions =
      format === "folder"
        ? { properties: ["openDirectory"] }
        : format === "application"
          ? {
              properties: ["openFile"],
              defaultPath: path.join(
                process.env.ProgramData ?? "C:/ProgramData",
                "Microsoft",
                "Windows",
                "Start Menu",
                "Programs"
              ),
              filters: [{ name: "Applications and shortcuts", extensions: ["exe", "lnk"] }],
            }
          : { properties: ["openFile"] };
    const result = ctx.mainWindow
      ? await dialog.showOpenDialog(ctx.mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("nimbus:execute-action", async (_event, actionId: unknown, params: unknown) => {
    const id = idArg(actionId);
    const result = await actionService.executeAction(id, asRecord(params));
    ctx.onActionExecuted(id, result);
    return result;
  });
}
