import { ContextProvider } from "../context/types";
import { NetworkService } from "./networkService";
import { NetworkContext } from "./types";

/**
 * The Network slice of the Context snapshot: how many devices are online,
 * how many are recognized, and which unknown ones are around. Reads the
 * service's current state — it never triggers a scan, and only waits for
 * a first read of the neighbor cache when none has happened yet.
 */
export class NetworkProvider implements ContextProvider<NetworkContext> {
  readonly id = "network";
  readonly displayName = "Network";

  constructor(private readonly service: NetworkService) {}

  isAvailable(): boolean {
    return this.service.isEnabled();
  }

  async getContext(): Promise<NetworkContext> {
    if (!this.service.hasRead()) await this.service.refresh(true);
    const context = this.service.getContext();
    if (!context.network) {
      throw new Error(this.service.getState().lastError ?? "No local network connection");
    }
    return context;
  }
}
