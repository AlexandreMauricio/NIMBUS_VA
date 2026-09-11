# Network

The **Network** tab shows the devices NIMBUS can see on your local
network — this PC, the router, and everything else — and lets you
nickname them and mark the ones you recognize.

**It observes; it does nothing else.** NIMBUS never connects to a device,
opens or probes a port, logs in, tries a password, captures traffic, or
runs anything remotely. The only traffic it ever sends for this feature is
one ping per local address, and only when you press **Scan network**.

Code: [src/network/](../src/network/) (Core, no Electron) and
[src/main/network/](../src/main/network/) (the Windows part).

## How discovery works

1. **Watching (every 2 minutes, while "Watch my network" is on — the
   default).** NIMBUS reads what Windows already knows, sending nothing:
   the default route's network adapter, its IPv4 address, prefix, MAC and
   gateway, and that adapter's **neighbor (ARP) cache** (`Get-NetNeighbor`
   — the list of nearby devices Windows has recently talked to).
   Entries Windows marks *Reachable*, *Delay* or *Probe* are confirmed;
   *Stale* ones are only remembered; *Unreachable*, *Incomplete* and
   *Permanent* (broadcast/multicast) entries are dropped, as are
   all-zero, broadcast and multicast MACs.
2. **Scan network (only when you press it).** Devices your PC hasn't
   talked to aren't in that cache, so the scan pings each address on your
   local subnet once, then reads the cache again.
   - Private addresses only (10/8, 172.16/12, 192.168/16), on this PC's
     own subnet — **at most the /24 around it** (253 addresses), even on
     a larger network.
   - In batches of 32 (800 ms timeout each), **cancellable** between
     batches, and **at most one scan a minute**.
   - ICMP echo only — never a port, never an Internet address.
3. **Names.** For online devices, a reverse name lookup through Windows'
   normal resolver (on a home network, usually your router answering for
   the devices it gave addresses to) — private addresses only, 1.5 s
   timeout, 8 at a time, each address at most once an hour. This PC is
   named after its own computer name.
4. **Manufacturer.** Read from the official IEEE registry, only if you put
   its file there: download `oui.csv` (the MA-L list) from
   [IEEE](https://standards-oui.ieee.org/) and place it in NIMBUS's data
   folder (`%APPDATA%\nimbus\oui.csv`); it is read at startup. NIMBUS
   never downloads it and doesn't guess. Phones and laptops often use a
   **private (randomized) MAC**, which has no manufacturer; the tab says so.

Both PowerShell scripts are fixed text, run the same way the desktop
actions run theirs (no shell, `-EncodedCommand`); the only value passed in
is the list of addresses to ping, which the main process validates as
private IPv4 twice (in the service and again in the scanner). Nothing in
the renderer can choose an address.

## Devices and identity

A device is identified by its **MAC address**, never its IP — the router
hands addresses out again and again.

- The same MAC at a new IP is **the same device**; its **IP history**
  (current address first, up to 10) records the change.
- A new MAC at a familiar IP is **a different device**.
- Duplicates in one read (the same MAC and IP listed twice) are one.
- **Online** means confirmed in the last **10 minutes**. A *Stale* cache
  entry doesn't keep a device online, but a device seen for the first time
  as *Stale* starts online (Windows saw it recently). This PC is online
  whenever it has a network.
- **First seen** / **Last seen** — first sighting; last confirmation.

The list shows this PC first ("This device"), then the router, then online
devices, recognized ones first, by address.

### Your labels

- **Nickname** — up to 60 characters; clear it to go back to the name.
- **Recognized** — "I know this device". It is **NIMBUS's own note, not a
  security check**: any device can present another's MAC address, and
  nothing here verifies identity.
- **Forget device** (two clicks) removes it and its labels; if it's still
  on the network it comes back as new.

Stored in `network-devices.json` (MAC, nickname, recognized, hostname,
manufacturer, first/last seen, recent IPs), at most 500 devices — past
that, unlabelled devices that have been gone the longest are dropped.
The on/off switch is a per-PC setting (`windowsClient.network.enabled`,
default on), since a local network only means something on this machine.

## New devices, Context and events

- The first read ever records what's already there as the **baseline** and
  announces nothing. After that, a MAC never seen before publishes
  **`networkDeviceAppeared`** on the existing Context event bus (device
  id, IP, MAC, hostname, manufacturer). Nothing reacts to it yet — no
  popup, no routine trigger, no Attention signal.
- **`NetworkProvider`** (`network` in the Context snapshot) reports the
  network, how many devices are online, known and recognized, how many
  unknown ones are online, and the online list. It never starts a scan;
  it only waits for a first read if none has happened.

## What is deliberately not here

Nothing on the network is reachable through the **Action system** — no
action, no generic "run", nothing a routine could call. The IPC channels
(`nimbus:get-network-state`, `nimbus:refresh-network`,
`nimbus:scan-network`, `nimbus:cancel-network-scan`,
`nimbus:update-network-device`, `nimbus:forget-network-device`,
`nimbus:update-network-settings`) each do one fixed thing, and none takes
an address. There is no port scanning, service or OS fingerprinting,
vulnerability detection, packet capture, credential or login attempt,
remote command, Wake-on-LAN, or anything that touches the Internet.

## Limitations

- **Devices that don't answer pings** (many phones in standby, some
  firewalled PCs) only appear once they talk on the network; online status
  is most accurate right after a scan.
- **Private MACs**: a phone using a randomized address can appear as a new
  device when it rotates it, and never shows a manufacturer.
- **One network**: the adapter of the default route. Other adapters
  (VPNs, a second NIC, virtual switches) and IPv6-only devices aren't
  listed; networks bigger than a /24 are only scanned around this PC.
- **Names depend on your router**: without reverse DNS on the LAN,
  devices show as "Unknown device" until you nickname them.
- **Manufacturer** needs the IEEE file (above).
- Name lookups and the scan run from this PC only; nothing is shared.

## Tests

`network.test.ts` (MAC normalisation, device/multicast/randomized
addresses, the IEEE list, address maths, private ranges, sweep targets,
nicknames), `networkService.test.ts` (baseline, new-device events, IP
changes, duplicates, a new MAC at an old IP, online/stale, labels and
persistence, forgetting, read failures, no network, switched off, scan
batching/limits/cancel, name lookups, the Context provider), and
`src/main/network/neighborParsing.test.ts` (the script's output, and the
scanner passing only private addresses to the ping script).

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
