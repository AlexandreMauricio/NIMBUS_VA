import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextEventBus } from "../events/eventBus";
import { ContextEvent } from "../events/types";
import { ONLINE_WINDOW_MS } from "./networkRegistry";
import { NetworkProvider } from "./networkProvider";
import { MIN_SWEEP_INTERVAL_MS, NetworkService } from "./networkService";
import { DiscoveryResult, NetworkScanner, NetworkStoreState } from "./types";
import { DeviceIdentifier, DeviceProbeResult } from "./identify";

const SELF = "28-D0-43-00-00-01";
const ROUTER = "D8-78-7F-00-00-02";
const TV = "CC-28-AA-00-00-03";

class FakeScanner implements NetworkScanner {
  result: DiscoveryResult = {
    local: {
      interfaceAlias: "Wi-Fi",
      ip: "192.168.1.170",
      prefixLength: 24,
      mac: SELF,
      gateway: "192.168.1.254",
    },
    neighbors: [
      { ip: "192.168.1.254", mac: ROUTER, state: "reachable" },
      { ip: "192.168.1.40", mac: TV, state: "stale" },
      { ip: "192.168.1.255", mac: "FF-FF-FF-FF-FF-FF", state: "reachable" },
      { ip: "224.0.0.251", mac: "01-00-5E-00-00-FB", state: "reachable" },
      { ip: "192.168.1.209", mac: "00-00-00-00-00-00", state: "stale" },
      { ip: "10.0.0.5", mac: "AA-00-00-00-00-09", state: "reachable" },
    ],
  };
  fail = false;
  reads = 0;
  pings: string[][] = [];
  onPing: (() => void) | null = null;

  async readNeighbors(): Promise<DiscoveryResult> {
    this.reads++;
    if (this.fail) throw new Error("PowerShell unavailable");
    return JSON.parse(JSON.stringify(this.result));
  }
  async ping(addresses: string[]): Promise<void> {
    this.pings.push(addresses);
    this.onPing?.();
  }
}

function setup(
  options: { saved?: NetworkStoreState; enabled?: boolean; identifier?: DeviceIdentifier } = {}
) {
  const clock = { now: new Date("2026-09-11T10:00:00Z") };
  const scanner = new FakeScanner();
  const bus = new ContextEventBus();
  const events: ContextEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const saves: NetworkStoreState[] = [];
  const settings = { enabled: options.enabled ?? true };
  const lookups: string[] = [];
  const names: Record<string, string> = { "192.168.1.254": "GEN8." };
  const service = new NetworkService({
    scanner,
    identifier: options.identifier,
    resolver: {
      reverse: async (ip) => {
        lookups.push(ip);
        return names[ip] ?? null;
      },
    },
    store: {
      load: () => options.saved ?? { baselineAt: null, devices: [] },
      save: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    },
    bus,
    isEnabled: () => settings.enabled,
    now: () => clock.now,
    localHostname: () => "Alexandre-PC",
  });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { service, scanner, events, saves, settings, advance, lookups, names };
}

const byName = (state: { devices: Array<{ displayName: string }> }) =>
  state.devices.map((d) => d.displayName);

// --------------------------------------------------------------- discovery

test("the first read records what's there — this PC, the router, a cached TV — and announces nothing", async () => {
  const { service, events } = setup();
  const state = await service.refresh();

  assert.equal(state.network, "192.168.1.0/24");
  assert.deepEqual(byName(state), ["Alexandre-PC", "GEN8", "Unknown device"]);
  const [self, router, tv] = state.devices;
  assert.equal(self.isSelf, true);
  assert.equal(router.isGateway, true);
  assert.equal(router.mac, "d8:78:7f:00:00:02");
  assert.equal(tv.lastIp, "192.168.1.40");
  assert.equal(
    state.devices.length,
    3,
    "broadcast, multicast, unresolved and off-subnet entries are ignored"
  );
  assert.deepEqual(events, [], "the baseline isn't news");
});

