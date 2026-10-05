/**
 * The Context tab: one fold-away box per source, and Attention's box.
 */

import { formatContextValue } from "./uiFormat";
import type { AttentionDebugView, ContextSnapshot } from "./rendererTypes";

/**
 * Renders any context value generically — providers can contribute
 * arbitrarily-shaped data (nested objects, arrays) and this still shows
 * something reasonable without the UI needing per-provider rendering code.
 */
function renderContextSnapshot(snapshot: ContextSnapshot): void {
  document.getElementById("contextGeneratedAt")!.textContent =
    `Last updated: ${new Date(snapshot.generatedAt).toLocaleString()}`;

  const container = document.getElementById("contextProviders")!;
  container.innerHTML = "";
  const open = readOpenContextCards();

  for (const result of Object.values(snapshot.providers)) {
    // A fold-away box per provider: the header (name and status) is always
    // visible; how it works and its raw data are inside.
    const card = document.createElement("details");
    card.className = "context-card";
    card.open = open.has(result.providerId);
    card.addEventListener("toggle", () => rememberContextCard(result.providerId, card.open));

    const header = document.createElement("summary");
    header.className = "context-card-header";

    const title = document.createElement("span");
    title.className = "context-card-title";
    title.textContent = result.displayName;
    header.appendChild(title);

    const badges = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = `context-badge ${result.status}`;
    badge.textContent = result.status;
    badges.appendChild(badge);
    if (result.stale) {
      const staleBadge = document.createElement("span");
      staleBadge.className = "context-badge stale";
      staleBadge.textContent = "stale";
      badges.appendChild(staleBadge);
    }
    header.appendChild(badges);
    card.appendChild(header);

    const explanation = CONTEXT_EXPLANATIONS[result.providerId];
    if (explanation) {
      const explainer = document.createElement("p");
      explainer.className = "context-explainer";
      explainer.textContent = explanation;
      card.appendChild(explainer);
    }

    if (result.error) {
      const errorEl = document.createElement("p");
      errorEl.className = "context-error";
      errorEl.textContent = result.error;
      card.appendChild(errorEl);
    }

    if (result.data) {
      const dl = document.createElement("dl");
      dl.className = "context-fields";
      for (const [key, value] of Object.entries(result.data)) {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = formatContextValue(value);
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    container.appendChild(card);
  }
}

/** How each Context provider works, in plain words — shown inside its box. */
const CONTEXT_EXPLANATIONS: Record<string, string> = {
  network:
    "Devices on your local network, from Windows' own list of nearby devices (read every 2 minutes; nothing is sent) and the Network tab's scan (one ping to each local address, at most once a minute). Devices are told apart by hardware (MAC) address, not IP. \"Recognized\" is NIMBUS's own label, not a security check. A device never seen before is published as an event.",
  dateTime:
    "Reads the date, time and time zone from this PC's own clock. Nothing is fetched or cached, so it is always current. The briefing uses it for the greeting and the date line.",
  system:
    "Reads basic facts about this PC from the operating system. Local only — nothing leaves the machine.",
  weather:
    "Current conditions and the coming days' forecast from Open-Meteo (free, no account), for the location you set in Settings or one estimated from your internet connection. Fetched at most every 10 minutes. Feeds the briefing and Attention's \"rain likely\" notice.",
  calendar:
    "Today's and upcoming events from the calendar feeds (.ics links or files) you added in Settings. Refreshed every 15 minutes, or every 2 when an event is close. Recurring events appear once, at their first occurrence. Feeds the Calendar tab, the briefing and Attention's \"meeting soon\" alerts.",
  email:
    'Recent messages from your email accounts over IMAP, strictly read-only — NIMBUS never sends, moves, deletes or marks anything. Each message gets an importance from simple signals: unread, flagged, automated senders, keywords. Refreshed every 5 minutes. Feeds the briefing and Attention\'s "important email" notices.',
  tasks:
    "Your active Todoist tasks, sorted into overdue, due today, upcoming and no deadline, each with an urgency worked out from its due time, priority and reminder. Refreshed every 5 minutes, or every minute when something is due soon. Feeds the Tasks tab, the briefing and Attention.",
  spotify:
    "What is playing on your Spotify account, read through Spotify's Web API once you connect it. Refreshed at most every 20 seconds. Used by the Home now-playing card and by routine conditions such as \"Spotify isn't already playing\".",
  stocks:
    "Prices for the positions in your Stocks tab from Yahoo Finance's public data (no account), turned into estimates of value and gain, with totals converted to your base currency. Quotes are reused for 2 minutes. Read-only — no trading. Feeds the Stocks tab, the briefing and Attention's \"big move\" notice.",
};

/** Which Context boxes are open is a per-device convenience, so it lives in localStorage. */
const OPEN_CONTEXT_CARDS_KEY = "nimbus.context.openCards";

function readOpenContextCards(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_CONTEXT_CARDS_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberContextCard(id: string, open: boolean): void {
  try {
    const cards = readOpenContextCards();
    if (open) cards.add(id);
    else cards.delete(id);
    localStorage.setItem(OPEN_CONTEXT_CARDS_KEY, JSON.stringify([...cards]));
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

const ATTENTION_DECISIONS: Record<string, string> = {
  surface: "Shown now",
  shown: "Already shown",
  held: "Waiting",
  quiet: "Quiet",
  acknowledged: "Acknowledged",
  dismissed: "Dismissed",
};

/** The Attention debug view: what NIMBUS thinks deserves attention, and why. */
function renderAttention(state: AttentionDebugView): void {
  (document.getElementById("attentionEnabled") as HTMLInputElement).checked = state.enabled;
  (document.getElementById("attentionPopups") as HTMLInputElement).checked = state.popups;
  (document.getElementById("attentionReminderMinutes") as HTMLSelectElement).value = String(
    state.reminderMinutes
  );
  document.getElementById("attentionBadge")!.textContent = !state.enabled
    ? "off"
    : `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  const summary = document.getElementById("attentionSummary")!;
  summary.textContent = !state.enabled
    ? "Attention is off — routine suggestions pop up as they come, and nothing else is raised."
    : state.evaluatedAt
      ? `Last looked at ${new Date(state.evaluatedAt).toLocaleTimeString()}${state.busy ? ` · ${state.busyReason}` : ""}.`
      : "Not evaluated yet.";

  const list = document.getElementById("attentionItems")!;
  list.innerHTML = "";
  if (state.enabled && state.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "feed-empty";
    empty.textContent = "Nothing needs your attention right now.";
    list.appendChild(empty);
  }
  for (const item of state.items) {
    const card = document.createElement("div");
    card.className = "attention-item";

    const header = document.createElement("div");
    header.className = "attention-item-header";
    const title = document.createElement("span");
    title.className = "attention-title";
    title.textContent = item.title;
    const badge = document.createElement("span");
    badge.className = `context-badge attention-${item.priority}`;
    badge.textContent = `${item.priority} · ${item.score}`;
    const source = document.createElement("span");
    source.className = "attention-source";
    source.textContent = item.source;
    header.append(title, badge, source);
    card.appendChild(header);

    if (item.description) {
      const description = document.createElement("p");
      description.className = "attention-line";
      description.textContent = item.description;
      card.appendChild(description);
    }
    const decision = document.createElement("p");
    decision.className = "attention-line";
    decision.textContent = `${ATTENTION_DECISIONS[item.decision] ?? item.decision} — ${item.decisionReason}`;
    card.appendChild(decision);

    const why = document.createElement("details");
    why.className = "attention-why";
    const whySummary = document.createElement("summary");
    whySummary.textContent = "Why";
    why.appendChild(whySummary);
    const factors = document.createElement("ul");
    for (const reason of item.reasons) {
      const li = document.createElement("li");
      li.textContent = reason;
      factors.appendChild(li);
    }
    for (const factor of item.factors) {
      const li = document.createElement("li");
      li.textContent = `${factor.label}: ${factor.points > 0 ? "+" : ""}${factor.points}`;
      factors.appendChild(li);
    }
    why.appendChild(factors);
    card.appendChild(why);
    list.appendChild(card);
  }
}

async function loadAttention(): Promise<void> {
  try {
    renderAttention(await window.nimbus.getAttention());
  } catch (err) {
    console.error("Failed to load attention", err);
  }
}

async function loadContext(): Promise<void> {
  try {
    const snapshot = await window.nimbus.getContext();
    renderContextSnapshot(snapshot);
  } catch (err) {
    console.error("Failed to load context", err);
  }
}

export function initContext(): void {
  loadContext();
  void loadAttention();
  const attentionSection = document.getElementById("attentionSection") as HTMLDetailsElement;
  attentionSection.open = readOpenContextCards().has("attention");
  attentionSection.addEventListener("toggle", () => rememberContextCard("attention", attentionSection.open));
  document.getElementById("refreshContextBtn")?.addEventListener("click", loadContext);
  document.getElementById("refreshContextBtn")?.addEventListener("click", () => void loadAttention());
  for (const [id, key] of [
    ["attentionEnabled", "enabled"],
    ["attentionPopups", "popups"],
  ] as const) {
    document.getElementById(id)?.addEventListener("change", async (event) => {
      await window.nimbus.updateAttentionSettings({ [key]: (event.target as HTMLInputElement).checked });
      await loadAttention();
    });
  }
  document.getElementById("attentionReminderMinutes")?.addEventListener("change", async (event) => {
    await window.nimbus.updateAttentionSettings({
      reminderMinutes: Number((event.target as HTMLSelectElement).value),
    });
    await loadAttention();
  });
}
