/**
 * The Tasks tab's list and editor.
 */

import { formatTaskDue } from "./uiFormat";
import type { TaskItem, TaskPriority, TaskWriteRequest } from "./rendererTypes";

export const TASK_REFRESH_EVENT = "nimbus:refresh-tasks";

const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * The Tasks tab — list/grid view, sorting, and create/edit/complete/
 * delete, all writing straight through to Todoist (see
 * src/context/providers/tasks/todoistTaskSource.ts's write methods).
 * Mirrors initRoutinesSettings()'s own list-view/edit-view pattern
 * (same show/hide toggle, same one-form-for-create-and-edit reuse) —
 * deliberately not sharing code with it beyond that shape, since a task
 * and a routine are unrelated concepts that just happen to want a
 * similar management UI.
 */
export function initTaskManagement(): void {
  const listViewEl = document.getElementById("tasksListView") as HTMLElement;
  const editViewEl = document.getElementById("tasksEditView") as HTMLElement;
  const taskListEl = document.getElementById("taskList") as HTMLElement;
  const taskListEmptyEl = document.getElementById("taskListEmpty") as HTMLElement;
  const disabledWarningEl = document.getElementById("tasksDisabledWarning") as HTMLElement;
  const viewListBtn = document.getElementById("tasksViewListBtn") as HTMLButtonElement;
  const viewGridBtn = document.getElementById("tasksViewGridBtn") as HTMLButtonElement;
  const sortSelect = document.getElementById("taskSortSelect") as HTMLSelectElement;
  const newTaskBtn = document.getElementById("newTaskBtn") as HTMLButtonElement;
  const backToListBtn = document.getElementById("backToTaskListBtn") as HTMLButtonElement;

  const formHeadingEl = document.getElementById("taskFormHeading") as HTMLElement;
  const titleInput = document.getElementById("taskTitleInput") as HTMLInputElement;
  const descriptionInput = document.getElementById("taskDescriptionInput") as HTMLInputElement;
  const dueDateInput = document.getElementById("taskDueDateInput") as HTMLInputElement;
  const prioritySelect = document.getElementById("taskPrioritySelect") as HTMLSelectElement;
  const projectSelect = document.getElementById("taskProjectSelect") as HTMLSelectElement;
  const saveBtn = document.getElementById("saveTaskBtn") as HTMLButtonElement;
  const cancelEditBtn = document.getElementById("cancelTaskEditBtn") as HTMLButtonElement;

  let currentTasks: TaskItem[] = [];
  let editingTaskId: string | null = null;
  let projectsLoaded = false;

  function showListView(): void {
    listViewEl.hidden = false;
    editViewEl.hidden = true;
  }
  function showEditView(): void {
    listViewEl.hidden = true;
    editViewEl.hidden = false;
  }

  const CARD_LAYOUT_STORAGE_KEY = "nimbus:tasks-card-layout";
  function applyCardLayout(layout: "list" | "grid"): void {
    taskListEl.classList.toggle("grid-view", layout === "grid");
    viewListBtn.classList.toggle("active", layout === "list");
    viewGridBtn.classList.toggle("active", layout === "grid");
    try {
      localStorage.setItem(CARD_LAYOUT_STORAGE_KEY, layout);
    } catch {
      // per-viewer convenience only
    }
  }
  viewListBtn.addEventListener("click", () => applyCardLayout("list"));
  viewGridBtn.addEventListener("click", () => applyCardLayout("grid"));
  let savedLayout: string | null = null;
  try {
    savedLayout = localStorage.getItem(CARD_LAYOUT_STORAGE_KEY);
  } catch {
    // defaults to list below
  }
  applyCardLayout(savedLayout === "grid" ? "grid" : "list");

  const SORT_STORAGE_KEY = "nimbus:tasks-sort";
  try {
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (savedSort) sortSelect.value = savedSort;
  } catch {
    // defaults to the select's own first option
  }

  function sortTasks(tasks: TaskItem[]): TaskItem[] {
    const sorted = [...tasks];
    const priorityRank: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };
    switch (sortSelect.value) {
      case "priority":
        sorted.sort(
          (a, b) =>
            priorityRank[a.priority] - priorityRank[b.priority] ||
            (a.dueAt ?? "").localeCompare(b.dueAt ?? "")
        );
        break;
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "created":
        sorted.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        break;
      default: // due date — tasks with no due date sort last, alphabetically among themselves
        sorted.sort((a, b) => {
          if (!a.dueAt && !b.dueAt) return a.title.localeCompare(b.title);
          if (!a.dueAt) return 1;
          if (!b.dueAt) return -1;
          return a.dueAt.localeCompare(b.dueAt);
        });
    }
    return sorted;
  }

  async function ensureProjectsLoaded(): Promise<void> {
    if (projectsLoaded) return;
    try {
      const projects = await window.nimbus.listTaskProjects();
      projectSelect.innerHTML = '<option value="">(default)</option>';
      for (const p of projects) {
        const option = document.createElement("option");
        option.value = p.id;
        option.textContent = p.name;
        projectSelect.appendChild(option);
      }
      projectsLoaded = true;
    } catch (err) {
      console.error("Failed to load task lists", err);
    }
  }

  const taskListErrorEl = document.getElementById("taskListError") as HTMLElement;
  const taskFormErrorEl = document.getElementById("taskFormError") as HTMLElement;

  /**
   * Shows a problem inline. Not alert()/confirm(): a native dialog in
   * Electron takes keyboard focus away from the page, and more than once
   * left a form that could no longer be typed into.
   */
  function showTaskError(target: HTMLElement, message: string): void {
    target.textContent = message;
    target.hidden = false;
  }

  function renderTaskCard(task: TaskItem): HTMLElement {
    const card = document.createElement("div");
    card.className = task.category === "overdue" ? "task-card task-card-overdue" : "task-card";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-card-checkbox";
    checkbox.title = "Mark complete";
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await window.nimbus.completeTask(task.id);
        await loadAndRenderTasks();
      } catch (err) {
        showTaskError(taskListErrorEl, `Couldn't complete "${task.title}": ${String(err)}`);
        checkbox.checked = false;
        checkbox.disabled = false;
      }
    });
    card.appendChild(checkbox);

    const body = document.createElement("div");
    body.className = "task-card-body";

    const titleEl = document.createElement("div");
    titleEl.className = "task-card-title";
    titleEl.textContent = task.title;
    body.appendChild(titleEl);

    if (task.description) {
      const descEl = document.createElement("div");
      descEl.className = "task-card-description";
      descEl.textContent = task.description;
      body.appendChild(descEl);
    }

    const meta = document.createElement("div");
    meta.className = "task-card-meta";
    const due = formatTaskDue(task);
    if (due) {
      const dueEl = document.createElement("span");
      if (due.overdue) dueEl.className = "task-due-overdue";
      dueEl.textContent = due.text;
      meta.appendChild(dueEl);
    }
    if (task.priority !== "none") {
      const badge = document.createElement("span");
      badge.className = `task-priority-badge task-priority-${task.priority}`;
      badge.textContent = TASK_PRIORITY_LABELS[task.priority];
      meta.appendChild(badge);
    }
    if (task.listName) {
      const listEl = document.createElement("span");
      listEl.textContent = task.listName;
      meta.appendChild(listEl);
    }
    if (meta.children.length > 0) body.appendChild(meta);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "task-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => populateFormForEdit(task));
    actions.appendChild(editBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "calendar-feed-remove";
    removeBtn.textContent = "Delete";
    // Two clicks instead of a confirm() dialog: the first arms it, the
    // second deletes, and it disarms itself if the second never comes.
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    removeBtn.addEventListener("click", async () => {
      if (!armTimer) {
        removeBtn.textContent = "Click again to delete";
        armTimer = setTimeout(() => {
          armTimer = null;
          removeBtn.textContent = "Delete";
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      armTimer = null;
      removeBtn.disabled = true;
      try {
        await window.nimbus.deleteTask(task.id);
        if (editingTaskId === task.id) {
          resetForm();
          showListView();
        }
        await loadAndRenderTasks();
      } catch (err) {
        showTaskError(taskListErrorEl, `Couldn't delete "${task.title}": ${String(err)}`);
        removeBtn.textContent = "Delete";
        removeBtn.disabled = false;
      }
    });
    actions.appendChild(removeBtn);

    card.appendChild(actions);
    return card;
  }

  function renderList(): void {
    const sorted = sortTasks(currentTasks);
    taskListEl.innerHTML = "";
    taskListEmptyEl.hidden = sorted.length > 0;
    for (const task of sorted) {
      taskListEl.appendChild(renderTaskCard(task));
    }
  }

  async function loadAndRenderTasks(): Promise<void> {
    try {
      const { tasks } = await window.nimbus.listTasks();
      currentTasks = tasks;
      taskListErrorEl.hidden = true;
      taskListEmptyEl.textContent =
        'No active tasks. Click "+ New task" to add one — or enjoy being caught up.';
      renderList();
    } catch (err) {
      console.error("Failed to load tasks", err);
      currentTasks = [];
      taskListEl.innerHTML = "";
      taskListEmptyEl.hidden = false;
      taskListEmptyEl.textContent = "Couldn't load tasks — check your Todoist connection in Settings.";
    }
  }

  async function refreshEnabledState(): Promise<void> {
    try {
      const settings = await window.nimbus.getTaskSettings();
      disabledWarningEl.hidden = settings.enabled && settings.accounts.some((a) => a.enabled);
    } catch {
      disabledWarningEl.hidden = true;
    }
  }

  function resetForm(): void {
    editingTaskId = null;
    taskFormErrorEl.hidden = true;
    formHeadingEl.textContent = "New task";
    saveBtn.textContent = "Save task";
    cancelEditBtn.hidden = true;
    titleInput.value = "";
    descriptionInput.value = "";
    dueDateInput.value = "";
    prioritySelect.value = "none";
    projectSelect.value = "";
  }

  async function populateFormForEdit(task: TaskItem): Promise<void> {
    showEditView();
    editingTaskId = task.id;
    formHeadingEl.textContent = `Editing "${task.title}"`;
    saveBtn.textContent = "Update task";
    cancelEditBtn.hidden = false;

    titleInput.value = task.title;
    descriptionInput.value = task.description ?? "";
    dueDateInput.value = task.dueAt ? task.dueAt.slice(0, 10) : "";
    prioritySelect.value = task.priority;

    await ensureProjectsLoaded();
    // TaskItem only carries the project's resolved *name*, not its id
    // (see todoistTaskSource.ts) — matching by name against the loaded
    // project list is the best this form can do without a shape change
    // there; project names are effectively unique per Todoist account in
    // practice.
    projectSelect.value = "";
    if (task.listName) {
      const match = Array.from(projectSelect.options).find((o) => o.textContent === task.listName);
      if (match) projectSelect.value = match.value;
    }
  }

  sortSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sortSelect.value);
    } catch {
      // per-viewer convenience only
    }
    renderList();
  });

  newTaskBtn.addEventListener("click", async () => {
    resetForm();
    showEditView();
    await ensureProjectsLoaded();
  });

  backToListBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });

  cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showListView();
  });

  saveBtn.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    if (!title) {
      showTaskError(taskFormErrorEl, "A task needs a title.");
      titleInput.focus();
      return;
    }
    taskFormErrorEl.hidden = true;

    const request: TaskWriteRequest = {
      title,
      description: descriptionInput.value.trim() || null,
      dueDate: dueDateInput.value || null,
      priority: prioritySelect.value as TaskPriority,
      projectId: projectSelect.value || null,
    };

    saveBtn.disabled = true;
    try {
      if (editingTaskId) {
        await window.nimbus.updateTask(editingTaskId, request);
      } else {
        await window.nimbus.createTask(request);
      }
      resetForm();
      showListView();
      await loadAndRenderTasks();
    } catch (err) {
      showTaskError(taskFormErrorEl, `Couldn't save the task: ${String(err)}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  window.addEventListener(TASK_REFRESH_EVENT, () => loadAndRenderTasks());

  refreshEnabledState();
  loadAndRenderTasks();
}
