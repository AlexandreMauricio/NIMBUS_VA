/**
 * The Books view of the Collections tab — comics collected editions and
 * manga volumes, and what they cover. Contents are parsed live as you type
 * with the same parser the main process saves with (src/collections/books/
 * runs.ts, pure and shared), so the preview is exactly what will be kept.
 */
import { formatRuns, parseRuns } from "../collections/books/runs";

interface IssueRunUI {
  series: string;
  year: number | null;
  from: number;
  to: number;
  partial: boolean;
}

interface BookUI {
  id: string;
  kind: "comic" | "manga";
  title: string;
  volume: string | null;
  format: string;
  publisher: string | null;
  isbn: string | null;
  status: "owned" | "wishlist";
  runs: IssueRunUI[];
  notes: string | null;
  source: string | null;
}

interface BookRefUI {
  id: string;
  label: string;
}

interface SeriesCoverageUI {
  key: string;
  series: string;
  year: number | null;
  segments: Array<{ from: number; to: number; books: BookRefUI[]; partial: boolean }>;
  gaps: Array<{ from: number; to: number; wishlist: BookRefUI[] }>;
  ownedIssues: number;
  duplicatedIssues: number;
}

interface GcdSeriesUI {
  id: number;
  name: string;
  yearBegan: number | null;
  publisher: string | null;
  volumes: Array<{ issueId: number; descriptor: string }>;
}

interface GcdVolumeUI {
  issueId: number;
  seriesName: string;
  descriptor: string;
  isbn: string | null;
  publisher: string | null;
  format: string;
  runs: IssueRunUI[];
  unread: string[];
  notes: string | null;
}

interface BooksBridge {
  getBooks(
    filter: Record<string, unknown>
  ): Promise<{ books: BookUI[]; coverage: SeriesCoverageUI[]; formats: string[] }>;
  searchComicSeries(name: string): Promise<GcdSeriesUI[]>;
  getComicVolume(issueId: number): Promise<GcdVolumeUI>;
  addBook(input: Record<string, unknown>): Promise<{ book: BookUI; unread: string[] }>;
  updateBook(id: string, input: Record<string, unknown>): Promise<{ book: BookUI; unread: string[] }>;
  removeBook(id: string): Promise<boolean>;
  onBooksChanged(callback: () => void): () => void;
}

function bridge(): BooksBridge {
  return (window as unknown as { nimbus: BooksBridge }).nimbus;
}

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

