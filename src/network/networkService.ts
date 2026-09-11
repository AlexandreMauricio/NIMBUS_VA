import { randomUUID } from "crypto";
import * as os from "os";
import { logger } from "../logging/logger";
import { ContextEventBus } from "../events/eventBus";
import { NetworkRegistry } from "./networkRegistry";
import { networkLabel, sweepTargets } from "./subnet";
import {
  HostnameResolver,
  LocalNetworkInfo,
  NetworkContext,
  NetworkScanner,
  NetworkState,
  NetworkStateStore,
  normalizeNickname,
} from "./types";

/** How often Windows' neighbor cache is read while watching is on. Reading sends nothing. */
export const PASSIVE_INTERVAL_MS = 2 * 60_000;
/** A scan (the ping sweep) may start at most this often. */
export const MIN_SWEEP_INTERVAL_MS = 60_000;
/** Addresses pinged together; the sweep can be cancelled between batches. */
export const SWEEP_BATCH_SIZE = 32;
/** A "Refresh" within this long of the last read reuses it. */
const MIN_READ_INTERVAL_MS = 10_000;
const HOSTNAME_RECHECK_MS = 60 * 60_000;
const MAX_HOSTNAME_LOOKUPS = 64;
const HOSTNAME_CONCURRENCY = 8;

export interface NetworkServiceDeps {
  scanner: NetworkScanner;
  resolver?: HostnameResolver;
  store?: NetworkStateStore;
  /** Where "a new device appeared" is published — the one existing event bus. */
  bus?: ContextEventBus;
  vendorFor?: (mac: string) => string | null;
  isEnabled: () => boolean;
  now?: () => Date;
  /** This PC's own name. */
  localHostname?: () => string;
  /** Something the Network tab shows changed. */
  onChange?: () => void;
}

/**
 * Runs network awareness: reads the neighbor cache every two minutes
 * while watching is on, runs the bounded ping sweep when asked, keeps the
 * device registry, persists it, and publishes `networkDeviceAppeared` for
 * a device never seen before. It observes; it never connects to a device.
 */
