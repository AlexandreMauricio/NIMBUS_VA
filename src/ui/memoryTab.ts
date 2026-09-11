/**
 * The Memory tab — what NIMBUS remembers, where each thing came from, and
 * the controls to keep, switch off or forget it. Storage lives in Core
 * (src/memory/); this only asks the preload bridge.
 */

type MemoryValueUI = string | number | boolean | null | Record<string, string | number | boolean | null>;

interface MemoryItemUI {
  id: string;
  kind: "preference" | "fact" | "pattern" | "history";
  origin: "explicit" | "learned" | "observed";
  key: string | null;
  title: string;
  value: MemoryValueUI;
  detail: string | null;
  source: string;
  confidence: number;
  evidence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  disabled: boolean;
}

interface MemoryBridge {
  listMemories(filter: Record<string, unknown>): Promise<MemoryItemUI[]>;
  rememberMemory(input: {
    kind: "preference" | "fact";
    title: string;
    value: string;
    detail: string | null;
    expiresAt: string | null;
  }): Promise<MemoryItemUI>;
  updateMemory(id: string, changes: Record<string, unknown>): Promise<MemoryItemUI>;
  promoteMemory(id: string): Promise<MemoryItemUI>;
  forgetMemory(id: string): Promise<boolean>;
  getMemorySettings(): Promise<{ learning: boolean }>;
  updateMemorySettings(partial: { learning?: boolean }): Promise<{ learning: boolean }>;
  onMemoryChanged(callback: () => void): () => void;
}

function memoryBridge(): MemoryBridge {
  return (window as unknown as { nimbus: MemoryBridge }).nimbus;
}

const ORIGIN_LABELS: Record<MemoryItemUI["origin"], string> = {
  explicit: "Saved by you",
  learned: "Learned",
  observed: "Observed",
};

const KIND_LABELS: Record<MemoryItemUI["kind"], string> = {
  preference: "Preference",
  fact: "Fact",
  pattern: "Pattern",
  history: "History",
};

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A value as one readable line; internal bookkeeping fields (like an hour histogram) are left out. */
function describeValue(value: MemoryValueUI): string {
  if (value === null || value === "") return "";
  if (typeof value !== "object") return String(value);
  return Object.entries(value)
    .filter(([key, field]) => key !== "hours" && field !== null && field !== "")
    .map(([key, field]) => `${key}: ${field}`)
    .join(" · ");
}

