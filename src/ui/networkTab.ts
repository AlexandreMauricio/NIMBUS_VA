/**
 * The Network tab — devices NIMBUS can see on the local network.
 *
 * Observation only. The controls here read Windows' neighbor list, run the
 * bounded local scan, or change NIMBUS's own labels (nickname, recognized).
 * Nothing connects to a device, and no address is ever sent from here —
 * the main process decides what may be pinged.
 *
 * Shapes mirror src/network/types.ts; the renderer only talks to the
 * preload bridge, never to Core.
 */

interface NetworkDeviceUI {
  id: string;
  mac: string;
  nickname: string | null;
  recognized: boolean;
  hostname: string | null;
  vendor: string | null;
  firstSeen: string;
  lastSeen: string;
  lastIp: string;
  ipHistory: Array<{ ip: string; firstSeen: string; lastSeen: string }>;
  displayName: string;
  online: boolean;
  isSelf: boolean;
  isGateway: boolean;
  randomizedMac: boolean;
  details?: {
    askedAt: string;
    answered: boolean;
    name: string | null;
    manufacturer: string | null;
    model: string | null;
    kind: string | null;
    software: string | null;
    services: string[];
    sources: string[];
  } | null;
}

interface NetworkStateUI {
  enabled: boolean;
  scanning: boolean;
  identifying: string | null;
  sweepProgress: { done: number; total: number } | null;
  lastScanAt: string | null;
  lastError: string | null;
  notice: string | null;
  network: string | null;
  local: { ip: string; interfaceAlias: string | null; gateway: string | null } | null;
  devices: NetworkDeviceUI[];
}

interface NetworkBridge {
  getNetworkState(): Promise<NetworkStateUI>;
  refreshNetwork(): Promise<NetworkStateUI>;
  scanNetwork(): Promise<NetworkStateUI>;
  cancelNetworkScan(): Promise<boolean>;
  updateNetworkDevice(
    id: string,
    changes: { nickname?: string | null; recognized?: boolean }
  ): Promise<NetworkStateUI>;
  forgetNetworkDevice(id: string): Promise<NetworkStateUI>;
  identifyNetworkDevice(id: string): Promise<NetworkStateUI>;
  updateNetworkSettings(partial: { enabled?: boolean }): Promise<{ enabled: boolean }>;
  onNetworkChanged(callback: () => void): () => void;
}

