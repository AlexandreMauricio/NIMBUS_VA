/**
 * The Books tab's reading log: logging a reading of an issue (or a stretch
 * of a book's issues) on a day, the readings of one issue, and what the log
 * adds up to — time reading, re-reads, and time with each series,
 * character, writer and artist. The sums are Core's (collections/books/
 * readings.ts); everything saved goes through the preload bridge.
 */
import { seriesKey } from "../collections/books/runs";
import {
  IssueCredits,
  IssueReading,
  TimeLine,
  formatReadingTime,
  readingStats,
} from "../collections/books/readings";

export interface ReadingLogView {
  readings: IssueReading[];
  credits: Record<string, IssueCredits>;
  minutesPerIssue: number;
}

export interface IssueRef {
  series: string;
  year: number | null;
  number: number;
}

interface ReadingBridge {
  logIssueReadings(
    issues: IssueRef[],
    readOn: string,
    minutes: number | null,
    bookId: string | null
  ): Promise<number>;
  removeIssueReading(id: string): Promise<boolean>;
  setMinutesPerIssue(minutes: number): Promise<number>;
  fillReadingCredits(count: number): Promise<{ filled: number; notFound: number; left: number }>;
}

/** bookService.issueReadKey, without pulling the service into the page. */
const issueReadKey = (series: string, year: number | null, number: number): string =>
  `${seriesKey(series, year)}#${number}`;

function bridge(): ReadingBridge {
  return (window as unknown as { nimbus: ReadingBridge }).nimbus;
}

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

/** Today as "YYYY-MM-DD" in local time. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dayLabel = (readOn: string): string =>
  new Date(`${readOn}T12:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * "Log a reading": a day and the minutes each issue took. With several
 * issues (a book's), from/to pickers choose the stretch read that day.
 */
export function logReadingForm(
  issues: IssueRef[],
  log: ReadingLogView,
  bookId: string | null,
  onLogged: () => void
): HTMLElement {
  const form = make("div", "reading-form");
  let from = 0;
  let to = issues.length - 1;
  if (issues.length > 1) {
    const pick = (label: string, value: number, set: (n: number) => void) => {
      const select = make("select", "select reading-issue-pick");
      issues.forEach((issue, i) => select.appendChild(new Option(`#${issue.number}`, String(i))));
      select.value = String(value);
      select.setAttribute("aria-label", label);
      select.addEventListener("change", () => {
        set(Number(select.value));
        refreshCount();
      });
      return select;
    };
    form.append(
      make("span", "books-small", "Issues"),
      pick("First issue read", from, (n) => (from = n)),
      make("span", "books-small", "to"),
      pick("Last issue read", to, (n) => (to = n))
    );
  }
  const date = make("input", "input reading-date");
  date.type = "date";
  date.max = localToday();
  date.value = localToday();
  date.setAttribute("aria-label", "Day read");
  const minutes = make("input", "input reading-minutes");
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "600";
  minutes.value = String(log.minutesPerIssue);
  minutes.setAttribute("aria-label", "Minutes per issue");
  const count = make("span", "books-small");
  const status = make("span", "books-small");
  const refreshCount = () => {
    const n = Math.abs(to - from) + 1;
    const each = Number(minutes.value) || log.minutesPerIssue;
    count.textContent = `${n} issue${n === 1 ? "" : "s"} · about ${formatReadingTime(n * each)}`;
  };
  minutes.addEventListener("input", refreshCount);
  const save = button("Log reading", "btn btn-secondary", async () => {
    const chosen = issues.slice(Math.min(from, to), Math.max(from, to) + 1);
    save.disabled = true;
    try {
      const n = await bridge().logIssueReadings(chosen, date.value, Number(minutes.value) || null, bookId);
      status.textContent = `Logged ${n} reading${n === 1 ? "" : "s"}.`;
      onLogged();
    } catch (err) {
      status.textContent = errorText(err);
    } finally {
      save.disabled = false;
    }
  });
  form.append(
    make("span", "books-small", "on"),
    date,
    minutes,
    make("span", "books-small", "min each"),
    save,
    count,
    status
  );
  refreshCount();
  return form;
}

/** One issue's readings, newest first, each removable. */
export function issueReadingList(issue: IssueRef, log: ReadingLogView, onChanged: () => void): HTMLElement {
  const key = issueReadKey(issue.series, issue.year, issue.number);
  const mine = log.readings.filter((r) => r.key === key);
  const list = make("div", "reading-list");
  if (!mine.length) {
    list.appendChild(make("p", "books-small", "No readings logged yet."));
    return list;
  }
  for (const reading of mine) {
    const row = make("div", "reading-row");
    row.append(
      make("span", undefined, dayLabel(reading.readOn)),
      make("span", "books-small", formatReadingTime(reading.minutes)),
      button("Remove", "btn btn-ghost", async () => {
        await bridge().removeIssueReading(reading.id);
        onChanged();
      })
    );
    list.appendChild(row);
  }
  return list;
}

