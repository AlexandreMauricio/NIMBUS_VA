/**
 * The Books tab — four pages deep:
 *
 *   Shelf (Shelf / Reading / Wishlist / Stats)
 *     → a series ("Thor": its collected editions)
 *       → a book (the issues it collects, and how many copies of each you own)
 *         → a single issue (credits, story, characters — from GCD — and links
 *           out to League of Comic Geeks and the GCD page)
 *
 * The shelf's grouping and each book's issue list are worked out here with
 * the same pure Core functions the main process uses (src/collections/
 * books/shelf.ts, coverage.ts, runs.ts). Everything that reaches a network
 * — GCD lookups, covers, opening a link — goes through the preload bridge,
 * and the main process builds every address.
 */
import { formatRuns, parseRuns } from "../collections/books/runs";
import { coverUrlForIsbn, isChosenCover } from "../collections/books/covers";
import {
  BOOK_ORDERS,
  BookOrder,
  GROUP_ORDERS,
  GroupOrder,
  bookIssues,
  bookProgress,
  readingStatus,
  bookOverlap,
  groupShelf,
  shelfName,
  shelfStats,
  BookIssue,
} from "../collections/books/shelf";
import type { Book } from "../collections/books/types";
import type { SeriesCoverage } from "../collections/books/coverage";
import type { GcdIssueDetail } from "../collections/books/gcd";
import {
  ReadingLogView,
  issueReadingList,
  logReadingForm,
  readingStatsSection,
  readingSummary,
} from "./readingLog";
import { seriesYearsPanel } from "./seriesYearsPanel";
import { creditsEditor } from "./creditsEditor";
import { VaultBridge, VaultSnapshotUI, vaultByBook, vaultPane, vaultPanel, vaultTag } from "./booksVault";
import { bookFromVault } from "../collections/books/vault";
import type { VaultBook } from "../collections/books/vault";

interface GcdSeriesUI {
  id: number;
  name: string;
  yearBegan: number | null;
  yearEnded: number | null;
  publisher: string | null;
  binding: string | null;
  publishingFormat: string | null;
  language: string | null;
  dimensions: string | null;
  volumes: Array<{ issueId: number; descriptor: string }>;
}

interface GcdVolumeUI {
  issueId: number;
  seriesName: string;
  descriptor: string;
  isbn: string | null;
  publisher: string | null;
  publicationDate: string | null;
  pageCount: number | null;
  price: string | null;
  format: string;
  runs: Book["runs"];
  unread: string[];
  notes: string | null;
  /** Where the contents came from: "gcd", a Wikipedia list's name, or null if neither had them. */
  contentsFrom: string | null;
}

interface ContentsUI {
  list: string;
  title: string | null;
  contents: string;
  runs: Book["runs"];
  unread: string[];
}

interface EditionUI extends ContentsUI {
  bookTitle: string;
  volume: string | null;
  format: Book["format"];
  isbn: string | null;
}

interface BooksBridge extends VaultBridge {
  getBooks(filter: Record<string, unknown>): Promise<{
    books: Book[];
    coverage: SeriesCoverage[];
    formats: string[];
    readIssues: string[];
    readingLog: ReadingLogView;
  }>;
  setIssuesRead(
    issues: Array<{ series: string; year: number | null; number: number }>,
    read: boolean
  ): Promise<number>;
  chooseBookCover(id: string): Promise<boolean>;
  clearBookCover(id: string): Promise<boolean>;
  searchComicSeries(name: string): Promise<GcdSeriesUI[]>;
  getComicVolume(issueId: number): Promise<GcdVolumeUI>;
  getComicIssue(series: string, year: number | null, number: number): Promise<GcdIssueDetail | null>;
  findBookContents(isbn: string): Promise<ContentsUI | null>;
  searchBookEditions(query: string): Promise<EditionUI[]>;
  openComicLink(site: "locg" | "gcd", lookup: { text?: string; gcdIssueId?: number }): Promise<boolean>;
  addBook(input: Record<string, unknown>): Promise<{ book: Book; unread: string[] }>;
  updateBook(id: string, input: Record<string, unknown>): Promise<{ book: Book; unread: string[] }>;
  removeBook(id: string): Promise<boolean>;
  onBooksChanged(callback: () => void): () => void;
}

type Page =
  | { view: "shelf" }
  | { view: "series"; name: string }
  | { view: "book"; id: string }
  | { view: "issue"; bookId: string; series: string; year: number | null; number: number }
  | { view: "add" };

type Pane = "shelf" | "reading" | "wishlist" | "stats" | "vault";

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

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const range = (from: number, to: number): string => (from === to ? `#${from}` : `#${from}–${to}`);
const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");
const KIND_LABEL: Record<Book["kind"], string> = { comic: "Comic", manga: "Manga", novel: "Novel" };
const KIND_TAG: Record<Book["kind"], string> = {
  comic: "tag-accent",
  manga: "tag-accent-2",
  novel: "tag-neutral",
};
const seriesLabel = (series: string, year: number | null) => `${series}${year ? ` (${year})` : ""}`;
/** "Thor Epic Collection" + "1 - The God of Thunder" → "Thor Epic Collection Vol. 1: The God of Thunder". */
function bookTitle(book: Pick<Book, "title" | "volume">): string {
  if (!book.volume) return book.title;
  const named = book.volume.match(/^(\d+)\s*[-–—:]\s*(.+)$/);
  if (named) return `${book.title} Vol. ${named[1]}: ${named[2]}`;
  return /^\d+$/.test(book.volume) ? `${book.title} Vol. ${book.volume}` : `${book.title} ${book.volume}`;
}

/** A cover, or a quiet placeholder with the title when there isn't one. */
function cover(url: string | null, label: string, className = "books-cover"): HTMLElement {
  const wrap = make("div", className);
  if (url) {
    const img = make("img");
    img.src = url;
    img.alt = label;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.replaceWith(make("span", "books-cover-placeholder", label)));
    wrap.appendChild(img);
  } else {
    wrap.appendChild(make("span", "books-cover-placeholder", label));
  }
  return wrap;
}

function progressBar(percent: number, className = "books-progress"): HTMLElement {
  const track = make("div", className);
  const fill = make("div", "books-progress-fill");
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  track.appendChild(fill);
  return track;
}

function backLink(label: string, onClick: () => void): HTMLElement {
  const back = make("button", "books-back", `← ${label}`);
  back.type = "button";
  back.addEventListener("click", onClick);
  return back;
}

/**
 * GCD writes characters as "The Asgardians [Balder (guest); Loki (villain)];
 * Beta Ray Bill (antagonist)" — split at the top level into one entry each.
 */
function characterList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.slice(0, 60);
}

