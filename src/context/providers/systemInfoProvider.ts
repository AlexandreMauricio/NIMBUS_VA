import * as os from "os";
import { ContextProvider } from "../types";
import { APP_VERSION } from "../../common/appInfo";

export interface SystemInfoContext {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  cpuCount: number;
  totalMemoryMB: number;
  freeMemoryMB: number;
  uptimeSeconds: number;
  nimbusVersion: string;
}

/**
 * Provides basic, non-sensitive machine information: OS/platform, CPU
 * count, memory, uptime. Nothing here leaves the machine — it exists so
 * NIMBUS can reason about its own operating environment (e.g. later:
 * "system running low on memory"), not for telemetry.
 */
export class SystemInfoProvider implements ContextProvider<SystemInfoContext> {
  readonly id = "system";
  readonly displayName = "System Information";

  isAvailable(): boolean {
    return true;
  }

  getContext(): SystemInfoContext {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuCount: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds: Math.round(os.uptime()),
      nimbusVersion: APP_VERSION,
    };
  }
}
