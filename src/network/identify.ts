/**
 * "What are you?" — the standard questions phones and PCs use to find TVs,
 * speakers and printers, asked of ONE device when the user presses "Ask the
 * device". Pure: packet building and parsing, and turning the answers into
 * a summary. The sockets live in src/main/network/deviceProbe.ts.
 *
 *  - UPnP / SSDP: an M-SEARCH sent straight to the device; its reply names
 *    its software ("Tizen/4.0 UPnP/1.0") and links to a description file
 *    with its exact name, manufacturer and model.
 *  - mDNS / DNS-SD: the device's own network name ("Galaxy-S23.local") and
 *    the services it offers (casting, AirPlay, printing…).
 *  - NetBIOS: the computer name Windows PCs answer with.
 *
 * Nothing here logs in, tries a port list, or guesses an OS from packet
 * timing. What is reported is only what the device says about itself.
 */

export interface SsdpReply {
  server: string | null;
  st: string | null;
  usn: string | null;
  location: string | null;
}

export interface UpnpDescription {
  friendlyName: string | null;
  manufacturer: string | null;
  modelName: string | null;
  modelNumber: string | null;
  modelDescription: string | null;
  deviceType: string | null;
}

/** Everything one probe collected. */
export interface DeviceProbeResult {
  ssdp: SsdpReply[];
  upnp: UpnpDescription | null;
  /** From the reverse mDNS lookup, e.g. "Galaxy-S23.local". */
  mdnsNames: string[];
  /** Service types, e.g. "_googlecast._tcp.local". */
  mdnsServices: string[];
  /** Service instance names, e.g. "Living Room TV". */
  mdnsInstances: string[];
  netbiosName: string | null;
}

/** Implemented by the Windows client (src/main/network/deviceProbe.ts). */
export interface DeviceIdentifier {
  /** Asks the device at `ip` (private addresses only). Never throws for silence — an empty result is an answer. */
  probe(ip: string, signal: AbortSignal): Promise<DeviceProbeResult>;
}

/** What NIMBUS shows and keeps from an answer. */
export interface DeviceDetails {
  askedAt: string;
  /** Whether anything answered at all. Phones usually don't — silence is itself a hint. */
  answered: boolean;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  /** A plain guess from what it offers: "TV", "Printer", "Router", "Windows PC"… */
  kind: string | null;
  /** The software string it announces (often the OS), e.g. "Tizen/4.0 UPnP/1.0 Samsung". */
  software: string | null;
  services: string[];
  /** Which of the three questions it answered: "UPnP", "mDNS", "NetBIOS". */
  sources: string[];
}

const MAX_TEXT = 120;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

// --------------------------------------------------------------------- DNS

/** "192.168.1.40" → "40.1.168.192.in-addr.arpa". */
export function reverseName(ip: string): string {
  return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
}

/** A one-question DNS query (PTR by default), as sent to a device's mDNS port. */
export function buildDnsQuery(id: number, name: string, type = 12): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(1, 4);
  const labels = name
    .split(".")
    .filter(Boolean)
    .map((label) => {
      const bytes = Buffer.from(label, "utf8").subarray(0, 63);
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

export interface DnsRecord {
  name: string;
  type: number;
  /** For a PTR record, the name it points to; otherwise null. */
  data: string | null;
}

function readName(packet: Buffer, start: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let position = start;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (position >= packet.length) return null;
    const length = packet[position];
    if (length === 0) {
      position += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= packet.length || ++jumps > 20) return null;
      if (next < 0) next = position + 2;
      position = ((length & 0x3f) << 8) | packet[position + 1];
      continue;
    }
    if (position + 1 + length > packet.length || labels.length > 64) return null;
    labels.push(packet.toString("utf8", position + 1, position + 1 + length));
    position += 1 + length;
  }
  return { name: labels.join("."), next: next >= 0 ? next : position };
}

