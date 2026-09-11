import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../../logging/logger";
import { parseOuiCsv, vendorLookup } from "../../network/oui";
import { NetworkStateStore, NetworkStoreState } from "../../network/types";

/**
 * The network device list — MAC, nickname, recognized flag, names,
 * first/last seen and recent IPs — in network-devices.json. Plain JSON:
 * nothing in it is a credential. The registry validates each entry again
 * when it loads.
 */
export class FileNetworkStore implements NetworkStateStore {
  private readonly filePath = path.join(app.getPath("userData"), "network-devices.json");

  load(): NetworkStoreState {
    try {
      if (!fs.existsSync(this.filePath)) return { baselineAt: null, devices: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<NetworkStoreState>;
      return {
        baselineAt: typeof parsed.baselineAt === "string" ? parsed.baselineAt : null,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      };
    } catch (err) {
      logger.warn("Could not read network-devices.json — starting empty", { error: String(err) });
      return { baselineAt: null, devices: [] };
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: NetworkStoreState): void {
    const tempPath = `${this.filePath}.tmp`;
    try {
      const fd = fs.openSync(tempPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(state), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      logger.warn("Could not save network-devices.json", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}

/**
 * Manufacturer names, only if the user placed the IEEE registry's
 * oui.csv in NIMBUS's data folder. NIMBUS never downloads it.
 */
export function loadVendorLookup(): (mac: string) => string | null {
  const file = path.join(app.getPath("userData"), "oui.csv");
  try {
    if (!fs.existsSync(file)) return () => null;
    const map = parseOuiCsv(fs.readFileSync(file, "utf-8"));
    logger.info("Loaded the manufacturer list", { entries: map.size });
    return vendorLookup(map);
  } catch (err) {
    logger.warn("Could not read oui.csv — manufacturers won't be shown", { error: String(err) });
    return () => null;
  }
}