const range = (from: number, to: number): string => (from === to ? `#${from}` : `#${from}–${to}`);
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initBooksTab(): void {
  const query = byId<HTMLInputElement>("bookSeriesQuery");
  const searchBtn = byId<HTMLButtonElement>("bookSeriesSearchBtn");
  const manualBtn = byId<HTMLButtonElement>("bookAddManualBtn");
  const searchStatus = byId<HTMLElement>("bookSearchStatus");
  const seriesResults = byId<HTMLElement>("bookSeriesResults");
  const volumeResults = byId<HTMLElement>("bookVolumeResults");

  const form = byId<HTMLElement>("bookForm");
  const heading = byId<HTMLElement>("bookFormHeading");
  const notice = byId<HTMLElement>("bookFormNotice");
  const kind = byId<HTMLSelectElement>("bookKind");
  const title = byId<HTMLInputElement>("bookTitle");
  const volume = byId<HTMLInputElement>("bookVolume");
  const format = byId<HTMLSelectElement>("bookFormat");
  const publisher = byId<HTMLInputElement>("bookPublisher");
  const isbn = byId<HTMLInputElement>("bookIsbn");
  const status = byId<HTMLSelectElement>("bookStatus");
  const runs = byId<HTMLTextAreaElement>("bookRuns");
  const preview = byId<HTMLElement>("bookRunsPreview");
  const notes = byId<HTMLInputElement>("bookNotes");
  const formError = byId<HTMLElement>("bookFormError");
  const saveBtn = byId<HTMLButtonElement>("bookSaveBtn");
  const cancelBtn = byId<HTMLButtonElement>("bookCancelBtn");

  const coverageEl = byId<HTMLElement>("bookCoverage");
  const coverageEmpty = byId<HTMLElement>("bookCoverageEmpty");
  const filterKind = byId<HTMLSelectElement>("bookFilterKind");
  const filterStatus = byId<HTMLSelectElement>("bookFilterStatus");
  const filterText = byId<HTMLInputElement>("bookFilterText");
  const list = byId<HTMLElement>("bookList");
  const empty = byId<HTMLElement>("bookEmpty");
  const errorEl = byId<HTMLElement>("bookError");

  let editingId: string | null = null;
  let source: string | null = null;
  let formatsFilled = false;

  const show = (el: HTMLElement, message: string | null): void => {
    el.textContent = message ?? "";
    el.hidden = !message;
  };
  const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

  function renderPreview(): void {
    const parsed = parseRuns(runs.value);
    if (!runs.value.trim()) {
      preview.textContent =
        "Write each run as Series (year) #from-to, separated by ; — e.g. Thor (1966) #126-130; Annual #2";
      return;
    }
    const read = parsed.runs.length
      ? `Reads as: ${parsed.runs.map((r) => `${r.partial ? "part of " : ""}${r.series}${r.year ? ` (${r.year})` : ""} ${range(r.from, r.to)}`).join(" · ")}`
      : "Nothing readable yet.";
    preview.textContent = parsed.unread.length
      ? `${read} — couldn't read: ${parsed.unread.join(", ")}`
      : read;
  }

  function openForm(values: Partial<BookUI> & { runsText?: string }, message: string | null): void {
    form.hidden = false;
    heading.textContent = editingId ? "Edit book" : "Add a book";
    show(notice, message);
    show(formError, null);
    kind.value = values.kind ?? "comic";
    title.value = values.title ?? "";
    volume.value = values.volume ?? "";
    format.value = values.format ?? (kind.value === "manga" ? "Manga volume" : "Other");
    publisher.value = values.publisher ?? "";
    isbn.value = values.isbn ?? "";
    status.value = values.status ?? "owned";
    runs.value = values.runsText ?? (values.runs ? formatRuns(values.runs) : "");
    notes.value = values.notes ?? "";
    renderPreview();
    form.scrollIntoView({ block: "nearest" });
    title.focus();
  }

  function closeForm(): void {
    form.hidden = true;
    editingId = null;
    source = null;
  }

  async function load(): Promise<void> {
    try {
      const view = await bridge().getBooks({
        ...(filterKind.value ? { kind: filterKind.value } : {}),
        ...(filterStatus.value ? { status: filterStatus.value } : {}),
        ...(filterText.value.trim() ? { text: filterText.value.trim() } : {}),
      });
      if (!formatsFilled) {
        formatsFilled = true;
        for (const name of view.formats) {
          const option = make("option", undefined, name);
          option.value = name;
          format.appendChild(option);
        }
      }
      renderCoverage(view.coverage);
      renderBooks(view.books);
      show(errorEl, null);
    } catch (err) {
      show(errorEl, `Couldn't load books: ${errorText(err)}`);
    }
  }

  function renderCoverage(coverage: SeriesCoverageUI[]): void {
    coverageEl.replaceChildren();
    coverageEmpty.hidden = coverage.length > 0;
    for (const series of coverage) {
      const card = make("div", "book-coverage");
      const head = make("div", "book-coverage-head");
      head.appendChild(
        make("span", "collection-name", `${series.series}${series.year ? ` (${series.year})` : ""}`)
      );
      const missing = series.gaps.reduce((sum, gap) => sum + gap.to - gap.from + 1, 0);
      const facts = [
        `${series.ownedIssues} owned`,
        series.duplicatedIssues ? `${series.duplicatedIssues} held twice` : null,
        missing ? `${missing} missing` : "no gaps",
      ].filter(Boolean);
      head.appendChild(make("span", "collection-meta", facts.join(" · ")));
      card.appendChild(head);

      // Owned ranges and gaps, interleaved in issue order.
      const lines: Array<{ at: number; el: HTMLElement }> = [];
      for (const segment of series.segments) {
        const line = make("div", "book-coverage-line");
        line.appendChild(make("span", "book-coverage-range", range(segment.from, segment.to)));
        line.appendChild(make("span", undefined, segment.books.map((b) => b.label).join(" + ")));
        if (segment.books.length > 1) line.appendChild(make("span", "tag tag-neutral", "duplicate"));
        if (segment.partial) line.appendChild(make("span", "tag tag-neutral", "partial"));
        lines.push({ at: segment.from, el: line });
      }
      for (const gap of series.gaps) {
        const line = make("div", "book-coverage-line book-coverage-gap");
        line.appendChild(make("span", "book-coverage-range", range(gap.from, gap.to)));
        line.appendChild(
          make(
            "span",
            undefined,
            gap.wishlist.length
              ? `Missing — on your wishlist: ${gap.wishlist.map((b) => b.label).join(", ")}`
              : "Missing"
          )
        );
        lines.push({ at: gap.from, el: line });
      }
      lines.sort((a, b) => a.at - b.at).forEach((line) => card.appendChild(line.el));
      coverageEl.appendChild(card);
    }
  }

  function renderBooks(books: BookUI[]): void {
    list.replaceChildren();
    empty.hidden = books.length > 0;
    for (const book of books) {
      const row = make("div", "memory-row");
      const head = make("div", "memory-row-head");
      head.appendChild(make("span", "memory-title", `${book.title}${book.volume ? ` ${book.volume}` : ""}`));
      head.appendChild(make("span", "tag tag-neutral", book.format));
      if (book.status === "wishlist") head.appendChild(make("span", "tag tag-neutral", "Wishlist"));
      row.appendChild(head);
      row.appendChild(
        make(
          "div",
          "memory-body",
          book.runs.length ? formatRuns(book.runs) : "Contents not entered — edit to add what it collects"
        )
      );
      const meta = [
        book.publisher,
        book.isbn ? `ISBN ${book.isbn}` : null,
        book.source?.startsWith("gcd:") ? "from GCD" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (meta) row.appendChild(make("div", "memory-meta", meta));

      const actions = make("div", "memory-actions");
      const edit = make("button", "btn btn-ghost", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        editingId = book.id;
        source = book.source;
        openForm(book, null);
      });
      const move = make("button", "btn btn-ghost", book.status === "wishlist" ? "Got it" : "To wishlist");
      move.type = "button";
      move.addEventListener("click", async () => {
        try {
          await bridge().updateBook(book.id, { status: book.status === "wishlist" ? "owned" : "wishlist" });
          await load();
        } catch (err) {
          show(errorEl, errorText(err));
        }
      });
      const remove = make("button", "btn btn-ghost", "Remove");
      remove.type = "button";
      let armed: ReturnType<typeof setTimeout> | null = null;
      remove.addEventListener("click", async () => {
        if (!armed) {
          remove.textContent = "Click again to remove";
          armed = setTimeout(() => {
            armed = null;
            remove.textContent = "Remove";
          }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        await bridge().removeBook(book.id);
        if (editingId === book.id) closeForm();
        await load();
      });
      actions.append(edit, move, remove);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  async function searchSeries(): Promise<void> {
    searchBtn.disabled = true;
    show(searchStatus, "Searching the Grand Comics Database…");
    seriesResults.replaceChildren();
    volumeResults.replaceChildren();
    try {
      const found = await bridge().searchComicSeries(query.value);
      show(
        searchStatus,
        found.length ? "Pick a series:" : "No series by that name on GCD. You can add it by hand."
      );
      for (const series of found) {
        const pick = make(
          "button",
          "btn btn-ghost book-pick",
          `${series.name}${series.yearBegan ? ` (${series.yearBegan})` : ""} — ${series.volumes.length} vol.`
        );
        pick.type = "button";
        pick.addEventListener("click", () => showVolumes(series));
        seriesResults.appendChild(pick);
      }
    } catch (err) {
      show(searchStatus, errorText(err));
    } finally {
      searchBtn.disabled = false;
    }
  }

  function showVolumes(series: GcdSeriesUI): void {
    seriesResults.replaceChildren();
    show(searchStatus, `${series.name}: pick a volume`);
    volumeResults.replaceChildren();
    for (const entry of series.volumes) {
      const pick = make("button", "btn btn-ghost book-pick", entry.descriptor);
      pick.type = "button";
      pick.addEventListener("click", async () => {
        show(searchStatus, "Reading that volume from GCD…");
        try {
          const found = await bridge().getComicVolume(entry.issueId);
          editingId = null;
          source = `gcd:${found.issueId}`;
          volumeResults.replaceChildren();
          show(searchStatus, null);
          openForm(
            {
              kind: "comic",
              title: found.seriesName,
              volume: found.descriptor,
              format: found.format,
              publisher: found.publisher ?? series.publisher ?? "",
              isbn: found.isbn,
              runs: found.runs,
            },
            found.runs.length
              ? found.unread.length
                ? `Filled in from GCD's note, except: ${found.unread.join(", ")}. Check it matches your copy.`
                : "Contents filled in from GCD's note. Check it matches your copy."
              : "GCD doesn't list what this volume collects — type the issue runs below."
          );
        } catch (err) {
          show(searchStatus, errorText(err));
        }
      });
      volumeResults.appendChild(pick);
    }
  }

  async function save(): Promise<void> {
    const input = {
      kind: kind.value,
      title: title.value,
      volume: volume.value,
      format: format.value,
      publisher: publisher.value,
      isbn: isbn.value,
      status: status.value,
      runs: runs.value,
      notes: notes.value,
      source,
    };
    saveBtn.disabled = true;
    try {
      const result = editingId ? await bridge().updateBook(editingId, input) : await bridge().addBook(input);
      closeForm();
      await load();
      if (result.unread.length) show(errorEl, `Saved — but couldn't read: ${result.unread.join(", ")}`);
    } catch (err) {
      show(formError, errorText(err));
    } finally {
      saveBtn.disabled = false;
    }
  }

  searchBtn.addEventListener("click", () => void searchSeries());
  query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchSeries();
  });
  manualBtn.addEventListener("click", () => {
    editingId = null;
    source = null;
    openForm({}, null);
  });
  kind.addEventListener("change", () => {
    if (kind.value === "manga" && format.value === "Other") format.value = "Manga volume";
  });
  runs.addEventListener("input", renderPreview);
  saveBtn.addEventListener("click", () => void save());
  cancelBtn.addEventListener("click", closeForm);

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  filterText.addEventListener("input", () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void load(), 200);
  });
  filterKind.addEventListener("change", () => void load());
  filterStatus.addEventListener("change", () => void load());

  bridge().onBooksChanged(() => void load());
  void load();
}
