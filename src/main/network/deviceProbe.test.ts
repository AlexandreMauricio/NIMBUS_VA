import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceProber, ProbeTransport } from "./deviceProbe";
import { buildDnsQuery } from "../../network/identify";

const TV = "192.168.1.40";

function dnsPtrReply(id: number, question: string, targets: string[]): Buffer {
  const q = buildDnsQuery(id, question);
  const header = Buffer.from(q.subarray(0, 12));
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(targets.length, 6);
  const name = q.subarray(12, q.length - 4);
  const answers = targets.map((t) => {
    const rdata = Buffer.concat([
      ...t.split(".").map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])),
      Buffer.from([0]),
    ]);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(12, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(120, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([name, fixed, rdata]);
  });
  return Buffer.concat([header, ...answers]);
}

class FakeTransport implements ProbeTransport {
  sent: Array<{ ip: string; port: number }> = [];
  fetched: string[] = [];
  location = `http://${TV}:8001/dmr`;
  async udp(ip: string, port: number, packet: Buffer): Promise<Buffer[]> {
    this.sent.push({ ip, port });
    if (port === 1900) {
      return [
        Buffer.from(
          `HTTP/1.1 200 OK\r\nSERVER: Tizen/4.0 UPnP/1.0\r\nST: upnp:rootdevice\r\nLOCATION: ${this.location}\r\n\r\n`
        ),
      ];
    }
    if (port === 5353) {
      const id = packet.readUInt16BE(0);
      if (id === 1) return [dnsPtrReply(1, "40.1.168.192.in-addr.arpa", ["Samsung-TV.local"])];
      if (id === 2) return [dnsPtrReply(2, "_services._dns-sd._udp.local", ["_googlecast._tcp.local"])];
      return [dnsPtrReply(id, "_googlecast._tcp.local", ["Living Room TV._googlecast._tcp.local"])];
    }
    return [];
  }
  async httpGet(url: string): Promise<string | null> {
    this.fetched.push(url);
    return "<root><device><friendlyName>[TV] Samsung Q60</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>QE55Q60T</modelName></device></root>";
  }
}

test("one device is asked on SSDP, NetBIOS and mDNS, and its own description file is read", async () => {
  const transport = new FakeTransport();
  const result = await new DeviceProber(transport).probe(TV, new AbortController().signal);

  assert.ok(
    transport.sent.every((s) => s.ip === TV),
    "nothing goes to any other host"
  );
  assert.deepEqual(
    [...new Set(transport.sent.map((s) => s.port))].sort((a, b) => a - b),
    [137, 1900, 5353]
  );
  assert.deepEqual(transport.fetched, [`http://${TV}:8001/dmr`]);
  assert.equal(result.upnp?.friendlyName, "[TV] Samsung Q60");
  assert.equal(result.ssdp[0].server, "Tizen/4.0 UPnP/1.0");
  assert.deepEqual(result.mdnsNames, ["Samsung-TV.local"]);
  assert.deepEqual(result.mdnsServices, ["_googlecast._tcp.local"]);
  assert.deepEqual(result.mdnsInstances, ["Living Room TV"]);
});

test("a description file advertised on another host (or over HTTPS) is never fetched", async () => {
  for (const location of [
    "http://192.168.1.99:8001/dmr",
    "http://evil.example/desc.xml",
    `https://${TV}/desc.xml`,
  ]) {
    const transport = new FakeTransport();
    transport.location = location;
    const result = await new DeviceProber(transport).probe(TV, new AbortController().signal);
    assert.deepEqual(transport.fetched, [], location);
    assert.equal(result.upnp, null);
  }
});

test("only private addresses can be asked", async () => {
  const transport = new FakeTransport();
  await assert.rejects(
    new DeviceProber(transport).probe("8.8.8.8", new AbortController().signal),
    /local network/
  );
  assert.deepEqual(transport.sent, []);
});
