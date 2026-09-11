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