/** "Read twice — last on 12 Sep 2026", or null when never logged. */
export function readingSummary(issue: IssueRef, log: ReadingLogView): string | null {
  const key = issueReadKey(issue.series, issue.year, issue.number);
  const mine = log.readings.filter((r) => r.key === key);
  if (!mine.length) return null;
  const times =
    mine.length === 1 ? "Read once" : mine.length === 2 ? "Read twice" : `Read ${mine.length} times`;
  return `${times} — last on ${dayLabel(mine[0].readOn)}`;
}

function timeList(title: string, lines: TimeLine[], empty: string): HTMLElement {
  const card = make("div", "card reading-top");
  card.appendChild(make("div", "card-kicker", title));
  if (!lines.length) {
    card.appendChild(make("p", "books-small", empty));
    return card;
  }
  const peak = lines[0].minutes || 1;
  for (const line of lines) {
    const row = make("div", "reading-top-row");
    const bar = make("span", "reading-top-bar");
    const fill = make("span", "reading-top-fill");
    fill.style.width = `${Math.max(3, (line.minutes / peak) * 100)}%`;
    bar.appendChild(fill);
    row.append(
      Object.assign(make("span", "reading-top-name", line.name), { title: line.name }),
      bar,
      make("span", "books-small", `${formatReadingTime(line.minutes)} · ${line.readings}×`)
    );
    card.appendChild(row);
  }
  return card;
}

/** The Stats pane's reading section. */
export function readingStatsSection(log: ReadingLogView, onChanged: () => void): HTMLElement {
  const stats = readingStats(log.readings, log.credits, localToday());
  const section = make("section", "reading-stats");
  section.appendChild(make("h6", "kicker books-section", "Reading time"));

  if (!stats.readings) {
    section.appendChild(
      make(
        "p",
        "books-small",
        "Nothing logged yet. On a book's page, \"Log reading\" records the issues you read and the day; on an issue's page you can log each reading, including re-reads."
      )
    );
  } else {
    const tiles = make("div", "books-stat-tiles");
    for (const [label, value] of [
      ["Time reading", formatReadingTime(stats.totalMinutes)],
      ["This month", formatReadingTime(stats.thisMonthMinutes)],
      ["This year", formatReadingTime(stats.thisYearMinutes)],
      ["Readings", `${stats.readings} of ${stats.issues} issues`],
      ["Read again", `${stats.reread} issue${stats.reread === 1 ? "" : "s"}`],
    ] as const) {
      const tile = make("div", "card books-stat");
      tile.append(make("div", "card-kicker", label), make("h2", "books-stat-value", value));
      tiles.appendChild(tile);
    }
    section.appendChild(tiles);
  }

  // The estimate new readings take.
  const estimate = make("div", "reading-estimate");
  const minutes = make("input", "input reading-minutes");
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "240";
  minutes.value = String(log.minutesPerIssue);
  minutes.setAttribute("aria-label", "Minutes per issue");
  const note = make("span", "books-small");
  minutes.addEventListener("change", async () => {
    try {
      await bridge().setMinutesPerIssue(Number(minutes.value));
      note.textContent = "Saved — new readings use it; logged ones keep theirs.";
    } catch (err) {
      note.textContent = errorText(err);
    }
  });
  estimate.append(
    make("span", "books-small", "A single issue takes about"),
    minutes,
    make("span", "books-small", "minutes to read (a 20–24 page issue at an easy pace is 10–15)."),
    note
  );
  section.appendChild(estimate);

  if (!stats.readings) return section;

  if (stats.withoutCredits > 0) {
    const fill = make("div", "reading-estimate");
    const status = make(
      "span",
      "books-small",
      `${stats.withoutCredits} issue${stats.withoutCredits === 1 ? " hasn't" : "s haven't"} been looked up yet, so their characters and creators aren't counted.`
    );
    const go = button("Look them up on GCD", "btn btn-secondary", async () => {
      go.disabled = true;
      let done = 0;
      try {
        for (;;) {
          const result = await bridge().fillReadingCredits(5);
          done += result.filled + result.notFound;
          status.textContent = `Looked up ${done} — ${result.left} to go (GCD asks for a second between lookups).`;
          if (!result.left || !(result.filled + result.notFound)) break;
        }
        onChanged();
      } catch (err) {
        status.textContent = errorText(err);
        go.disabled = false;
      }
    });
    fill.append(status, go);
    section.appendChild(fill);
  }

  const grid = make("div", "reading-top-grid");
  grid.append(
    timeList("Series", stats.bySeries, "—"),
    timeList("Characters", stats.byCharacter, "Look the issues up on GCD to see who's in them."),
    timeList("Writers", stats.byWriter, "Look the issues up on GCD to see who wrote them."),
    timeList("Artists", stats.byArtist, "Look the issues up on GCD to see who drew them.")
  );
  section.appendChild(grid);

  const recent = make("div", "card reading-top");
  recent.appendChild(make("div", "card-kicker", "Latest readings"));
  for (const r of stats.recent) {
    const row = make("div", "reading-row");
    row.append(
      make("span", undefined, `${r.year ? `${r.series} (${r.year})` : r.series} #${r.number}`),
      make("span", "books-small", `${dayLabel(r.readOn)} · ${formatReadingTime(r.minutes)}`)
    );
    recent.appendChild(row);
  }
  section.appendChild(recent);
  return section;
}
