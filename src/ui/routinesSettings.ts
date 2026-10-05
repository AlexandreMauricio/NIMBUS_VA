/**
 * The Routines tab: the routine list and editor, run-now buttons, and the
 * routine history. Its helpers (the trigger form, the run-now icons) are
 * here with it.
 */

import { routineHistoryText, triggerSummary, withSkipIfActiveCondition } from "./uiFormat";
// The one description of what a routine can check (field -> operator ->
// value). Imported from Core rather than mirrored here: it is pure data
// with no imports of its own, and a second copy would drift from the
// evaluator that reads the same conditions.
import {
  CONDITION_FIELDS,
  ConditionRow,
  ConditionValue,
  buildCondition,
  operatorsFor,
  readCondition,
} from "../routines/conditionCatalog";
import type {
  ActionDefinition,
  RawActivitySnapshot,
  Routine,
  RoutineActionStep,
  RoutineCondition,
  RoutineEvaluation,
  RoutineHistoryEntry,
  RoutineSettings,
  SpotifyPlaylistSummary,
  StringMatchMode,
  TriggerConfig,
} from "./rendererTypes";
import { NOW_PLAYING_REFRESH_EVENT } from "./nowPlaying";
import { buildSwitch } from "./controls";

const TRIGGER_TYPES: TriggerConfig["type"][] = [
  "applicationOpened",
  "websiteOpened",
  "folderOpened",
  "activityEnded",
];

/**
 * Builds a trigger from the form.
 *
 * `existing` is the trigger being edited, when there is one. The form has
 * no match-mode control, so without this an edit would rewrite whatever
 * was saved to "contains" — silently loosening an "exact" routine's
 * matching as a side effect of changing something unrelated. The saved
 * mode is carried over whenever the trigger type is unchanged; a genuinely
 * new trigger type gets the form's default.
 */