export class NetworkService {
  private readonly registry: NetworkRegistry;
  private local: LocalNetworkInfo | null = null;
  private lastScanAt: string | null = null;
  private lastReadAtMs = -Infinity;
  private lastSweepAtMs = -Infinity;
  private lastError: string | null = null;
  private notice: string | null = null;
  private sweep: { controller: AbortController; done: number; total: number } | null = null;
  private reading: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly hostnameCheckedAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: NetworkServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    let saved = null;
    try {
      saved = deps.store?.load() ?? null;
    } catch (err) {
      logger.warn("Could not read the network device list — starting empty", { error: String(err) });
    }
    this.registry = new NetworkRegistry(saved, deps.vendorFor);
  }

  isEnabled(): boolean {
    return this.deps.isEnabled();
  }

  start(intervalMs = PASSIVE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancel();
  }

  /** Re-reads the neighbor cache (unless it was read moments ago). Sends nothing. */
  async refresh(force = false): Promise<NetworkState> {
    if (!this.isEnabled()) return this.getState();
    if (force || this.now().getTime() - this.lastReadAtMs >= MIN_READ_INTERVAL_MS) await this.read();
    return this.getState();
  }

  /** Whether a first read has happened — the Context provider waits for one. */
  hasRead(): boolean {
    return this.lastScanAt !== null || this.lastError !== null;
  }

  /**
   * The "Scan network" button: pings each address on this PC's subnet (at
   * most its /24, private addresses only) in batches of 32, cancellable
   * between batches, at most once a minute — then reads the neighbor
   * cache, which the pings have filled.
   */
  async scan(): Promise<NetworkState> {
    if (!this.isEnabled()) {
      this.notice = "Network watching is off.";
      return this.getState();
    }
    if (this.sweep) return this.getState();
    const waitMs = MIN_SWEEP_INTERVAL_MS - (this.now().getTime() - this.lastSweepAtMs);
    if (waitMs > 0) {
      this.notice = `You can scan again in ${Math.ceil(waitMs / 1000)} s.`;
      this.changed();
      return this.getState();
    }
    if (!this.local) await this.read();
    if (!this.local) return this.getState();

    const targets = sweepTargets(this.local);
    const controller = new AbortController();
    this.sweep = { controller, done: 0, total: targets.length };
    this.lastSweepAtMs = this.now().getTime();
    this.notice = null;
    this.changed();
    logger.info("Network scan started", { addresses: targets.length });

    try {
      for (let i = 0; i < targets.length; i += SWEEP_BATCH_SIZE) {
        if (controller.signal.aborted) break;
        const batch = targets.slice(i, i + SWEEP_BATCH_SIZE);
        try {
          await this.deps.scanner.ping(batch, controller.signal);
        } catch (err) {
          logger.warn("Network scan batch failed", { error: String(err) });
          this.lastError = "The scan stopped early: Windows couldn't send the pings.";
          break;
        }
        this.sweep.done += batch.length;
        this.changed();
      }
    } finally {
      if (controller.signal.aborted) this.notice = "Scan cancelled.";
      this.sweep = null;
    }
    await this.read();
    return this.getState();
  }

  /** Stops a running scan after its current batch. */
  cancel(): boolean {
    if (!this.sweep) return false;
    this.sweep.controller.abort();
    return true;
  }

  /** Nickname and/or recognized flag — the user's own labels. */
  updateDevice(id: string, changes: unknown): NetworkState {
    if (!this.registry.has(id)) throw new Error("That device is no longer known.");
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      throw new Error("Nothing to change.");
    const c = changes as Record<string, unknown>;
    if ("nickname" in c) {
      const result = normalizeNickname(c.nickname);
      if (!result.ok) throw new Error(result.error);
      this.registry.setNickname(id, result.nickname);
    }
    if ("recognized" in c) {
      if (typeof c.recognized !== "boolean") throw new Error("Recognized must be true or false.");
      this.registry.setRecognized(id, c.recognized);
    }
    this.persist();
    this.changed();
    return this.getState();
  }

  /** Removes a device and its labels. If it's still around, it comes back as new. */
  forget(id: string): NetworkState {
    if (this.registry.forget(id)) {
      this.persist();
      this.changed();
    }
    return this.getState();
  }

  getState(): NetworkState {
    const now = this.now();
    return {
      enabled: this.isEnabled(),
      scanning: this.sweep !== null,
      sweepProgress: this.sweep ? { done: this.sweep.done, total: this.sweep.total } : null,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      notice: this.notice,
      network: this.local ? networkLabel(this.local.ip, this.local.prefixLength) : null,
      local: this.local
        ? { ip: this.local.ip, interfaceAlias: this.local.interfaceAlias, gateway: this.local.gateway }
        : null,
      devices: this.registry.views(now, this.local),
    };
  }

  getContext(): NetworkContext {
    const views = this.registry.views(this.now(), this.local);
    const online = views.filter((d) => d.online);
    return {
      retrievedAt: this.lastScanAt ?? this.now().toISOString(),
      network: this.local ? networkLabel(this.local.ip, this.local.prefixLength) : null,
      onlineCount: online.length,
      knownCount: views.length,
      recognizedCount: views.filter((d) => d.recognized).length,
      unknownOnlineCount: online.filter((d) => !d.recognized && !d.isSelf).length,
      online: online.map((d) => ({
        name: d.displayName,
        ip: d.lastIp,
        recognized: d.recognized,
        isSelf: d.isSelf,
      })),
    };
  }

  private read(): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = (async () => {
      const now = this.now();
      this.lastReadAtMs = now.getTime();
      let result;
      try {
        result = await this.deps.scanner.readNeighbors();
      } catch (err) {
        logger.warn("Could not read the network neighbor list", { error: String(err) });
        this.lastError = "Couldn't read the network right now. The devices below are from earlier.";
        this.changed();
        return;
      }
      if (!result.local) {
        this.local = null;
        this.lastError = "This PC doesn't seem to be connected to a local network.";
        this.changed();
        return;
      }
      this.lastError = null;
      this.local = result.local;
      const created = this.registry.apply(result, now);
      this.lastScanAt = now.toISOString();
      this.nameSelf();
      await this.resolveHostnames(now.getTime());
      this.persist();
      for (const device of created) {
        if (this.local.mac && device.mac === this.registry.views(now, this.local).find((d) => d.isSelf)?.mac)
          continue;
        this.deps.bus?.publish({
          id: randomUUID(),
          type: "networkDeviceAppeared",
          occurredAt: now.toISOString(),
          source: "networkService",
          deviceId: device.id,
          ip: device.lastIp,
          mac: device.mac,
          hostname: device.hostname,
          vendor: device.vendor,
        });
      }
      if (created.length > 0) logger.info("New devices on the network", { count: created.length });
      this.changed();
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private nameSelf(): void {
    const self = this.registry.views(this.now(), this.local).find((d) => d.isSelf);
    if (!self) return;
    try {
      this.registry.setHostname(self.id, (this.deps.localHostname ?? os.hostname)());
    } catch {
      // Not knowing this PC's own name only costs a label.
    }
  }

  /** Names for online devices, a few at a time, each address at most once an hour. */
  private async resolveHostnames(nowMs: number): Promise<void> {
    const resolver = this.deps.resolver;
    if (!resolver) return;
    const due = this.registry
      .views(new Date(nowMs), this.local)
      .filter((d) => d.online && !d.isSelf)
      .filter((d) => nowMs - (this.hostnameCheckedAt.get(d.lastIp) ?? -Infinity) >= HOSTNAME_RECHECK_MS)
      .slice(0, MAX_HOSTNAME_LOOKUPS);
    for (let i = 0; i < due.length; i += HOSTNAME_CONCURRENCY) {
      const batch = due.slice(i, i + HOSTNAME_CONCURRENCY);
      const names = await Promise.all(batch.map((d) => resolver.reverse(d.lastIp).catch(() => null)));
      batch.forEach((device, j) => {
        this.hostnameCheckedAt.set(device.lastIp, nowMs);
        const name = names[j];
        if (name) this.registry.setHostname(device.id, name);
      });
    }
  }

  private persist(): void {
    try {
      this.deps.store?.save(this.registry.state());
    } catch (err) {
      logger.warn("Could not save the network device list", { error: String(err) });
    }
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch (err) {
      logger.warn("A network change listener threw", { error: String(err) });
    }
  }
}
