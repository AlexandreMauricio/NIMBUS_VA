/**
 * Settings → Your data: export everything movable to one file, and import
 * such a file on another PC (src/main/dataTransfer.ts does the files).
 * An import shows what the file holds and replaces only the parts ticked,
 * after backing this PC's copy up; NIMBUS then restarts.
 */

interface SectionSummaryUI {
  id: string;
  label: string;
  detail: string;
  files: number;
}

interface TransferBridge {
  dataSummary(): Promise<Array<{ id: string; label: string; files: number }>>;
  exportData(): Promise<string | null>;
  readImport(): Promise<{ summary: SectionSummaryUI[]; appVersion: string; exportedAt: string } | null>;
  cancelImport(): Promise<void>;
  applyImport(sections: string[]): Promise<{ backup: string }>;
}

const bridge = () => (window as unknown as { nimbus: TransferBridge }).nimbus;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

const errorText = (err: unknown) => String(err).replace(/^.*Error: /, "");

export function initDataTransfer(): void {
  const root = document.getElementById("dataTransfer");
  if (!root) return;

  const draw = (message: string | null = null, error = false) => {
    root.replaceChildren();
    root.appendChild(
      make(
        "p",
        "setting-note",
        "Move your meals, books, cards, decks and memory to NIMBUS on another PC: export them here to one file, then import that file there. Settings, passwords and tokens stay on each PC, and so does anything tied to one PC (the comics vault folder, usage history)."
      )
    );
    const row = make("div", "settings-row data-transfer-actions");
    row.append(
      button("Export my data…", "btn btn-secondary", () => void doExport()),
      button("Import from a file…", "btn btn-ghost", () => void doRead())
    );
    root.appendChild(row);
    if (message) root.appendChild(make("p", error ? "form-error" : "setting-note", message));
  };

  const doExport = async () => {
    try {
      const where = await bridge().exportData();
      if (where) draw(`Exported to ${where}. Copy that file to the other PC and import it there.`);
    } catch (err) {
      draw(`Couldn't export: ${errorText(err)}`, true);
    }
  };

  const doRead = async () => {
    try {
      const read = await bridge().readImport();
      if (!read) return;
      const here = await bridge().dataSummary();
      draw();
      const box = make("div", "data-transfer-import");
      box.appendChild(
        make(
          "p",
          "setting-note",
          `From NIMBUS ${read.appVersion}${read.exportedAt ? `, exported ${new Date(read.exportedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : ""}. Tick what to bring over — each part ticked replaces this PC's.`
        )
      );
      const ticks = new Map<string, HTMLInputElement>();
      for (const section of read.summary) {
        const label = make("label", "data-transfer-section");
        const tick = document.createElement("input");
        tick.type = "checkbox";
        tick.checked = true;
        ticks.set(section.id, tick);
        const mine = here.find((entry) => entry.id === section.id);
        const text = make("span");
        text.append(
          make("strong", undefined, section.label),
          make(
            "span",
            "setting-note",
            ` — ${section.detail || `${section.files} file(s)`}${mine && mine.files ? " · replaces what's here (kept as a backup)" : ""}`
          )
        );
        label.append(tick, text);
        box.appendChild(label);
      }
      const actions = make("div", "settings-row data-transfer-actions");
      actions.append(
        button("Import and restart", "btn btn-primary", () => {
          const chosen = [...ticks.entries()].filter(([, tick]) => tick.checked).map(([id]) => id);
          if (!chosen.length) return;
          const list = read.summary.filter((s) => chosen.includes(s.id)).map((s) => s.label.split(" — ")[0]);
          if (
            !window.confirm(
              `Replace this PC's ${list.join(", ")} with the imported ones? This PC's copy is backed up first, and NIMBUS restarts.`
            )
          )
            return;
          bridge()
            .applyImport(chosen)
            .catch((err) => draw(`Couldn't import: ${errorText(err)}`, true));
        }),
        button(
          "Cancel",
          "btn btn-ghost",
          () =>
            void bridge()
              .cancelImport()
              .then(() => draw())
        )
      );
      box.appendChild(actions);
      root.appendChild(box);
    } catch (err) {
      draw(`Couldn't read that file: ${errorText(err)}`, true);
    }
  };

  draw();
}
