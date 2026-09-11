import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeviceProbeResult,
  buildDnsQuery,
  buildNetbiosStatusQuery,
  buildSsdpSearch,
  parseDnsResponse,
  parseNetbiosStatus,
  parseSsdpReply,
  parseUpnpDescription,
  reverseName,
  summarizeDetails,
} from "./identify";

const NOW = new Date("2026-09-11T10:00:00Z");

function empty(overrides: Partial<DeviceProbeResult> = {}): DeviceProbeResult {
  return {
    ssdp: [],
    upnp: null,
    mdnsNames: [],
    mdnsServices: [],
    mdnsInstances: [],
    netbiosName: null,
    ...overrides,
  };
}

// --------------------------------------------------------------------- DNS

test("a DNS query is built label by label, and reverse names are written backwards", () => {
  assert.equal(reverseName("192.168.1.40"), "40.1.168.192.in-addr.arpa");
  const query = buildDnsQuery(7, "_services._dns-sd._udp.local");
  assert.equal(query.readUInt16BE(0), 7);
  assert.equal(query.readUInt16BE(4), 1, "one question");
  assert.equal(query[12], "_services".length);
  assert.equal(query.readUInt16BE(query.length - 4), 12, "PTR");
});

/** A response with one PTR answer whose target reuses the question's name through a compression pointer. */
function ptrResponse(question: string, target: string): Buffer {
  const q = buildDnsQuery(9, question);
  const header = Buffer.from(q.subarray(0, 12));
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const questionSection = q.subarray(12);
  const targetLabels = Buffer.concat(
    target.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
  );
  // Answer name: pointer to the question name at offset 12.
  const rdata = Buffer.concat([
    targetLabels,
    Buffer.from([
      0xc0,
      12 + questionSection.length - 4 - (question.length + 2) + 1 + question.split(".")[0].length,
    ]),
  ]);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(12, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([header, questionSection, Buffer.from([0xc0, 12]), fixed, rdata]);
}

test("DNS responses are read, compression pointers included", () => {
  const packet = ptrResponse("_googlecast._tcp.local", "Living Room TV");
  const parsed = parseDnsResponse(packet)!;
  assert.equal(parsed.id, 9);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].name, "_googlecast._tcp.local");
  assert.equal(parsed.records[0].type, 12);
  assert.equal(parsed.records[0].data, "Living Room TV._tcp.local");
});

test("what isn't a DNS response is ignored", () => {
  assert.equal(parseDnsResponse(Buffer.from("hello")), null);
  assert.equal(parseDnsResponse(buildDnsQuery(1, "x.local")), null, "a query isn't a response");
});

// ------------------------------------------------------------------ NetBIOS

test("the NetBIOS status query asks for the wildcard name", () => {
  const query = buildNetbiosStatusQuery(0x1234);
  assert.equal(query.readUInt16BE(0), 0x1234);
  assert.equal(query.toString("ascii", 13, 45), `CK${"A".repeat(30)}`);
  assert.deepEqual([...query.subarray(query.length - 4)], [0, 0x21, 0, 1]);
});

test("a NetBIOS status reply gives the computer name, not the workgroup", () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const name = Buffer.concat([Buffer.from([32]), Buffer.from(`CK${"A".repeat(30)}`), Buffer.from([0])]);
  const fixed = Buffer.from([0, 0x21, 0, 1, 0, 0, 0, 0, 0, 0]);
  const entry = (n: string, suffix: number, group: boolean) => {
    const b = Buffer.alloc(18, 0x20);
    b.write(n.padEnd(15, " "), 0, "latin1");
    b[15] = suffix;
    b.writeUInt16BE(group ? 0x8400 : 0x0400, 16);
    return b;
  };
  const packet = Buffer.concat([
    header,
    name,
    fixed,
    Buffer.from([2]),
    entry("WORKGROUP", 0, true),
    entry("LIVINGROOM-PC", 0, false),
  ]);
  assert.equal(parseNetbiosStatus(packet), "LIVINGROOM-PC");
  assert.equal(parseNetbiosStatus(Buffer.alloc(10)), null);
});

// --------------------------------------------------------------------- SSDP

test("the SSDP search is addressed to the one device", () => {
  const text = buildSsdpSearch("192.168.1.40").toString();
  assert.match(text, /^M-SEARCH \* HTTP\/1\.1\r\nHOST: 192\.168\.1\.40:1900\r\n/);
  assert.match(text, /ST: ssdp:all/);
});

