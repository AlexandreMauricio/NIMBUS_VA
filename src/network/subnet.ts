import { LocalNetworkInfo } from "./types";

/** A sweep never covers more than a /24 (253 addresses besides this PC), whatever the real subnet size. */
export const MAX_SWEEP_PREFIX = 24;

/** "192.168.1.20" → 3232235796; null for anything that isn't a dotted IPv4 address. */
export function parseIPv4(ip: string): number | null {
  if (typeof ip !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

export function formatIPv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function maskFor(prefix: number): number {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - Math.min(prefix, 32))) >>> 0;
}

/** RFC 1918 private ranges only: 10/8, 172.16/12, 192.168/16. Never the Internet, loopback or link-local. */
export function isPrivateIPv4(ip: string): boolean {
  const value = parseIPv4(ip);
  if (value === null) return false;
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * "::1" → its eight 16-bit groups; null for anything that isn't an IPv6
 * address. Brackets (as in a URL's hostname) and a zone ("%eth0") are
 * dropped, and a dotted IPv4 tail ("::ffff:1.2.3.4") becomes two groups.
 */
export function parseIPv6(ip: string): number[] | null {
  if (typeof ip !== "string") return null;
  let text = ip.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  text = text.split("%")[0];
  if (!text.includes(":")) return null;
  const tail = text.match(/:(\d{1,3}(\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part ? part.split(":") : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Whether `ip` is an address on the public Internet — the only kind a
 * page NIMBUS fetches on the renderer's say-so may connect to. Refused:
 * this machine, the local network (RFC 1918 and carrier-grade NAT, which
 * VPNs like Tailscale use), link-local, benchmarking, multicast and
 * reserved ranges, their IPv6 counterparts, and IPv4 dressed up as IPv6.
 * Anything that isn't an IP address at all is refused too.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  if (!v6) return false;
  const [g0, g1, , , , g5, g6, g7] = v6;
  const high = v6.slice(0, 5).every((g) => g === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) are IPv4 underneath.
  if (high && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && g7 <= 1) return false; // :: and ::1
    return isPublicIPv4(((g6 << 16) | g7) >>> 0);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return isPublicIPv4(((g6 << 16) | g7) >>> 0); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 old site-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  return true;
}

function isPublicIPv4(value: number): boolean {
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Whether `ip` is a host on the subnet `localIp/prefix` — not its network or broadcast address. */
export function isHostInSubnet(ip: string, localIp: string, prefix: number): boolean {
  const value = parseIPv4(ip);
  const local = parseIPv4(localIp);
  if (value === null || local === null) return false;
  const mask = maskFor(prefix);
  if ((value & mask) >>> 0 !== (local & mask) >>> 0) return false;
  if (prefix >= 31) return true;
  const network = (local & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return value !== network && value !== broadcast;
}

/** "192.168.1.0/24" for 192.168.1.170/24. */
export function networkLabel(ip: string, prefix: number): string | null {
  const value = parseIPv4(ip);
  if (value === null) return null;
  return `${formatIPv4((value & maskFor(prefix)) >>> 0)}/${prefix}`;
}

/**
 * The addresses a sweep may ping: this PC's subnet — at most the /24
 * around it — without its network and broadcast addresses or this PC
 * itself. Empty unless this PC's address is private.
 */
export function sweepTargets(local: LocalNetworkInfo): string[] {
  const ip = parseIPv4(local.ip);
  if (ip === null || !isPrivateIPv4(local.ip)) return [];
  const prefix = Math.max(local.prefixLength, MAX_SWEEP_PREFIX);
  if (prefix >= 31) return [];
  const mask = maskFor(prefix);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const targets: string[] = [];
  for (let address = network + 1; address < broadcast; address++) {
    if (address !== ip) targets.push(formatIPv4(address));
  }
  return targets;
}