/** Reads a DNS/mDNS response's records. Null for anything that isn't one. */
export function parseDnsResponse(packet: Buffer): { id: number; records: DnsRecord[] } | null {
  if (packet.length < 12 || (packet.readUInt16BE(2) & 0x8000) === 0) return null;
  const questions = packet.readUInt16BE(4);
  const total = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) {
    const name = readName(packet, offset);
    if (!name) return null;
    offset = name.next + 4;
  }
  const records: DnsRecord[] = [];
  for (let i = 0; i < Math.min(total, 100); i++) {
    const name = readName(packet, offset);
    if (!name || name.next + 10 > packet.length) break;
    const type = packet.readUInt16BE(name.next);
    const length = packet.readUInt16BE(name.next + 8);
    const dataStart = name.next + 10;
    if (dataStart + length > packet.length) break;
    records.push({
      name: name.name,
      type,
      data: type === 12 ? (readName(packet, dataStart)?.name ?? null) : null,
    });
    offset = dataStart + length;
  }
  return { id: packet.readUInt16BE(0), records };
}

// ------------------------------------------------------------------ NetBIOS

/** A NetBIOS "node status" request for the wildcard name — what `nbtstat -A` sends. */
export function buildNetbiosStatusQuery(id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(1, 4);
  const name = Buffer.concat([
    Buffer.from([32]),
    Buffer.from(`CK${"A".repeat(30)}`, "ascii"),
    Buffer.from([0]),
  ]);
  return Buffer.concat([header, name, Buffer.from([0, 0x21, 0, 1])]);
}

/** The computer name in a node-status reply (the unique name with suffix 0x00), or null. */
export function parseNetbiosStatus(packet: Buffer): string | null {
  if (packet.length < 57) return null;
  let offset = 12;
  if (packet[offset] === 32) offset += 34;
  else if ((packet[offset] & 0xc0) === 0xc0) offset += 2;
  else return null;
  offset += 10;
  if (offset >= packet.length) return null;
  const count = packet[offset];
  offset += 1;
  let fallback: string | null = null;
  for (let i = 0; i < count && offset + 18 <= packet.length; i++, offset += 18) {
    const name = packet.toString("latin1", offset, offset + 15).trim();
    const suffix = packet[offset + 15];
    const group = (packet.readUInt16BE(offset + 16) & 0x8000) !== 0;
    if (!name) continue;
    if (suffix === 0 && !group) return clean(name);
    fallback ??= name;
  }
  return clean(fallback);
}

// --------------------------------------------------------------------- SSDP

