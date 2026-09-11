/**
 * Network awareness — which devices are on the user's local network.
 *
 * Observation and organization only. Nothing here connects to a device,
 * opens a port, logs in, captures traffic or runs anything remotely; the
 * only traffic NIMBUS ever sends for this feature is one ICMP echo
 * ("ping") per local address, when the user presses "Scan network".
 *
 * A device is identified by its hardware (MAC) address, never by its IP:
 * addresses are handed out again and again by the router, so an IP says
 * where a device is today, not which device it is.
 */

/** A neighbor-cache entry: "reachable" was confirmed recently; "stale" is only remembered. */
export type NeighborState = "reachable" | "stale";

export interface NeighborEntry {
  ip: string;
  /** As Windows writes it, e.g. "D8-78-7F-AA-BB-CC". */
  mac: string;
  state: NeighborState;
}

/** This PC on the local network. */
export interface LocalNetworkInfo {
  interfaceAlias: string | null;
  ip: string;
  prefixLength: number;
  mac: string | null;
  gateway: string | null;
}

export interface DiscoveryResult {
  /** Null when this PC has no local network connection. */
  local: LocalNetworkInfo | null;
  neighbors: NeighborEntry[];
}

/**
 * The narrow, fixed set of things discovery may do — implemented for
 * Windows in src/main/network/. There is deliberately no method that
 * takes a port, a command or an arbitrary address range.
 */
export interface NetworkScanner {
  /** Reads what Windows already knows: this PC's address and its neighbor (ARP) cache. Sends nothing. */
  readNeighbors(): Promise<DiscoveryResult>;
  /** Pings each address once so devices answer and enter the neighbor cache. Only private addresses are accepted. */
  ping(addresses: string[], signal: AbortSignal): Promise<void>;
}

export interface HostnameResolver {
  /** A local address's name from the system resolver (usually the router), or null. Never throws. */
  reverse(ip: string): Promise<string | null>;
}

export interface IpHistoryEntry {
  ip: string;
  firstSeen: string;
  lastSeen: string;
}

/** What NIMBUS remembers about one device. */
export interface NetworkDeviceRecord {
  /** "mac:" + the normalized MAC — stable across IP changes. */
  id: string;
  /** Normalized: "d8:78:7f:aa:bb:cc". */
  mac: string;
  nickname: string | null;
  /**
   * The user's own "I know this one" label. A NIMBUS-local classification,
   * NOT a security guarantee: a device can present another's MAC address.
   */
  recognized: boolean;
  hostname: string | null;
  vendor: string | null;
  firstSeen: string;
  /** Last time the device was confirmed present (a "reachable" sighting). */
  lastSeen: string;
  lastIp: string;
  /** Addresses it has used, the current one first. */
  ipHistory: IpHistoryEntry[];
}

export interface NetworkStoreState {
  /** When the first read happened. Devices present then aren't announced as new. */
  baselineAt: string | null;
  devices: NetworkDeviceRecord[];
}

export interface NetworkStateStore {
  load(): NetworkStoreState;
  save(state: NetworkStoreState): void;
}

export interface NetworkDeviceView extends NetworkDeviceRecord {
  displayName: string;
  online: boolean;
  isSelf: boolean;
  isGateway: boolean;
  /** A "private"/randomized address (phones, laptops): it may change, and no manufacturer can be read from it. */
  randomizedMac: boolean;
}

/** Everything the Network tab shows. */
export interface NetworkState {
  enabled: boolean;
  scanning: boolean;
  sweepProgress: { done: number; total: number } | null;
  lastScanAt: string | null;
  lastError: string | null;
  /** A passing message: "Scan cancelled.", "You can scan again in 40 s." */
  notice: string | null;
  /** E.g. "192.168.1.0/24". */
  network: string | null;
  local: { ip: string; interfaceAlias: string | null; gateway: string | null } | null;
  devices: NetworkDeviceView[];
}

/** The Network slice of the Context snapshot. */
export interface NetworkContext {
  retrievedAt: string;
  network: string | null;
  onlineCount: number;
  knownCount: number;
  recognizedCount: number;
  /** Online right now, not recognized, and not this PC. */
  unknownOnlineCount: number;
  online: Array<{ name: string; ip: string; recognized: boolean; isSelf: boolean }>;
}

export const MAX_DEVICES = 500;
export const MAX_IP_HISTORY = 10;
export const MAX_NICKNAME_LENGTH = 60;

export function normalizeNickname(
  value: unknown
): { ok: true; nickname: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, nickname: null };
  if (typeof value !== "string") return { ok: false, error: "A nickname must be text." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, nickname: null };
  if (trimmed.length > MAX_NICKNAME_LENGTH) {
    return { ok: false, error: `A nickname can be at most ${MAX_NICKNAME_LENGTH} characters.` };
  }
  if ([...trimmed].some((c) => c.charCodeAt(0) < 32)) {
    return { ok: false, error: "A nickname can't contain control characters." };
  }
  return { ok: true, nickname: trimmed };
}
