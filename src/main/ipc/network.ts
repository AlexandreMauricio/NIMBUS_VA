import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import { handle } from "./handle";
import { mergeKnown } from "./mergeKnown";
import type { IpcContext } from "./context";

/** Network and presence. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerNetworkIpc(ctx: IpcContext): void {
  // Network (src/network/) — observation only. Each channel does one fixed
  // thing: read the neighbor cache, run the bounded local scan, or edit
  // NIMBUS's own label for a device. None takes an address from the UI.
  handle("nimbus:get-network-state", () => ctx.networkService.getState());
  handle("nimbus:refresh-network", () => ctx.networkService.refresh());
  handle("nimbus:scan-network", () => ctx.networkService.scan());
  handle("nimbus:cancel-network-scan", () => ctx.networkService.cancel());
  handle("nimbus:update-network-device", (_event, id: unknown, changes: unknown) =>
    ctx.networkService.updateDevice(String(id ?? ""), changes)
  );
  handle("nimbus:forget-network-device", (_event, id: unknown) =>
    ctx.networkService.forget(String(id ?? ""))
  );
  // "Ask the device" — by device id only; the address comes from NIMBUS's
  // own list, and must be private and on this PC's subnet.
  handle("nimbus:identify-network-device", (_event, id: unknown) =>
    ctx.networkService.identifyDevice(String(id ?? ""))
  );

  handle("nimbus:update-network-settings", (_event, partial: unknown) => {
    ctx.settings.windowsClient.network = mergeKnown(ctx.settings.windowsClient.network, partial);
    saveSettings(ctx.settings);
    logger.info("Network settings updated", { ...ctx.settings.windowsClient.network });
    if (ctx.settings.windowsClient.network.enabled) void ctx.networkService.refresh(true);
    else ctx.networkService.cancel();
    return ctx.settings.windowsClient.network;
  });

  // Presence: the current judgement, and the devices you can choose as your
  // phone. The choice is a Network tab device id — checked against the list.
  handle("nimbus:get-presence", () => ({
    ...(ctx.presenceService?.update() ?? null),
    phoneDeviceId: ctx.settings.windowsClient.network.phoneDeviceId,
    devices: ctx.networkService
      .getState()
      .devices.filter((device) => !device.isSelf && !device.isGateway)
      .map((device) => ({ id: device.id, name: device.displayName, randomizedMac: device.randomizedMac })),
  }));
  handle("nimbus:set-presence-phone", (_event, deviceId: unknown) => {
    const known = ctx.networkService.getState().devices.some((device) => device.id === deviceId);
    ctx.settings.windowsClient.network.phoneDeviceId =
      typeof deviceId === "string" && known ? deviceId : null;
    saveSettings(ctx.settings);
    logger.info("Presence phone chosen", {
      chosen: ctx.settings.windowsClient.network.phoneDeviceId !== null,
    });
    return ctx.presenceService?.update() ?? null;
  });
}
