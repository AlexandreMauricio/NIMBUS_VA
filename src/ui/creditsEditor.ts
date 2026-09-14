/**
 * Your own characters, writers and artists for a comic issue, instead of
 * GCD's when you choose — for when GCD has none, or misses someone. Names
 * are chips; typing offers the names already known, and a name typed
 * differently ("venom") takes the known spelling ("Venom"), so reading
 * stats count them as one (collections/books/readings.ts).
 */
import { seriesKey } from "../collections/books/runs";
import { CreditField, knownNames, personKey } from "../collections/books/readings";
import type { IssueRef, ReadingLogView } from "./readingLog";

interface CreditsBridge {
  setMyIssueCredits(issue: IssueRef, changes: Partial<Record<CreditField, string[]>>): Promise<unknown>;
  useMyIssueCredits(issue: IssueRef, on: boolean): Promise<boolean>;
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
 * An issue's characters and creators for reading stats. By default they're
 * GCD's, shown as they are. Ticking "Use my own info" switches this issue to
 * your names — starting from GCD's — which you edit and save; unticking goes
 * back to GCD's and keeps yours for next time.
 */
export function creditsEditor(issue: IssueRef, log: ReadingLogView, onSaved: () => void): HTMLElement {
  const box = make("div", "card credits-editor");
  const key = issueKey(issue);
  const gcd = log.gcdCredits[key];
  const mine = log.customCredits[key];
  const using = log.useCustom.includes(key);

  box.appendChild(make("h6", "kicker", "Characters & creators in your reading stats"));
  const toggle = make("label", "credits-toggle");
  const check = make("input");
  check.type = "checkbox";
  check.checked = using;
  toggle.append(check, document.createTextNode(" Use my own info for this issue instead of GCD's"));
  box.appendChild(toggle);
  const status = make("span", "books-small");
  check.addEventListener("change", async () => {
    check.disabled = true;
    try {
      await bridge().useMyIssueCredits(issue, check.checked);
      onSaved();
    } catch (err) {
      status.textContent = errorText(err);
      check.checked = !check.checked;
      check.disabled = false;
    }
  });

  if (!using) {
    const list = make("div", "credits-readonly");
    if (!gcd) {
      list.appendChild(
        make(
          "p",
          "books-small",
          "Not looked up on the Grand Comics Database yet — opening this page looks it up when GCD answers."
        )
      );
    } else {
      for (const [field, label] of FIELDS) {
        const row = make("p", "books-small");
        row.append(
          make("span", "books-fact-label", `${label}: `),
          document.createTextNode(gcd[field].length ? gcd[field].join(", ") : "none on GCD")
        );
        list.appendChild(row);
      }
    }
    box.append(list, status);
    return box;
  }

  const known = (field: CreditField) => {
    const all = { ...log.gcdCredits };
    for (const [k, c] of Object.entries(log.customCredits))
      all[`custom|${k}`] = { title: null, pageCount: null, ...c };
    return knownNames(all, field);
  };
  const start = mine ?? gcd;
  const fields = FIELDS.map(([field, label, placeholder]) => ({
    field,
    ...chipField(label, placeholder, known(field), start?.[field] ?? []),
  }));
  box.appendChild(
    make(
      "p",
      "books-small",
      'Type a name and press Enter. Names already known are suggested, and one typed differently ("venom") is counted as the same ("Venom").'
    )
  );
  for (const f of fields) box.appendChild(f.element);
  const save = make("button", "btn btn-secondary", "Save my info");
  save.type = "button";
  save.addEventListener("click", async () => {
    const changes: Partial<Record<CreditField, string[]>> = {};
    for (const f of fields) changes[f.field] = f.values();
    save.disabled = true;
    try {
      await bridge().setMyIssueCredits(issue, changes);
      status.textContent = "Saved.";
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
