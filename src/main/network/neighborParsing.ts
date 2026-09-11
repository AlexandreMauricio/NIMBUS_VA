import { DiscoveryResult, LocalNetworkInfo, NeighborEntry } from "../../network/types";

/** Neighbor-cache states that mean "confirmed recently". "Stale" is remembered only; others are dropped. */
const REACHABLE_STATES = new Set(["Reachable", "Delay", "Probe"]);

interface RawLocal {
  alias?: unknown;
  ip?: unknown;
  prefix?: unknown;
  mac?: unknown;
  gateway?: unknown;
}

interface RawNeighbor {
  IPAddress?: unknown;
  LinkLayerAddress?: unknown;
  State?: unknown;
}

/**
 * The neighbor-read script's one JSON line → a DiscoveryResult. Pure, so
 * it is tested without PowerShell. Unreachable, incomplete and permanent
 * (broadcast/multicast) entries are dropped here; the registry filters
 * the rest (MAC validity, subnet, private range).
 */
export function parseNeighborOutput(output: string): DiscoveryResult {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error("The neighbor list came back empty");
  const parsed = JSON.parse(line) as {
    local?: RawLocal | null;
    neighbors?: RawNeighbor | RawNeighbor[] | null;
  };

  const raw = parsed.local;
  const local: LocalNetworkInfo | null =
    raw && typeof raw.ip === "string" && typeof raw.prefix === "number"
      ? {
          interfaceAlias: typeof raw.alias === "string" ? raw.alias : null,
          ip: raw.ip,
          prefixLength: raw.prefix,
          mac: typeof raw.mac === "string" && raw.mac ? raw.mac : null,
          gateway:
            typeof raw.gateway === "string" && raw.gateway && raw.gateway !== "0.0.0.0" ? raw.gateway : null,
        }
      : null;

  const list = Array.isArray(parsed.neighbors)
    ? parsed.neighbors
    : parsed.neighbors
      ? [parsed.neighbors]
      : [];
  const neighbors: NeighborEntry[] = [];
  for (const n of list) {
    if (!n || typeof n.IPAddress !== "string" || typeof n.LinkLayerAddress !== "string") continue;
    const state = String(n.State ?? "");
    if (REACHABLE_STATES.has(state))
      neighbors.push({ ip: n.IPAddress, mac: n.LinkLayerAddress, state: "reachable" });
    else if (state === "Stale") neighbors.push({ ip: n.IPAddress, mac: n.LinkLayerAddress, state: "stale" });
  }
  return { local, neighbors };
}
