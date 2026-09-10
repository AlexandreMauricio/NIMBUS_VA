import { contextBridge, ipcRenderer } from "electron";

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

/** The timer popup window's own minimal preload — read/pause/resume/cancel the one current timer, nothing else. */
contextBridge.exposeInMainWorld("nimbusTimer", {
  getState: (): Promise<PublicTimerState | null> => ipcRenderer.invoke("nimbus:get-timer-state"),
  pause: (timerId: string): Promise<PublicTimerState | null> =>
    ipcRenderer.invoke("nimbus:pause-timer", timerId),
  resume: (timerId: string): Promise<PublicTimerState | null> =>
    ipcRenderer.invoke("nimbus:resume-timer", timerId),
  cancel: (timerId: string): Promise<PublicTimerState | null> =>
    ipcRenderer.invoke("nimbus:cancel-timer", timerId),
  /**
   * Adds another study to the Pomodoro already running — "actually,
   * three today". Goes through the registered `timer.addStudy` Action
   * like any other, rather than reaching into TimerService: this window
   * can invoke that one action by name and nothing else.
   */
  addStudy: (): Promise<{ status: string; message?: string }> => ipcRenderer.invoke("nimbus:timer-add-study"),
  close: (): Promise<void> => ipcRenderer.invoke("nimbus:close-timer-window"),
});
