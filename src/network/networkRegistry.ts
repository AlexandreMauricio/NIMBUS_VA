import { isDeviceMac, isRandomizedMac, normalizeMac } from "./mac";
import { isHostInSubnet, isPrivateIPv4, parseIPv4 } from "./subnet";
import {
  DiscoveryResult,
  LocalNetworkInfo,
  MAX_DEVICES,
  MAX_IP_HISTORY,
  NeighborEntry,
  NetworkDeviceRecord,
  NetworkDeviceView,
  NetworkStoreState,
} from "./types";

/** A device confirmed within this long counts as online. */
export const ONLINE_WINDOW_MS = 10 * 60_000;

/**
 * The devices NIMBUS knows, merged from each discovery pass. Pure: no
 * I/O, and the clock is passed in.
 *
 * Identity is the MAC address. The same MAC at a new IP is the same
 * device (its IP history grows); a new MAC at a familiar IP is a
 * different device (the router handed the address on).
 */
export class NetworkRegistry {
  private readonly devices = new Map<string, NetworkDeviceRecord>();
  private baselineAt: string | null;

  constructor(
    state: NetworkStoreState | null = null,
    private readonly vendorFor: (mac: string) => string | null = () => null
  ) {
    this.baselineAt = typeof state?.baselineAt === "string" ? state.baselineAt : null;
    for (const device of state?.devices ?? []) {
      if (!isRecord(device)) continue;
      this.devices.set(device.id, {
        ...device,
        nickname: typeof device.nickname === "string" ? device.nickname : null,
        recognized: device.recognized === true,
        hostname: typeof device.hostname === "string" ? device.hostname : null,
        vendor: typeof device.vendor === "string" ? device.vendor : null,
        ipHistory: device.ipHistory
          .filter(
            (e) =>
              e &&
              typeof e.ip === "string" &&
              typeof e.firstSeen === "string" &&
              typeof e.lastSeen === "string"
          )
          .slice(0, MAX_IP_HISTORY)
          .map((e) => ({ ...e })),
      });
    }
  }

  /**
   * Merges one discovery pass. Returns the devices seen for the first
   * time — except on the very first pass, which records what is already
   * there as the baseline and announces nothing.
   */
  apply(result: DiscoveryResult, now: Date): NetworkDeviceRecord[] {
    const nowIso = now.toISOString();
    const firstRun = this.baselineAt === null;
    const created: NetworkDeviceRecord[] = [];

    for (const sighting of sightings(result)) {
      const id = `mac:${sighting.mac}`;
      const reachable = sighting.state === "reachable";
      const record = this.devices.get(id);
      if (!record) {
        const fresh: NetworkDeviceRecord = {
          id,
          mac: sighting.mac,
          nickname: null,
          recognized: false,
          hostname: null,
          vendor: this.vendorFor(sighting.mac),
          firstSeen: nowIso,
          lastSeen: nowIso,
          lastIp: sighting.ip,
          ipHistory: [{ ip: sighting.ip, firstSeen: nowIso, lastSeen: nowIso }],
        };
        this.devices.set(id, fresh);
        created.push(fresh);
        continue;
      }
      if (reachable) record.lastSeen = nowIso;
      if (!record.vendor) record.vendor = this.vendorFor(sighting.mac);
      noteIp(record, sighting.ip, nowIso, reachable);
    }

    if (firstRun) this.baselineAt = nowIso;
    this.enforceCap();
    return firstRun ? [] : created;
  }

  has(id: string): boolean {
    return this.devices.has(id);
  }

  setNickname(id: string, nickname: string | null): void {
    const device = this.devices.get(id);
    if (device) device.nickname = nickname;
  }

  setRecognized(id: string, recognized: boolean): void {
    const device = this.devices.get(id);
    if (device) device.recognized = recognized;
  }

  setHostname(id: string, hostname: string): void {
    const device = this.devices.get(id);
    const clean = hostname.trim().replace(/\.$/, "").slice(0, 100);
    if (device && clean) device.hostname = clean;
  }

  forget(id: string): boolean {
    return this.devices.delete(id);
  }

