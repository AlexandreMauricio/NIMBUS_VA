/**
 * Settings → Presence: what NIMBUS currently thinks (at the PC, home, out)
 * and why, and the choice of which network device is your phone.
 */

interface PresenceView {
  state: "atPc" | "home" | "away" | "idle";
  reason: string;
  since: string;
  phoneDeviceId: string | null;
  devices: Array<{ id: string; name: string; randomizedMac: boolean }>;
}

interface PresenceBridge {
  getPresence(): Promise<PresenceView>;
  setPresencePhone(deviceId: string | null): Promise<unknown>;
  onPresenceChanged(callback: () => void): () => void;
}

const LABELS: Record<PresenceView["state"], string> = {
  atPc: "At the PC",
  home: "Home, away from the PC",
  away: "Out",
  idle: "Away from the PC",
};

export function initPresenceSettings(): void {
  const status = document.getElementById("presenceStatus") as HTMLElement;
  const select = document.getElementById("presencePhone") as HTMLSelectElement;
  const bridge = (window as unknown as { nimbus: PresenceBridge }).nimbus;

  const load = async (): Promise<void> => {
    try {
      const view = await bridge.getPresence();
      const since = new Date(view.since).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      status.textContent = `Now: ${LABELS[view.state]} (since ${since}) — ${view.reason}.`;

      // Rebuild the list, keeping a chosen phone even if it isn't seen right now.
      select.replaceChildren(new Option("No phone", ""));
      const devices = [...view.devices];
      if (view.phoneDeviceId && !devices.some((d) => d.id === view.phoneDeviceId)) {
        devices.unshift({
          id: view.phoneDeviceId,
          name: "Chosen phone (not seen now)",
          randomizedMac: false,
        });
      }
      for (const device of devices) {
        select.appendChild(
          new Option(device.randomizedMac ? `${device.name} (private address)` : device.name, device.id)
        );
      }
      select.value = view.phoneDeviceId ?? "";
    } catch (err) {
      status.textContent = `Couldn't read presence: ${String(err).replace(/^.*Error: /, "")}`;
    }
  };

  select.addEventListener("change", async () => {
    await bridge.setPresencePhone(select.value || null);
    await load();
  });
  document.querySelector('.side-link[data-tab="settings"]')?.addEventListener("click", () => void load());
  bridge.onPresenceChanged(() => void load());
  void load();
}
