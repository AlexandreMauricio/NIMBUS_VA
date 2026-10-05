/**
 * Home's activity feed: routine suggestions, automatic runs and
 * Attention's notices and questions.
 */

import type { AssistantEvent } from "./rendererTypes";

/**
 * One of Attention's questions, posted to the feed because it wasn't
 * pressing enough for a popup — with its two answers as buttons. Answering
 * goes through the same path as the popup's buttons.
 */
function renderFeedQuestion(item: HTMLElement, event: AssistantEvent): void {
  item.classList.add("feed-question");
  const itemId = String(event.attentionItemId);

  const text = document.createElement("div");
  text.textContent = `${String(event.title)}: ${String(event.body)}`;
  item.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "feed-question-actions";
  const outcomeNote = document.createElement("span");
  outcomeNote.className = "feed-question-outcome";

  const answer = async (outcome: "accepted" | "dismissed", label: string): Promise<void> => {
    actions.querySelectorAll("button").forEach((button) => (button.disabled = true));
    let answered = false;
    try {
      answered = await window.nimbus.answerAttentionItem(itemId, outcome);
    } catch (err) {
      console.error("Failed to answer", err);
    }
    actions.replaceChildren(outcomeNote);
    outcomeNote.textContent = answered ? label : "No longer waiting for an answer";
  };

  const primary = document.createElement("button");
  primary.className = "btn btn-secondary";
  primary.type = "button";
  primary.textContent = String(event.primaryLabel ?? "Yes");
  primary.addEventListener("click", () => void answer("accepted", "Done"));

  const secondary = document.createElement("button");
  secondary.className = "btn btn-ghost";
  secondary.type = "button";
  secondary.textContent = String(event.secondaryLabel ?? "Not now");
  secondary.addEventListener("click", () => void answer("dismissed", `Answered: ${secondary.textContent}`));

  actions.append(primary, secondary);
  item.appendChild(actions);
}

export function initAssistantFeed(): void {
  const feed = document.getElementById("feed")!;
  const countTag = document.getElementById("activityCount")!;
  let count = 0;

  window.nimbus.onAssistantEvent((event) => {
    const empty = feed.querySelector(".feed-empty");
    empty?.remove();

    const item = document.createElement("div");
    item.className = "feed-item";
    // The interactive prompt for a suggestion is the NIMBUS-owned popup
    // window (see src/main/suggestionWindow.ts) — this is just a passive
    // record that it happened, same as every other event type here. A
    // "notification" is what an `autoRun` routine's own completion
    // shows up as instead of a suggestion — see Routine.autoRun.
    if (event.type === "suggestion") {
      item.textContent = `Suggested: ${event.title}`;
    } else if (event.type === "notification" && typeof event.attentionItemId === "string") {
      renderFeedQuestion(item, event);
    } else if (event.type === "notification") {
      item.textContent = `${event.title}: ${event.body}`;
    } else {
      item.textContent = `[${event.source}] ${event.type}`;
    }
    feed.prepend(item);

    count += 1;
    countTag.textContent = `${count} event${count === 1 ? "" : "s"}`;
  });
}
