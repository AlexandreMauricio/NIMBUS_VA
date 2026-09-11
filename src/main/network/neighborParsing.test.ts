import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNeighborOutput } from "./neighborParsing";
import { WindowsNetworkScanner } from "./windowsNetworkScanner";

test("the neighbor script's JSON becomes this PC's network and its confirmed or cached neighbors", () => {
  const output = [
    "some warning text PowerShell printed",
    JSON.stringify({
      local: {
        alias: "Wi-Fi",
        ip: "192.168.1.170",
        prefix: 24,
        mac: "28-D0-43-00-00-01",
        gateway: "192.168.1.254",
      },
      neighbors: [
        { IPAddress: "192.168.1.254", LinkLayerAddress: "D8-78-7F-00-00-02", State: "Reachable" },
        { IPAddress: "192.168.1.40", LinkLayerAddress: "CC-28-AA-00-00-03", State: "Stale" },
        { IPAddress: "192.168.1.41", LinkLayerAddress: "CC-28-AA-00-00-04", State: "Delay" },
        { IPAddress: "192.168.1.209", LinkLayerAddress: "00-00-00-00-00-00", State: "Unreachable" },
        { IPAddress: "192.168.1.255", LinkLayerAddress: "FF-FF-FF-FF-FF-FF", State: "Permanent" },
      ],
    }),
  ].join("\n");

  const result = parseNeighborOutput(output);

  assert.deepEqual(result.local, {
    interfaceAlias: "Wi-Fi",
    ip: "192.168.1.170",
    prefixLength: 24,
    mac: "28-D0-43-00-00-01",
    gateway: "192.168.1.254",
  });
  assert.deepEqual(
    result.neighbors.map((n) => [n.ip, n.state]),
    [
      ["192.168.1.254", "reachable"],
      ["192.168.1.40", "stale"],
      ["192.168.1.41", "reachable"],
    ]
  );
});

test("PowerShell's single-item collapse, a missing connection and empty output are all handled", () => {
  const one = parseNeighborOutput(
    JSON.stringify({
      local: { alias: null, ip: "10.0.0.2", prefix: 24, mac: "", gateway: "0.0.0.0" },
      neighbors: { IPAddress: "10.0.0.1", LinkLayerAddress: "D8-78-7F-00-00-02", State: "Reachable" },
    })
  );
  assert.equal(one.neighbors.length, 1);
  assert.equal(one.local?.mac, null);
  assert.equal(one.local?.gateway, null);

  assert.equal(parseNeighborOutput(JSON.stringify({ local: null, neighbors: [] })).local, null);
  assert.throws(() => parseNeighborOutput(""), /empty/);
});

test("the scanner passes only well-formed private addresses to the ping script, and nothing once cancelled", async () => {
  const calls: Array<{ env: Record<string, string> }> = [];
  const scanner = new WindowsNetworkScanner(async (_script, env) => {
    calls.push({ env });
    return '{"ok":true}';
  });

  await scanner.ping(
    ["192.168.1.5", "8.8.8.8", "192.168.1.6; rm -rf", "10.0.0.7"],
    new AbortController().signal
  );
  assert.deepEqual(calls, [{ env: { NIMBUS_TARGETS: "192.168.1.5,10.0.0.7" } }]);

  const cancelled = new AbortController();
  cancelled.abort();
  await scanner.ping(["192.168.1.5"], cancelled.signal);
  await scanner.ping(["8.8.8.8"], new AbortController().signal);
  assert.equal(calls.length, 1);
});