export function initBooksTab(): void {
  const shelfView = byId<HTMLElement>("booksShelfView");
  const detailView = byId<HTMLElement>("booksDetailView");
  const addView = byId<HTMLElement>("booksAddView");
  const errorEl = byId<HTMLElement>("bookError");

  const panes: Record<Pane, HTMLElement> = {
    shelf: byId("booksPaneShelf"),
    reading: byId("booksPaneReading"),
    wishlist: byId("booksPaneWishlist"),
    stats: byId("booksPaneStats"),
    vault: byId("booksPaneVault"),
  };
  /** The comics vault as last read (read-only), and its notes by NIMBUS book id. */
  let vault: VaultSnapshotUI | null = null;
  let vaultNotes = new Map<string, VaultBook>();
  const grid = byId<HTMLElement>("bookGrid");
  const empty = byId<HTMLElement>("bookEmpty");
  const readingList = byId<HTMLElement>("bookReadingList");
  const wishlistList = byId<HTMLElement>("bookWishlistList");
  const statsEl = byId<HTMLElement>("bookStats");
  const coverageEl = byId<HTMLElement>("bookCoverage");
  const coverageEmpty = byId<HTMLElement>("bookCoverageEmpty");
  const filterKind = byId<HTMLSelectElement>("bookFilterKind");
  const shelfSort = byId<HTMLSelectElement>("bookShelfSort");
  const shelfLayoutBtn = byId<HTMLButtonElement>("bookShelfLayout");
  const filterStatus = byId<HTMLSelectElement>("bookFilterStatus");
  const filterText = byId<HTMLInputElement>("bookFilterText");

  // The add/edit form (kept from before, now its own page).
  const query = byId<HTMLInputElement>("bookSeriesQuery");
  const searchBtn = byId<HTMLButtonElement>("bookSeriesSearchBtn");
  const manualBtn = byId<HTMLButtonElement>("bookAddManualBtn");
  const searchStatus = byId<HTMLElement>("bookSearchStatus");
  const seriesResults = byId<HTMLElement>("bookSeriesResults");
  const volumeResults = byId<HTMLElement>("bookVolumeResults");
  const editionStatus = byId<HTMLElement>("bookEditionStatus");
  const editionResults = byId<HTMLElement>("bookEditionResults");
  const form = byId<HTMLElement>("bookForm");
  const heading = byId<HTMLElement>("bookFormHeading");
  const notice = byId<HTMLElement>("bookFormNotice");
  const kind = byId<HTMLSelectElement>("bookKind");
  const title = byId<HTMLInputElement>("bookTitle");
  const volume = byId<HTMLInputElement>("bookVolume");
  const format = byId<HTMLSelectElement>("bookFormat");
  const publisher = byId<HTMLInputElement>("bookPublisher");
  const author = byId<HTMLInputElement>("bookAuthor");
  const shelf = byId<HTMLInputElement>("bookShelf");
  const progress = byId<HTMLInputElement>("bookProgress");
  const isbn = byId<HTMLInputElement>("bookIsbn");
  const status = byId<HTMLSelectElement>("bookStatus");
  const runs = byId<HTMLTextAreaElement>("bookRuns");
  const preview = byId<HTMLElement>("bookRunsPreview");
  const notes = byId<HTMLInputElement>("bookNotes");
  const formError = byId<HTMLElement>("bookFormError");
  const saveBtn = byId<HTMLButtonElement>("bookSaveBtn");
  const cancelBtn = byId<HTMLButtonElement>("bookCancelBtn");
  const findContentsBtn = byId<HTMLButtonElement>("bookFindContentsBtn");
  const findContentsStatus = byId<HTMLElement>("bookFindContentsStatus");

  let books: Book[] = [];
  let coverage: SeriesCoverage[] = [];
  /** Issues read, shared by every book that collects them. */
  let readIssues: ReadonlySet<string> = new Set();
  let readingLog: ReadingLogView = {
    readings: [],
    credits: {},
    gcdCredits: {},
    customCredits: {},
    useCustom: [],
    minutesPerIssue: 12,
    undated: [],
  };
  const progressOf = (book: Book) => bookProgress(book, books, readIssues);
  let formatsFilled = false;
  let pane: Pane = "shelf";
  let page: Page = { view: "shelf" };
  /** Where "back" goes from the add form — the page it was opened from. */
  let returnTo: Page = { view: "shelf" };
  let editingId: string | null = null;
  let source: string | null = null;
  // Sort orders, remembered on this PC.
  const remembered = <T extends string>(key: string, allowed: readonly { id: T }[], fallback: T): T => {
    try {
      const value = localStorage.getItem(key);
      return allowed.some((o) => o.id === value) ? (value as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const remember = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A convenience only.
    }
  };
  let groupOrder = remembered<GroupOrder>("nimbus:books-shelf-sort", GROUP_ORDERS, "name");
  let bookOrder = remembered<BookOrder>("nimbus:books-series-sort", BOOK_ORDERS, "volume");
  for (const order of GROUP_ORDERS) shelfSort.appendChild(new Option(`Sort: ${order.label}`, order.id));
  shelfSort.value = groupOrder;
  let shelfLayout: "grid" | "list" = remembered<"grid" | "list">(
    "nimbus:books-shelf-layout",
    [{ id: "grid" }, { id: "list" }],
    "grid"
  );
  const showLayout = () => {
    shelfLayoutBtn.textContent = shelfLayout === "grid" ? "List view" : "Grid view";
    shelfLayoutBtn.setAttribute("aria-pressed", String(shelfLayout === "list"));
  };
  showLayout();
  shelfLayoutBtn.addEventListener("click", () => {
    shelfLayout = shelfLayout === "grid" ? "list" : "grid";
    remember("nimbus:books-shelf-layout", shelfLayout);
    showLayout();
    render();
  });
  shelfSort.addEventListener("change", () => {
    groupOrder = shelfSort.value as GroupOrder;
    remember("nimbus:books-shelf-sort", groupOrder);
    render();
  });
  /** Issue pages already looked up this session, by "series|year|number". */
  const issueCache = new Map<string, GcdIssueDetail | null>();

  const show = (el: HTMLElement, message: string | null): void => {
    el.textContent = message ?? "";
    el.hidden = !message;
  };

  function go(next: Page): void {
    page = next;
    render();
    document.getElementById("tab-books")?.scrollIntoView({ block: "start" });
  }

  async function load(): Promise<void> {
    try {
      const view = await bridge().getBooks({});
      books = view.books;
      coverage = view.coverage;
      readIssues = new Set(view.readIssues ?? []);
      readingLog = view.readingLog ?? readingLog;
      try {
        vault = await bridge().getComicsVault();
      } catch {
        vault = null;
      }
      vaultNotes = vaultByBook(vault, books);
      if (!formatsFilled) {
        formatsFilled = true;
        for (const name of view.formats) format.appendChild(new Option(name, name));
      }
      show(errorEl, null);
      render();
    } catch (err) {
      show(errorEl, `Couldn't load books: ${errorText(err)}`);
    }
  }

  function render(): void {
    shelfView.hidden = page.view !== "shelf";
    detailView.hidden = page.view === "shelf" || page.view === "add";
    addView.hidden = page.view !== "add";
    if (page.view === "shelf") renderShelf();
    else if (page.view === "series") renderSeries(page.name);
    else if (page.view === "book") renderBook(page.id);
    else if (page.view === "issue") void renderIssue(page);
  }

  // ------------------------------------------------------------------ shelf

  function filtered(): Book[] {
    const needle = filterText.value.trim().toLowerCase();
    return books
      .filter((b) => !filterKind.value || b.kind === filterKind.value)
      .filter((b) => !filterStatus.value || b.status === filterStatus.value)
      .filter(
        (b) =>
          !needle ||
          [
            b.title,
            b.volume ?? "",
            b.publisher ?? "",
            b.author ?? "",
            shelfName(b),
            ...b.runs.map((r) => r.series),
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)
      );
  }

  function renderShelf(): void {
    document.querySelectorAll<HTMLButtonElement>(".books-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.booksPane === pane);
    });
    (Object.keys(panes) as Pane[]).forEach((key) => (panes[key].hidden = key !== pane));

    if (pane === "shelf") {
      grid.replaceChildren();
      const groups = groupShelf(filtered(), books, readIssues, bookOrder, groupOrder);
      empty.hidden = groups.length > 0;
      grid.classList.toggle("books-grid", shelfLayout === "grid");
      grid.classList.toggle("books-list", shelfLayout === "list");
      if (shelfLayout === "list") {
        for (const group of groups) grid.appendChild(shelfListRow(group));
      }
      for (const group of shelfLayout === "grid" ? groups : []) {
        const card = make("button", "books-card");
        card.type = "button";
        const coverWrap = cover(group.coverUrl, group.name, "books-cover books-card-cover");
        if (group.progress !== null && group.progress > 0) {
          const overlay = make("div", "books-cover-progress");
          overlay.appendChild(progressBar(group.progress));
          coverWrap.appendChild(overlay);
        }
        if (group.owned === 0)
          coverWrap.appendChild(make("span", "tag tag-outline books-cover-flag", "Wishlist"));
        card.appendChild(coverWrap);
        card.appendChild(make("p", "books-card-title", group.name));
        const count = group.books.length;
        const meta =
          group.kind === "comic"
            ? `${group.publisher ?? "Comic"} · ${count} ${count === 1 ? "book" : "books"}`
            : `${group.author ?? group.publisher ?? KIND_LABEL[group.kind]} · ${count === 1 ? KIND_LABEL[group.kind] : `${count} volumes`}`;
        card.appendChild(make("p", "books-card-meta", meta));
        card.appendChild(make("span", `tag ${KIND_TAG[group.kind]} books-card-tag`, KIND_LABEL[group.kind]));
        card.addEventListener("click", () =>
          count === 1 ? go({ view: "book", id: group.books[0].id }) : go({ view: "series", name: group.name })
        );
        grid.appendChild(card);
      }
    } else if (pane === "reading") {
      readingList.replaceChildren();
      const reading = books
        .map((book) => ({ book, percent: progressOf(book).percent }))
        .filter((entry) => readingStatus(entry.percent, entry.book.retired) === "Reading")
        .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
        .map((entry) => entry.book);
      const retired = books.filter((b) => readingStatus(progressOf(b).percent, b.retired) === "Retired");
      if (!reading.length) {
        readingList.appendChild(
          make(
            "p",
            "feed-empty",
            "Nothing in progress. Open a book and tick the issues you've read — or set how far you are in a novel."
          )
        );
      }
      for (const book of reading) readingList.appendChild(bookRow(book, "reading"));
      if (retired.length) {
        readingList.appendChild(make("h6", "kicker books-section", `Retired (${retired.length})`));
        readingList.appendChild(
          make("p", "books-small", "Books you stopped reading. Un-retire one to have it back in Reading.")
        );
        for (const book of retired) readingList.appendChild(bookRow(book, "retired"));
      }
    } else if (pane === "vault") {
      panes.vault.replaceChildren(
        vaultPane(vault, books, bridge(), {
          onAdd: addFromVault,
          onOpenBook: (id) => go({ view: "book", id }),
          onError: (message) => show(errorEl, message),
          onChanged: (next) => {
            vault = next;
            vaultNotes = vaultByBook(vault, books);
            render();
          },
        })
      );
    } else if (pane === "wishlist") {
      wishlistList.replaceChildren();
      const wanted = books.filter((b) => b.status === "wishlist");
      if (!wanted.length) wishlistList.appendChild(make("p", "feed-empty", "Your wishlist is empty."));
      for (const book of wanted) wishlistList.appendChild(bookRow(book, "wishlist"));
    } else {
      renderStats();
    }
  }

  /** The shelf's list view: one row per group — cover, name, what's in it, and progress. */
  function shelfListRow(group: ReturnType<typeof groupShelf>[number]): HTMLElement {
    const count = group.books.length;
    const row = make("button", "books-list-row");
    row.type = "button";
    row.appendChild(cover(group.coverUrl, group.name, "books-cover books-list-cover"));
    const body = make("div", "books-list-body");
    body.appendChild(make("span", "books-list-title", group.name));
    const years = new Set<number>();
    for (const b of group.books) for (const run of b.runs) if (run.year) years.add(run.year);
    const span = years.size ? `${Math.min(...years)}${years.size > 1 ? `–${Math.max(...years)}` : ""}` : null;
    body.appendChild(
      make(
        "span",
        "books-small",
        [
          group.kind === "comic"
            ? (group.publisher ?? "Comic")
            : (group.author ?? group.publisher ?? KIND_LABEL[group.kind]),
          `${count} ${count === 1 ? "book" : "books"}`,
          group.wishlist ? `${group.wishlist} on wishlist` : null,
          span ? `comics from ${span}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      )
    );
    row.appendChild(body);
    const progress = make("div", "books-list-progress");
    if (group.progress !== null && group.progress > 0) {
      progress.append(progressBar(group.progress), make("span", "books-small", `${group.progress}%`));
    } else {
      progress.appendChild(make("span", "books-small", group.owned ? "Not started" : "Wishlist"));
    }
    row.appendChild(progress);
    row.appendChild(make("span", `tag ${KIND_TAG[group.kind]}`, KIND_LABEL[group.kind]));
    row.addEventListener("click", () =>
      count === 1 ? go({ view: "book", id: group.books[0].id }) : go({ view: "series", name: group.name })
    );
    return row;
  }

  /** A row for Reading and Wishlist: cover, title, and the one action that page is for. */
  function bookRow(book: Book, kindOfRow: "reading" | "wishlist" | "retired"): HTMLElement {
    const row = make("div", "card books-row");
    const coverBtn = make("button", "books-row-cover");
    coverBtn.type = "button";
    coverBtn.appendChild(cover(book.coverUrl, book.title));
    coverBtn.addEventListener("click", () => go({ view: "book", id: book.id }));
    row.appendChild(coverBtn);
    const body = make("div", "books-row-body");
    const name = make("button", "books-link card-title", bookTitle(book));
    name.type = "button";
    name.addEventListener("click", () => go({ view: "book", id: book.id }));
    body.appendChild(name);
    const meta = [book.author ?? book.publisher, book.format].filter(Boolean).join(" · ");
    body.appendChild(make("p", "card-meta books-row-meta", meta));
    if (kindOfRow !== "wishlist") {
      const progress = progressOf(book);
      const line = make("div", "books-progress-line");
      line.append(
        progressBar(progress.percent ?? 0),
        make(
          "span",
          "books-small",
          progress.fromIssues
            ? `${progress.readIssues} of ${progress.totalIssues} issues read`
            : `${progress.percent}%`
        )
      );
      body.appendChild(line);
    } else {
      const overlap = bookOverlap(book, books);
      if (overlap.issues) {
        body.appendChild(
          make(
            "p",
            "books-small",
            overlap.ownedElsewhere
              ? `You already have ${overlap.ownedElsewhere} of its ${overlap.issues} issues`
              : `${overlap.issues} issues, none of them on your shelf yet`
          )
        );
      }
    }
    row.appendChild(body);
    if (kindOfRow === "retired") {
      row.appendChild(retireButton(book, "btn btn-secondary"));
    } else if (kindOfRow === "reading") {
      if (!progressOf(book).fromIssues) row.appendChild(progressEditor(book));
      row.appendChild(retireButton(book, "btn btn-ghost"));
    } else {
      row.appendChild(make("span", `tag ${KIND_TAG[book.kind]}`, KIND_LABEL[book.kind]));
      const got = make("button", "btn btn-secondary", "Mark owned");
      got.type = "button";
      got.addEventListener("click", () => void act(() => bridge().updateBook(book.id, { status: "owned" })));
      row.appendChild(got);
    }
    return row;
  }

  /** Retire a book you stopped reading, or bring it back. */
  function retireButton(book: Book, className: string): HTMLButtonElement {
    const button = make("button", className, book.retired ? "Un-retire" : "Retire");
    button.type = "button";
    button.title = book.retired
      ? "Start reading it again — it goes back to Reading"
      : "Stopped reading it — keep it off Reading";
    button.addEventListener(
      "click",
      () => void act(() => bridge().updateBook(book.id, { retired: !book.retired }))
    );
    return button;
  }

  /** "Update progress": a percentage, saved on change. */
  function progressEditor(book: Book): HTMLElement {
    const wrap = make("label", "books-progress-editor");
    wrap.appendChild(make("span", "books-small", "Read"));
    const input = make("input", "input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "5";
    input.value = book.progress === null ? "" : String(book.progress);
    input.placeholder = "—";
    input.addEventListener(
      "change",
      () =>
        void act(() =>
          bridge().updateBook(book.id, { progress: input.value === "" ? null : Number(input.value) })
        )
    );
    wrap.append(input, make("span", "books-small", "%"));
    return wrap;
  }

  function renderStats(): void {
    const stats = shelfStats(books, readIssues);
    statsEl.replaceChildren();
    const tiles = make("div", "books-stat-tiles");
    for (const [label, value] of [
      ["Owned volumes", stats.owned],
      ["Currently reading", stats.reading],
      ["On wishlist", stats.wishlist],
    ] as const) {
      const tile = make("div", "card books-stat");
      tile.append(make("div", "card-kicker", label), make("h2", "books-stat-value", String(value)));
      tiles.appendChild(tile);
    }
    statsEl.appendChild(tiles);
    statsEl.appendChild(
      make(
        "p",
        "books-small",
        `${stats.byKind.comic} comics · ${stats.byKind.manga} manga · ${stats.byKind.novel} novels owned · ${stats.finished} finished${stats.retired ? ` · ${stats.retired} retired` : ""}`
      )
    );
    statsEl.appendChild(readingStatsSection(readingLog));

    coverageEl.replaceChildren();
    coverageEmpty.hidden = coverage.length > 0;
    const list = make("div", "card books-coverage-card");
    for (const series of coverage) {
      const missing = series.gaps.reduce((sum, gap) => sum + gap.to - gap.from + 1, 0);
      const span = series.ownedIssues + missing;
      const item = make("details", "books-coverage-item");
      const summary = make("summary", "books-coverage-summary");
      const head = make("div", "books-coverage-head");
      head.append(
        make("span", undefined, seriesLabel(series.series, series.year)),
        make(
          "span",
          "books-small",
          `${series.ownedIssues} of ${span} issues${series.duplicatedIssues ? ` · ${series.duplicatedIssues} held twice` : ""}`
        )
      );
      summary.append(
        head,
        progressBar(span ? (series.ownedIssues / span) * 100 : 0, "books-progress books-progress-wide")
      );
      item.appendChild(summary);

      // Owned ranges and gaps, in issue order.
      const lines: Array<{ at: number; el: HTMLElement }> = [];
      for (const segment of series.segments) {
        const line = make("div", "book-coverage-line");
        line.append(
          make("span", "book-coverage-range", range(segment.from, segment.to)),
          make("span", undefined, segment.books.map((b) => b.label).join(" + "))
        );
        if (segment.books.length > 1) line.appendChild(make("span", "tag tag-neutral", "duplicate"));
        if (segment.partial) line.appendChild(make("span", "tag tag-neutral", "partial"));
        lines.push({ at: segment.from, el: line });
      }
      for (const gap of series.gaps) {
        const line = make("div", "book-coverage-line book-coverage-gap");
        line.append(
          make("span", "book-coverage-range", range(gap.from, gap.to)),
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
      lines.sort((a, b) => a.at - b.at).forEach((line) => item.appendChild(line.el));
      list.appendChild(item);
    }
    if (coverage.length) coverageEl.appendChild(list);
  }

  // ----------------------------------------------------------------- series

  function renderSeries(name: string): void {
    const members = groupShelf(books, books, readIssues, bookOrder).find(
      (g) => g.name.toLowerCase() === name.toLowerCase()
    );
    detailView.replaceChildren(backLink("Back to books", () => go({ view: "shelf" })));
    if (!members) {
      detailView.appendChild(make("p", "feed-empty", "Nothing on the shelf under that name any more."));
      return;
    }
    detailView.appendChild(
      make("span", `tag ${KIND_TAG[members.kind]} books-page-tag`, `${KIND_LABEL[members.kind]} series`)
    );
    detailView.appendChild(make("h2", "books-heading", members.name));
    detailView.appendChild(
      make(
        "p",
        "card-body books-intro",
        members.kind === "comic"
          ? "Collected editions and omnibuses on your shelf for this series. Open one to see which issues it collects and how much of it you own."
          : "The volumes on your shelf and wishlist for this series."
      )
    );
    const sortRow = make("div", "books-sort-row");
    const sort = make("select", "select");
    sort.setAttribute("aria-label", "Sort these books");
    for (const order of BOOK_ORDERS) sort.appendChild(new Option(`Sort: ${order.label}`, order.id));
    sort.value = bookOrder;
    sort.addEventListener("change", () => {
      bookOrder = sort.value as BookOrder;
      remember("nimbus:books-series-sort", bookOrder);
      render();
    });
    sortRow.appendChild(sort);
    if (bookOrder === "collected") {
      sortRow.appendChild(
        make("span", "books-small", "By the year and number of the first issue each book collects.")
      );
    }
    detailView.appendChild(sortRow);
    const list = make("div", "books-rows");
    for (const book of members.books) {
      const row = make("button", "card books-row books-row-link");
      row.type = "button";
      row.addEventListener("click", () => go({ view: "book", id: book.id }));
      const coverBox = make("div", "books-row-cover");
      coverBox.appendChild(cover(book.coverUrl, book.title));
      row.appendChild(coverBox);
      const body = make("div", "books-row-body");
      body.appendChild(make("p", "card-title books-row-title", bookTitle(book)));
      body.appendChild(
        make(
          "p",
          "card-meta books-row-meta",
          book.runs.length
            ? `Collects ${formatRuns(book.runs)}`
            : [book.author, book.format].filter(Boolean).join(" · ")
        )
      );
      const line = make("div", "books-progress-line");
      if (book.status === "owned") {
        const overlap = bookOverlap(book, books);
        const progress = progressOf(book);
        const status = readingStatus(progress.percent, book.retired);
        if (progress.percent !== null && progress.percent > 0)
          line.appendChild(progressBar(progress.percent));
        line.append(
          make(
            "span",
            "books-small",
            [
              status === "Reading" ? `Reading · ${progress.percent}%` : status,
              overlap.ownedElsewhere
                ? `${overlap.ownedElsewhere} of ${overlap.issues} issues also in other books`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
          )
        );
      } else {
        const overlap = bookOverlap(book, books);
        line.append(
          progressBar(overlap.issues ? (overlap.ownedElsewhere / overlap.issues) * 100 : 0),
          make(
            "span",
            "books-small",
            overlap.issues ? `You have ${overlap.ownedElsewhere} of ${overlap.issues} issues` : "Not owned"
          )
        );
      }
      body.appendChild(line);
      row.appendChild(body);
      if (book.status === "wishlist") row.appendChild(make("span", "tag tag-outline", "Wishlist"));
      const note = vaultNotes.get(book.id);
      const tag = note && note.status !== "owned" && note.status !== "wanted" ? vaultTag(note) : null;
      if (tag) row.appendChild(tag);
      list.appendChild(row);
    }
    detailView.appendChild(list);
  }

  // ------------------------------------------------------------------- book

  function renderBook(id: string): void {
    const book = books.find((b) => b.id === id);
    const group = book ? shelfName(book) : null;
    const siblings = group
      ? books.filter((b) => shelfName(b).toLowerCase() === group.toLowerCase()).length
      : 0;
    detailView.replaceChildren(
      siblings > 1 && group
        ? backLink(`Back to ${group}`, () => go({ view: "series", name: group }))
        : backLink("Back to books", () => go({ view: "shelf" }))
    );
    if (!book) {
      detailView.appendChild(make("p", "feed-empty", "That book is no longer on the shelf."));
      return;
    }
    const { issues, truncated } = bookIssues(book, books, readIssues);
    const progress = progressOf(book);
    const status = readingStatus(progress.percent, book.retired);

    const hero = make("div", "books-hero");
    const coverColumn = make("div", "books-hero-cover-column");
    const coverButton = make("button", "books-cover-button");
    coverButton.type = "button";
    coverButton.title = "Change the cover";
    coverButton.appendChild(cover(book.coverUrl, book.title, "books-cover books-hero-cover"));
    const changeCover = async () => {
      try {
        if (await bridge().chooseBookCover(book.id)) await load();
      } catch (err) {
        show(errorEl, errorText(err));
      }
    };
    coverButton.addEventListener("click", () => void changeCover());
    coverColumn.appendChild(coverButton);
    const coverTools = make("div", "books-cover-tools");
    const changeBtn = make("button", "btn btn-ghost", book.coverUrl ? "Change cover" : "Add a cover");
    changeBtn.type = "button";
    changeBtn.addEventListener("click", () => void changeCover());
    coverTools.appendChild(changeBtn);
    if (isChosenCover(book.coverUrl) || (book.coverUrl && coverUrlForIsbn(book.isbn) === book.coverUrl)) {
      const reset = make(
        "button",
        "btn btn-ghost",
        isChosenCover(book.coverUrl) ? (book.isbn ? "Use the ISBN's cover" : "Remove cover") : "Remove cover"
      );
      reset.type = "button";
      reset.addEventListener("click", () => void act(() => bridge().clearBookCover(book.id)));
      coverTools.appendChild(reset);
    }
    coverColumn.appendChild(coverTools);
    hero.appendChild(coverColumn);
    const info = make("div", "books-hero-info");
    const toolbar = make("div", "books-toolbar");
    const editTop = make("button", "btn btn-secondary", "Edit details");
    editTop.type = "button";
    editTop.addEventListener("click", () => openEditor(book));
    toolbar.appendChild(editTop);
    info.appendChild(toolbar);
    const kindText =
      book.kind === "comic"
        ? book.runs.length > 1 || issues.length > 1
          ? "Collected edition"
          : book.format
        : book.format;
    info.appendChild(
      make("span", `tag ${KIND_TAG[book.kind]} books-page-tag`, `${KIND_LABEL[book.kind]} · ${kindText}`)
    );
    info.appendChild(make("h2", "books-heading", bookTitle(book)));
    const about = [
      book.publisher ? `${book.publisher}.` : null,
      book.author ? `By ${book.author}.` : null,
      book.runs.length ? `Collects ${formatRuns(book.runs)}.` : null,
      book.source?.startsWith("gcd:") ? "Sourced from the Grand Comics Database." : null,
    ]
      .filter(Boolean)
      .join(" ");
    if (about) info.appendChild(make("p", "card-body books-intro", about));
    if (book.notes) info.appendChild(make("p", "books-small", book.notes));

    const facts = make("div", "books-facts");
    const fact = (label: string, value: string) => {
      const item = make("div");
      item.append(make("span", "books-fact-label", label), make("span", "books-fact-value", value));
      facts.appendChild(item);
    };
    fact("Shelf", book.status === "owned" ? "Owned" : "Wishlist");
    fact("Reading", status === "Reading" ? `Reading · ${progress.percent}%` : status);
    if (issues.length) {
      const twice = issues.filter((i) => i.copies > 1).length;
      const elsewhere = issues.filter((i) => i.elsewhere.some((b) => b.status === "owned")).length;
      if (book.status === "owned") {
        fact(
          "Issues",
          `${issues.length}${truncated ? "+" : ""}${twice ? ` · ${twice} also in other books` : ""}`
        );
      } else {
        fact("Already have", `${elsewhere} of ${issues.length} issues`);
      }
    }
    if (book.isbn) fact("ISBN", book.isbn);
    info.appendChild(facts);

    const progressLine = make("div", "books-progress-line books-hero-progress");
    progressLine.append(make("span", "books-fact-label", "Reading progress"));
    if (progress.fromIssues) {
      progressLine.append(
        progressBar(progress.percent ?? 0),
        make("span", "books-small", `${progress.readIssues} of ${progress.totalIssues} issues read`)
      );
      const all = issues.map((i) => ({ series: i.series, year: i.year, number: i.number }));
      if (progress.readIssues < progress.totalIssues) {
        const allRead = make("button", "btn btn-ghost", "Mark all read");
        allRead.type = "button";
        allRead.addEventListener("click", () => void act(() => bridge().setIssuesRead(all, true)));
        progressLine.appendChild(allRead);
      }
      if (progress.readIssues > 0) {
        const noneRead = make("button", "btn btn-ghost", "Mark all unread");
        noneRead.type = "button";
        noneRead.addEventListener("click", () => void act(() => bridge().setIssuesRead(all, false)));
        progressLine.appendChild(noneRead);
      }
    } else {
      if (book.progress !== null) progressLine.appendChild(progressBar(book.progress));
      progressLine.appendChild(progressEditor(book));
    }
    info.appendChild(progressLine);
    hero.appendChild(info);
    detailView.appendChild(hero);
    const note = vaultNotes.get(book.id);
    if (note) detailView.appendChild(vaultPanel(note, bridge()));

    const years = seriesYearsPanel(book);
    if (years) detailView.appendChild(years);

    if (issues.length) {
      detailView.appendChild(
        make("h6", "kicker books-section", book.kind === "manga" ? "Volumes" : "Issues collected")
      );
      if (book.kind === "comic") {
        const logBox = make("details", "reading-log-box");
        logBox.appendChild(make("summary", undefined, "Log a reading — which issues you read, and when"));
        logBox.appendChild(
          logReadingForm(
            issues.map((i) => ({ series: i.series, year: i.year, number: i.number })),
            readingLog,
            book.id,
            () => void load()
          )
        );
        detailView.appendChild(logBox);
      }
      const card = make("div", "card books-issues");
      for (const issue of issues) card.appendChild(issueRow(book, issue));
      if (truncated) card.appendChild(make("p", "books-small", "The list stops here — it's very long."));
      detailView.appendChild(card);
    } else if (book.kind === "comic") {
      const none = make("div", "books-actions books-actions-start");
      none.appendChild(
        make("p", "feed-empty", "No issues entered for this book — Edit details to add what it collects.")
      );
      if (book.isbn) {
        const find = make("button", "btn btn-secondary", "Find contents by ISBN");
        find.type = "button";
        const note = make("span", "books-small");
        find.addEventListener("click", async () => {
          find.disabled = true;
          note.textContent = "Looking through Wikipedia's lists…";
          try {
            const found = await bridge().findBookContents(book.isbn!);
            if (!found) {
              note.textContent = "Not in Wikipedia's lists — Edit details to type the runs.";
              find.disabled = false;
              return;
            }
            await bridge().updateBook(book.id, { runs: formatRuns(found.runs) });
            await load();
          } catch (err) {
            note.textContent = errorText(err);
            find.disabled = false;
          }
        });
        none.append(find, note);
      }
      detailView.appendChild(none);
    }

    const actions = make("div", "books-actions");
    const locg = make("button", "btn btn-ghost", "League of Comic Geeks");
    locg.type = "button";
    locg.addEventListener("click", () => void bridge().openComicLink("locg", { text: bookTitle(book) }));
    actions.appendChild(locg);
    if (book.source?.startsWith("gcd:")) {
      const gcd = make("button", "btn btn-ghost", "GCD page");
      gcd.type = "button";
      gcd.addEventListener(
        "click",
        () => void bridge().openComicLink("gcd", { gcdIssueId: Number(book.source!.slice(4)) })
      );
      actions.appendChild(gcd);
    }
    const move = make(
      "button",
      "btn btn-ghost",
      book.status === "wishlist" ? "Mark owned" : "Move to wishlist"
    );
    move.type = "button";
    move.addEventListener(
      "click",
      () =>
        void act(() =>
          bridge().updateBook(book.id, { status: book.status === "wishlist" ? "owned" : "wishlist" })
        )
    );
    const remove = make("button", "btn btn-ghost books-danger", "Remove from shelf");
    remove.type = "button";
    let armed: ReturnType<typeof setTimeout> | null = null;
    remove.addEventListener("click", async () => {
      if (!armed) {
        remove.textContent = "Click again to remove";
        armed = setTimeout(() => {
          armed = null;
          remove.textContent = "Remove from shelf";
        }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      await bridge().removeBook(book.id);
      page = { view: "shelf" };
      await load();
    });
    if (book.status === "owned" && status !== "Read") actions.append(retireButton(book, "btn btn-ghost"));
    actions.append(move, remove);
    detailView.appendChild(actions);
  }

  /** The add form, filled with a book, to change anything about it. */
  function openEditor(book: Book): void {
    editingId = book.id;
    source = book.source;
    returnTo = { view: "book", id: book.id };
    go({ view: "add" });
    openForm(book, null);
  }

  function issueRow(book: Book, issue: BookIssue): HTMLElement {
    const row = make("div", `books-issue${issue.read ? " books-issue-read" : ""}`);
    const check = make("input", "books-read-check");
    check.type = "checkbox";
    check.checked = issue.read;
    check.title = issue.read ? "Read — untick to mark unread" : "Mark as read";
    check.setAttribute("aria-label", `Read ${issue.series} #${issue.number}`);
    check.addEventListener(
      "change",
      () =>
        void act(() =>
          bridge().setIssuesRead(
            [{ series: issue.series, year: issue.year, number: issue.number }],
            check.checked
          )
        )
    );
    row.appendChild(check);
    row.appendChild(make("span", "books-issue-num", `#${issue.number}`));
    const name = make(
      "button",
      "books-link books-issue-title",
      `${seriesLabel(issue.series, issue.year)} #${issue.number}`
    );
    name.type = "button";
    name.title = "Open this issue's page";
    name.addEventListener("click", () =>
      go({ view: "issue", bookId: book.id, series: issue.series, year: issue.year, number: issue.number })
    );
    row.appendChild(name);
    if (issue.partial) row.appendChild(make("span", "tag tag-neutral", "partial"));
    const ownedElsewhere = issue.elsewhere.filter((b) => b.status === "owned");
    const label =
      issue.copies === 0
        ? issue.elsewhere.length
          ? `Not owned · wishlist: ${issue.elsewhere.map((b) => b.label).join(", ")}`
          : "Not owned"
        : issue.copies === 1
          ? ownedElsewhere.length
            ? `Owned once · in ${ownedElsewhere[0].label}`
            : "Owned once"
          : `Owned ${issue.copies}× · also in ${ownedElsewhere.map((b) => b.label).join(", ")}`;
    row.appendChild(make("span", `books-copies${issue.copies > 1 ? " books-copies-many" : ""}`, label));
    return row;
  }

  // ------------------------------------------------------------------ issue

  async function renderIssue(target: Extract<Page, { view: "issue" }>): Promise<void> {
    const book = books.find((b) => b.id === target.bookId);
    detailView.replaceChildren(
      backLink(book ? `Back to ${bookTitle(book)}` : "Back to books", () =>
        go(book ? { view: "book", id: book.id } : { view: "shelf" })
      )
    );
    const label = `${seriesLabel(target.series, target.year)} #${target.number}`;
    const hero = make("div", "books-hero");
    // No cover: GCD's cover images only load in a person's own browser.
    hero.appendChild(cover(null, label, "books-cover books-hero-cover"));
    const info = make("div", "books-hero-info");
    info.appendChild(make("span", "tag tag-accent books-page-tag", "Comic · Single issue"));
    info.appendChild(make("h2", "books-heading", label));
    const metaLine = make("p", "card-meta books-row-meta", "Looking it up on the Grand Comics Database…");
    info.appendChild(metaLine);
    if (target.year === null) {
      info.appendChild(
        make(
          "p",
          "books-small series-years-warning",
          "This issue's series has no year, so it may be a different volume of the same name — set it on the book's page."
        )
      );
    }

    // What your shelf says about it, without waiting for GCD.
    const thisIssue = book
      ? bookIssues(book, books, readIssues).issues.find(
          (i) => i.number === target.number && i.series.toLowerCase() === target.series.toLowerCase()
        )
      : undefined;
    const holders = books.filter(
      (b) =>
        b.status === "owned" &&
        bookIssues(b, books).issues.some(
          (i) =>
            i.number === target.number &&
            i.series.toLowerCase() === target.series.toLowerCase() &&
            i.year === target.year
        )
    );
    const facts = make("div", "books-facts");
    const addFact = (name: string, value: string) => {
      const item = make("div");
      item.append(make("span", "books-fact-label", name), make("span", "books-fact-value", value));
      facts.appendChild(item);
    };
    addFact("Copies owned", String(holders.length));
    if (holders.length) addFact("Collected in", holders.map((b) => bookTitle(b)).join(", "));
    const issueRef = { series: target.series, year: target.year, number: target.number };
    addFact("Read", readingSummary(issueRef, readingLog, thisIssue?.read ?? false) ?? "Not yet");
    info.appendChild(facts);

    const readTools = make("div", "books-actions books-actions-start");
    const toggleRead = make(
      "button",
      thisIssue?.read ? "btn btn-ghost" : "btn btn-primary",
      thisIssue?.read ? "Mark as unread" : "Mark as read"
    );
    toggleRead.type = "button";
    toggleRead.addEventListener(
      "click",
      () =>
        void act(() =>
          bridge().setIssuesRead(
            [{ series: target.series, year: target.year, number: target.number }],
            !thisIssue?.read
          )
        )
    );
    readTools.appendChild(toggleRead);
    if (book) {
      const fix = make("button", "btn btn-ghost", "Edit this book's issues");
      fix.type = "button";
      fix.title = "The issue's series, year and number come from what the book collects";
      fix.addEventListener("click", () => openEditor(book));
      readTools.appendChild(fix);
    }
    info.appendChild(readTools);
    const readings = make("div", "reading-issue");
    readings.appendChild(make("span", "books-fact-label", "Readings"));
    readings.appendChild(issueReadingList(issueRef, readingLog, () => void load()));
    readings.appendChild(logReadingForm([issueRef], readingLog, book?.id ?? null, () => void load()));
    info.appendChild(readings);

    const links = make("div", "books-actions books-actions-start");
    const locg = make("button", "btn btn-secondary", "League of Comic Geeks");
    locg.type = "button";
    locg.title = "Search for this issue — credits, characters, reviews";
    locg.addEventListener(
      "click",
      () => void bridge().openComicLink("locg", { text: `${target.series} #${target.number}` })
    );
    const gcdLink = make("button", "btn btn-ghost", "GCD page");
    gcdLink.type = "button";
    gcdLink.addEventListener("click", () => void bridge().openComicLink("gcd", { text: `${label}` }));
    links.append(locg, gcdLink);
    info.appendChild(links);
    hero.appendChild(info);
    detailView.appendChild(hero);
    // Which names this issue counts in reading stats — GCD's, or yours.
    detailView.appendChild(creditsEditor(issueRef, readingLog, () => void load()));

    const key = `${target.series.toLowerCase()}|${target.year ?? ""}|${target.number}`;
    let detail: GcdIssueDetail | null;
    try {
      if (issueCache.has(key)) {
        detail = issueCache.get(key)!;
      } else {
        detail = await bridge().getComicIssue(target.series, target.year, target.number);
        issueCache.set(key, detail);
      }
    } catch (err) {
      if (page !== target) return;
      metaLine.textContent = errorText(err);
      return;
    }
    // The user may have gone elsewhere while GCD answered.
    if (page !== target) return;
    if (!detail) {
      metaLine.textContent = target.year
        ? "The Grand Comics Database has no issue by that series, year and number."
        : "Not found on the Grand Comics Database — adding the series' year to the book's runs (e.g. Thor (1966) #337) helps it find the right one.";
      return;
    }
    const found = detail;
    metaLine.textContent = [found.publisher, found.publicationDate].filter(Boolean).join(" · ");
    gcdLink.onclick = null;
    const freshGcd = gcdLink.cloneNode(true) as HTMLButtonElement;
    freshGcd.addEventListener(
      "click",
      () => void bridge().openComicLink("gcd", { gcdIssueId: found.issueId })
    );
    gcdLink.replaceWith(freshGcd);

    const titles = found.stories.map((s) => s.title).filter((t): t is string => !!t);
    if (titles.length || found.title) {
      const quote = make(
        "p",
        "card-body books-intro",
        [found.title, ...titles]
          .filter(Boolean)
          .map((t) => `“${t}”`)
          .join(" · ")
      );
      metaLine.after(quote);
    }
    const extra = [
      found.pageCount ? `${found.pageCount} pages` : null,
      found.onSaleDate ? `On sale ${found.onSaleDate}` : null,
      found.price,
    ]
      .filter(Boolean)
      .join(" · ");
    if (extra) addFact("Details", extra);

    const synopsis = found.stories.map((s) => s.synopsis).filter((t): t is string => !!t);
    if (synopsis.length) {
      detailView.appendChild(make("h6", "kicker books-section", "Story"));
      const card = make("div", "card books-text");
      for (const text of synopsis) card.appendChild(make("p", "books-paragraph", text));
      detailView.appendChild(card);
    }

    if (found.credits.length) {
      detailView.appendChild(make("h6", "kicker books-section", "Credits"));
      const card = make("div", "card books-credits");
      for (const person of found.credits) {
        const row = make("div", "books-credit");
        row.append(
          make("span", undefined, person.name),
          make("span", "books-credit-role", person.roles.join(", "))
        );
        card.appendChild(row);
      }
      detailView.appendChild(card);
    }

    const characters = found.stories.flatMap((s) => (s.characters ? characterList(s.characters) : []));
    if (characters.length) {
      detailView.appendChild(make("h6", "kicker books-section", "Characters"));
      const card = make("div", "card books-characters");
      for (const character of [...new Set(characters)])
        card.appendChild(make("span", "tag tag-neutral", character));
      detailView.appendChild(card);
    }
    detailView.appendChild(
      make(
        "p",
        "books-small books-source",
        "From the Grand Comics Database (comics.org), a volunteer-run index."
      )
    );
  }

  // ------------------------------------------------------------- add / edit

  function renderPreview(): void {
    const parsed = parseRuns(runs.value);
    if (!runs.value.trim()) {
      preview.textContent =
        "Write each run as Series (year) #from-to, separated by ; — e.g. Thor (1966) #126-130; Annual #2";
      return;
    }
    const read = parsed.runs.length
      ? `Reads as: ${parsed.runs.map((r) => `${r.partial ? "part of " : ""}${seriesLabel(r.series, r.year)} ${range(r.from, r.to)}`).join(" · ")}`
      : "Nothing readable yet.";
    preview.textContent = parsed.unread.length
      ? `${read} — couldn't read: ${parsed.unread.join(", ")}`
      : read;
  }

  function openForm(values: Partial<Book> & { runsText?: string }, message: string | null): void {
    form.hidden = false;
    findContentsStatus.textContent = "";
    heading.textContent = editingId ? "Edit book" : "Add a book";
    show(notice, message);
    show(formError, null);
    kind.value = values.kind ?? "comic";
    title.value = values.title ?? "";
    volume.value = values.volume ?? "";
    format.value =
      values.format ?? (kind.value === "manga" ? "Manga volume" : kind.value === "novel" ? "Novel" : "Other");
    publisher.value = values.publisher ?? "";
    author.value = values.author ?? "";
    shelf.value = values.shelf ?? "";
    shelf.placeholder = values.title ? shelfName({ title: values.title, shelf: null }) : "From the title";
    progress.value = values.progress === null || values.progress === undefined ? "" : String(values.progress);
    isbn.value = values.isbn ?? "";
    status.value = values.status ?? "owned";
    runs.value = values.runsText ?? (values.runs ? formatRuns(values.runs) : "");
    notes.value = values.notes ?? "";
    renderPreview();
    form.scrollIntoView({ block: "nearest" });
    title.focus();
  }

  /** A vault note into the add form, its contents then looked up by ISBN as the form does. */
  function addFromVault(note: VaultBook): void {
    const target = bookFromVault(note);
    openAdd();
    openForm(
      {
        kind: "comic",
        title: target.title,
        volume: target.volume,
        format: target.format,
        isbn: target.isbn,
        status: target.status,
        shelf: note.line,
        // The note's own "issues", until Wikipedia's list (looked up below) has better.
        runsText: note.issues ? note.issues.replace(/[–—]/g, "-") : undefined,
      },
      `From your vault: ${note.name}${note.issues ? ` — collects ${note.issues}` : ""}. Check it and save.`
    );
    if (target.isbn) findContentsBtn.click();
  }

  function openAdd(): void {
    editingId = null;
    source = null;
    returnTo = page.view === "add" ? returnTo : page;
    form.hidden = true;
    seriesResults.replaceChildren();
    volumeResults.replaceChildren();
    editionResults.replaceChildren();
    show(searchStatus, null);
    show(editionStatus, null);
    go({ view: "add" });
    query.focus();
  }

  function leaveAdd(): void {
    form.hidden = true;
    editingId = null;
    source = null;
    go(returnTo);
  }

  /**
   * "1 volume (2 printings)": GCD lists a direct-market or variant printing
   * ("1 [Direct]") as its own entry, which reads like a second volume.
   */
  function volumeCount(series: GcdSeriesUI): string {
    const volumes = new Set(series.volumes.map((v) => v.descriptor.replace(/\s*\[[^\]]*\]\s*$/, "")));
    const printings = series.volumes.length;
    const label = `${volumes.size} ${volumes.size === 1 ? "volume" : "volumes"}`;
    return printings > volumes.size ? `${label} (${printings} printings)` : label;
  }

  /** Wikipedia's lists, searched beside GCD — and the way in while GCD is unavailable. */
  async function searchEditions(text: string): Promise<void> {
    editionResults.replaceChildren();
    show(editionStatus, "Looking through Wikipedia's lists of omnibuses, Epic Collections and Masterworks…");
    try {
      const found = await bridge().searchBookEditions(text);
      show(editionStatus, found.length ? "In Wikipedia's lists — with what each collects:" : null);
      for (const edition of found) {
        const pick = make("button", "btn btn-ghost book-pick book-edition-pick");
        pick.type = "button";
        pick.append(
          make(
            "span",
            "book-edition-title",
            `${edition.bookTitle}${edition.volume ? ` · ${edition.volume}` : ""}`
          ),
          make("span", "books-small", edition.contents)
        );
        pick.addEventListener("click", () => {
          editingId = null;
          source = null;
          seriesResults.replaceChildren();
          volumeResults.replaceChildren();
          editionResults.replaceChildren();
          show(searchStatus, null);
          show(editionStatus, null);
          openForm(
            {
              kind: "comic",
              title: edition.bookTitle,
              volume: edition.volume,
              format: edition.format,
              publisher: edition.list.startsWith("DC") ? "DC" : "Marvel",
              isbn: edition.isbn,
              runs: edition.runs,
            },
            `Filled in from Wikipedia's ${edition.list} list${edition.unread.length ? `, except: ${edition.unread.join(", ")}` : ""}. Check it matches your copy.`
          );
        });
        editionResults.appendChild(pick);
      }
    } catch (err) {
      show(editionStatus, errorText(err));
    }
  }

  async function searchSeries(): Promise<void> {
    searchBtn.disabled = true;
    show(searchStatus, "Searching the Grand Comics Database…");
    seriesResults.replaceChildren();
    volumeResults.replaceChildren();
    void searchEditions(query.value);
    try {
      const found = await bridge().searchComicSeries(query.value);
      show(
        searchStatus,
        found.length ? "On the Grand Comics Database — pick a series:" : "No series by that name on GCD."
      );
      for (const series of found) {
        const pick = make("button", "card book-series-pick");
        pick.type = "button";
        pick.append(
          make("span", "book-series-name", series.name),
          make("span", "books-small", seriesFacts(series).join(" · "))
        );
        pick.addEventListener("click", () => showVolumes(series));
        seriesResults.appendChild(pick);
      }
    } catch (err) {
      show(searchStatus, errorText(err));
    } finally {
      searchBtn.disabled = false;
    }
  }

  /** "Marvel · 2024– · hardcover with dustjacket · collected edition · 1 volume (2 printings)". */
  function seriesFacts(series: GcdSeriesUI): string[] {
    const years = series.yearBegan
      ? series.yearEnded && series.yearEnded !== series.yearBegan
        ? `${series.yearBegan}–${series.yearEnded}`
        : series.yearEnded
          ? `${series.yearBegan}`
          : `${series.yearBegan}–`
      : null;
    return [
      series.publisher,
      years,
      series.binding,
      series.publishingFormat,
      volumeCount(series),
      series.language && series.language !== "en" ? series.language.toUpperCase() : null,
    ].filter((part): part is string => !!part);
  }

  /** GCD volumes already read this session, so opening one twice doesn't ask GCD again. */
  const volumeCache = new Map<number, GcdVolumeUI>();

  function showVolumes(series: GcdSeriesUI): void {
    seriesResults.replaceChildren();
    show(searchStatus, null);
    volumeResults.replaceChildren();

    const header = make("div", "card book-series-header");
    const back = make("button", "books-back", "← Other series");
    back.type = "button";
    back.addEventListener("click", () => void searchSeries());
    header.append(
      back,
      make("span", "book-series-name", series.name),
      make("span", "books-small", seriesFacts(series).join(" · "))
    );
    if (series.dimensions) header.appendChild(make("span", "books-small", `Size: ${series.dimensions}`));
    volumeResults.appendChild(header);
    volumeResults.appendChild(
      make("p", "setting-note", "Pick a volume to see its details before adding it.")
    );

    for (const entry of series.volumes) {
      const direct = /\[Direct\]\s*$/i.test(entry.descriptor);
      const variant = entry.descriptor.match(/\[([^\]]+)\]\s*$/)?.[1] ?? null;
      const number = entry.descriptor.replace(/\s*\[[^\]]*\]\s*$/, "");
      const item = make("div", "card book-volume");
      const pick = make("button", "book-volume-pick");
      pick.type = "button";
      pick.append(
        make("span", "book-series-name", /^\d+$/.test(number) ? `Vol. ${number}` : number),
        make(
          "span",
          "books-small",
          direct
            ? "Direct market printing — the comic-shop cover"
            : variant
              ? `${variant} printing`
              : "Standard printing"
        )
      );
      const preview = make("div", "book-volume-preview");
      preview.hidden = true;
      pick.addEventListener("click", () => {
        if (!preview.hidden) {
          preview.hidden = true;
          return;
        }
        preview.hidden = false;
        void showVolumePreview(series, entry.issueId, preview);
      });
      item.append(pick, preview);
      volumeResults.appendChild(item);
    }
  }

  /** A volume's details — cover, ISBN, pages, date, what it collects — with "Add". */
  async function showVolumePreview(series: GcdSeriesUI, issueId: number, into: HTMLElement): Promise<void> {
    into.replaceChildren(make("p", "books-small", "Reading that volume from GCD…"));
    let found: GcdVolumeUI;
    try {
      found = volumeCache.get(issueId) ?? (await bridge().getComicVolume(issueId));
      volumeCache.set(issueId, found);
    } catch (err) {
      into.replaceChildren(make("p", "form-error", errorText(err)));
      return;
    }
    const label = `${found.seriesName} ${found.descriptor}`;
    const layout = make("div", "book-volume-layout");
    layout.appendChild(cover(coverUrlForIsbn(found.isbn), label, "books-cover book-volume-cover"));
    const body = make("div", "books-row-body");
    const facts = make("div", "books-facts");
    const fact = (name: string, value: string | null) => {
      if (!value) return;
      const item = make("div");
      item.append(make("span", "books-fact-label", name), make("span", "books-fact-value", value));
      facts.appendChild(item);
    };
    fact("Published", found.publicationDate);
    fact("Pages", found.pageCount ? String(found.pageCount) : null);
    fact("Price", found.price);
    fact("ISBN", found.isbn);
    fact("Publisher", found.publisher ?? series.publisher);
    body.appendChild(facts);
    if (found.runs.length) {
      body.appendChild(make("p", "card-body book-volume-contents", `Collects ${formatRuns(found.runs)}`));
      body.appendChild(
        make(
          "p",
          "books-small",
          found.contentsFrom === "gcd"
            ? "Contents from GCD's note."
            : `Contents from Wikipedia's ${found.contentsFrom} list.`
        )
      );
    } else {
      body.appendChild(
        make(
          "p",
          "books-small",
          "Neither GCD nor Wikipedia's lists say what this collects — you can type it in."
        )
      );
    }
    const actions = make("div", "books-actions books-actions-start");
    const addAs = (status: Book["status"]) => {
      editingId = null;
      source = `gcd:${found.issueId}`;
      volumeResults.replaceChildren();
      editionResults.replaceChildren();
      show(searchStatus, null);
      show(editionStatus, null);
      openForm(
        {
          kind: "comic",
          title: found.seriesName,
          volume: found.descriptor.replace(/\s*\[[^\]]*\]\s*$/, ""),
          format: found.format as Book["format"],
          publisher: found.publisher ?? series.publisher ?? "",
          isbn: found.isbn,
          runs: found.runs,
          status,
        },
        found.runs.length
          ? `Contents filled in from ${found.contentsFrom === "gcd" ? "GCD's note" : `Wikipedia's ${found.contentsFrom} list`}${found.unread.length ? `, except: ${found.unread.join(", ")}` : ""}. Check it matches your copy.`
          : "Neither GCD nor Wikipedia's lists say what this volume collects — type the issue runs below."
      );
    };
    const add = make("button", "btn btn-primary", "Add this book");
    add.type = "button";
    add.addEventListener("click", () => addAs("owned"));
    const wish = make("button", "btn btn-ghost", "Add to wishlist");
    wish.type = "button";
    wish.addEventListener("click", () => addAs("wishlist"));
    actions.append(add, wish);
    body.appendChild(actions);
    layout.appendChild(body);
    into.replaceChildren(layout);
  }

  async function save(): Promise<void> {
    const input = {
      kind: kind.value,
      title: title.value,
      volume: volume.value,
      format: format.value,
      publisher: publisher.value,
      author: author.value,
      shelf: shelf.value,
      progress: progress.value === "" ? null : Number(progress.value),
      isbn: isbn.value,
      status: status.value,
      runs: runs.value,
      notes: notes.value,
      source,
    };
    saveBtn.disabled = true;
    try {
      const result = editingId ? await bridge().updateBook(editingId, input) : await bridge().addBook(input);
      form.hidden = true;
      editingId = null;
      source = null;
      returnTo = { view: "book", id: result.book.id };
      page = returnTo;
      await load();
      if (result.unread.length) show(errorEl, `Saved — but couldn't read: ${result.unread.join(", ")}`);
    } catch (err) {
      show(formError, errorText(err));
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await load();
    } catch (err) {
      show(errorEl, errorText(err));
      page = { view: "shelf" };
      render();
    }
  }

  // ----------------------------------------------------------------- wiring

  document.querySelectorAll<HTMLButtonElement>(".books-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      pane = (tab.dataset.booksPane as Pane) ?? "shelf";
      render();
    })
  );
  byId<HTMLButtonElement>("bookAddBtn").addEventListener("click", openAdd);
  byId<HTMLButtonElement>("bookAddBackBtn").addEventListener("click", leaveAdd);
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
    if (kind.value === "novel" && format.value === "Other") format.value = "Novel";
  });
  title.addEventListener("input", () => {
    shelf.placeholder = title.value.trim()
      ? shelfName({ title: title.value, shelf: null })
      : "From the title";
  });
  runs.addEventListener("input", renderPreview);
  findContentsBtn.addEventListener("click", async () => {
    if (!isbn.value.trim()) {
      findContentsStatus.textContent = "Type the ISBN first.";
      return;
    }
    findContentsBtn.disabled = true;
    findContentsStatus.textContent =
      "Looking through Wikipedia's lists of omnibuses, Epic Collections and Masterworks…";
    try {
      const found = await bridge().findBookContents(isbn.value.trim());
      if (!found) {
        findContentsStatus.textContent = "Not in Wikipedia's lists — type the runs by hand.";
      } else {
        runs.value = formatRuns(found.runs);
        renderPreview();
        findContentsStatus.textContent = `Found in Wikipedia's ${found.list} list${found.title ? ` as "${found.title}"` : ""}. Check it matches your copy.`;
      }
    } catch (err) {
      findContentsStatus.textContent = errorText(err);
    } finally {
      findContentsBtn.disabled = false;
    }
  });
  saveBtn.addEventListener("click", () => void save());
  cancelBtn.addEventListener("click", leaveAdd);

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  filterText.addEventListener("input", () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(render, 150);
  });
  filterKind.addEventListener("change", render);
  filterStatus.addEventListener("change", render);

  // Opening Books from the sidebar starts at the shelf.
  document.querySelector('.side-link[data-tab="books"]')?.addEventListener("click", () => {
    if (page.view !== "add") page = { view: "shelf" };
    void load();
  });
  // Covers arriving or a save elsewhere: redraw the page you're on, unless
  // it's the form (which would lose what you're typing).
  // A note saved in Obsidian (or a git pull) reads the vault again.
  bridge().onComicsVaultChanged(() => void load());
  bridge().onBooksChanged(() => {
    if (page.view !== "add") void load();
  });
  void load();
}