test("an SSDP reply's headers are read case-insensitively; anything else is ignored", () => {
  const reply = parseSsdpReply(
    "HTTP/1.1 200 OK\r\nserver: Tizen/4.0 UPnP/1.0 Samsung UPnP SDK/1.0\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nLOCATION: http://192.168.1.40:8001/dmr\r\nUSN: uuid:abc::urn:dial\r\n\r\n"
  );
  assert.deepEqual(reply, {
    server: "Tizen/4.0 UPnP/1.0 Samsung UPnP SDK/1.0",
    st: "urn:dial-multiscreen-org:service:dial:1",
    usn: "uuid:abc::urn:dial",
    location: "http://192.168.1.40:8001/dmr",
  });
  assert.equal(parseSsdpReply("NOTIFY * HTTP/1.1\r\n\r\n"), null);
});

// --------------------------------------------------------------------- UPnP

test("the description file's name, maker and model are read, entities decoded", () => {
  const xml = `<?xml version="1.0"?><root><device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>[TV] Samsung Q60 Series (55)</friendlyName>
    <manufacturer>Samsung Electronics</manufacturer>
    <modelName>QE55Q60T</modelName><modelNumber>AllShare1.0</modelNumber>
    <modelDescription>Samsung TV &amp; DMR</modelDescription></device></root>`;
  assert.deepEqual(parseUpnpDescription(xml), {
    friendlyName: "[TV] Samsung Q60 Series (55)",
    manufacturer: "Samsung Electronics",
    modelName: "QE55Q60T",
    modelNumber: "AllShare1.0",
    modelDescription: "Samsung TV & DMR",
    deviceType: "urn:schemas-upnp-org:device:MediaRenderer:1",
  });
  assert.equal(parseUpnpDescription("<html>not a device</html>"), null);
});

// ------------------------------------------------------------------ summary

test("a Samsung TV says it's a TV, with its model, software and what it offers", () => {
  const details = summarizeDetails(
    empty({
      ssdp: [
        {
          server: "Tizen/4.0 UPnP/1.0 Samsung UPnP SDK/1.0",
          st: "urn:dial-multiscreen-org:service:dial:1",
          usn: null,
          location: "http://192.168.1.40:8001/dmr",
        },
        { server: null, st: "urn:samsung.com:device:RemoteControlReceiver:1", usn: null, location: null },
      ],
      upnp: {
        friendlyName: "[TV] Samsung Q60 Series (55)",
        manufacturer: "Samsung Electronics",
        modelName: "QE55Q60T",
        modelNumber: null,
        modelDescription: null,
        deviceType: "urn:schemas-upnp-org:device:MediaRenderer:1",
      },
      mdnsServices: ["_googlecast._tcp.local", "_airplay._tcp.local"],
    }),
    NOW
  );

  assert.equal(details.answered, true);
  assert.equal(details.name, "[TV] Samsung Q60 Series (55)");
  assert.equal(details.manufacturer, "Samsung Electronics");
  assert.equal(details.model, "QE55Q60T");
  assert.equal(details.kind, "TV");
  assert.equal(details.software, "Tizen/4.0 UPnP/1.0 Samsung UPnP SDK/1.0");
  assert.deepEqual(details.sources, ["UPnP", "mDNS"]);
  assert.ok(details.services.includes("Google Cast (Chromecast)"));
  assert.ok(details.services.includes("DIAL (smart-TV apps)"));
  assert.ok(details.services.includes("Samsung TV remote control"));
});

test("silence is recorded as silence — typical of a phone", () => {
  const details = summarizeDetails(empty(), NOW);
  assert.equal(details.answered, false);
  assert.equal(details.name, null);
  assert.equal(details.kind, null);
  assert.deepEqual(details.services, []);
});

test("other kinds: a Windows PC by its NetBIOS name, a printer, an Apple device, a router", () => {
  const pc = summarizeDetails(empty({ netbiosName: "LIVINGROOM-PC" }), NOW);
  assert.equal(pc.name, "LIVINGROOM-PC");
  assert.equal(pc.kind, "Windows PC (or a file server)");

  const printer = summarizeDetails(
    empty({ mdnsServices: ["_ipp._tcp.local"], mdnsInstances: ["Office Printer"] }),
    NOW
  );
  assert.equal(printer.kind, "Printer");
  assert.equal(printer.name, "Office Printer");

  const phone = summarizeDetails(
    empty({ mdnsServices: ["_companion-link._tcp.local"], mdnsNames: ["Alexs-iPhone.local"] }),
    NOW
  );
  assert.equal(phone.kind, "Apple phone, tablet or computer");
  assert.equal(phone.name, "Alexs-iPhone");

  const router = summarizeDetails(
    empty({
      ssdp: [
        {
          server: "Linux UPnP/1.0",
          st: "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
          usn: null,
          location: null,
        },
      ],
    }),
    NOW
  );
  assert.equal(router.kind, "Router");
  assert.equal(router.software, "Linux UPnP/1.0");

  const unknownService = summarizeDetails(empty({ mdnsServices: ["_weirdthing._tcp.local"] }), NOW);
  assert.deepEqual(unknownService.services, ["_weirdthing._tcp"]);
});
