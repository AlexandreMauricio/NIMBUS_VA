import { runEncodedPowerShell } from "../desktop/windowsDesktop";
import { isPrivateIPv4, parseIPv4 } from "../../network/subnet";
import { DiscoveryResult, NetworkScanner } from "../../network/types";
import { parseNeighborOutput } from "./neighborParsing";

/**
 * Network discovery for Windows — two fixed PowerShell scripts, run the
 * same way the desktop actions run theirs: -EncodedCommand, no shell, and
 * the only value passed in is a validated list of private IPv4 addresses,
 * as an environment variable. There is no path from the UI to either
 * script's text.
 */

/**
 * Reads, without sending anything: the default route's interface, its
 * IPv4 address and prefix, its adapter's MAC and the gateway — then the
 * neighbor (ARP) cache for that interface only.
 */
const READ_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
$local = $null
$neighbors = @()
if ($route) {
  $addr = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |
    Where-Object { $_.IPAddress -notlike '169.254*' } | Select-Object -First 1
  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex
  if ($addr) {
    $local = @{
      alias = $addr.InterfaceAlias
      ip = $addr.IPAddress
      prefix = [int]$addr.PrefixLength
      mac = $adapter.MacAddress
      gateway = $route.NextHop
    }
    $neighbors = @(Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |
      Select-Object IPAddress, LinkLayerAddress, @{ n = 'State'; e = { [string]$_.State } })
  }
}
@{ local = $local; neighbors = $neighbors } | ConvertTo-Json -Compress -Depth 4
`.trim();

/**
 * One ICMP echo to each address in NIMBUS_TARGETS, 800 ms timeout, all at
 * once, waiting at most 3 s. Ports are never touched.
 */
const PING_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$tasks = @()
foreach ($t in ($env:NIMBUS_TARGETS -split ',')) {
  if (-not $t) { continue }
  try { $tasks += (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($t, 800) } catch {}
}
if ($tasks.Count -gt 0) {
  try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks, 3000) | Out-Null } catch {}
}
'{"ok":true}'
`.trim();

const READ_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
/** A second limit behind the service's own batch size. */
const MAX_TARGETS_PER_CALL = 64;

export class WindowsNetworkScanner implements NetworkScanner {
  constructor(
    private readonly run: (
      script: string,
      env: Record<string, string>,
      timeoutMs: number
    ) => Promise<string> = runEncodedPowerShell
  ) {}

  async readNeighbors(): Promise<DiscoveryResult> {
    return parseNeighborOutput(await this.run(READ_SCRIPT, {}, READ_TIMEOUT_MS));
  }

  async ping(addresses: string[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    // Checked again here, whatever the caller did: only well-formed
    // private IPv4 addresses ever reach the script.
    const targets = addresses
      .filter((a) => parseIPv4(a) !== null && isPrivateIPv4(a))
      .slice(0, MAX_TARGETS_PER_CALL);
    if (targets.length === 0) return;
    await this.run(PING_SCRIPT, { NIMBUS_TARGETS: targets.join(",") }, PING_TIMEOUT_MS);
  }
}