test("a device never seen before is announced on the event bus, once", async () => {
  const { service, scanner, events, advance } = setup();
  await service.refresh();
  scanner.result.neighbors.push({ ip: "192.168.1.42", mac: "3C-22-FB-00-00-04", state: "reachable" });
  advance(60_000);
  await service.refresh();
  advance(60_000);
  await service.refresh();

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "networkDeviceAppeared");
  if (event.type !== "networkDeviceAppeared") return;
  assert.equal(event.deviceId, "mac:3c:22:fb:00:00:04");
  assert.equal(event.ip, "192.168.1.42");
  assert.equal(event.source, "networkService");
});

test("an IP change is the same device, with its address history", async () => {
  const { service, scanner, advance } = setup();
  await service.refresh();
  scanner.result.neighbors[0] = { ip: "192.168.1.253", mac: ROUTER, state: "reachable" };
  advance(60_000);
  const state = await service.refresh();

  const routers = state.devices.filter((d) => d.mac === "d8:78:7f:00:00:02");
  assert.equal(routers.length, 1);
  assert.equal(routers[0].lastIp, "192.168.1.253");
  assert.deepEqual(
    routers[0].ipHistory.map((e) => e.ip),
    ["192.168.1.253", "192.168.1.254"]
  );
});

test("a new MAC at a familiar IP is a different device; duplicates in one read are one", async () => {
  const { service, scanner, advance } = setup();
  await service.refresh();
  scanner.result.neighbors = [
    { ip: "192.168.1.40", mac: "3C-22-FB-00-00-04", state: "reachable" },
    { ip: "192.168.1.40", mac: "3c:22:fb:00:00:04", state: "stale" },
    { ip: "192.168.1.40", mac: "3C-22-FB-00-00-04", state: "reachable" },
  ];
  advance(60_000);
  const state = await service.refresh();

  assert.equal(state.devices.filter((d) => d.mac === "3c:22:fb:00:00:04").length, 1);
  assert.equal(
    state.devices.filter((d) => d.lastIp === "192.168.1.40").length,
    2,
    "the old TV and the newcomer"
  );
});

test("online means confirmed in the last 10 minutes — a cached ('stale') entry doesn't keep a device online", async () => {
  const { service, scanner, advance } = setup();
  await service.refresh();
  scanner.result.neighbors = [{ ip: "192.168.1.40", mac: TV, state: "stale" }];
  advance(ONLINE_WINDOW_MS + 60_000);
  const state = await service.refresh();

  const tv = state.devices.find((d) => d.mac === "cc:28:aa:00:00:03")!;
  const router = state.devices.find((d) => d.mac === "d8:78:7f:00:00:02")!;
  assert.equal(tv.online, false);
  assert.equal(router.online, false, "not in the cache any more");
  assert.equal(state.devices.find((d) => d.isSelf)!.online, true);
});

// ----------------------------------------------------------------- labels

test("nicknames and the recognized label are saved, checked, and survive a restart", async () => {
  const first = setup();
  await first.service.refresh();
  const tvId = "mac:cc:28:aa:00:00:03";

  first.service.updateDevice(tvId, { nickname: " Living Room TV ", recognized: true });
  assert.throws(() => first.service.updateDevice(tvId, { nickname: "x".repeat(61) }), /at most 60/);
  assert.throws(() => first.service.updateDevice(tvId, { recognized: "yes" }), /true or false/);
  assert.throws(
    () => first.service.updateDevice("mac:00:00:00:00:00:99", { nickname: "x" }),
    /no longer known/
  );

  const saved = first.saves[first.saves.length - 1];
  const restarted = setup({ saved });
  const state = await restarted.service.refresh();
  const tv = state.devices.find((d) => d.id === tvId)!;
  assert.equal(tv.nickname, "Living Room TV");
  assert.equal(tv.displayName, "Living Room TV");
  assert.equal(tv.recognized, true);
  assert.deepEqual(restarted.events, [], "known devices aren't news after a restart");

  restarted.service.updateDevice(tvId, { nickname: "" });
  assert.equal(restarted.service.getState().devices.find((d) => d.id === tvId)!.nickname, null);
});

