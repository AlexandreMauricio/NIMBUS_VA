/**
 * Renderer for the NIMBUS-owned suggestion popup window — see
 * src/main/suggestionWindow.ts. Deliberately tiny and self-contained
 * (its own HTML/CSS/preload, not sharing the main window's renderer.ts)
 * since it's a completely separate BrowserWindow. Never shows anything
 * but what the suggestion itself carries — no internal ids, no routine
 * ids, no technical/debug text (see the task's own "Windows
 * presentation" requirement).
 *
 * Loaded as a plain classic <script> (not type="module") like every
 * other renderer in this app, so its top-level names live in the page's
 * global scope — hence the `renderSuggestion` prefix below, to avoid
 * colliding with timerRenderer.ts's own top-level `render`-named function
 * (each file is a separate BrowserWindow/page, but TypeScript itself
 * still compiles both under one shared global scope, since neither uses
 * import/export).
 */
interface AssistantSuggestion {
  id: string;
  routineId: string;
  title: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
  expiresAt: string;
  actionSummary: Array<{ label: string; service: string }>;
}

interface NimbusPopupApi {
  getSuggestion: () => Promise<AssistantSuggestion | null>;
  onSuggestionUpdated: (callback: (suggestion: AssistantSuggestion) => void) => () => void;
  acceptSuggestion: (suggestionId: string) => Promise<unknown>;
  dismissSuggestion: (suggestionId: string) => Promise<void>;
  close: () => Promise<void>;
}

interface Window {
  nimbusPopup: NimbusPopupApi;
}

/** A generic icon by owning-service id — presentation only, never a hard-coded per-action string. Falls back to a plain dot for any service not listed here. */
const SERVICE_ICONS: Record<string, string> = {
  spotify: "🎵",
  timer: "⏱",
};

function iconFor(service: string): string {
  return SERVICE_ICONS[service] ?? "•";
}

let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
let currentSuggestion: AssistantSuggestion | null = null;

function renderSuggestion(suggestion: AssistantSuggestion): void {
  currentSuggestion = suggestion;

  document.getElementById("suggestionTitle")!.textContent = suggestion.title;
  document.getElementById("suggestionMessage")!.textContent = suggestion.message;

  const summaryEl = document.getElementById("actionsSummary")!;
  summaryEl.innerHTML = "";
  for (const step of suggestion.actionSummary) {
    const row = document.createElement("div");
    row.className = "actions-summary-item";
    row.textContent = `${iconFor(step.service)} ${step.label}`;
    summaryEl.appendChild(row);
  }

  const primaryBtn = document.getElementById("primaryBtn") as HTMLButtonElement;
  const secondaryBtn = document.getElementById("secondaryBtn") as HTMLButtonElement;
  primaryBtn.textContent = suggestion.primaryLabel;
  secondaryBtn.textContent = suggestion.secondaryLabel;

  if (autoDismissTimer) clearTimeout(autoDismissTimer);
  const msUntilExpiry = new Date(suggestion.expiresAt).getTime() - Date.now();
  autoDismissTimer = setTimeout(() => dismiss(), Math.max(0, msUntilExpiry));
}

async function accept(): Promise<void> {
  if (!currentSuggestion) return;
  const id = currentSuggestion.id;
  currentSuggestion = null;
  await window.nimbusPopup.acceptSuggestion(id);
  await window.nimbusPopup.close();
}

async function dismiss(): Promise<void> {
  if (!currentSuggestion) return;
  const id = currentSuggestion.id;
  currentSuggestion = null;
  await window.nimbusPopup.dismissSuggestion(id);
  await window.nimbusPopup.close();
}

document.getElementById("primaryBtn")!.addEventListener("click", accept);
document.getElementById("secondaryBtn")!.addEventListener("click", dismiss);

window.nimbusPopup.onSuggestionUpdated(renderSuggestion);
window.nimbusPopup.getSuggestion().then((suggestion) => {
  if (suggestion) renderSuggestion(suggestion);
});
