import { contextBridge, ipcRenderer } from "electron";
import { AssistantSuggestion } from "../common/assistantEvents";
import { PublicActionResult } from "./preload";

/**
 * The suggestion popup window's own minimal preload — deliberately
 * separate from the main window's preload.ts. It exposes nothing beyond
 * what this one small window needs: read the current suggestion, accept
 * or dismiss it (via the exact same IPC channels the main window's
 * "getActiveSuggestions"/accept/dismiss already use — see lifecycle.ts),
 * and close itself. No settings, no context, no action execution beyond
 * accept/dismiss — a compromised suggestion popup renderer still
 * couldn't do anything the main window can't already do more directly.
 */
contextBridge.exposeInMainWorld("nimbusPopup", {
  getSuggestion: (): Promise<AssistantSuggestion | null> => ipcRenderer.invoke("nimbus:get-popup-suggestion"),
  onSuggestionUpdated: (callback: (suggestion: AssistantSuggestion) => void): (() => void) => {
    const listener = (_event: unknown, suggestion: AssistantSuggestion) => callback(suggestion);
    ipcRenderer.on("nimbus:popup-suggestion-updated", listener);
    return () => ipcRenderer.removeListener("nimbus:popup-suggestion-updated", listener);
  },
  acceptSuggestion: (suggestionId: string): Promise<PublicActionResult[]> =>
    ipcRenderer.invoke("nimbus:accept-suggestion", suggestionId),
  dismissSuggestion: (suggestionId: string): Promise<void> => ipcRenderer.invoke("nimbus:dismiss-suggestion", suggestionId),
  close: (): Promise<void> => ipcRenderer.invoke("nimbus:close-suggestion-popup"),
});
