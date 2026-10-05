/**
 * Activity: Home's current-activity card and the Activity settings editor.
 */

import { refreshUsageList, USAGE_PROMOTION_EVENT, UsagePromotion } from "./homeWeek";
import type { ActivityMapping, ActivityPreferences, ActivitySession } from "./rendererTypes";
import { buildSwitch } from "./controls";
import { switchToTab } from "./sidebarGroups";

/**
 * The Home page's "what am I doing right now" card.
 *
 * Reads the Activity service's conclusion and, when relevant, shows the
 * Spotify and Timer state alongside it — by reading their existing
 * surfaces, not by owning any of it. Hidden entirely when there is no
 * recognized activity, so a user who hasn't configured mappings isn't
 * shown an empty frame.
 */
export function initCurrentActivity(): void {
  const card = document.getElementById("currentActivityCard") as HTMLElement;
  const iconEl = document.getElementById("currentActivityIcon") as HTMLElement;
  const nameEl = document.getElementById("currentActivityName") as HTMLElement;
  const sourceEl = document.getElementById("currentActivitySource") as HTMLElement;
  const durationEl = document.getElementById("currentActivityDuration") as HTMLElement;
  const contextEl = document.getElementById("currentActivityContext") as HTMLElement;
  const historyCard = document.getElementById("activityHistoryCard") as HTMLElement;
  const historyList = document.getElementById("activityHistoryList") as HTMLElement;

  function formatMinutes(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  function formatClock(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  async function renderContext(): Promise<void> {
    contextEl.innerHTML = "";

    // Spotify and the timer are read from their existing state. If
    // either isn't running or configured, its line simply isn't there.
    const [snapshot, timer] = await Promise.all([
      window.nimbus.getContext().catch(() => null),
      window.nimbus.getTimerState().catch(() => null),
    ]);

    const spotify = snapshot?.providers?.spotify?.data as
      { playbackState?: string; track?: { name?: string; artists?: string[] } } | undefined;
    if (spotify?.playbackState === "playing" && spotify.track?.name) {
      const line = document.createElement("div");
      line.className = "current-activity-context-line";
      const artists = spotify.track.artists?.join(", ");
      line.textContent = `🎵 ${spotify.track.name}${artists ? ` · ${artists}` : ""}`;
      contextEl.appendChild(line);
    }

    // Paused counts as current state: a paused Pomodoro is still the
    // session you are in, and hiding it makes the card look like the
    // timer vanished. Completed and cancelled ones are genuinely over.
    if (timer && (timer.status === "running" || timer.status === "paused")) {
      const line = document.createElement("div");
      line.className = "current-activity-context-line";
      const remaining = `${formatMinutes(timer.remainingMs)} remaining`;
      line.textContent =
        timer.status === "paused"
          ? `⏱ ${timer.title} · ${remaining} · paused`
          : `⏱ ${timer.title} · ${remaining}`;
      contextEl.appendChild(line);
    }
  }

  function renderHistory(sessions: ActivitySession[]): void {
    const ended = sessions.filter((s) => s.state === "ended" && s.endedAt);
    historyCard.hidden = ended.length === 0;
    historyList.innerHTML = "";

    for (const session of ended.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "activity-history-row";

      const when = document.createElement("span");
      when.className = "activity-history-when";
      when.textContent = `${formatClock(session.startedAt)}–${formatClock(session.endedAt!)}`;
      row.appendChild(when);

      const what = document.createElement("span");
      what.className = "activity-history-what";
      what.textContent = `${session.icon ? session.icon + " " : ""}${session.activity}`;
      row.appendChild(what);

      const where = document.createElement("span");
      where.className = "activity-history-where";
      where.textContent = session.sourceValue;
      row.appendChild(where);

      historyList.appendChild(row);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [current, sessions] = await Promise.all([
        window.nimbus.getCurrentActivity(),
        window.nimbus.getActivitySessions(),
      ]);

      card.hidden = current === null;
      if (current) {
        iconEl.textContent = current.icon ?? "";
        iconEl.hidden = !current.icon;
        nameEl.textContent = current.activity;
        sourceEl.textContent = current.sourceValue;
        durationEl.textContent = formatMinutes(current.durationMs);
        await renderContext();
      }

      renderHistory(sessions);
    } catch (err) {
      console.error("Failed to refresh current activity", err);
    }
  }

  void refresh();
  // Ten seconds, not thirty. The activity's own duration changes slowly,
  // but the Spotify and timer lines beside it do not: accepting a
  // routine's suggestion starts a timer moments AFTER the activity
  // began, and a card that only re-read every 30s showed no timer for
  // half a minute afterwards — which reads as "it stopped showing the
  // timer" rather than "not yet".
  setInterval(() => void refresh(), 10_000);
  window.nimbus.onActivityChanged(() => void refresh());
  // Spotify actions already push this; a routine that starts playback
  // and a timer together then updates both lines at once.
  window.nimbus.onNowPlayingChanged(() => void refresh());
}

/**
 * The Activity mappings editor in Settings — "this app means that
 * activity". Follows the same list-plus-add-row shape the calendar feed
 * and email account editors already use, rather than inventing a
 * different pattern for the same job.
 */
export async function initActivitySettings(): Promise<void> {
  const enabled = document.getElementById("activityEnabled") as HTMLInputElement;
  const suggestApps = document.getElementById("activitySuggestApps") as HTMLInputElement;
  const list = document.getElementById("activityMappingList") as HTMLElement;
  const empty = document.getElementById("activityMappingEmpty") as HTMLElement;
  const nameInput = document.getElementById("activityMappingName") as HTMLInputElement;
  const iconInput = document.getElementById("activityMappingIcon") as HTMLInputElement;
  const sourceSelect = document.getElementById("activityMappingSource") as HTMLSelectElement;
  const valueInput = document.getElementById("activityMappingValue") as HTMLInputElement;
  const priorityInput = document.getElementById("activityMappingPriority") as HTMLInputElement;
  const graceInput = document.getElementById("activityGraceMinutes") as HTMLInputElement;
  const addBtn = document.getElementById("addActivityMappingBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelActivityMappingEditBtn") as HTMLButtonElement;
  const errorEl = document.getElementById("activityMappingError") as HTMLElement;

  /** The activity being edited, or null when the form is adding a new one. */
  let editingMappingId: string | null = null;

  function showError(message: string): void {
    // Not alert(): a modal dialog in Electron takes keyboard focus away
    // from the form behind it, and the form is what needs fixing.
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError(): void {
    errorEl.hidden = true;
  }

  function resetForm(): void {
    editingMappingId = null;
    nameInput.value = "";
    iconInput.value = "";
    valueInput.value = "";
    priorityInput.value = "0";
    sourceSelect.value = "application";
    addBtn.textContent = "Add activity";
    cancelEditBtn.hidden = true;
    clearError();
  }

  /**
   * Loads an existing activity back into the same fields that create one.
   * One form for both, rather than a second editing surface to keep in
   * step with the first.
   */
  function startEditing(mapping: ActivityMapping): void {
    editingMappingId = mapping.id;
    nameInput.value = mapping.activity;
    iconInput.value = mapping.icon ?? "";
    sourceSelect.value = mapping.source;
    valueInput.value = mapping.value;
    priorityInput.value = String(mapping.priority);
    addBtn.textContent = "Update activity";
    cancelEditBtn.hidden = false;
    clearError();
    nameInput.focus();
  }

  const SOURCE_LABELS: Record<string, string> = {
    application: "App",
    website: "Site",
    folder: "Folder",
  };

  function render(settings: ActivityPreferences): void {
    enabled.checked = settings.enabled;
    suggestApps.checked = settings.suggestFrequentApps === true;
    graceInput.value = String(settings.graceMinutes);
    empty.hidden = settings.mappings.length > 0;
    list.innerHTML = "";

    // Shown in the order they are applied, so the precedence rules are
    // visible rather than something to infer.
    const ordered = [...settings.mappings].sort((a, b) => b.priority - a.priority);
    for (const m of ordered) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const label = document.createElement("span");
      label.className = "calendar-feed-row-label";
      label.textContent = `${m.icon ? m.icon + " " : ""}${m.activity}`;
      row.appendChild(label);

      const detail = document.createElement("span");
      detail.className = "calendar-feed-row-address";
      detail.textContent = `${SOURCE_LABELS[m.source] ?? m.source}: ${m.value}${m.priority !== 0 ? ` · priority ${m.priority}` : ""}`;
      row.appendChild(detail);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("label");
      toggle.className = "routine-active-toggle";
      toggle.title = "Disable to keep the mapping without using it";
      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.checked = m.enabled;
      toggleInput.addEventListener("change", async () => {
        const updated = settings.mappings.map((x) =>
          x.id === m.id ? { ...x, enabled: toggleInput.checked } : x
        );
        render(await window.nimbus.updateActivitySettings({ mappings: updated }));
      });
      toggle.appendChild(buildSwitch(toggleInput));
      const toggleText = document.createElement("span");
      toggleText.textContent = "On";
      toggle.appendChild(toggleText);
      actions.appendChild(toggle);

      const edit = document.createElement("button");
      edit.className = "calendar-feed-remove";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditing(m));
      actions.appendChild(edit);

      const remove = document.createElement("button");
      remove.className = "calendar-feed-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        // Editing the very row being removed would leave the form
        // pointing at something that no longer exists.
        if (editingMappingId === m.id) resetForm();
        const updated = settings.mappings.filter((x) => x.id !== m.id);
        render(await window.nimbus.updateActivitySettings({ mappings: updated }));
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getActivitySettings();
    render(settings);

    enabled.addEventListener("change", async () => {
      render(await window.nimbus.updateActivitySettings({ enabled: enabled.checked }));
    });

    suggestApps.addEventListener("change", async () => {
      render(await window.nimbus.updateActivitySettings({ suggestFrequentApps: suggestApps.checked }));
    });

    // "Make it an activity?" answered yes: this form, with the program
    // filled in. Nothing is saved until the user presses "Add activity".
    const prefillEditor = (application: string, name: string, source?: "application" | "website") => {
      resetForm();
      nameInput.value = name;
      sourceSelect.value = source === "website" ? "website" : "application";
      sourceSelect.dispatchEvent(new Event("change"));
      valueInput.value = application;
      nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
      nameInput.focus();
      nameInput.select();
    };
    window.nimbus.onOpenActivityEditor(({ application, name, source }) => {
      switchToTab("routines");
      document.getElementById("routinesTabActivitiesBtn")?.click();
      prefillEditor(application, name, source);
    });

    // From "What NIMBUS has counted this week" (homeWeek.ts): a new activity
    // opens this form filled in; "Add to" saves a rule for an existing
    // activity straight away, with that activity's icon and priority.
    window.addEventListener(USAGE_PROMOTION_EVENT, async (event) => {
      const promotion = (event as CustomEvent<UsagePromotion>).detail;
      if (promotion.kind === "new") {
        prefillEditor(promotion.value, promotion.name, promotion.source);
        return;
      }
      const current = await window.nimbus.getActivitySettings();
      const sibling = current.mappings.find((m) => m.activity === promotion.activity);
      if (!sibling) return;
      const mapping: ActivityMapping = {
        id: `activity-${Date.now()}`,
        enabled: true,
        activity: sibling.activity,
        icon: sibling.icon,
        source: promotion.source,
        value: promotion.value,
        matchMode: promotion.source === "application" ? "exact" : "contains",
        priority: sibling.priority,
      };
      try {
        render(await window.nimbus.updateActivitySettings({ mappings: [...current.mappings, mapping] }));
        refreshUsageList();
      } catch (err) {
        showError(`Couldn't save that activity: ${String(err)}`);
      }
    });

    graceInput.addEventListener("change", async () => {
      const minutes = Number(graceInput.value);
      if (!Number.isFinite(minutes) || minutes < 0) return;
      render(await window.nimbus.updateActivitySettings({ graceMinutes: minutes }));
    });

    cancelEditBtn.addEventListener("click", () => resetForm());

    addBtn.addEventListener("click", async () => {
      const activity = nameInput.value.trim();
      const value = valueInput.value.trim();
      if (!activity || !value) {
        showError("Give the activity a name and something to match against.");
        return;
      }
      clearError();

      const current = await window.nimbus.getActivitySettings();
      const existing = current.mappings.find((m) => m.id === editingMappingId);
      const mapping: ActivityMapping = {
        id: existing?.id ?? `activity-${Date.now()}`,
        // Editing an activity shouldn't silently switch a disabled one
        // back on; that is what the row's own toggle is for.
        enabled: existing?.enabled ?? true,
        activity,
        icon: iconInput.value.trim() || undefined,
        source: sourceSelect.value as ActivityMapping["source"],
        value,
        // "contains" for everything but an exact executable name, which
        // is what the Routine trigger form does for the same reason: a
        // window title is never going to match exactly.
        matchMode: sourceSelect.value === "application" ? "exact" : "contains",
        priority: Number(priorityInput.value) || 0,
      };

      const mappings = existing
        ? current.mappings.map((m) => (m.id === existing.id ? mapping : m))
        : [...current.mappings, mapping];

      try {
        render(await window.nimbus.updateActivitySettings({ mappings }));
        resetForm();
        refreshUsageList();
      } catch (err) {
        // The main process validates before saving; show why rather than
        // failing silently.
        showError(`Couldn't save that activity: ${String(err)}`);
      }
    });
  } catch (err) {
    console.error("Failed to load activity settings", err);
  }
}
