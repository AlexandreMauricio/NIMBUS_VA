import { BrowserWindow } from "electron";
import { logger } from "../logging/logger";
import { AssistantEvent } from "../common/assistantEvents";

/**
 * The single seam through which future assistant subsystems (under
 * `src/services/`) reach the UI. A producer calls `assistantBridge.publish(event)`
 * — it doesn't need a window reference, doesn't touch IPC, and doesn't know
 * whether anything is listening. The bridge forwards the event to every
 * open renderer over the `nimbus:assistant-event` channel.
 *
 * This keeps `src/main` (window/app plumbing) and `src/ui` (presentation)
 * decoupled from `src/services` (assistant logic, added later).
 */
const CHANNEL = "nimbus:assistant-event";

function broadcast(event: AssistantEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNEL, event);
  }
}

export const assistantBridge = {
  publish(event: AssistantEvent): void {
    logger.debug("Assistant event published", { type: event.type, source: event.source });
    broadcast(event);
  },
};

export const ASSISTANT_EVENT_CHANNEL = CHANNEL;