/** An SSDP M-SEARCH addressed to one device (unicast), asking for everything it offers. */
export function buildSsdpSearch(ip: string): Buffer {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${ip}:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n`,
    "ascii"
  );
}

export function parseSsdpReply(text: string): SsdpReply | null {
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? "")) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line
          .slice(colon + 1)
          .trim()
          .slice(0, 300)
      );
  }
  return {
    server: headers.get("server") || null,
    st: headers.get("st") || null,
    usn: headers.get("usn") || null,
    location: headers.get("location") || null,
  };
}

// --------------------------------------------------------------------- UPnP

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The root device's fields from a UPnP description document. */
export function parseUpnpDescription(xml: string): UpnpDescription | null {
  const field = (tag: string): string | null => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
    return match ? clean(decodeEntities(match[1])) : null;
  };
  const description: UpnpDescription = {
    friendlyName: field("friendlyName"),
    manufacturer: field("manufacturer"),
    modelName: field("modelName"),
    modelNumber: field("modelNumber"),
    modelDescription: field("modelDescription"),
    deviceType: field("deviceType"),
  };
  return Object.values(description).some((v) => v !== null) ? description : null;
}

// ------------------------------------------------------------------ summary

const SERVICE_LABELS: Array<[RegExp, string]> = [
  [/_googlecast\._tcp/i, "Google Cast (Chromecast)"],
  [/_airplay\._tcp|_raop\._tcp/i, "AirPlay"],
  [/_spotify-connect\._tcp/i, "Spotify Connect"],
  [/_ipps?\._tcp|_printer\._tcp|_pdl-datastream\._tcp/i, "Printing"],
  [/_smb\._tcp/i, "File sharing"],
  [/_companion-link\._tcp|_apple-mobdev2\._tcp/i, "Apple device link"],
  [/_hap\._tcp/i, "HomeKit accessory"],
  [/_amzn-wplay\._tcp/i, "Amazon Fire TV casting"],
  [/_androidtvremote2?\._tcp/i, "Android TV remote"],
  [/dial-multiscreen-org:service:dial/i, "DIAL (smart-TV apps)"],
  [/device:MediaRenderer/i, "Plays media (DLNA)"],
  [/device:MediaServer/i, "Shares media (DLNA)"],
  [/device:InternetGatewayDevice/i, "Internet gateway"],
  [/samsung\.com:device:RemoteControlReceiver/i, "Samsung TV remote control"],
];

const MAX_SERVICES = 12;

function servicesFrom(raw: DeviceProbeResult): string[] {
  const labels = new Set<string>();
  const sources = [
    ...raw.mdnsServices,
    ...raw.ssdp.flatMap((r) => [r.st ?? "", r.usn ?? ""]),
    raw.upnp?.deviceType ?? "",
  ].filter(Boolean);
  for (const text of sources) {
    const known = SERVICE_LABELS.find(([pattern]) => pattern.test(text));
    if (known) labels.add(known[1]);
  }
  // mDNS service types nothing above explains are shown as they are.
  for (const type of raw.mdnsServices) {
    if (!SERVICE_LABELS.some(([pattern]) => pattern.test(type))) labels.add(type.replace(/\.local\.?$/, ""));
  }
  return [...labels].slice(0, MAX_SERVICES);
}

function kindFrom(raw: DeviceProbeResult, services: string[], text: string): string | null {
  const all = [text, ...raw.ssdp.map((r) => `${r.st ?? ""} ${r.usn ?? ""}`), raw.upnp?.deviceType ?? ""].join(
    " "
  );
  if (/InternetGatewayDevice/i.test(all)) return "Router";
  if (/playstation|xbox|nintendo/i.test(all)) return "Game console";
  if (/\bTV\b|RemoteControlReceiver/i.test(all)) return "TV";
  if (services.includes("Printing")) return "Printer";
  if (
    services.some((s) =>
      [
        "Google Cast (Chromecast)",
        "DIAL (smart-TV apps)",
        "Plays media (DLNA)",
        "Amazon Fire TV casting",
        "Android TV remote",
      ].includes(s)
    )
  ) {
    return "TV or streaming device";
  }
  if (services.includes("Apple device link")) return "Apple phone, tablet or computer";
  if (services.includes("AirPlay") || services.includes("Spotify Connect")) return "Speaker or media player";
  if (raw.netbiosName) return "Windows PC (or a file server)";
  return null;
}

export function summarizeDetails(raw: DeviceProbeResult, now: Date): DeviceDetails {
  const upnp = raw.upnp;
  const host = raw.mdnsNames.map((n) => clean(n.replace(/\.local\.?$/i, ""))).find(Boolean) ?? null;
  const name = clean(upnp?.friendlyName) ?? clean(raw.mdnsInstances[0]) ?? host ?? raw.netbiosName;
  const modelParts = [upnp?.modelName, upnp?.modelNumber].map(clean).filter((p): p is string => !!p);
  const model =
    (modelParts.length === 2 && modelParts[0].includes(modelParts[1])
      ? modelParts[0]
      : modelParts.join(" ")) || clean(upnp?.modelDescription);
  const services = servicesFrom(raw);
  const software = raw.ssdp.map((r) => clean(r.server)).find(Boolean) ?? null;
  const text = [upnp?.friendlyName, upnp?.modelName, upnp?.modelDescription, ...raw.mdnsInstances, software]
    .filter(Boolean)
    .join(" ");
  const sources = [
    raw.ssdp.length > 0 || upnp ? "UPnP" : null,
    raw.mdnsNames.length + raw.mdnsServices.length + raw.mdnsInstances.length > 0 ? "mDNS" : null,
    raw.netbiosName ? "NetBIOS" : null,
  ].filter((s): s is string => s !== null);
  return {
    askedAt: now.toISOString(),
    answered: sources.length > 0,
    name,
    manufacturer: clean(upnp?.manufacturer),
    model: model || null,
    kind: kindFrom(raw, services, text),
    software,
    services,
    sources,
  };
}
