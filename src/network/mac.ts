/** "D8-78-7F-AA-BB-CC", "d8:78:7f:aa:bb:cc" or "d8787faabbcc" → "d8:78:7f:aa:bb:cc"; null if it isn't a MAC address. */
export function normalizeMac(value: string): string | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F:.\- ]+$/.test(value)) return null;
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return null;
  return hex.match(/../g)!.join(":");
}

/** False for addresses that don't name one device: all zeros (an unresolved entry), broadcast and multicast. */
export function isDeviceMac(mac: string): boolean {
  if (mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff") return false;
  return (parseInt(mac.slice(0, 2), 16) & 1) === 0;
}

/**
 * A "locally administered" address — what phones and laptops use as a
 * private, per-network (sometimes rotating) MAC. It says nothing about the
 * manufacturer, and the same phone may show up again under a new one.
 */
export function isRandomizedMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 2) === 2;
}

/** The manufacturer part (OUI), e.g. "D8787F". */
export function macPrefix(mac: string): string {
  return mac.replace(/:/g, "").slice(0, 6).toUpperCase();
}