function buildTriggerFromForm(existing?: TriggerConfig): TriggerConfig | null {
  const type = (document.getElementById("routineTriggerType") as HTMLSelectElement)
    .value as TriggerConfig["type"];
  // Only the pattern-matching triggers carry a match mode to preserve;
  // "activity ended" and "timer completed" match by name, not pattern.
  const matchMode: StringMatchMode =
    existing &&
    existing.type === type &&
    existing.type !== "activityEnded" &&
    existing.type !== "timerCompleted"
      ? existing.matchMode
      : "contains";

  if (type === "applicationOpened") {
    const application = (document.getElementById("routineAppName") as HTMLInputElement).value.trim();
    return application ? { type, application, matchMode } : null;
  }
  if (type === "websiteOpened") {
    const pattern = (document.getElementById("routineWebsitePattern") as HTMLInputElement).value.trim();
    const matchField = existing?.type === "websiteOpened" ? existing.matchField : ("windowTitle" as const);
    return pattern ? { type, matchField, pattern, matchMode } : null;
  }
  if (type === "activityEnded") {
    // An empty activity name is meaningful here — it means "any activity
    // ending" — so unlike the other triggers this one is never null for
    // want of a value.
    const activity = (document.getElementById("routineActivityEndedName") as HTMLSelectElement).value.trim();
    const minutes = Number(
      (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value
    );
    return {
      type,
      activity,
      minMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
    };
  }

  const path = (document.getElementById("routineFolderPath") as HTMLInputElement).value.trim();
  return path ? { type: "folderOpened", path, matchMode } : null;
}

const ROUTINE_RUN_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,1 3,15 15,8"/></svg>`;

const ROUTINE_RUNNING_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6" stroke-dasharray="28" stroke-dashoffset="10"/></svg>`;

const ROUTINE_RUN_SUCCESS_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,9 6,13 14,3"/></svg>`;

const ROUTINE_RUN_FAILURE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>`;

/**
 * Wires the whole Routines configuration flow: create/enable-disable/
 * delete/test a Routine, choose a trigger + its parameters, and build an
 * ordered action sequence from NIMBUS's existing, already-registered
 * Actions — never anything Routines invents or hard-codes itself (see
 * "Generic configuration" in docs/routines.md).
 */
export async function initRoutinesSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("routinesEnabled") as HTMLInputElement;
  const disabledWarningEl = document.getElementById("routinesDisabledWarning") as HTMLElement;
  const routineListEl = document.getElementById("routineList") as HTMLElement;
  const nameInput = document.getElementById("routineName") as HTMLInputElement;
  const triggerTypeSelect = document.getElementById("routineTriggerType") as HTMLSelectElement;
  const suggestionTitleInput = document.getElementById("routineSuggestionTitle") as HTMLInputElement;
  const suggestionMessageInput = document.getElementById("routineSuggestionMessage") as HTMLInputElement;
  const cooldownInput = document.getElementById("routineCooldown") as HTMLInputElement;
  const skipIfActiveCheckbox = document.getElementById("routineSkipIfActive") as HTMLInputElement;
  const autoRunCheckbox = document.getElementById("routineAutoRun") as HTMLInputElement;
  const actionListEl = document.getElementById("routineActionList") as HTMLElement;
  const actionServiceSelect = document.getElementById("routineActionServiceSelect") as HTMLSelectElement;
  const actionSelect = document.getElementById("routineActionSelect") as HTMLSelectElement;
  const addActionBtn = document.getElementById("routineAddActionBtn") as HTMLButtonElement;
  const cancelActionEditBtn = document.getElementById("routineCancelActionEditBtn") as HTMLButtonElement;
  const actionParamFieldsEl = document.getElementById("routineActionParamFields") as HTMLElement;
  const saveBtn = document.getElementById("addRoutineBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelRoutineEditBtn") as HTMLButtonElement;
  const formHeadingEl = document.getElementById("routineFormHeading") as HTMLElement;
  const listViewEl = document.getElementById("routinesListView") as HTMLElement;
  const editViewEl = document.getElementById("routinesEditView") as HTMLElement;
  const newRoutineBtn = document.getElementById("newRoutineBtn") as HTMLButtonElement;
  const backToListBtn = document.getElementById("backToRoutineListBtn") as HTMLButtonElement;
  const viewListBtn = document.getElementById("routinesViewListBtn") as HTMLButtonElement;
  const viewGridBtn = document.getElementById("routinesViewGridBtn") as HTMLButtonElement;
  const routineListEmptyEl = document.getElementById("routineListEmpty") as HTMLElement;
  const activityDebugDetails = document.querySelector(".activity-debug") as HTMLDetailsElement;
  const activitySnapshotContentEl = document.getElementById("activitySnapshotContent") as HTMLElement;
  const refreshActivitySnapshotBtn = document.getElementById(
    "refreshActivitySnapshotBtn"
  ) as HTMLButtonElement;

  function showListView(): void {
    listViewEl.hidden = false;
    editViewEl.hidden = true;
  }

  function showEditView(): void {
    listViewEl.hidden = true;
    editViewEl.hidden = false;
  }

  const CARD_LAYOUT_STORAGE_KEY = "nimbus:routines-card-layout";
  function applyCardLayout(layout: "list" | "grid"): void {
    routineListEl.classList.toggle("grid-view", layout === "grid");
    viewListBtn.classList.toggle("active", layout === "list");
    viewGridBtn.classList.toggle("active", layout === "grid");
    try {
      localStorage.setItem(CARD_LAYOUT_STORAGE_KEY, layout);
    } catch {
      // per-viewer convenience only — fine if storage is unavailable (private window, etc.)
    }
  }
  viewListBtn.addEventListener("click", () => applyCardLayout("list"));
  viewGridBtn.addEventListener("click", () => applyCardLayout("grid"));
  let savedLayout: string | null = null;
  try {
    savedLayout = localStorage.getItem(CARD_LAYOUT_STORAGE_KEY);
  } catch {
    // ignore — defaults to list view below
  }
  applyCardLayout(savedLayout === "grid" ? "grid" : "list");

  let availableActions: ActionDefinition[] = [];
  let availablePlaylists: SpotifyPlaylistSummary[] = [];
  let pendingActions: RoutineActionStep[] = [];
  // Index into pendingActions currently loaded into the picker row for
  // editing — null means the picker is building a brand new step to
  // append, matching the "Save routine"/"Update routine" duality above.
  let editingActionIndex: number | null = null;
  // Set only while editing an existing routine — the same create form
  // above doubles as the editor (see this function's doc comment); this
  // is the one bit of state that changes "Save routine" from appending a
  // new routine to replacing this one in place.
  let editingRoutineId: string | null = null;
  /** The trigger of the routine open in the editor, so an edit preserves its match mode. */
  let editedRoutineTrigger: TriggerConfig | null = null;

  function syncTriggerFieldsVisibility(): void {
    for (const type of TRIGGER_TYPES) {
      const el = document.getElementById(`routineTriggerFields-${type}`) as HTMLElement;
      el.hidden = type !== triggerTypeSelect.value;
    }
    // "Activity ended" is the one trigger with a second field of its own.
    const minEl = document.getElementById("routineTriggerFields-activityEndedMin") as HTMLElement;
    minEl.hidden = triggerTypeSelect.value !== "activityEnded";
  }

  function paramFieldId(name: string): string {
    return `routineParam-${name}`;
  }

  /**
   * A service-first picker for the action dropdown — with every action
   * from every provider in one flat list, a routine only interested in
   * "open a website" had to scroll past every Spotify action first (and
   * will have to scroll past even more once more providers exist).
   * Services come entirely from `ActionDefinition.affectsService`, never
   * a hard-coded list — a brand new provider shows up here with no
   * changes to this file.
   */
  function populateActionServiceSelect(): void {
    const previousValue = actionServiceSelect.value;
    actionServiceSelect.innerHTML = "";
    const services = [...new Set(availableActions.map((a) => a.affectsService))].sort();
    for (const service of services) {
      const option = document.createElement("option");
      option.value = service;
      option.textContent = capitalize(service);
      actionServiceSelect.appendChild(option);
    }
    if (services.includes(previousValue)) actionServiceSelect.value = previousValue;
  }

  function populateActionSelectForService(service: string): void {
    actionSelect.innerHTML = "";
    for (const def of availableActions.filter((a) => a.affectsService === service)) {
      const option = document.createElement("option");
      option.value = def.id;
      option.textContent = def.name;
      actionSelect.appendChild(option);
    }
  }

  function capitalize(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Fields declare their choices in plain English in ActionDefinition's
  // own `description` (e.g. "single | pomodoro — defaults to single") —
  // an existing convention (see spotify.search's "type" param) reused
  // here rather than invented for Timer specifically. Parsing it into a
  // dropdown works for any action's enum-shaped string param, current or
  // future, without the Routine editor needing to special-case which
  // action or param it is.
  function parseEnumOptions(description: string): string[] | null {
    const beforeDash = description.split("—")[0];
    const candidates = beforeDash.split("|").map((s) => s.trim());
    if (candidates.length < 2 || candidates.some((c) => c.length === 0 || /\s/.test(c))) return null;
    return candidates;
  }

  // timer.start's params fall into two groups depending on `mode` — a
  // single duration/type/title, or a Pomodoro studyMinutes/breakMinutes/
  // cycles plan. Both sets are always sent to collectActionParams (a
  // hidden field simply isn't filled in, same as any other optional
  // field left blank), this only avoids showing the user irrelevant
  // fields for the mode they didn't pick.
  const TIMER_SINGLE_ONLY_PARAMS = new Set(["duration", "type"]);
  const TIMER_POMODORO_ONLY_PARAMS = new Set(["studyMinutes", "breakMinutes", "cycles"]);

  function updateTimerModeVisibility(mode: string): void {
    for (const [name, row] of paramRowsByName) {
      if (TIMER_SINGLE_ONLY_PARAMS.has(name)) row.hidden = mode !== "single";
      else if (TIMER_POMODORO_ONLY_PARAMS.has(name)) row.hidden = mode !== "pomodoro";
    }
  }

  let paramRowsByName = new Map<string, HTMLElement>();

  function renderActionParamFields(actionDef: ActionDefinition | undefined): void {
    actionParamFieldsEl.innerHTML = "";
    paramRowsByName = new Map();
    if (!actionDef) return;

    for (const param of actionDef.parameters) {
      const row = document.createElement("label");
      row.className = "field-row";
      const label = document.createElement("span");
      label.className = "setting-title";
      label.textContent = param.required ? param.name : `${param.name} (optional)`;
      row.appendChild(label);

      const enumOptions =
        param.type === "string" && param.description ? parseEnumOptions(param.description) : null;

      // A picked-playlist affordance for Spotify's playPlaylist action —
      // still just filling in a plain action parameter, not a special
      // routine concept (see "Generic configuration" in docs/routines.md).
      if (
        actionDef.id === "spotify.playPlaylist" &&
        param.name === "playlistUri" &&
        availablePlaylists.length > 0
      ) {
        const select = document.createElement("select");
        select.className = "select";
        select.id = paramFieldId(param.name);
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "(search by name instead)";
        select.appendChild(blank);
        for (const playlist of availablePlaylists) {
          const option = document.createElement("option");
          option.value = playlist.uri;
          option.textContent = playlist.name;
          select.appendChild(option);
        }
        row.appendChild(select);
      } else if (enumOptions) {
        const select = document.createElement("select");
        select.className = "select";
        select.id = paramFieldId(param.name);
        if (!param.required) {
          const blank = document.createElement("option");
          blank.value = "";
          blank.textContent = "(default)";
          select.appendChild(blank);
        }
        for (const optionValue of enumOptions) {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionValue;
          select.appendChild(option);
        }
        if (actionDef.id === "timer.start" && param.name === "mode") {
          select.addEventListener("change", () => updateTimerModeVisibility(select.value || "single"));
        }
        row.appendChild(select);
      } else {
        const input = document.createElement("input");
        input.id = paramFieldId(param.name);
        input.type = param.type === "number" ? "number" : "text";
        // The provider's own description doubles as the hint — which
        // process name, what range — so the field isn't a blank guess.
        if (param.description) input.placeholder = param.description;
        if (param.format) {
          // A path parameter gets a picker beside the text field. The text
          // stays editable, so a path — say, a shortcut the picker would
          // resolve to its target — can also be pasted in directly.
          const pickerRow = document.createElement("div");
          pickerRow.className = "action-picker-row";
          pickerRow.appendChild(input);
          const browse = document.createElement("button");
          browse.type = "button";
          browse.className = "btn btn-secondary";
          browse.textContent = "Browse…";
          const format = param.format;
          browse.addEventListener("click", async (event) => {
            event.preventDefault();
            const picked = await window.nimbus.pickPath(format);
            if (picked) input.value = picked;
          });
          pickerRow.appendChild(browse);
          row.appendChild(pickerRow);
        } else {
          row.appendChild(input);
        }
      }

      actionParamFieldsEl.appendChild(row);
      paramRowsByName.set(param.name, row);
    }

    if (actionDef.id === "timer.start") {
      updateTimerModeVisibility("single"); // matches the mode select's own default first option
    }
  }

  function collectActionParams(actionDef: ActionDefinition): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const param of actionDef.parameters) {
      const el = document.getElementById(paramFieldId(param.name)) as
        HTMLInputElement | HTMLSelectElement | null;
      if (!el || !el.value) continue;
      params[param.name] = param.type === "number" ? Number(el.value) : el.value;
    }
    return params;
  }

  function countLabel(count: number): string {
    return count === 0 ? "none" : `${count} action${count === 1 ? "" : "s"}`;
  }

  /**
   * The wind-down list. Deliberately simpler than the start list: add and
   * remove, no in-place edit or reordering. Undoing what a routine
   * started is usually one or two steps, and "remove and add again" is a
   * smaller thing to learn than a second editing mode.
   */
  const STOP_TRIGGER_TYPES = [
    "activityEnded",
    "timerCompleted",
    "applicationOpened",
    "websiteOpened",
    "folderOpened",
  ];

  function syncStopTriggerFields(): void {
    for (const type of STOP_TRIGGER_TYPES) {
      const el = document.getElementById(`routineStopTriggerFields-${type}`) as HTMLElement | null;
      if (el) el.hidden = type !== stopTriggerTypeSelect.value;
    }
  }

  /**
   * The end half's trigger. Mirrors buildTriggerFromForm for the start
   * half, over its own fields — the two halves are the same kind of rule,
   * so they are configured the same way.
   */
  function buildStopTriggerFromForm(): TriggerConfig | null {
    const value = (id: string): string =>
      (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();

    switch (stopTriggerTypeSelect.value) {
      case "activityEnded":
        // An empty activity means "any activity ending" — a real choice,
        // so this never fails for want of a value.
        return { type: "activityEnded", activity: stopActivitySelect.value.trim() };
      case "timerCompleted":
        return { type: "timerCompleted", timerType: value("routineStopTimerType") };
      case "applicationOpened": {
        const application = value("routineStopAppName");
        return application ? { type: "applicationOpened", application, matchMode: "contains" } : null;
      }
      case "websiteOpened": {
        const pattern = value("routineStopWebsitePattern");
        return pattern
          ? { type: "websiteOpened", matchField: "windowTitle", pattern, matchMode: "contains" }
          : null;
      }
      case "folderOpened": {
        const path = value("routineStopFolderPath");
        return path ? { type: "folderOpened", path, matchMode: "contains" } : null;
      }
      default:
        return null;
    }
  }

  function loadStopTrigger(trigger: TriggerConfig | undefined): void {
    const set = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = v;
    };
    set("routineStopTimerType", "");
    set("routineStopAppName", "");
    set("routineStopWebsitePattern", "");
    set("routineStopFolderPath", "");

    // No saved end trigger means the default: this routine's own activity
    // ending. Shown as such rather than left blank.
    stopTriggerTypeSelect.value = trigger?.type ?? "activityEnded";
    if (trigger?.type === "activityEnded") {
      fillActivityOptions(stopActivitySelect, trigger.activity, "Any activity");
    } else {
      fillActivityOptions(stopActivitySelect, "", "Any activity");
    }
    if (trigger?.type === "timerCompleted") set("routineStopTimerType", trigger.timerType);
    if (trigger?.type === "applicationOpened") set("routineStopAppName", trigger.application);
    if (trigger?.type === "websiteOpened") set("routineStopWebsitePattern", trigger.pattern);
    if (trigger?.type === "folderOpened") set("routineStopFolderPath", trigger.path);
    syncStopTriggerFields();
    syncStopSectionAvailability();
  }

  function renderStopActions(): void {
    stopActionListEl.innerHTML = "";

    pendingStopActions.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "action-row";

      const info = document.createElement("span");
      info.className = "action-row-label";
      const badge = document.createElement("span");
      badge.className = "tag tag-accent action-row-index";
      badge.textContent = String(index + 1);
      info.appendChild(badge);
      const def = availableActions.find((a) => a.id === step.actionId);
      const name = document.createElement("span");
      name.textContent = def?.name ?? step.actionId;
      info.appendChild(name);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "action-row-actions";
      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        pendingStopActions = pendingStopActions.filter((_, i) => i !== index);
        renderStopActions();
      });
      actions.appendChild(remove);
      row.appendChild(actions);

      stopActionListEl.appendChild(row);
    });

    stopCountEl.textContent = countLabel(pendingStopActions.length);
    syncStopSectionAvailability();
  }

  /**
   * The end half always has a trigger of its own — every type in the list
   * is complete without help, and "activity ended" with nothing chosen
   * means any activity ending, not this routine's. So there is nothing
   * left to gate on: the section is always available.
   */
  function syncStopSectionAvailability(): void {
    addStopActionBtn.disabled = false;
    // An end trigger with nothing to run is saved but inert. Saying so
    // beats letting someone set one and wonder why nothing happens.
    const triggerWithoutActions = stopTriggerToSave() !== undefined && pendingStopActions.length === 0;
    stopHintEl.textContent = triggerWithoutActions
      ? "This end trigger is saved, but nothing runs on it yet — add an action below."
      : "Only runs if this routine actually started — winding down something that was never wound up would, at best, do nothing.";
    // A section with something in it stays open, so it isn't forgotten.
    if (pendingStopActions.length > 0) stopSectionEl.open = true;
  }

  function renderPendingActions(): void {
    actionListEl.innerHTML = "";
    startCountEl.textContent = countLabel(pendingActions.length);
    pendingActions.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "action-row";

      // The step number is a tag rather than a "1." prefix on the label,
      // so the order of a multi-step routine reads at a glance.
      const info = document.createElement("span");
      info.className = "action-row-label";
      const badge = document.createElement("span");
      badge.className = "tag tag-accent action-row-index";
      badge.textContent = String(index + 1);
      info.appendChild(badge);
      const def = availableActions.find((a) => a.id === step.actionId);
      const name = document.createElement("span");
      name.textContent = def?.name ?? step.actionId;
      info.appendChild(name);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "action-row-actions";

      if (index > 0) {
        const up = document.createElement("button");
        up.className = "btn btn-ghost";
        up.textContent = "↑";
        up.addEventListener("click", () => {
          stopEditingAction(); // reordering while the picker has one of these steps loaded would edit the wrong one after the swap
          [pendingActions[index - 1], pendingActions[index]] = [
            pendingActions[index],
            pendingActions[index - 1],
          ];
          renderPendingActions();
        });
        actions.appendChild(up);
      }
      if (index < pendingActions.length - 1) {
        const down = document.createElement("button");
        down.className = "btn btn-ghost";
        down.textContent = "↓";
        down.addEventListener("click", () => {
          stopEditingAction();
          [pendingActions[index + 1], pendingActions[index]] = [
            pendingActions[index],
            pendingActions[index + 1],
          ];
          renderPendingActions();
        });
        actions.appendChild(down);
      }

      const edit = document.createElement("button");
      edit.className = "btn btn-ghost";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditingAction(index));
      actions.appendChild(edit);

      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (editingActionIndex === index) stopEditingAction(); // the step being edited is the one being removed
        pendingActions = pendingActions.filter((_, i) => i !== index);
        renderPendingActions();
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      actionListEl.appendChild(row);
    });
  }

  /**
   * Loads one already-added action step back into the picker row so it
   * can be changed in place — without this, changing a single param
   * meant Remove-then-re-Add-from-scratch, retyping everything. Reuses
   * the exact same service/action selects and param fields "Add action"
   * already builds; only what happens on click (replace vs. append)
   * differs, mirroring how the routine-level form doubles as create/edit.
   */
  const actionBuilderEl = document.getElementById("routineActionBuilder") as HTMLElement;
  const confirmActionBtn = document.getElementById("routineConfirmActionBtn") as HTMLButtonElement;

  /** Which list the builder is currently adding to, or null when it is closed. */
  let builderTarget: "start" | "stop" | null = null;

  /**
   * Opens the action builder inside a section.
   *
   * The builder is one element that MOVES rather than two copies: it
   * always reads as part of the section being edited, and there is only
   * ever one set of parameter fields to keep straight.
   */
  function openActionBuilder(target: "start" | "stop"): void {
    builderTarget = target;
    const button = target === "start" ? addActionBtn : addStopActionBtn;
    button.parentElement?.insertBefore(actionBuilderEl, button);
    actionBuilderEl.hidden = false;

    populateActionServiceSelect();
    populateActionSelectForService(actionServiceSelect.value);
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
    confirmActionBtn.textContent = editingActionIndex !== null ? "Update" : "Add";
    actionBuilderEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeActionBuilder(): void {
    builderTarget = null;
    editingActionIndex = null;
    actionBuilderEl.hidden = true;
  }

  function startEditingAction(index: number): void {
    const step = pendingActions[index];
    const def = availableActions.find((a) => a.id === step.actionId);
    if (!def) return;

    editingActionIndex = index;
    builderTarget = "start";
    actionServiceSelect.value = def.affectsService;
    populateActionSelectForService(def.affectsService);
    actionSelect.value = def.id;
    renderActionParamFields(def);
    for (const param of def.parameters) {
      const value = step.params[param.name];
      if (value === undefined) continue;
      const el = document.getElementById(paramFieldId(param.name)) as
        HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = String(value);
    }

    openActionBuilder("start");
    confirmActionBtn.textContent = "Update";
  }

  function stopEditingAction(): void {
    closeActionBuilder();
  }

  function resetForm(): void {
    stopEditingAction();
    editingRoutineId = null;
    editedRoutineTrigger = null;
    clearFormError();
    formHeadingEl.textContent = "New routine";
    saveBtn.textContent = "Save routine";
    cancelEditBtn.hidden = true;

    nameInput.value = "";
    triggerTypeSelect.value = "applicationOpened";
    (document.getElementById("routineAppName") as HTMLInputElement).value = "";
    (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = "";
    (document.getElementById("routineFolderPath") as HTMLInputElement).value = "";
    fillActivityOptions(activityEndedSelect, "", "Any activity");
    (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value = "0";
    syncTriggerFieldsVisibility();
    suggestionTitleInput.value = "";
    suggestionMessageInput.value = "";
    cooldownInput.value = "30";
    skipIfActiveCheckbox.checked = false;
    autoRunCheckbox.checked = false;
    routineEnabledCheckbox.checked = true; // a routine you just created is meant to run
    oncePerSessionCheckbox.checked = false;
    descriptionInput.value = "";
    conditionLogicSelect.value = "all";
    pendingConditions = [];
    renderPendingConditions();
    pendingActions = [];
    renderPendingActions();
    pendingStopActions = [];
    pendingStopConditions = [];
    stopAutoRunCheckbox.checked = true;
    stopConditionLogicSelect.value = "all";
    stopSectionEl.open = false;
    loadStopTrigger(undefined);
    renderStopConditions();
    renderStopActions();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  }

  /**
   * Loads an existing routine's fields into the same create form above,
   * so Edit reuses one form/save-path instead of a second editor (see
   * this function's doc comment / task's own "reuse the create UI"
   * requirement). Only application/website/folder triggers have form
   * fields today — a routine with any other trigger type still opens
   * for editing, just with the trigger section left on its default.
   */
  function populateFormForEdit(routine: Routine): void {
    // Awaited nowhere: the pickers below are filled from whatever is
    // known now, and refilled when the fetch lands.
    void refreshKnownActivities().then(() => {
      if (editingRoutineId !== routine.id) return; // the user moved on
      fillActivityOptions(
        activityEndedSelect,
        routine.trigger.type === "activityEnded" ? routine.trigger.activity : "",
        "Any activity"
      );
      // The end half has its own picker over the same list, and its
      // selection was made before the list arrived.
      fillActivityOptions(stopActivitySelect, stopActivitySelect.value, "Any activity");
      renderStopConditions();
      renderPendingConditions();
    });
    showEditView();
    stopEditingAction();
    clearFormError();
    editingRoutineId = routine.id;
    editedRoutineTrigger = routine.trigger;
    formHeadingEl.textContent = `Editing "${routine.name}"`;
    saveBtn.textContent = "Update routine";
    cancelEditBtn.hidden = false;

    nameInput.value = routine.name;
    suggestionTitleInput.value = routine.suggestion.title;
    suggestionMessageInput.value = routine.suggestion.message;
    cooldownInput.value = String(routine.cooldownMinutes);
    skipIfActiveCheckbox.checked = routine.conditions.some((c) => c.type === "actionsNotAlreadyActive");
    autoRunCheckbox.checked = routine.autoRun ?? false;
    routineEnabledCheckbox.checked = routine.enabled;
    oncePerSessionCheckbox.checked = (routine.sessionRestriction ?? "none") === "oncePerSession";
    descriptionInput.value = routine.description ?? "";
    conditionLogicSelect.value = routine.conditionLogic ?? "all";
    // Everything except the "Skip if already active" switch, which owns
    // that one condition — see buildConditionsFromForm. Deep-copied so
    // editing the form never mutates the stored routine before save.
    pendingConditions = routine.conditions
      .filter((c) => c.type !== "actionsNotAlreadyActive")
      .map((c) => structuredClone(c));
    renderPendingConditions();

    (document.getElementById("routineAppName") as HTMLInputElement).value = "";
    (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = "";
    (document.getElementById("routineFolderPath") as HTMLInputElement).value = "";
    if (routine.trigger.type === "applicationOpened") {
      triggerTypeSelect.value = "applicationOpened";
      (document.getElementById("routineAppName") as HTMLInputElement).value = routine.trigger.application;
    } else if (routine.trigger.type === "websiteOpened") {
      triggerTypeSelect.value = "websiteOpened";
      (document.getElementById("routineWebsitePattern") as HTMLInputElement).value = routine.trigger.pattern;
    } else if (routine.trigger.type === "folderOpened") {
      triggerTypeSelect.value = "folderOpened";
      (document.getElementById("routineFolderPath") as HTMLInputElement).value = routine.trigger.path;
    } else if (routine.trigger.type === "activityEnded") {
      triggerTypeSelect.value = "activityEnded";
      fillActivityOptions(activityEndedSelect, routine.trigger.activity, "Any activity");
      (document.getElementById("routineActivityEndedMinutes") as HTMLInputElement).value = String(
        routine.trigger.minMinutes ?? 0
      );
    }
    syncTriggerFieldsVisibility();

    pendingActions = routine.actions.map((step) => ({ ...step, params: { ...step.params } }));
    renderPendingActions();
    pendingStopActions = (routine.stopActions ?? []).map((step) => ({
      ...step,
      params: { ...step.params },
    }));
    stopAutoRunCheckbox.checked = routine.stopAutoRun !== false;
    pendingStopConditions = (routine.stopConditions ?? []).map((c) => structuredClone(c));
    stopConditionLogicSelect.value = routine.stopConditionLogic ?? "all";
    loadStopTrigger(routine.stopTrigger);
    renderStopConditions();
    renderStopActions();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));

    document.getElementById("routineName")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /**
   * The conditions being edited, mirroring `pendingActions` above: the
   * form owns a working copy and only writes it back into a Routine on
   * save, so cancelling leaves the stored routine untouched.
   *
   * There are two of these now — one per half of the routine — so the
   * editor below is built once and pointed at whichever it is editing.
   *
   * `actionsNotAlreadyActive` is deliberately NOT in the start list — it
   * is the "Skip if already active" switch. Keeping one setting in two
   * places is worse than the small asymmetry of leaving it out, and a
   * routine that already has it keeps it through an edit either way (see
   * buildConditionsFromForm).
   */
  let pendingConditions: RoutineCondition[] = [];
  let pendingStopConditions: RoutineCondition[] = [];

  /**
   * Activity names already defined anywhere — refreshed whenever the
   * editor opens, so a picker never offers a stale list.
   *
   * Referencing an activity by choice rather than by retyping it is the
   * point: a typo in a free-text box produces a routine that silently
   * can never match, and nothing tells you why.
   */
  let knownActivities: string[] = [];

  const activityEndedSelect = document.getElementById("routineActivityEndedName") as HTMLSelectElement;

  async function refreshKnownActivities(): Promise<void> {
    try {
      knownActivities = await window.nimbus.getKnownActivities();
    } catch {
      knownActivities = [];
    }
  }

  /**
   * Fills a picker with the known activities, keeping `selected` even if
   * it is no longer one of them — a routine that references an activity
   * whose definition was removed must not silently lose the reference
   * just by being opened.
   */
  function fillActivityOptions(select: HTMLSelectElement, selected: string, anyLabel?: string): void {
    select.innerHTML = "";
    if (anyLabel !== undefined) {
      const any = document.createElement("option");
      any.value = "";
      any.textContent = anyLabel;
      select.appendChild(any);
    }

    const names = [...knownActivities];

    if (selected && !names.some((n) => n.toLowerCase() === selected.toLowerCase())) {
      names.push(selected);
    }
    // With an "any" option there is already something selectable, so a
    // second placeholder would just be a dead entry in the list.
    if (names.length === 0 && anyLabel === undefined) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "No activities yet — name one above";
      select.appendChild(none);
    }

    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.value = selected;
  }

  /** The wind-down half, kept separate so each section owns its own list. */
  let pendingStopActions: RoutineActionStep[] = [];

  const stopActionListEl = document.getElementById("routineStopActionList") as HTMLElement;
  const addStopActionBtn = document.getElementById("routineAddStopActionBtn") as HTMLButtonElement;
  const stopAutoRunCheckbox = document.getElementById("routineStopAutoRun") as HTMLInputElement;
  const startCountEl = document.getElementById("routineStartCount") as HTMLElement;
  const stopCountEl = document.getElementById("routineStopCount") as HTMLElement;
  const stopSectionEl = document.getElementById("routineStopSection") as HTMLDetailsElement;
  const stopHintEl = document.getElementById("routineStopHint") as HTMLElement;

  const conditionListEl = document.getElementById("routineConditionList") as HTMLElement;
  const stopConditionListEl = document.getElementById("routineStopConditionList") as HTMLElement;
  const stopConditionEmptyEl = document.getElementById("routineStopConditionEmpty") as HTMLElement;
  const stopConditionLogicSelect = document.getElementById("routineStopConditionLogic") as HTMLSelectElement;
  const stopConditionFieldSelect = document.getElementById(
    "routineStopConditionFieldSelect"
  ) as HTMLSelectElement;
  const stopConditionOperatorSelect = document.getElementById(
    "routineStopConditionOperatorSelect"
  ) as HTMLSelectElement;
  const addStopConditionBtn = document.getElementById("routineAddStopConditionBtn") as HTMLButtonElement;
  const stopTriggerTypeSelect = document.getElementById("routineStopTriggerType") as HTMLSelectElement;
  const stopActivitySelect = document.getElementById("routineStopActivityName") as HTMLSelectElement;
  const conditionEmptyEl = document.getElementById("routineConditionEmpty") as HTMLElement;
  const conditionLogicSelect = document.getElementById("routineConditionLogic") as HTMLSelectElement;
  const conditionFieldSelect = document.getElementById("routineConditionFieldSelect") as HTMLSelectElement;
  const conditionOperatorSelect = document.getElementById(
    "routineConditionOperatorSelect"
  ) as HTMLSelectElement;
  const addConditionBtn = document.getElementById("routineAddConditionBtn") as HTMLButtonElement;
  const descriptionInput = document.getElementById("routineDescription") as HTMLInputElement;
  const oncePerSessionCheckbox = document.getElementById("routineOncePerSession") as HTMLInputElement;
  const routineEnabledCheckbox = document.getElementById("routineEnabled") as HTMLInputElement;

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /** Minutes-since-midnight <-> the "HH:MM" an <input type="time"> speaks. */
  function toTimeValue(hour: number, minute: number | undefined): string {
    return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
  }

  /**
   * Fills a condition picker: the fields NIMBUS can check, and the
   * operators that follow whichever field is chosen. Both come from the
   * catalog, so a new condition appears here without touching this code.
   */
  function fillConditionPickers(fieldSelect: HTMLSelectElement, operatorSelect: HTMLSelectElement): void {
    fieldSelect.innerHTML = "";
    for (const field of CONDITION_FIELDS) {
      const option = document.createElement("option");
      option.value = field.id;
      option.textContent = field.label;
      if (field.note) option.title = field.note;
      fieldSelect.appendChild(option);
    }

    const syncOperators = (): void => {
      operatorSelect.innerHTML = "";
      for (const operator of operatorsFor(fieldSelect.value)) {
        const option = document.createElement("option");
        option.value = operator.id;
        option.textContent = operator.label;
        operatorSelect.appendChild(option);
      }
    };
    fieldSelect.addEventListener("change", syncOperators);
    syncOperators();
  }

  /** Adds the chosen field/operator as a new row, with its default value. */
  function addCondition(
    fieldSelect: HTMLSelectElement,
    operatorSelect: HTMLSelectElement,
    into: RoutineCondition[],
    redraw: () => void
  ): void {
    const condition = buildCondition(fieldSelect.value, operatorSelect.value);
    if (condition) into.push(condition as RoutineCondition);
    redraw();
  }

  // Loaded once, and only when a condition actually needs them.
  let playlistOptionsPromise: Promise<Array<{ id: string; name: string }>> | null = null;
  function conditionPlaylists(): Promise<Array<{ id: string; name: string }>> {
    playlistOptionsPromise ??= window.nimbus
      .listSpotifyPlaylists()
      .then((playlists) => playlists.map((playlist) => ({ id: playlist.uri, name: playlist.name })))
      .catch(() => []);
    return playlistOptionsPromise;
  }

  let deviceOptionsPromise: Promise<Array<{ id: string; name: string }>> | null = null;
  function conditionDevices(): Promise<Array<{ id: string; name: string }>> {
    deviceOptionsPromise ??= window.nimbus
      .getNetworkState()
      .then((state) => state.devices.map((device) => ({ id: device.id, name: device.displayName })))
      .catch(() => []);
    return deviceOptionsPromise;
  }

  function timeInput(value: string, onPicked: (hour: number, minute: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "time";
    input.className = "input";
    input.value = value;
    input.addEventListener("change", () => {
      const [hour, minute] = input.value.split(":").map(Number);
      if (Number.isFinite(hour) && Number.isFinite(minute)) onPicked(hour, minute);
    });
    return input;
  }

  /**
   * A picker over things NIMBUS already knows about - the Spotify
   * playlists, or the devices on the network. Whatever the routine names
   * stays selectable even if it is no longer in the list, so editing a
   * routine never silently repoints it at something else.
   */
  function knownThingPicker(
    chosen: { id: string; name: string },
    load: () => Promise<Array<{ id: string; name: string }>>,
    emptyLabel: string,
    onPicked: (value: { id: string; name: string }) => void
  ): HTMLSelectElement {
    const picker = document.createElement("select");
    picker.className = "input input-compact";
    const placeholder = document.createElement("option");
    placeholder.value = chosen.id;
    placeholder.textContent = chosen.name || chosen.id || "Loading…";
    picker.appendChild(placeholder);

    void load().then((items) => {
      picker.innerHTML = "";
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name;
        picker.appendChild(option);
      }
      if (chosen.id && !items.some((item) => item.id === chosen.id)) {
        const missing = document.createElement("option");
        missing.value = chosen.id;
        missing.textContent = `${chosen.name || chosen.id} (not found)`;
        picker.appendChild(missing);
      }
      if (items.length === 0 && !chosen.id) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = emptyLabel;
        picker.appendChild(none);
      }
      picker.value = chosen.id;
    });

    picker.addEventListener("change", () => {
      const label = picker.options[picker.selectedIndex]?.textContent ?? "";
      onPicked({ id: picker.value, name: label.replace(" (not found)", "") });
    });
    return picker;
  }

  /** The inputs one condition's value needs - nothing at all for "none". */
  function conditionValueControls(row: ConditionRow, apply: (value: ConditionValue) => void): HTMLElement[] {
    const separator = (text: string): HTMLElement => {
      const span = document.createElement("span");
      span.className = "condition-row-sep";
      span.textContent = text;
      return span;
    };

    switch (row.valueKind) {
      case "timeRange": {
        const range = {
          ...(row.value as { startHour: number; startMinute: number; endHour: number; endMinute: number }),
        };
        const from = timeInput(toTimeValue(range.startHour, range.startMinute), (hour, minute) => {
          range.startHour = hour;
          range.startMinute = minute;
          apply({ ...range });
        });
        const to = timeInput(toTimeValue(range.endHour, range.endMinute), (hour, minute) => {
          range.endHour = hour;
          range.endMinute = minute;
          apply({ ...range });
        });
        return [from, separator("to"), to];
      }
      case "time": {
        const at = row.value as { hour: number; minute: number };
        return [timeInput(toTimeValue(at.hour, at.minute), (hour, minute) => apply({ hour, minute }))];
      }
      case "days": {
        const days = [...((row.value as number[]) ?? [])];
        return Array.from({ length: 7 }, (_unused, day) => {
          const chip = document.createElement("label");
          chip.className = "day-chip";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = days.includes(day);
          box.addEventListener("change", () => {
            const next = (box.checked ? [...days, day] : days.filter((d) => d !== day)).sort((a, b) => a - b);
            days.length = 0;
            days.push(...next);
            apply([...days]);
          });
          const text = document.createElement("span");
          text.textContent = DAY_LABELS[day];
          chip.append(box, text);
          return chip;
        });
      }
      case "activity": {
        const picker = document.createElement("select");
        picker.className = "input input-compact";
        fillActivityOptions(picker, String(row.value ?? ""));
        picker.addEventListener("change", () => apply(picker.value));
        return [picker];
      }
      case "minutes": {
        const minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "0";
        minutes.className = "input";
        minutes.value = String(row.value ?? 0);
        minutes.addEventListener("change", () => {
          const value = Number(minutes.value);
          if (Number.isFinite(value) && value >= 0) apply(value);
        });
        return [minutes, separator("minutes")];
      }
      case "playlist": {
        const chosen = (row.value ?? { id: "", name: "" }) as { id: string; name: string };
        return [knownThingPicker(chosen, conditionPlaylists, "No playlists available", apply)];
      }
      case "device": {
        const chosen = (row.value ?? { id: "", name: "" }) as { id: string; name: string };
        return [knownThingPicker(chosen, conditionDevices, "No devices seen yet", apply)];
      }
      default:
        return [];
    }
  }

  function renderPendingConditions(): void {
    renderConditionsInto(conditionListEl, conditionEmptyEl, pendingConditions, (next) => {
      pendingConditions = next;
      renderPendingConditions();
    });
  }

  function renderStopConditions(): void {
    renderConditionsInto(stopConditionListEl, stopConditionEmptyEl, pendingStopConditions, (next) => {
      pendingStopConditions = next;
      renderStopConditions();
    });
  }

  /**
   * Draws one list of conditions. Both halves of a routine use this —
   * the rows are identical, only the array they edit differs.
   */
  function renderConditionsInto(
    listEl: HTMLElement,
    emptyEl: HTMLElement,
    conditions: RoutineCondition[],
    onChange: (next: RoutineCondition[]) => void
  ): void {
    listEl.innerHTML = "";
    emptyEl.hidden = conditions.length > 0;

    conditions.forEach((condition, index) => {
      const rowEl = document.createElement("div");
      rowEl.className = "condition-row";

      const label = document.createElement("span");
      label.className = "condition-row-label";
      rowEl.appendChild(label);

      const controls = document.createElement("div");
      controls.className = "condition-row-controls";
      rowEl.appendChild(controls);

      const row = readCondition(condition);
      if (!row) {
        // Something this NIMBUS doesn't know - shown, never silently
        // dropped, so an older or newer routine survives an edit.
        label.textContent = `Unrecognized condition (${String(condition.type)})`;
      } else {
        label.textContent = `${row.fieldLabel} ${row.operatorLabel}`;
        // Written back in place rather than by redrawing: re-rendering on
        // every keystroke would take the focus out of the input.
        const apply = (value: ConditionValue): void => {
          const rebuilt = buildCondition(row.fieldId, row.operatorId, value);
          if (!rebuilt) return;
          for (const key of Object.keys(condition)) delete condition[key];
          Object.assign(condition, rebuilt);
        };
        controls.append(...conditionValueControls(row, apply));
      }

      const remove = document.createElement("button");
      remove.className = "btn btn-ghost action-row-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        onChange(conditions.filter((_, i) => i !== index));
      });
      controls.appendChild(remove);

      listEl.appendChild(rowEl);
    });
  }

  fillConditionPickers(conditionFieldSelect, conditionOperatorSelect);
  fillConditionPickers(stopConditionFieldSelect, stopConditionOperatorSelect);
  addConditionBtn.addEventListener("click", () =>
    addCondition(conditionFieldSelect, conditionOperatorSelect, pendingConditions, renderPendingConditions)
  );
  stopTriggerTypeSelect.addEventListener("change", () => {
    syncStopTriggerFields();
    syncStopSectionAvailability();
  });
  stopActivitySelect.addEventListener("change", () => syncStopSectionAvailability());
  // The hint above depends on the trigger, so every path that changes it
  // has to refresh -- including loading a routine into the form.

  addStopConditionBtn.addEventListener("click", () =>
    addCondition(
      stopConditionFieldSelect,
      stopConditionOperatorSelect,
      pendingStopConditions,
      renderStopConditions
    )
  );

  /**
   * The end trigger to persist, or undefined when there is nothing worth
   * keeping.
   *
   * Not gated on there being end actions. A trigger without actions does
   * nothing at runtime, but forgetting what the user picked because they
   * hadn't finished the other half yet loses their work silently -- which
   * is exactly how this was found. The default ("any activity ended",
   * chosen by nobody) is still dropped, so an untouched form doesn't
   * write a trigger onto every routine.
   */
  function stopTriggerToSave(): TriggerConfig | undefined {
    const trigger = buildStopTriggerFromForm();
    if (!trigger) return undefined;
    if (pendingStopActions.length > 0) return trigger;
    const untouched = trigger.type === "activityEnded" && trigger.activity.trim().length === 0;
    return untouched ? undefined : trigger;
  }

  /**
   * The conditions to save: the edited list, plus the "Skip if already
   * active" switch expressed as the condition it has always been.
   */
  function buildConditionsFromForm(): RoutineCondition[] {
    return withSkipIfActiveCondition(pendingConditions, skipIfActiveCheckbox.checked);
  }

  /**
   * Renders a routine evaluation as the tick/cross list the engine
   * produced. The labels come from the engine itself rather than being
   * re-derived here, so what the user reads is what actually decided.
   */
  function renderRoutineExplanation(target: HTMLElement, evaluation: RoutineEvaluation | null): void {
    target.innerHTML = "";
    if (!evaluation) {
      target.textContent = "That routine no longer exists.";
      return;
    }

    const verdict = document.createElement("div");
    verdict.className = evaluation.matched
      ? "routine-explain-verdict matched"
      : "routine-explain-verdict blocked";
    verdict.textContent = evaluation.matched ? "Would match" : "Would not match";
    target.appendChild(verdict);

    for (const check of evaluation.checks) {
      const line = document.createElement("div");
      line.className = check.passed ? "routine-explain-check pass" : "routine-explain-check fail";
      line.textContent = `${check.passed ? "\u2713" : "\u2717"} ${check.label}`;
      target.appendChild(line);
    }

    const note = document.createElement("div");
    note.className = "routine-explain-note";
    note.textContent = "Evaluated against the current state. Nothing was run.";
    target.appendChild(note);
  }

  /**
   * When each routine last fired, refreshed alongside the list. Held
   * here rather than fetched per card so rendering stays synchronous.
   */
  let lastTriggeredAt: Record<string, number> = {};

  /**
   * One line describing what a routine does and what limits it. Built
   * from the routine's own configuration — every part is omitted when
   * not configured, so a simple routine still reads simply.
   */
  function summarizeRoutine(routine: Routine): string {
    const parts = [triggerSummary(routine.trigger)];

    const conditions = routine.conditions ?? [];
    if (conditions.length > 0) {
      const joiner = (routine.conditionLogic ?? "all") === "any" ? "any of" : "all of";
      parts.push(`${joiner} ${conditions.length} condition${conditions.length === 1 ? "" : "s"}`);
    }

    parts.push(`${routine.actions.length} action${routine.actions.length === 1 ? "" : "s"}`);

    if (routine.stopActions?.length) {
      parts.push(`${routine.stopActions.length} on end`);
    }
    if (routine.cooldownMinutes > 0) parts.push(`${routine.cooldownMinutes} min cooldown`);
    if ((routine.sessionRestriction ?? "none") === "oncePerSession") parts.push("once per session");
    if (routine.autoRun) parts.push("runs automatically");

    return parts.join(" · ");
  }

  /** Coarse on purpose — the exact second a routine fired is noise in a list. */
  function formatRelativeTime(epochMs: number): string {
    const minutes = Math.floor((Date.now() - epochMs) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  const formErrorEl = document.getElementById("routineFormError") as HTMLElement;

  /**
   * Reports what a save is missing, inline.
   *
   * Deliberately not `alert()`. A native dialog blocks the renderer, and
   * in Electron on Windows it routinely leaves the window without
   * keyboard focus once dismissed — which left the form impossible to
   * type into after a failed save, exactly when the user needs to fix
   * it. Inline text cannot steal focus, and it stays on screen while
   * they do.
   */
  function showFormError(message: string, invalid: HTMLElement[] = []): void {
    clearFormError();
    formErrorEl.textContent = message;
    formErrorEl.hidden = false;

    for (const el of invalid) el.classList.add("field-invalid");
    // Put the caret where the work is, rather than making them hunt for
    // the field the message is about.
    const first = invalid[0] as HTMLInputElement | undefined;
    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      first.focus();
    } else {
      formErrorEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function clearFormError(): void {
    formErrorEl.hidden = true;
    formErrorEl.textContent = "";
    for (const el of Array.from(document.querySelectorAll(".field-invalid"))) {
      el.classList.remove("field-invalid");
    }
  }

  /** The trigger's own value field, which differs per trigger type. */
  function triggerValueInput(): HTMLInputElement | null {
    switch (triggerTypeSelect.value) {
      case "applicationOpened":
        return document.getElementById("routineAppName") as HTMLInputElement;
      case "websiteOpened":
        return document.getElementById("routineWebsitePattern") as HTMLInputElement;
      case "folderOpened":
        return document.getElementById("routineFolderPath") as HTMLInputElement;
      default:
        // "Activity ended" needs no value: an empty name means any
        // activity, which is a real choice rather than a missing one.
        return null;
    }
  }

  /**
   * Routines and Activities are two views of the same tab rather than
   * two places in the app. Activities are personal definitions like
   * routines are — sitting them next to weather and calendar preferences
   * in Settings made them feel like configuration, which they aren't.
   */
  function initRoutinesTabSwitch(): void {
    const routinesBtn = document.getElementById("routinesTabRoutinesBtn") as HTMLButtonElement;
    const activitiesBtn = document.getElementById("routinesTabActivitiesBtn") as HTMLButtonElement;
    const routinesPane = document.getElementById("routinesPane") as HTMLElement;
    const activitiesPane = document.getElementById("activitiesPane") as HTMLElement;

    const show = (activities: boolean): void => {
      routinesPane.hidden = activities;
      activitiesPane.hidden = !activities;
      routinesBtn.classList.toggle("active", !activities);
      activitiesBtn.classList.toggle("active", activities);
    };

    routinesBtn.addEventListener("click", () => show(false));
    activitiesBtn.addEventListener("click", () => show(true));
    show(false);
  }

  initRoutinesTabSwitch();

  function renderRoutineList(settings: RoutineSettings): void {
    // Refreshed in the background: a stale "last triggered" line is a
    // cosmetic lag, and awaiting it would make every list render async.
    void window.nimbus
      .getRoutineLastTriggered()
      .then((latest) => {
        const changed = JSON.stringify(latest) !== JSON.stringify(lastTriggeredAt);
        lastTriggeredAt = latest;
        if (changed) renderRoutineList(settings);
      })
      .catch(() => undefined);

    // Surfaces the "your routine exists but can't fire" trap directly in
    // the UI instead of leaving it silently confusing — see the
    // save-routine handler below for the other half of this fix.
    disabledWarningEl.hidden = settings.enabled || settings.routines.length === 0;
    routineListEmptyEl.hidden = settings.routines.length > 0;

    routineListEl.innerHTML = "";
    for (const routine of settings.routines) {
      const card = document.createElement("div");
      card.className = "routine-card";

      // The card's own name/summary area opens it for editing — the
      // same "click the thing to open it" pattern as any list of
      // editable items, so a click anywhere except an explicit control
      // (toggle/Test/Delete) below opens the editor, matching "open a
      // single one and edit/customize" without needing a separate "Edit"
      // button to hunt for.
      const body = document.createElement("button");
      body.type = "button";
      body.className = "routine-card-body";
      body.addEventListener("click", () => populateFormForEdit(routine));

      const nameEl = document.createElement("span");
      nameEl.className = "routine-card-name";
      nameEl.textContent = routine.name;
      body.appendChild(nameEl);

      const metaEl = document.createElement("span");
      metaEl.className = "routine-card-meta";
      metaEl.textContent = summarizeRoutine(routine);
      body.appendChild(metaEl);

      // "Last triggered" comes from the engine's own cooldown clock, so
      // it reflects when the routine actually fired — not when it was
      // edited or when a suggestion happened to be accepted.
      const lastAt = lastTriggeredAt[routine.id];
      if (lastAt) {
        const lastEl = document.createElement("span");
        lastEl.className = "routine-card-meta";
        lastEl.textContent = `Last triggered ${formatRelativeTime(lastAt)}`;
        body.appendChild(lastEl);
      }

      if (routine.description) {
        const descEl = document.createElement("span");
        descEl.className = "routine-card-meta";
        descEl.textContent = routine.description;
        body.appendChild(descEl);
      }

      // The design splits the card: everything you read and every control
      // that changes the routine on the left, and one big affordance for
      // "run it now" on the right. The run button is the only thing that
      // acts on the world, so it is the only thing set apart.
      const main = document.createElement("div");
      main.className = "routine-card-main";
      const left = document.createElement("div");
      left.className = "routine-card-left";
      left.appendChild(body);
      main.appendChild(left);

      const actions = document.createElement("div");
      actions.className = "routine-card-actions";

      const toggleLabel = document.createElement("label");
      toggleLabel.className = "routine-active-toggle";
      toggleLabel.title = "Disable to stop this routine from triggering, without deleting it";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = routine.enabled;
      toggle.addEventListener("change", async () => {
        const updated = settings.routines.map((r) =>
          r.id === routine.id ? { ...r, enabled: toggle.checked } : r
        );
        const saved = await window.nimbus.updateRoutineSettings({ routines: updated });
        renderRoutineList(saved);
      });
      toggleLabel.appendChild(buildSwitch(toggle));
      const toggleText = document.createElement("span");
      toggleText.textContent = "Active";
      toggleLabel.appendChild(toggleText);
      actions.appendChild(toggleLabel);

      // Runs the routine's actions immediately — bypasses trigger match,
      // cooldown, and conditions entirely. Distinct from the Test button
      // beside it, which only evaluates and explains: asking whether a
      // routine matches must never start playing music or open anything.
      const runBtn = document.createElement("button");
      runBtn.className = "routine-run-btn";
      runBtn.title = "Run now";
      runBtn.innerHTML = ROUTINE_RUN_ICON_SVG;
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        runBtn.innerHTML = ROUTINE_RUNNING_ICON_SVG;
        try {
          const results = await window.nimbus.runRoutineNow(routine.id);
          const failed = results.filter((r) => r.status === "failure");
          runBtn.title =
            failed.length === 0
              ? "Ran successfully"
              : `${failed.length} action${failed.length === 1 ? "" : "s"} failed`;
          runBtn.innerHTML =
            failed.length === 0 ? ROUTINE_RUN_SUCCESS_ICON_SVG : ROUTINE_RUN_FAILURE_ICON_SVG;
          window.dispatchEvent(new Event(NOW_PLAYING_REFRESH_EVENT));
        } catch {
          runBtn.title = "Failed to run";
          runBtn.innerHTML = ROUTINE_RUN_FAILURE_ICON_SVG;
        } finally {
          setTimeout(() => {
            runBtn.title = "Run now";
            runBtn.innerHTML = ROUTINE_RUN_ICON_SVG;
            runBtn.disabled = false;
          }, 2000);
        }
      });
      // Evaluates the routine against the current state and shows every
      // check behind the verdict. Runs nothing — see the run button
      // above for the deliberate counterpart.
      const explainEl = document.createElement("div");
      explainEl.className = "routine-explain";
      explainEl.hidden = true;

      const testBtn = document.createElement("button");
      testBtn.className = "btn btn-ghost";
      testBtn.textContent = "Test";
      testBtn.title = "Check whether this routine would match right now — runs nothing";
      testBtn.addEventListener("click", async () => {
        if (!explainEl.hidden) {
          explainEl.hidden = true;
          return;
        }
        testBtn.disabled = true;
        try {
          const evaluation = await window.nimbus.testRoutine(routine.id);
          renderRoutineExplanation(explainEl, evaluation);
        } catch (err) {
          explainEl.textContent = `Could not evaluate this routine: ${String(err)}`;
        } finally {
          explainEl.hidden = false;
          testBtn.disabled = false;
        }
      });
      actions.appendChild(testBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-ghost routine-delete-btn";
      removeBtn.textContent = "Delete";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.routines.filter((r) => r.id !== routine.id);
        const saved = await window.nimbus.updateRoutineSettings({ routines: updated });
        if (editingRoutineId === routine.id) resetForm(); // the routine being edited no longer exists — don't leave a stale edit form open
        renderRoutineList(saved);
      });
      actions.appendChild(removeBtn);

      left.appendChild(actions);
      main.appendChild(runBtn);
      card.appendChild(main);
      // Full width under the split, since an explanation is a paragraph
      // rather than something that belongs in either column.
      card.appendChild(explainEl);
      routineListEl.appendChild(card);
    }
  }

  try {
    const [settings, actions, lastTriggered] = await Promise.all([
      window.nimbus.getRoutineSettings(),
      window.nimbus.listActions(),
      window.nimbus.getRoutineLastTriggered(),
    ]);
    lastTriggeredAt = lastTriggered;
    availableActions = actions;
    populateActionServiceSelect();
    populateActionSelectForService(actionServiceSelect.value);

    enabledCheckbox.checked = settings.enabled;
    renderRoutineList(settings);
    syncTriggerFieldsVisibility();
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  } catch (err) {
    console.error("Failed to load routine settings/actions", err);
  }

  window.nimbus
    .listSpotifyPlaylists()
    .then((playlists) => {
      availablePlaylists = playlists;
    })
    .catch(() => {}); // playlist picker is a nice-to-have; a manual query still works without it

  enabledCheckbox.addEventListener("change", async () => {
    const saved = await window.nimbus.updateRoutineSettings({ enabled: enabledCheckbox.checked });
    disabledWarningEl.hidden = saved.enabled || saved.routines.length === 0;
  });

  triggerTypeSelect.addEventListener("change", syncTriggerFieldsVisibility);

  actionServiceSelect.addEventListener("change", () => {
    populateActionSelectForService(actionServiceSelect.value);
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  });

  actionSelect.addEventListener("change", () => {
    renderActionParamFields(availableActions.find((a) => a.id === actionSelect.value));
  });

  addStopActionBtn.addEventListener("click", () => openActionBuilder("stop"));

  addActionBtn.addEventListener("click", () => openActionBuilder("start"));

  /**
   * Commits whatever the builder is showing into the list it was opened
   * for. Required parameters are checked here, once, for both lists.
   */
  confirmActionBtn.addEventListener("click", () => {
    const def = availableActions.find((a) => a.id === actionSelect.value);
    if (!def || !builderTarget) return;

    const params = collectActionParams(def);
    const missing = def.parameters.filter((prm) => prm.required && params[prm.name] === undefined);
    if (missing.length > 0) {
      const fields = missing
        .map((prm) => document.getElementById(paramFieldId(prm.name)))
        .filter((el): el is HTMLElement => el !== null);
      showFormError(`This action still needs: ${missing.map((prm) => prm.name).join(", ")}.`, fields);
      return;
    }
    clearFormError();

    if (builderTarget === "stop") {
      pendingStopActions.push({ actionId: def.id, params });
      renderStopActions();
    } else if (editingActionIndex !== null) {
      pendingActions[editingActionIndex] = { actionId: def.id, params };
      renderPendingActions();
    } else {
      pendingActions.push({ actionId: def.id, params });
      renderPendingActions();
    }
    closeActionBuilder();
  });

  cancelActionEditBtn.addEventListener("click", () => stopEditingAction());

  // Fixing a field should visibly un-break it, not leave a red border
  // and a stale message sitting there until the next save attempt.
  for (const field of [nameInput, suggestionTitleInput, suggestionMessageInput]) {
    field.addEventListener("input", () => field.classList.remove("field-invalid"));
  }
  document.getElementById("routinesEditView")?.addEventListener("input", (event) => {
    (event.target as HTMLElement)?.classList?.remove("field-invalid");
  });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    // The routine being edited (if any) is looked up before building the
    // trigger so its saved match mode survives the edit — see
    // buildTriggerFromForm.
    const editingTrigger = editingRoutineId ? (editedRoutineTrigger ?? undefined) : undefined;
    const trigger = buildTriggerFromForm(editingTrigger);
    const title = suggestionTitleInput.value.trim();
    const message = suggestionMessageInput.value.trim();
    const cooldownMinutes = Number(cooldownInput.value) || 0;

    // Each missing thing is named, and its field highlighted, so fixing
    // it doesn't mean re-reading the whole form to work out which one.
    const missing: string[] = [];
    const invalid: HTMLElement[] = [];
    if (!name) {
      missing.push("a name");
      invalid.push(nameInput);
    }
    if (!trigger) {
      missing.push("something for the trigger to match");
      const field = triggerValueInput();
      if (field) invalid.push(field);
    }
    if (!title) {
      missing.push("a suggestion title");
      invalid.push(suggestionTitleInput);
    }
    if (!message) {
      missing.push("a suggestion message");
      invalid.push(suggestionMessageInput);
    }
    if (pendingActions.length === 0) missing.push("at least one action");

    if (missing.length > 0) {
      showFormError(`This routine still needs ${missing.join(", ")}.`, invalid);
      return;
    }
    // Already covered by the check above; restated so the compiler can
    // see it too.
    if (!trigger) return;
    clearFormError();

    try {
      const current = await window.nimbus.getRoutineSettings();

      let updatedRoutines: Routine[];
      if (editingRoutineId) {
        const existing = current.routines.find((r) => r.id === editingRoutineId);
        if (!existing) {
          showFormError("This routine no longer exists — it may have been deleted.");
          resetForm();
          showListView();
          renderRoutineList(current);
          return;
        }
        // Spread `existing` first so any field this editor doesn't know
        // about survives a round-trip rather than being dropped.
        const updated: Routine = {
          ...existing,
          name,
          enabled: routineEnabledCheckbox.checked,
          trigger,
          suggestion: { ...existing.suggestion, title, message },
          actions: pendingActions,
          cooldownMinutes,
          conditions: buildConditionsFromForm(),
          stopActions: pendingStopActions.length > 0 ? pendingStopActions : undefined,
          stopTrigger: stopTriggerToSave(),
          stopConditions: pendingStopConditions.length > 0 ? pendingStopConditions : undefined,
          stopConditionLogic: stopConditionLogicSelect.value === "any" ? "any" : "all",
          stopAutoRun: stopAutoRunCheckbox.checked,
          conditionLogic: conditionLogicSelect.value === "any" ? "any" : "all",
          sessionRestriction: oncePerSessionCheckbox.checked ? "oncePerSession" : "none",
          description: descriptionInput.value.trim() || undefined,
          autoRun: autoRunCheckbox.checked,
        };
        updatedRoutines = current.routines.map((r) => (r.id === editingRoutineId ? updated : r));
      } else {
        const newRoutine: Routine = {
          id: `routine-${Date.now()}`,
          name,
          enabled: routineEnabledCheckbox.checked,
          trigger,
          conditions: buildConditionsFromForm(),
          stopActions: pendingStopActions.length > 0 ? pendingStopActions : undefined,
          stopTrigger: stopTriggerToSave(),
          stopConditions: pendingStopConditions.length > 0 ? pendingStopConditions : undefined,
          stopConditionLogic: stopConditionLogicSelect.value === "any" ? "any" : "all",
          stopAutoRun: stopAutoRunCheckbox.checked,
          conditionLogic: conditionLogicSelect.value === "any" ? "any" : "all",
          sessionRestriction: oncePerSessionCheckbox.checked ? "oncePerSession" : "none",
          description: descriptionInput.value.trim() || undefined,
          suggestion: { title, message, primaryLabel: "Yes", secondaryLabel: "Not now" },
          actions: pendingActions,
          cooldownMinutes,
          autoRun: autoRunCheckbox.checked,
        };
        updatedRoutines = [...current.routines, newRoutine];
      }

      // A routine a user just created is obviously meant to actually run
      // — but it only can if the master "Enable context-aware
      // suggestions" switch above is also on (that's what starts the
      // desktop activity monitor in the first place). Saving a routine
      // without it produces a routine that Test can run but that can
      // never fire from a real trigger, with nothing in the UI
      // explaining why — auto-enabling here closes that trap. Editing an
      // existing routine leaves the switch as the user already set it.
      const saved = await window.nimbus.updateRoutineSettings(
        editingRoutineId ? { routines: updatedRoutines } : { enabled: true, routines: updatedRoutines }
      );
      enabledCheckbox.checked = saved.enabled;
      renderRoutineList(saved);
      resetForm();
      showListView();
    } catch (err) {
      // Validation from the main process (an unknown action id, a
      // malformed condition) lands here — shown in the same place as the
      // client-side checks rather than in a dialog.
      showFormError(`Couldn't save this routine: ${String(err)}`);
    }
  });

  cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });
  backToListBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });
  newRoutineBtn.addEventListener("click", () => {
    void refreshKnownActivities().then(() => {
      fillActivityOptions(activityEndedSelect, "", "Any activity");
      fillActivityOptions(stopActivitySelect, "", "Any activity");
      renderPendingConditions();
      renderStopConditions();
    });
    resetForm();
    showEditView();
  });

  async function refreshActivitySnapshot(): Promise<void> {
    activitySnapshotContentEl.textContent = "Loading…";
    try {
      const snapshot = await window.nimbus.getActivitySnapshot();
      renderActivitySnapshot(snapshot);
    } catch (err) {
      activitySnapshotContentEl.textContent = "Couldn't read current activity.";
      console.error("Failed to load activity snapshot", err);
    }
  }

  function renderActivitySnapshot(snapshot: RawActivitySnapshot | null): void {
    activitySnapshotContentEl.innerHTML = "";
    if (!snapshot) {
      activitySnapshotContentEl.textContent =
        'Turn on "Enable context-aware suggestions" above first — this only has anything to show while that\'s on.';
      return;
    }

    const addSection = (label: string, items: string[]): void => {
      const section = document.createElement("div");
      const heading = document.createElement("div");
      heading.className = "setting-title";
      heading.textContent = label;
      section.appendChild(heading);
      if (items.length === 0) {
        const none = document.createElement("div");
        none.className = "activity-debug-empty";
        none.textContent = "None right now.";
        section.appendChild(none);
      } else {
        for (const item of items) {
          const line = document.createElement("div");
          line.className = "activity-debug-line";
          line.textContent = item;
          section.appendChild(line);
        }
      }
      activitySnapshotContentEl.appendChild(section);
    };

    addSection(
      "Browser tab titles (what a website trigger matches against)",
      snapshot.browserWindows.map((w) => w.title)
    );
    addSection("Running applications (what an app trigger matches against)", snapshot.processNames);
    addSection("Open Explorer folders (what a folder trigger matches against)", snapshot.explorerFolders);
  }

  refreshActivitySnapshotBtn.addEventListener("click", refreshActivitySnapshot);
  activityDebugDetails.addEventListener("toggle", () => {
    if (activityDebugDetails.open) refreshActivitySnapshot();
  });

  const routineHistoryDetails = document.getElementById("routineHistoryDetails") as HTMLDetailsElement;
  const routineHistoryListEl = document.getElementById("routineHistoryList") as HTMLOListElement;

  async function refreshRoutineHistory(): Promise<void> {
    let entries: RoutineHistoryEntry[];
    try {
      entries = await window.nimbus.getRoutineHistory();
    } catch (err) {
      console.error("Failed to load routine history", err);
      routineHistoryListEl.replaceChildren(historyNote("Couldn't load the history."));
      return;
    }
    if (entries.length === 0) {
      routineHistoryListEl.replaceChildren(
        historyNote("Nothing yet — a routine's decisions appear here once one is triggered.")
      );
      return;
    }
    routineHistoryListEl.replaceChildren(
      ...entries.map((entry) => {
        const { outcome, tone } = routineHistoryText(entry);
        const item = document.createElement("li");
        item.className = `routine-history-item tone-${tone}`;
        const time = document.createElement("time");
        time.className = "routine-history-time";
        time.dateTime = entry.at;
        const at = new Date(entry.at);
        time.textContent = at.toLocaleString(undefined, {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const name = document.createElement("span");
        name.className = "routine-history-name";
        name.textContent = entry.routineName;
        const what = document.createElement("span");
        what.className = "routine-history-outcome";
        what.textContent = outcome;
        item.append(time, name, what);
        return item;
      })
    );
  }

  function historyNote(text: string): HTMLLIElement {
    const note = document.createElement("li");
    note.className = "activity-debug-empty";
    note.textContent = text;
    return note;
  }

  document
    .getElementById("refreshRoutineHistoryBtn")
    ?.addEventListener("click", () => void refreshRoutineHistory());
  routineHistoryDetails.addEventListener("toggle", () => {
    if (routineHistoryDetails.open) void refreshRoutineHistory();
  });
}