export function initMemoryTab(): void {
  const list = document.getElementById("memoryList") as HTMLElement;
  const empty = document.getElementById("memoryEmpty") as HTMLElement;
  const errorEl = document.getElementById("memoryError") as HTMLElement;
  const search = document.getElementById("memorySearch") as HTMLInputElement;
  const kindFilter = document.getElementById("memoryKindFilter") as HTMLSelectElement;
  const originFilter = document.getElementById("memoryOriginFilter") as HTMLSelectElement;
  const learning = document.getElementById("memoryLearning") as HTMLInputElement;
  const formHeading = document.getElementById("memoryFormHeading") as HTMLElement;
  const kindInput = document.getElementById("memoryKind") as HTMLSelectElement;
  const titleInput = document.getElementById("memoryTitle") as HTMLInputElement;
  const valueInput = document.getElementById("memoryValue") as HTMLInputElement;
  const noteInput = document.getElementById("memoryNote") as HTMLInputElement;
  const expiresInput = document.getElementById("memoryExpires") as HTMLInputElement;
  const saveBtn = document.getElementById("memorySaveBtn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("memoryCancelEditBtn") as HTMLButtonElement;
  const formError = document.getElementById("memoryFormError") as HTMLElement;

  let editingId: string | null = null;

  function showError(target: HTMLElement, message: string | null): void {
    target.textContent = message ?? "";
    target.hidden = !message;
  }

  function errorText(err: unknown): string {
    return String(err).replace(/^.*Error: /, "");
  }

  function resetForm(): void {
    editingId = null;
    formHeading.textContent = "Remember something";
    kindInput.value = "preference";
    titleInput.value = "";
    valueInput.value = "";
    noteInput.value = "";
    expiresInput.value = "";
    saveBtn.textContent = "Remember";
    cancelBtn.hidden = true;
    showError(formError, null);
  }

  function startEditing(item: MemoryItemUI): void {
    editingId = item.id;
    formHeading.textContent = "Edit memory";
    kindInput.value = item.kind === "fact" ? "fact" : "preference";
    titleInput.value = item.title;
    valueInput.value =
      typeof item.value === "object" && item.value !== null
        ? describeValue(item.value)
        : String(item.value ?? "");
    noteInput.value = item.detail ?? "";
    expiresInput.value = item.expiresAt ? item.expiresAt.slice(0, 10) : "";
    saveBtn.textContent = "Save changes";
    cancelBtn.hidden = false;
    titleInput.focus();
  }

  async function load(): Promise<void> {
    try {
      const [items, settings] = await Promise.all([
        memoryBridge().listMemories({
          includeDisabled: true,
          ...(kindFilter.value ? { kind: kindFilter.value } : {}),
          ...(originFilter.value ? { origin: originFilter.value } : {}),
          ...(search.value.trim() ? { text: search.value.trim() } : {}),
        }),
        memoryBridge().getMemorySettings(),
      ]);
      learning.checked = settings.learning;
      showError(errorEl, null);
      render(items);
    } catch (err) {
      showError(errorEl, `Couldn't load memory: ${errorText(err)}`);
    }
  }

  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await load();
    } catch (err) {
      showError(errorEl, errorText(err));
    }
  }

  function render(items: MemoryItemUI[]): void {
    list.innerHTML = "";
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = make("div", `memory-row${item.disabled ? " memory-off" : ""}`);

      const head = make("div", "memory-row-head");
      head.appendChild(make("span", "memory-title", item.title));
      head.appendChild(
        make("span", `tag tag-neutral memory-origin-${item.origin}`, ORIGIN_LABELS[item.origin])
      );
      if (item.disabled) head.appendChild(make("span", "tag tag-neutral", "Off"));
      row.appendChild(head);

      const value = describeValue(item.value);
      const lines = [item.detail, value && value !== item.detail ? value : null].filter(Boolean);
      if (lines.length) row.appendChild(make("div", "memory-body", lines.join(" — ")));

      const meta = [
        KIND_LABELS[item.kind],
        `from ${item.source}`,
        item.origin === "explicit"
          ? null
          : `${Math.round(item.confidence * 100)}% sure · seen ${item.evidence} time${item.evidence === 1 ? "" : "s"}`,
        `updated ${shortDate(item.updatedAt)}`,
        item.expiresAt
          ? `forgotten ${shortDate(item.expiresAt)} unless ${item.origin === "explicit" ? "changed" : "seen again"}`
          : null,
      ].filter(Boolean);
      row.appendChild(make("div", "memory-meta", meta.join(" · ")));

      const actions = make("div", "memory-actions");
      if (item.origin === "explicit") {
        const edit = make("button", "btn btn-ghost", "Edit");
        edit.type = "button";
        edit.addEventListener("click", () => startEditing(item));
        actions.appendChild(edit);
      } else {
        const keep = make("button", "btn btn-ghost", "Keep");
        keep.type = "button";
        keep.title = "Make this your own memory: fully trusted, never forgotten automatically";
        keep.addEventListener("click", () => void act(() => memoryBridge().promoteMemory(item.id)));
        actions.appendChild(keep);
      }
      const toggle = make("button", "btn btn-ghost", item.disabled ? "Switch on" : "Switch off");
      toggle.type = "button";
      toggle.addEventListener(
        "click",
        () => void act(() => memoryBridge().updateMemory(item.id, { disabled: !item.disabled }))
      );
      actions.appendChild(toggle);

      const forget = make("button", "btn btn-ghost", "Forget");
      forget.type = "button";
      let armed: ReturnType<typeof setTimeout> | null = null;
      forget.addEventListener("click", () => {
        if (!armed) {
          forget.textContent = "Click again to forget";
          armed = setTimeout(() => {
            armed = null;
            forget.textContent = "Forget";
          }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        if (editingId === item.id) resetForm();
        void act(() => memoryBridge().forgetMemory(item.id));
      });
      actions.appendChild(forget);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  saveBtn.addEventListener("click", async () => {
    const kind = kindInput.value === "fact" ? "fact" : "preference";
    const expiresAt = expiresInput.value ? new Date(`${expiresInput.value}T23:59:59`).toISOString() : null;
    saveBtn.disabled = true;
    try {
      if (editingId) {
        await memoryBridge().updateMemory(editingId, {
          title: titleInput.value,
          value: valueInput.value.trim(),
          detail: noteInput.value.trim() || null,
          expiresAt,
        });
      } else {
        await memoryBridge().rememberMemory({
          kind,
          title: titleInput.value,
          value: valueInput.value.trim(),
          detail: noteInput.value.trim() || null,
          expiresAt,
        });
      }
      resetForm();
      await load();
    } catch (err) {
      showError(formError, errorText(err));
    } finally {
      saveBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener("click", resetForm);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 200);
  });
  kindFilter.addEventListener("change", () => void load());
  originFilter.addEventListener("change", () => void load());
  learning.addEventListener(
    "change",
    () => void act(() => memoryBridge().updateMemorySettings({ learning: learning.checked }))
  );

  document.querySelector('.side-link[data-tab="memory"]')?.addEventListener("click", () => void load());
  memoryBridge().onMemoryChanged(() => void load());
  resetForm();
  void load();
}
