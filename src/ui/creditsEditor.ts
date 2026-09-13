/**
 * Your own characters, writers and artists for comic issues — for when GCD
 * has none, or misses someone. Names are chips; typing offers the names
 * already known, and a name typed differently ("venom") takes the known
 * spelling ("Venom"), so reading stats count them as one. Core does the
 * matching (collections/books/readings.ts); the service keeps the edit
 * safe from later GCD lookups.
 */
import { seriesKey } from "../collections/books/runs";
import { CreditField, knownNames, personKey } from "../collections/books/readings";
import type { IssueRef, ReadingLogView } from "./readingLog";

interface CreditsBridge {
  editIssueCredits(
    issues: IssueRef[],
    changes: Partial<Record<CreditField, string[]>>,
    mode: "replace" | "add"
  ): Promise<number>;
}

const bridge = (): CreditsBridge => (window as unknown as { nimbus: CreditsBridge }).nimbus;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");
const issueKey = (issue: IssueRef) => `${seriesKey(issue.series, issue.year)}#${issue.number}`;

const FIELDS: Array<[CreditField, string, string]> = [
  ["characters", "Characters", "e.g. Venom"],
  ["writers", "Writers", "e.g. Donny Cates"],
  ["artists", "Artists", "e.g. Ryan Stegman"],
];

let listCounter = 0;

/** A field of name chips with suggestions from the names already known. */
function chipField(label: string, placeholder: string, known: string[], initial: string[]) {
  const names: string[] = [...initial];
  const knownByKey = new Map(known.map((n) => [personKey(n), n]));
  const wrap = make("div", "credits-field");
  wrap.appendChild(make("span", "books-fact-label", label));
  const chips = make("div", "credits-chips");
  const input = make("input", "input credits-input");
  input.placeholder = placeholder;
  input.maxLength = 80;
  const listId = `creditsList${++listCounter}`;
  input.setAttribute("list", listId);
  input.setAttribute("aria-label", `Add to ${label.toLowerCase()}`);
  const datalist = make("datalist");
  datalist.id = listId;
  for (const name of known) datalist.appendChild(new Option(name));

  const draw = () => {
    chips.replaceChildren();
    for (const name of names) {
      const chip = make("span", "tag tag-neutral credits-chip", name);
      const remove = make("button", "credits-chip-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.addEventListener("click", () => {
        names.splice(names.indexOf(name), 1);
        draw();
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
    chips.appendChild(input);
  };
  const add = () => {
    for (const part of input.value.split(/[;,]/)) {
      const typed = part.replace(/\s+/g, " ").trim();
      const key = personKey(typed);
      if (!key || names.some((n) => personKey(n) === key)) continue;
      names.push(knownByKey.get(key) ?? typed);
    }
    input.value = "";
    draw();
    input.focus();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && !input.value && names.length) {
      names.pop();
      draw();
    }
  });
  // Picking a suggestion from the list adds it straight away.
  input.addEventListener("change", () => {
    if (knownByKey.has(personKey(input.value))) add();
  });
  draw();
  wrap.append(chips, datalist);
  return {
    element: wrap,
    /** The names, including anything still typed in the box. */
    values: () => {
      if (input.value.trim()) add();
      return [...names];
    },
  };
}

/**
 * The editor. With `current` it edits that issue in full, and can instead
 * add the names to a stretch of the book's issues; without it, it only adds
 * to a stretch.
 */
export function creditsEditor(
  issues: IssueRef[],
  current: IssueRef | null,
  log: ReadingLogView,
  onSaved: () => void
): HTMLElement {
  const box = make("div", "credits-editor");
  const stored = current ? log.credits[issueKey(current)] : undefined;
  const fields = FIELDS.map(([field, label, placeholder]) => ({
    field,
    ...chipField(label, placeholder, knownNames(log.credits, field), stored?.[field] ?? []),
  }));
  box.appendChild(
    make(
      "p",
      "books-small",
      current
        ? stored?.edited
          ? "Edited by you — a GCD lookup won't change these."
          : "From the Grand Comics Database when it had them. Add or remove names; what you save is kept."
        : "Add names to a stretch of this book's issues — anything already on those issues is kept."
    )
  );
  for (const f of fields) box.appendChild(f.element);

  // Which issues.
  let from = current
    ? Math.max(
        0,
        issues.findIndex((i) => issueKey(i) === issueKey(current))
      )
    : 0;
  let to = current ? from : issues.length - 1;
  const scope = make("div", "reading-form");
  const rangeToggle = make("input");
  rangeToggle.type = "checkbox";
  rangeToggle.checked = !current;
  const pick = (label: string, value: number, set: (n: number) => void) => {
    const select = make("select", "select reading-issue-pick");
    issues.forEach((issue, i) => select.appendChild(new Option(`#${issue.number}`, String(i))));
    select.value = String(value);
    select.setAttribute("aria-label", label);
    select.addEventListener("change", () => set(Number(select.value)));
    return select;
  };
  if (current && issues.length > 1) {
    const toggleLabel = make("label", "books-small credits-scope");
    toggleLabel.append(rangeToggle, document.createTextNode(" Add these to issues"));
    scope.append(toggleLabel);
  } else if (!current) {
    scope.append(make("span", "books-small", "Issues"));
  }
  if (issues.length > 1) {
    scope.append(
      pick("First issue", from, (n) => (from = n)),
      make("span", "books-small", "to"),
      pick("Last issue", to, (n) => (to = n))
    );
  }
  box.appendChild(scope);

  const status = make("span", "books-small");
  const save = make("button", "btn btn-secondary", current ? "Save" : "Add to these issues");
  save.type = "button";
  save.addEventListener("click", async () => {
    const changes: Partial<Record<CreditField, string[]>> = {};
    for (const f of fields) changes[f.field] = f.values();
    const ranged = !current || rangeToggle.checked;
    const targets = ranged ? issues.slice(Math.min(from, to), Math.max(from, to) + 1) : [current!];
    if (ranged) {
      // Adding: only fields with names in them matter.
      for (const f of FIELDS) if (!changes[f[0]]?.length) delete changes[f[0]];
      if (!Object.keys(changes).length) {
        status.textContent = "Type a name first.";
        return;
      }
    }
    save.disabled = true;
    try {
      const n = await bridge().editIssueCredits(targets, changes, ranged ? "add" : "replace");
      status.textContent = ranged ? `Added to ${n} issue${n === 1 ? "" : "s"}.` : "Saved.";
      onSaved();
    } catch (err) {
      status.textContent = errorText(err);
    } finally {
      save.disabled = false;
    }
  });
  const actions = make("div", "reading-form");
  actions.append(save, status);
  box.appendChild(actions);
  return box;
}