  views(now: Date, local: LocalNetworkInfo | null): NetworkDeviceView[] {
    const selfMac = local?.mac ? normalizeMac(local.mac) : null;
    return [...this.devices.values()]
      .map((device): NetworkDeviceView => {
        const isSelf = selfMac !== null && device.mac === selfMac;
        const isGateway = !isSelf && !!local?.gateway && device.lastIp === local.gateway;
        const online =
          (isSelf && local !== null) || now.getTime() - Date.parse(device.lastSeen) <= ONLINE_WINDOW_MS;
        return {
          ...device,
          ipHistory: device.ipHistory.map((e) => ({ ...e })),
          isSelf,
          isGateway,
          online,
          randomizedMac: isRandomizedMac(device.mac),
          displayName:
            device.nickname ??
            device.hostname ??
            (isSelf ? "This PC" : isGateway ? "Router" : "Unknown device"),
        };
      })
      .sort(compareViews);
  }

  state(): NetworkStoreState {
    return {
      baselineAt: this.baselineAt,
      devices: [...this.devices.values()].map((d) => ({
        ...d,
        ipHistory: d.ipHistory.map((e) => ({ ...e })),
      })),
    };
  }

  /** Over the cap, the least useful records go first: unlabelled, then the longest unseen. */
  private enforceCap(): void {
    if (this.devices.size <= MAX_DEVICES) return;
    const disposable = [...this.devices.values()]
      .filter((d) => !d.nickname && !d.recognized)
      .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    for (const device of disposable) {
      if (this.devices.size <= MAX_DEVICES) break;
      this.devices.delete(device.id);
    }
  }
}

function isRecord(value: unknown): value is NetworkDeviceRecord {
  const d = value as NetworkDeviceRecord;
  return (
    !!d &&
    typeof d.mac === "string" &&
    normalizeMac(d.mac) === d.mac &&
    d.id === `mac:${d.mac}` &&
    typeof d.firstSeen === "string" &&
    typeof d.lastSeen === "string" &&
    typeof d.lastIp === "string" &&
    Array.isArray(d.ipHistory)
  );
}

/**
 * The usable entries of one pass: real device MACs, private addresses on
 * this PC's subnet, one per MAC-and-IP pair (a reachable sighting wins),
 * plus this PC itself. Stale entries come first, so where one device shows
 * at two addresses the reachable one ends up as its current IP.
 */
function sightings(result: DiscoveryResult): NeighborEntry[] {
  const local = result.local;
  const entries: NeighborEntry[] = [...result.neighbors];
  if (local?.mac) entries.push({ ip: local.ip, mac: local.mac, state: "reachable" });

  const byKey = new Map<string, NeighborEntry>();
  for (const entry of entries) {
    const mac = normalizeMac(entry?.mac ?? "");
    if (!mac || !isDeviceMac(mac)) continue;
    if (!isPrivateIPv4(entry.ip)) continue;
    if (local && !isHostInSubnet(entry.ip, local.ip, local.prefixLength)) continue;
    const key = `${mac}|${entry.ip}`;
    if (byKey.get(key)?.state === "reachable") continue;
    byKey.set(key, { ip: entry.ip, mac, state: entry.state === "reachable" ? "reachable" : "stale" });
  }
  return [...byKey.values()].sort((a, b) => (a.state === b.state ? 0 : a.state === "stale" ? -1 : 1));
}

function noteIp(record: NetworkDeviceRecord, ip: string, nowIso: string, reachable: boolean): void {
  const known = record.ipHistory.find((e) => e.ip === ip);
  if (known) {
    if (reachable) known.lastSeen = nowIso;
  } else {
    record.ipHistory.push({ ip, firstSeen: nowIso, lastSeen: nowIso });
  }
  if (reachable || !known) record.lastIp = ip;
  record.ipHistory.sort((a, b) =>
    a.ip === record.lastIp ? -1 : b.ip === record.lastIp ? 1 : b.lastSeen.localeCompare(a.lastSeen)
  );
  if (record.ipHistory.length > MAX_IP_HISTORY) record.ipHistory.length = MAX_IP_HISTORY;
}

function compareViews(a: NetworkDeviceView, b: NetworkDeviceView): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
  if (a.online !== b.online) return a.online ? -1 : 1;
  if (a.recognized !== b.recognized) return a.recognized ? -1 : 1;
  return (parseIPv4(a.lastIp) ?? 0) - (parseIPv4(b.lastIp) ?? 0);
}
