/**
 * Renderer for the NIMBUS timer popup window — see
 * src/main/timerWindow.ts. Polls state every second rather than being
 * pushed updates; simple and sufficient for one small window.
 *
 * Loaded as a plain classic <script> like every other renderer in this
 * app, so its top-level names live in the page's global scope — hence
 * the `renderTimer` name below, to avoid colliding with
 * suggestionRenderer.ts's own top-level `render`-named function (each
 * file is a separate BrowserWindow/page, but TypeScript itself still
 * compiles both under one shared global scope, since neither uses
 * import/export).
 */
interface PublicTimerState {
  id: string;
  title: string;
  type: string;
  durationMs: number;
  remainingMs: number;
  status: "running" | "paused" | "completed" | "cancelled";
  createdAt: string;
  completedAt: string | null;
}

interface NimbusTimerApi {
  getState: () => Promise<PublicTimerState | null>;
  pause: (timerId: string) => Promise<PublicTimerState | null>;
  resume: (timerId: string) => Promise<PublicTimerState | null>;
  cancel: (timerId: string) => Promise<PublicTimerState | null>;
  close: () => Promise<void>;
}

interface Window {
  nimbusTimer: NimbusTimerApi;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const pauseResumeBtn = document.getElementById("pauseResumeBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const titleEl = document.getElementById("timerTitle")!;
const remainingEl = document.getElementById("remaining")!;
const progressFillEl = document.getElementById("progressFill") as HTMLElement;
const statusEl = document.getElementById("statusText")!;

let currentId: string | null = null;

function renderTimer(state: PublicTimerState | null): void {
  if (!state || state.status === "cancelled" || state.status === "completed") {
    if (state?.status === "completed") {
      statusEl.textContent = "Complete";
      remainingEl.textContent = "0:00";
      progressFillEl.style.width = "100%";
      pauseResumeBtn.disabled = true;
      setTimeout(() => window.nimbusTimer.close(), 4000);
    } else {
      window.nimbusTimer.close();
    }
    return;
  }

  currentId = state.id;
  titleEl.textContent = state.title;
  remainingEl.textContent = formatRemaining(state.remainingMs);
  const progress =
    state.durationMs > 0 ? ((state.durationMs - state.remainingMs) / state.durationMs) * 100 : 0;
  progressFillEl.style.width = `${Math.min(100, Math.max(0, progress))}%`;
  pauseResumeBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  pauseResumeBtn.disabled = false;
  statusEl.textContent = state.status === "paused" ? "Paused" : "";
}

pauseResumeBtn.addEventListener("click", async () => {
  if (!currentId) return;
  const state = await window.nimbusTimer.getState();
  if (state?.status === "paused") {
    renderTimer(await window.nimbusTimer.resume(currentId));
  } else {
    renderTimer(await window.nimbusTimer.pause(currentId));
  }
});

stopBtn.addEventListener("click", async () => {
  if (!currentId) return;
  await window.nimbusTimer.cancel(currentId);
  window.nimbusTimer.close();
});

async function poll(): Promise<void> {
  const state = await window.nimbusTimer.getState();
  renderTimer(state);
}

poll();
setInterval(poll, 1000);
