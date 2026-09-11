import * as dgram from "dgram";
import * as http from "http";
import {
  DeviceIdentifier,
  DeviceProbeResult,
  SsdpReply,
  buildDnsQuery,
  buildNetbiosStatusQuery,
  buildSsdpSearch,
  parseDnsResponse,
  parseNetbiosStatus,
  parseSsdpReply,
  parseUpnpDescription,
  reverseName,
} from "../../network/identify";
import { isPrivateIPv4 } from "../../network/subnet";

/**
 * Asks ONE device what it is — only when the user presses "Ask the
 * device". Three standard questions, each sent straight to that device's
 * address (never a broadcast), so its replies come back as ordinary
 * answers, plus one HTTP GET of the description file the device itself
 * advertises — fetched only from that same address, with no redirects, a
 * size cap and a timeout.
 *
 *  - UDP 1900: SSDP M-SEARCH (UPnP)
 *  - UDP 5353: mDNS — its name, and the services it offers
 *  - UDP 137:  NetBIOS node status (Windows computer names)
 *
 * No port list, no login, no credentials, nothing sent to any other host.
 */

export interface ProbeTransport {
  /** Sends one datagram to ip:port and collects replies from that ip only, for `waitMs`. */
  udp(ip: string, port: number, packet: Buffer, waitMs: number, signal: AbortSignal): Promise<Buffer[]>;
  /** A plain GET, or null on any error, non-200, redirect, timeout or a body over `maxBytes`. */
  httpGet(url: string, timeoutMs: number, maxBytes: number, signal: AbortSignal): Promise<string | null>;
}

const MAX_REPLIES = 50;
const DESCRIPTION_MAX_BYTES = 64 * 1024;
const MAX_INSTANCE_QUERIES = 5;

export const nodeTransport: ProbeTransport = {
  udp(ip, port, packet, waitMs, signal) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      const replies: Buffer[] = [];
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(replies);
      };
      const timer = setTimeout(finish, waitMs);
      if (signal.aborted) return finish();
      signal.addEventListener("abort", finish);
      socket.on("message", (message, from) => {
        if (from.address === ip && replies.length < MAX_REPLIES) replies.push(message);
      });
      socket.on("error", finish);
      socket.bind(0, () => {
        socket.send(packet, port, ip, (err) => {
          if (err) finish();
        });
      });
    });
  },

  httpGet(url, timeoutMs, maxBytes, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | null): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let body = "";
      const request = http.get(
        url,
        { timeout: timeoutMs, signal, headers: { "User-Agent": "NIMBUS" } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            return done(null);
          }
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > maxBytes) {
              request.destroy();
              done(null);
            }
          });
          response.on("end", () => done(body));
          response.on("error", () => done(null));
        }
      );
      request.on("timeout", () => {
        request.destroy();
        done(null);
      });
      request.on("error", () => done(null));
    });
  },
};

export class DeviceProber implements DeviceIdentifier {
  constructor(private readonly transport: ProbeTransport = nodeTransport) {}

  async probe(ip: string, signal: AbortSignal): Promise<DeviceProbeResult> {
    if (!isPrivateIPv4(ip)) throw new Error("Only devices on the local network can be asked.");

    const [ssdpRaw, netbiosRaw, reverseRaw, servicesRaw] = await Promise.all([
      this.transport.udp(ip, 1900, buildSsdpSearch(ip), 2000, signal),
      this.transport.udp(ip, 137, buildNetbiosStatusQuery(0x4e42), 1500, signal),
      this.transport.udp(ip, 5353, buildDnsQuery(0x0001, reverseName(ip)), 1500, signal),
      this.transport.udp(ip, 5353, buildDnsQuery(0x0002, "_services._dns-sd._udp.local"), 1500, signal),
    ]);

    const ssdp = ssdpRaw
      .map((b) => parseSsdpReply(b.toString("utf8")))
      .filter((r): r is SsdpReply => r !== null);
    const ptr = (buffers: Buffer[]) =>
      buffers.flatMap((b) => parseDnsResponse(b)?.records ?? []).filter((r) => r.type === 12 && r.data);
    const mdnsNames = [...new Set(ptr(reverseRaw).map((r) => r.data!))];
    const mdnsServices = [
      ...new Set(
        ptr(servicesRaw)
          .filter((r) => r.name.toLowerCase() === "_services._dns-sd._udp.local")
          .map((r) => r.data!)
      ),
    ];

    // Instance names ("Living Room TV") for the first few services it offers.
    const instanceReplies = await Promise.all(
      mdnsServices
        .slice(0, MAX_INSTANCE_QUERIES)
        .map((type, i) => this.transport.udp(ip, 5353, buildDnsQuery(0x0010 + i, type), 1200, signal))
    );
    const mdnsInstances = [
      ...new Set(
        instanceReplies.flatMap((replies, i) => {
          const type = mdnsServices[i].toLowerCase();
          return ptr(replies)
            .filter((r) => r.name.toLowerCase() === type && r.data!.toLowerCase().endsWith(`.${type}`))
            .map((r) => r.data!.slice(0, r.data!.length - type.length - 1));
        })
      ),
    ];

    // The description file: only from the device's own address, over plain HTTP.
    let upnp = null;
    const location = ssdp.map((r) => r.location).find((l) => l && sameHost(l, ip));
    if (location && !signal.aborted) {
      const xml = await this.transport.httpGet(location, 3000, DESCRIPTION_MAX_BYTES, signal);
      upnp = xml ? parseUpnpDescription(xml) : null;
    }

    const netbiosName = netbiosRaw.map(parseNetbiosStatus).find((n): n is string => !!n) ?? null;
    return { ssdp, upnp, mdnsNames, mdnsServices, mdnsInstances, netbiosName };
  }
}

function sameHost(location: string, ip: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === "http:" && url.hostname === ip;
  } catch {
    return false;
  }
}