function net(): NetworkBridge {
  return (window as unknown as { nimbus: NetworkBridge }).nimbus;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function row(label: string, value: string): HTMLElement {
  const line = node("div", "stock-kv");
  line.appendChild(node("span", undefined, label));
  line.appendChild(node("span", undefined, value));
  return line;
}

function errorMessage(err: unknown): string {
  return String(err).replace(/^.*Error: /, "");
}

export function initNetworkTab(): void {
  const listView = document.getElementById("networkListView") as HTMLElement;
  const detailView = document.getElementById("networkDetailView") as HTMLElement;
  const statusEl = document.getElementById("networkStatus") as HTMLElement;
  const errorEl = document.getElementById("networkError") as HTMLElement;
  const listEl = document.getElementById("networkDeviceList") as HTMLElement;
  const emptyEl = document.getElementById("networkEmpty") as HTMLElement;
  const detailEl = document.getElementById("networkDeviceDetail") as HTMLElement;
  const scanBtn = document.getElementById("networkScanBtn") as HTMLButtonElement;
  const refreshBtn = document.getElementById("networkRefreshBtn") as HTMLButtonElement;
  const enabledInput = document.getElementById("networkEnabled") as HTMLInputElement;

  let state: NetworkStateUI | null = null;
  let selectedId: string | null = null;

  function show(view: "list" | "detail"): void {
    listView.hidden = view !== "list";
    detailView.hidden = view !== "detail";
  }

  function showError(message: string | null): void {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  }

  async function load(): Promise<void> {
    try {
      state = await net().getNetworkState();
      render();
    } catch (err) {
      showError(`Couldn't load the network: ${errorMessage(err)}`);
    }
  }

  function render(): void {
    if (!state) return;
    enabledInput.checked = state.enabled;
    scanBtn.disabled = !state.enabled;
    refreshBtn.disabled = !state.enabled || state.scanning;
    scanBtn.textContent = state.scanning ? "Cancel scan" : "Scan network";

    const online = state.devices.filter((d) => d.online).length;
    const parts: string[] = [];
    if (!state.enabled) {
      parts.push("Network watching is off — nothing is read or sent.");
    } else if (state.scanning && state.sweepProgress) {
      parts.push(`Scanning… ${state.sweepProgress.done} of ${state.sweepProgress.total} addresses.`);
    } else if (state.network) {
      parts.push(
        `${state.network}${state.local?.interfaceAlias ? ` on ${state.local.interfaceAlias}` : ""} · ${online} online of ${state.devices.length} known · looked ${when(state.lastScanAt)}.`
      );
    }
    if (state.notice) parts.push(state.notice);
    statusEl.textContent = parts.join(" ");
    statusEl.hidden = parts.length === 0;
    showError(state.enabled ? state.lastError : null);

    renderList();
    if (!detailView.hidden && selectedId) renderDetail(selectedId);
  }

  function tagFor(device: NetworkDeviceUI): string {
    if (device.isSelf) return "This device";
    if (device.isGateway) return "Router";
    return device.recognized ? "Recognized" : "Unknown";
  }

  function renderList(): void {
    const devices = state?.devices ?? [];
    listEl.innerHTML = "";
    emptyEl.hidden = devices.length > 0 || !state?.enabled;
    for (const device of devices) {
      const item = node("button", "network-row");
      item.type = "button";
      const dot = node("span", `network-dot${device.online ? " online" : ""}`);
      dot.title = device.online ? "Online" : "Offline";
      item.appendChild(dot);

      const who = node("span");
      who.appendChild(node("span", "network-name", device.displayName));
      const details = [
        device.nickname && device.hostname ? device.hostname : null,
        device.vendor,
        device.randomizedMac ? "private address" : null,
        device.online ? null : `last seen ${ago(device.lastSeen)}`,
      ].filter(Boolean);
      if (details.length) who.appendChild(node("span", "network-sub", details.join(" · ")));
      item.appendChild(who);

      item.appendChild(node("span", "network-ip", device.lastIp));
      const tag = tagFor(device);
      item.appendChild(
        node("span", `tag ${tag === "Unknown" ? "tag-neutral" : "tag-neutral network-known"}`, tag)
      );
      item.addEventListener("click", () => openDetail(device.id));
      listEl.appendChild(item);
    }
  }

  function openDetail(id: string): void {
    selectedId = id;
    show("detail");
    renderDetail(id);
  }

  function renderDetail(id: string): void {
    const device = state?.devices.find((d) => d.id === id);
    if (!device) {
      selectedId = null;
      show("list");
      return;
    }
    detailEl.innerHTML = "";
    detailEl.appendChild(node("h3", undefined, device.displayName));

    const grid = node("div", "stock-detail-grid");

    const facts = node("div", "stock-detail-card");
    facts.appendChild(node("div", "stock-stat-label", "Device"));
    facts.appendChild(
      row("Status", device.online ? "Online" : `Offline — last seen ${ago(device.lastSeen)}`)
    );
    facts.appendChild(row("IP address", device.lastIp));
    facts.appendChild(row("Hostname", device.hostname ?? "—"));
    facts.appendChild(
      row("MAC address", `${device.mac.toUpperCase()}${device.randomizedMac ? " (private address)" : ""}`)
    );
    facts.appendChild(
      row(
        "Manufacturer",
        device.vendor ?? (device.randomizedMac ? "Not shown for private addresses" : "Unknown")
      )
    );
    facts.appendChild(row("First seen", when(device.firstSeen)));
    facts.appendChild(row("Last seen", when(device.lastSeen)));
    if (device.isSelf) facts.appendChild(row("Role", "This PC"));
    if (device.isGateway) facts.appendChild(row("Role", "Router (your default gateway)"));
    grid.appendChild(facts);

    const labels = node("div", "stock-detail-card");
    labels.appendChild(node("div", "stock-stat-label", "Your labels"));
    const nicknameField = node("label", "network-field");
    nicknameField.appendChild(node("span", undefined, "Nickname"));
    const nicknameInput = node("input", "input");
    nicknameInput.type = "text";
    nicknameInput.maxLength = 60;
    nicknameInput.placeholder = device.hostname ?? "e.g. Living Room PS5";
    nicknameInput.value = device.nickname ?? "";
    nicknameField.appendChild(nicknameInput);
    labels.appendChild(nicknameField);

    const recognizedField = node("label", "network-field network-check");
    const recognizedInput = node("input");
    recognizedInput.type = "checkbox";
    recognizedInput.checked = device.recognized;
    recognizedField.appendChild(recognizedInput);
    recognizedField.appendChild(node("span", undefined, "I recognize this device"));
    labels.appendChild(recognizedField);

    const save = node("button", "btn btn-secondary", "Save");
    save.type = "button";
    const labelError = node("p", "form-error");
    labelError.hidden = true;
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        state = await net().updateNetworkDevice(device.id, {
          nickname: nicknameInput.value,
          recognized: recognizedInput.checked,
        });
        labelError.hidden = true;
        render();
      } catch (err) {
        labelError.textContent = errorMessage(err);
        labelError.hidden = false;
      } finally {
        save.disabled = false;
      }
    });
    labels.appendChild(labelError);
    labels.appendChild(save);
    labels.appendChild(
      node(
        "p",
        "setting-note",
        "“Recognized” is NIMBUS's own note that you know this device — not a security check. Any device can copy another's MAC address."
      )
    );
    grid.appendChild(labels);
    detailEl.appendChild(grid);
    if (!device.isSelf) detailEl.appendChild(askSection(device));

    if (device.ipHistory.length > 0) {
      const history = node("div", "stock-lots");
      history.appendChild(node("div", "stock-stat-label", "Addresses it has used"));
      const list = node("div", "stock-news-list");
      for (const entry of device.ipHistory) {
        const line = node("div", "stock-news-item");
        line.appendChild(node("div", "stock-news-title", entry.ip));
        line.appendChild(
          node("div", "stock-news-meta", `${when(entry.firstSeen)} – ${when(entry.lastSeen)}`)
        );
        list.appendChild(line);
      }
      history.appendChild(list);
      detailEl.appendChild(history);
    }

    const actions = node("div", "stock-detail-actions");
    const forget = node("button", "btn btn-ghost", "Forget device");
    forget.type = "button";
    let armed: ReturnType<typeof setTimeout> | null = null;
    forget.addEventListener("click", async () => {
      if (!armed) {
        forget.textContent = "Click again to forget";
        armed = setTimeout(() => {
          armed = null;
          forget.textContent = "Forget device";
        }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      state = await net().forgetNetworkDevice(device.id);
      selectedId = null;
      show("list");
      render();
    });
    actions.appendChild(forget);
    detailEl.appendChild(actions);
    detailEl.appendChild(
      node(
        "p",
        "setting-note",
        "Forgetting removes the nickname and label. If the device is still on the network, it comes back as new."
      )
    );
  }

  /** "What the device says" — and the button that asks it. */
  function askSection(device: NetworkDeviceUI): HTMLElement {
    const section = node("div", "stock-lots");
    section.appendChild(node("div", "stock-stat-label", "What the device says"));
    const details = device.details ?? null;
    if (!details) {
      section.appendChild(node("p", "feed-empty", "Not asked yet."));
    } else if (!details.answered) {
      section.appendChild(
        node(
          "p",
          "setting-note",
          `No answer when asked ${when(details.askedAt)}. Phones, tablets and laptops usually don't answer these questions, so silence often means one of those.`
        )
      );
    } else {
      const card = node("div", "stock-detail-card");
      if (details.name) card.appendChild(row("Name", details.name));
      if (details.kind) card.appendChild(row("Looks like", details.kind));
      if (details.manufacturer) card.appendChild(row("Manufacturer", details.manufacturer));
      if (details.model) card.appendChild(row("Model", details.model));
      if (details.software) card.appendChild(row("Software", details.software));
      if (details.services.length) card.appendChild(row("Offers", details.services.join(", ")));
      card.appendChild(row("Answered", `${details.sources.join(", ")} · ${when(details.askedAt)}`));
      section.appendChild(card);
      if (details.name && !device.nickname) {
        const use = node("button", "btn btn-ghost", `Use “${details.name}” as nickname`);
        use.type = "button";
        use.addEventListener("click", async () => {
          state = await net().updateNetworkDevice(device.id, { nickname: details.name!.slice(0, 60) });
          render();
        });
        section.appendChild(use);
      }
    }

    const asking = state?.identifying === device.id;
    const ask = node(
      "button",
      "btn btn-secondary",
      asking ? "Asking…" : details ? "Ask again" : "Ask the device"
    );
    ask.type = "button";
    ask.disabled = !!state?.identifying || !state?.enabled;
    const askError = node("p", "form-error");
    askError.hidden = true;
    ask.addEventListener("click", async () => {
      ask.disabled = true;
      ask.textContent = "Asking…";
      try {
        state = await net().identifyNetworkDevice(device.id);
        render();
      } catch (err) {
        askError.textContent = errorMessage(err);
        askError.hidden = false;
        ask.disabled = false;
        ask.textContent = "Ask the device";
      }
    });
    section.appendChild(askError);
    section.appendChild(ask);
    section.appendChild(
      node(
        "p",
        "setting-note",
        "Asks this one device what it is, with the standard questions phones and PCs use to find TVs and printers (UPnP, mDNS, NetBIOS), and reads the description file it publishes. It never logs in or tries other ports."
      )
    );
    return section;
  }

  scanBtn.addEventListener("click", async () => {
    if (!state) return;
    try {
      if (state.scanning) {
        await net().cancelNetworkScan();
      } else {
        state = await net().scanNetwork();
        render();
      }
    } catch (err) {
      showError(errorMessage(err));
    }
  });

  refreshBtn.addEventListener("click", async () => {
    try {
      state = await net().refreshNetwork();
      render();
    } catch (err) {
      showError(errorMessage(err));
    }
  });

  enabledInput.addEventListener("change", async () => {
    try {
      await net().updateNetworkSettings({ enabled: enabledInput.checked });
    } catch (err) {
      showError(errorMessage(err));
    }
    await load();
  });

  document.getElementById("backFromNetworkDeviceBtn")?.addEventListener("click", () => {
    selectedId = null;
    show("list");
  });
  document.querySelector('.side-link[data-tab="network"]')?.addEventListener("click", () => void load());
  net().onNetworkChanged(() => void load());

  void load();
}
