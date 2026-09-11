import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeviceMac, isRandomizedMac, normalizeMac } from "./mac";
import { parseOuiCsv, vendorLookup } from "./oui";
import { formatIPv4, isHostInSubnet, isPrivateIPv4, networkLabel, parseIPv4, sweepTargets } from "./subnet";
import { normalizeNickname } from "./types";

// --------------------------------------------------------------------- MAC

test("MAC addresses are normalised however Windows or a person writes them", () => {
  assert.equal(normalizeMac("D8-78-7F-AA-BB-CC"), "d8:78:7f:aa:bb:cc");
  assert.equal(normalizeMac("d8:78:7f:aa:bb:cc"), "d8:78:7f:aa:bb:cc");
  assert.equal(normalizeMac("d8787faabbcc"), "d8:78:7f:aa:bb:cc");
  assert.equal(normalizeMac("d8-78"), null);
  assert.equal(normalizeMac("zz-78-7f-aa-bb-cc"), null);
});

test("zero, broadcast and multicast addresses don't name a device", () => {
  assert.equal(isDeviceMac("00:00:00:00:00:00"), false);
  assert.equal(isDeviceMac("ff:ff:ff:ff:ff:ff"), false);
  assert.equal(isDeviceMac("01:00:5e:00:00:fb"), false);
  assert.equal(isDeviceMac("33:33:00:00:00:01"), false);
  assert.equal(isDeviceMac("d8:78:7f:aa:bb:cc"), true);
});

test("private (randomized) addresses are recognised", () => {
  assert.equal(isRandomizedMac("6a:31:b5:00:00:01"), true);
  assert.equal(isRandomizedMac("d8:78:7f:aa:bb:cc"), false);
});

test("the IEEE list is read, quotes and all; randomized addresses get no manufacturer", () => {
  const csv = [
    "Registry,Assignment,Organization Name,Organization Address",
    'MA-L,D8787F,"Example Networks, Inc.","1 Example Way"',
    "MA-L,28D043,Sample Devices,Somewhere",
    "not a line",
  ].join("\n");
  const map = parseOuiCsv(csv);
  assert.equal(map.size, 2);
  const lookup = vendorLookup(map);
  assert.equal(lookup("d8:78:7f:aa:bb:cc"), "Example Networks, Inc.");
  assert.equal(lookup("00:11:22:33:44:55"), null);
  assert.equal(lookup("6a:31:b5:00:00:01"), null);
});

// ------------------------------------------------------------------ subnet

test("IPv4 addresses parse and format; nonsense doesn't", () => {
  assert.equal(formatIPv4(parseIPv4("192.168.1.20")!), "192.168.1.20");
  for (const bad of ["256.1.1.1", "1.2.3", "a.b.c.d", " 1.2.3.4", "1.2.3.4/24"])
    assert.equal(parseIPv4(bad), null, bad);
});

test("only private ranges count as local", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1"])
    assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of ["172.32.0.1", "8.8.8.8", "169.254.1.1", "127.0.0.1", "100.64.0.1"]) {
    assert.equal(isPrivateIPv4(ip), false, ip);
  }
});

test("a host on the subnet excludes its network and broadcast addresses", () => {
  assert.equal(isHostInSubnet("192.168.1.40", "192.168.1.170", 24), true);
  assert.equal(isHostInSubnet("192.168.1.0", "192.168.1.170", 24), false);
  assert.equal(isHostInSubnet("192.168.1.255", "192.168.1.170", 24), false);
  assert.equal(isHostInSubnet("192.168.2.40", "192.168.1.170", 24), false);
  assert.equal(networkLabel("192.168.1.170", 24), "192.168.1.0/24");
});

test("a sweep covers this PC's /24 at most, never itself, and never a public network", () => {
  const local = { interfaceAlias: "Wi-Fi", ip: "192.168.1.170", prefixLength: 24, mac: null, gateway: null };
  const targets = sweepTargets(local);
  assert.equal(targets.length, 253);
  assert.ok(targets.includes("192.168.1.1") && targets.includes("192.168.1.254"));
  assert.ok(
    !targets.includes("192.168.1.170") &&
      !targets.includes("192.168.1.0") &&
      !targets.includes("192.168.1.255")
  );

  const wide = sweepTargets({ ...local, ip: "10.20.30.40", prefixLength: 16 });
  assert.equal(wide.length, 253, "a /16 is narrowed to the /24 around this PC");
  assert.ok(wide.every((ip) => ip.startsWith("10.20.30.")));

  assert.equal(sweepTargets({ ...local, prefixLength: 28 }).length, 13);
  assert.deepEqual(sweepTargets({ ...local, ip: "81.20.1.5" }), []);
});

// ---------------------------------------------------------------- nickname

test("nicknames are trimmed, can be cleared, and are checked", () => {
  assert.deepEqual(normalizeNickname("  Living Room PS5 "), { ok: true, nickname: "Living Room PS5" });
  assert.deepEqual(normalizeNickname(""), { ok: true, nickname: null });
  assert.deepEqual(normalizeNickname(null), { ok: true, nickname: null });
  assert.equal(normalizeNickname("x".repeat(61)).ok, false);
  assert.equal(normalizeNickname("badname").ok, false);
  assert.equal(normalizeNickname(42).ok, false);
});
