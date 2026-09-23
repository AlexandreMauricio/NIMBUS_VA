import { ipcMain } from "electron";
import { logger } from "../../logging/logger";
import { isTrustedSender } from "../navigationGuard";

/**
 * `ipcMain.handle`, answering only NIMBUS's own pages (see
 * navigationGuard.ts). Every channel is registered through this.
 */
export function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      logger.warn("Refused an IPC call from outside NIMBUS", {
        channel,
        url: String(event.senderFrame?.url ?? "").slice(0, 200),
      });
      throw new Error("Not allowed.");
    }
    return listener(event, ...args);
  });
}