test("forgetting a device removes it and its labels; if it's still there, it returns as new", async () => {
  const { service, events, advance } = setup();
  await service.refresh();
  service.updateDevice("mac:cc:28:aa:00:00:03", { nickname: "TV" });
  service.forget("mac:cc:28:aa:00:00:03");
  assert.equal(service.getState().devices.length, 2);

  advance(60_000);
  const state = await service.refresh();
  assert.equal(state.devices.find((d) => d.mac === "cc:28:aa:00:00:03")?.nickname, null);
  assert.equal(events.length, 1);
});

// --------------------------------------------------------------- failures

test("when Windows can't be read, the known devices stay and the reason is shown", async () => {
  const { service, scanner, advance } = setup();
  await service.refresh();
  scanner.fail = true;
  advance(60_000);
  const state = await service.refresh();

  assert.equal(state.devices.length, 3);
  assert.match(state.lastError ?? "", /Couldn't read the network/);

  scanner.fail = false;
  advance(60_000);
  assert.equal((await service.refresh()).lastError, null);
});

test("no local network connection is a clear state, not a crash", async () => {
  const { service, scanner } = setup();
  scanner.result = { local: null, neighbors: [] };
  const state = await service.refresh();
  assert.equal(state.network, null);
  assert.match(state.lastError ?? "", /isn't connected|doesn't seem to be connected/);
});

test("switched off, nothing is read", async () => {
  const { service, scanner } = setup({ enabled: false });
  await service.refresh();
  await service.scan();
  assert.equal(scanner.reads, 0);
  assert.deepEqual(scanner.pings, []);
});

test("a quick second Refresh reuses the last read", async () => {
  const { service, scanner, advance } = setup();
  await service.refresh();
  advance(5_000);
  await service.refresh();
  assert.equal(scanner.reads, 1);
});

// ------------------------------------------------------------------- scan

test("a scan pings the local /24 in batches of 32, never this PC, then reads the cache", async () => {
  const { service, scanner } = setup();
  await service.refresh();
  const readsBefore = scanner.reads;
  const state = await service.scan();

  const all = scanner.pings.flat();
  assert.equal(scanner.pings.length, 8);
  assert.ok(scanner.pings.every((batch) => batch.length <= 32));
  assert.equal(all.length, 253);
  assert.ok(all.every((ip) => ip.startsWith("192.168.1.")));
  assert.ok(!all.includes("192.168.1.170"));
  assert.equal(scanner.reads, readsBefore + 1);
  assert.equal(state.scanning, false);
});

test("scans are limited to one a minute", async () => {
  const { service, scanner, advance } = setup();
  await service.scan();
  const calls = scanner.pings.length;
  advance(10_000);
  const state = await service.scan();
  assert.equal(scanner.pings.length, calls);
  assert.match(state.notice ?? "", /scan again in 50 s/);
  advance(MIN_SWEEP_INTERVAL_MS);
  await service.scan();
  assert.ok(scanner.pings.length > calls);
});

test("a scan can be cancelled between batches", async () => {
  const { service, scanner } = setup();
  await service.refresh();
  scanner.onPing = () => service.cancel();
  const state = await service.scan();
  assert.equal(scanner.pings.length, 1);
  assert.equal(state.notice, "Scan cancelled.");
  assert.equal(service.cancel(), false, "nothing left to cancel");
});

// -------------------------------------------------------------- hostnames

test("names are looked up for online devices, at most once an hour per address", async () => {
  const { service, lookups, advance } = setup();
  await service.refresh();
  assert.deepEqual(lookups, ["192.168.1.254", "192.168.1.40"], "online ones, never this PC");
  advance(15 * 60_000);
  await service.refresh();
  assert.equal(lookups.length, 2, "none repeated within the hour");
  advance(60 * 60_000);
  await service.refresh();
  assert.deepEqual(lookups.slice(2), ["192.168.1.254"], "the router again; the TV isn't online any more");
});

// ---------------------------------------------------------------- context

test("the Context slice counts what's online, recognized and unknown", async () => {
  const { service } = setup();
  const provider = new NetworkProvider(service);
  const context = await provider.getContext();

  assert.equal(provider.id, "network");
  assert.equal(context.network, "192.168.1.0/24");
  assert.equal(context.onlineCount, 3);
  assert.equal(context.knownCount, 3);
  assert.equal(context.recognizedCount, 0);
  assert.equal(context.unknownOnlineCount, 2, "this PC isn't 'unknown'");
});

test("the Context provider fails clearly without a network, so ContextService can mark it", async () => {
  const { service, scanner } = setup();
  scanner.result = { local: null, neighbors: [] };
  await assert.rejects(new NetworkProvider(service).getContext(), /connected/);
});

// -------------------------------------------------------------- asking

const TV_ANSWER: DeviceProbeResult = {
  ssdp: [
    {
      server: "Tizen/4.0 UPnP/1.0",
      st: "urn:samsung.com:device:RemoteControlReceiver:1",
      usn: null,
      location: null,
    },
  ],
  upnp: {
    friendlyName: "[TV] Samsung Q60",
    manufacturer: "Samsung Electronics",
    modelName: "QE55Q60T",
    modelNumber: null,
    modelDescription: null,
    deviceType: null,
  },
  mdnsNames: [],
  mdnsServices: [],
  mdnsInstances: [],
  netbiosName: null,
};
const TV_ID = "mac:cc:28:aa:00:00:03";

test("asking a device keeps what it said; each device at most every 30 s, never this PC", async () => {
  const asked: string[] = [];
  const identifier: DeviceIdentifier = {
    probe: async (ip) => {
      asked.push(ip);
      return TV_ANSWER;
    },
  };
  const { service, advance, saves } = setup({ identifier });
  await service.refresh();

  const state = await service.identifyDevice(TV_ID);
  const tv = state.devices.find((d) => d.id === TV_ID)!;
  assert.deepEqual(asked, ["192.168.1.40"], "the address comes from NIMBUS's own list");
  assert.equal(tv.details?.kind, "TV");
  assert.equal(tv.details?.model, "QE55Q60T");
  assert.equal(tv.details?.software, "Tizen/4.0 UPnP/1.0");
  assert.equal(state.identifying, null);

  await assert.rejects(service.identifyDevice(TV_ID), /again in 30 s/);
  advance(31_000);
  await service.identifyDevice(TV_ID);
  assert.equal(asked.length, 2);

  await assert.rejects(service.identifyDevice("mac:28:d0:43:00:00:01"), /this PC/);
  await assert.rejects(service.identifyDevice("mac:00:00:00:00:00:99"), /no longer known/);

  const restarted = setup({ saved: saves[saves.length - 1] });
  const again = await restarted.service.refresh();
  assert.equal(
    again.devices.find((d) => d.id === TV_ID)?.details?.name,
    "[TV] Samsung Q60",
    "kept across restarts"
  );
});

test("one device is asked at a time; a failure is reported and frees the way", async () => {
  let finish: () => void = () => {};
  let fail = false;
  const identifier: DeviceIdentifier = {
    probe: () =>
      new Promise((resolve, reject) => {
        finish = () => (fail ? reject(new Error("socket error")) : resolve(TV_ANSWER));
      }),
  };
  const { service, advance } = setup({ identifier });
  await service.refresh();

  const first = service.identifyDevice(TV_ID);
  assert.equal(service.getState().identifying, TV_ID);
  await assert.rejects(service.identifyDevice("mac:d8:78:7f:00:00:02"), /Already asking/);
  finish();
  await first;

  advance(31_000);
  fail = true;
  const failing = service.identifyDevice("mac:d8:78:7f:00:00:02");
  finish();
  await assert.rejects(failing, /Couldn't ask/);
  assert.equal(service.getState().identifying, null);
});

test("with watching off, or without an identifier, nothing is asked", async () => {
  const off = setup({ enabled: false });
  await assert.rejects(off.service.identifyDevice(TV_ID), /off/);
  const none = setup();
  await none.service.refresh();
  await assert.rejects(none.service.identifyDevice(TV_ID), /isn't available/);
});
