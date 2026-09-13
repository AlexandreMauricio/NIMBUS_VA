/**
 * Settings → Updates: the running version, whether a newer one is on
 * GitHub, and "Restart to update" once it has downloaded.
 */

interface UpdateView {
  status: "unsupported" | "idle" | "checking" | "upToDate" | "downloading" | "ready" | "error";
  currentVersion: string;
  version: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: string | null;
}

interface UpdateBridge {
  getUpdateState(): Promise<UpdateView>;
  checkForUpdates(): Promise<UpdateView>;
  installUpdate(): Promise<void>;
  onUpdateStateChanged(callback: () => void): () => void;
}

export function initUpdateSettings(): void {
  const status = document.getElementById("updateStatus") as HTMLElement;
  const check = document.getElementById("updateCheckBtn") as HTMLButtonElement;
  const install = document.getElementById("updateInstallBtn") as HTMLButtonElement;
  const bridge = (window as unknown as { nimbus: UpdateBridge }).nimbus;

  const render = (view: UpdateView): void => {
    const checked = view.checkedAt
      ? ` Last checked ${new Date(view.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`
      : "";
    const text: Record<UpdateView["status"], string> = {
      unsupported: `Version ${view.currentVersion}, running from source — update with git or a new ZIP, then npm install. Installed builds update themselves.`,
      idle: `Version ${view.currentVersion}.`,
      checking: `Version ${view.currentVersion} — checking GitHub…`,
      upToDate: `Version ${view.currentVersion} — the latest.${checked}`,
      downloading: `Version ${view.version} is downloading${view.percent !== null ? ` (${view.percent}%)` : ""}…`,
      ready: `Version ${view.version} is ready. Restart NIMBUS to update — or it installs the next time NIMBUS quits.`,
      error: `Version ${view.currentVersion}. ${view.error ?? "The update check failed."}${checked}`,
    };
    status.textContent = text[view.status];
    check.hidden = view.status === "unsupported" || view.status === "ready";
    check.disabled = view.status === "checking" || view.status === "downloading";
    install.hidden = view.status !== "ready";
  };

  const load = async () => render(await bridge.getUpdateState());
  check.addEventListener("click", async () => render(await bridge.checkForUpdates()));
  install.addEventListener("click", () => void bridge.installUpdate());
  bridge.onUpdateStateChanged(() => void load());
  void load();
}
