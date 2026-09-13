/**
 * On a comic's page: runs written without a series year, and which volume
 * they are. The main process works the years out from GCD after the book
 * is saved (collections/books/seriesYears.ts); what it can't settle is
 * asked here — the volumes GCD offered, or a year typed in.
 */
import type { Book } from "../collections/books/types";

interface YearChoice {
  year: number;
  yearEnded: number | null;
  issues: number;
  publisher: string | null;
}

interface YearsState {
  working: boolean;
  settled: number;
  ambiguous: Array<{ index: number; series: string; from: number; to: number; choices: YearChoice[] }>;
  paused: string | null;
}

interface YearsBridge {
  getBookYears(id: string): Promise<YearsState | null>;
  workOutBookYears(id: string): Promise<YearsState | null>;
  setRunYear(id: string, index: number, series: string, year: number): Promise<number>;
}

const bridge = (): YearsBridge => (window as unknown as { nimbus: YearsBridge }).nimbus;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = make("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");
const numbers = (from: number, to: number) => (from === to ? `#${from}` : `#${from}–${to}`);

/** The panel, or null when every run has its year. */
export function seriesYearsPanel(book: Book): HTMLElement | null {
  const yearless = book.runs.map((run, index) => ({ run, index })).filter(({ run }) => run.year === null);
  if (book.kind !== "comic" || !yearless.length) return null;

  const panel = make("div", "card series-years");
  const head = make("p", "series-years-head");
  panel.appendChild(head);
  const body = make("div", "series-years-body");
  panel.appendChild(body);

  const draw = (state: YearsState | null) => {
    body.replaceChildren();
    head.textContent = `${yearless.length} run${yearless.length === 1 ? " has" : "s have"} no series year — so ${
      yearless.length === 1 ? "it" : "they"
    } could be mixed up with another volume of the same name (Amazing Spider-Man #29 from 1965 or from 2019).`;
    if (state?.working) {
      body.appendChild(
        make("p", "books-small", "Working out which volumes they are from the Grand Comics Database…")
      );
      return;
    }
    if (state?.paused) body.appendChild(make("p", "books-small", state.paused));
    const asked = new Map((state?.ambiguous ?? []).map((a) => [a.index, a]));
    for (const { run, index } of yearless) {
      const row = make("div", "series-years-row");
      row.appendChild(make("span", "series-years-run", `${run.series} ${numbers(run.from, run.to)}`));
      const question = asked.get(index);
      for (const choice of question?.choices ?? []) {
        row.appendChild(
          button(
            `${choice.year}–${choice.yearEnded ?? "now"}${choice.issues ? ` · ${choice.issues} issues` : ""}`,
            "btn btn-ghost series-years-choice",
            () => void choose(index, run.series, choice.year)
          )
        );
      }
      const year = make("input", "input series-years-input");
      year.type = "number";
      year.min = "1900";
      year.max = "2100";
      year.placeholder = "Year it began";
      year.setAttribute("aria-label", `Year ${run.series} began`);
      row.append(
        year,
        button("Set", "btn btn-secondary", () => {
          const n = Number(year.value);
          if (Number.isInteger(n) && n >= 1900 && n <= 2100) void choose(index, run.series, n);
        })
      );
      body.appendChild(row);
    }
    if (!state || state.paused) {
      body.appendChild(
        button("Work out the years from GCD", "btn btn-secondary", async () => {
          draw({ working: true, settled: 0, ambiguous: [], paused: null });
          try {
            draw(await bridge().workOutBookYears(book.id));
          } catch (err) {
            draw({ working: false, settled: 0, ambiguous: [], paused: errorText(err) });
          }
        })
      );
    }
  };

  const choose = async (index: number, series: string, year: number) => {
    try {
      await bridge().setRunYear(book.id, index, series, year);
    } catch (err) {
      body.appendChild(make("p", "form-error", errorText(err)));
    }
  };

  draw(null);
  void bridge()
    .getBookYears(book.id)
    .then((state) => draw(state))
    .catch(() => undefined);
  return panel;
}
