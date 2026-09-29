import { BrowserWindow, shell } from "electron";
import { logger } from "../../logging/logger";
import {
  BOOK_FORMATS,
  CreditsQueue,
  GcdPausedError,
  chosenCoverUrl,
  creditsFromGcd,
  isChosenCover,
  workOutRunYears,
} from "../../collections";
import type { AmbiguousRun } from "../../collections";
import { chooseCoverFile, removeCoverFile } from "../coverStore";
import { ComicsVault } from "../comicsVault";
import { handle } from "./handle";
import type { IpcContext } from "./context";

/** The comics vault (an Obsidian folder) on this PC — read-only; see comicsVault.ts. */
let comicsVault: ComicsVault | undefined;

/** Background GCD lookups of read issues' characters and creators — set up with the handlers. */
let creditsQueue: CreditsQueue | undefined;

/** Looks up credits for newly logged readings, if the queue isn't already at it. */
export function kickReadingCredits(): void {
  creditsQueue?.kick();
}

/** Books: comics and manga, the reading log, covers and GCD. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerBooksIpc(ctx: IpcContext): void {
  // Books (src/collections/books/): comics collected editions and manga.
  // GCD lookups take a series name or a numeric volume id only; the URL is
  // built in the main process.
  handle("nimbus:get-books", (_event, filter: unknown) => {
    const f = filter && typeof filter === "object" ? (filter as Record<string, unknown>) : {};
    return {
      books: ctx.bookService.list({
        kind: f.kind === "comic" || f.kind === "manga" || f.kind === "novel" ? f.kind : undefined,
        status: f.status === "owned" || f.status === "wishlist" ? f.status : undefined,
        text: typeof f.text === "string" ? f.text.slice(0, 100) : undefined,
      }),
      coverage: ctx.bookService.coverage(),
      formats: BOOK_FORMATS,
      readIssues: ctx.bookService.readIssueKeys(),
      readingLog: ctx.bookService.readingLog(),
    };
  });
  // The reading log: readings of issues on a day, with estimated minutes.
  handle(
    "nimbus:log-issue-readings",
    (_event, issues: unknown, readOn: unknown, minutes: unknown, bookId: unknown) =>
      ctx.bookService.logReadings(issues, readOn, minutes, bookId)
  );
  handle("nimbus:remove-issue-reading", (_event, id: unknown) => ctx.bookService.removeReading(id));
  // Your own characters, writers and artists for an issue, and whether stats use them.
  handle("nimbus:set-my-issue-credits", (_event, issue: unknown, changes: unknown) =>
    ctx.bookService.setCustomCredits(issue, changes)
  );
  handle("nimbus:use-my-issue-credits", (_event, issue: unknown, on: unknown) =>
    ctx.bookService.setUseCustomCredits(issue, on)
  );
  handle("nimbus:set-minutes-per-issue", (_event, minutes: unknown) =>
    ctx.bookService.setMinutesPerIssue(minutes)
  );
  // Characters and creators for logged issues not looked up yet — a few at a
  // time, each through GCD's own pacing (a second apart, kept a day).
  // Characters and creators of read issues, looked up by themselves in the
  // background (collections/books/creditsQueue.ts), gently and waiting out
  // GCD's pauses.
  creditsQueue = new CreditsQueue({
    pending: (limit) => {
      const all = ctx.bookService.issuesWithoutCredits(100_000);
      return { issues: all.slice(0, limit), total: all.length };
    },
    lookup: async (issue) => {
      const detail = await ctx.gcdCatalog.findIssue(issue.series, issue.year, issue.number);
      return detail ? creditsFromGcd(detail) : null;
    },
    save: (issue, credits) =>
      ctx.bookService.setIssueCredits(issue.series, issue.year, issue.number, credits),
    pauseSeconds: (err) => (err instanceof GcdPausedError ? (err.retryAfterSeconds ?? 0) : null),
    onState: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("nimbus:reading-credits-state", state);
      }
    },
  });
  setTimeout(() => creditsQueue?.kick(), 15_000);
  handle("nimbus:reading-credits-state", () => creditsQueue?.state() ?? null);
  // Issues read or unread: [{series, year, number}], checked in the service.
  handle("nimbus:set-issues-read", (_event, issues: unknown, read: unknown) =>
    ctx.bookService.setIssuesRead(issues, read)
  );
  // A cover you choose: the main process opens the file picker, and the
  // picture is resized and saved in NIMBUS's folder — the renderer never
  // names a path.
  handle("nimbus:choose-book-cover", async (_event, id: unknown) => {
    const book = ctx.bookService.get(String(id ?? ""));
    const saved = await chooseCoverFile(BrowserWindow.getFocusedWindow(), book.id);
    if (!saved) return false;
    const url = chosenCoverUrl(book.id, Date.now());
    if (url) ctx.bookService.setCover(book.id, url);
    return true;
  });
  // Back to the cover found by ISBN (looked for again).
  handle("nimbus:clear-book-cover", (_event, id: unknown) => {
    const book = ctx.bookService.get(String(id ?? ""));
    if (isChosenCover(book.coverUrl)) removeCoverFile(book.id);
    ctx.bookService.setCover(book.id, null);
    ctx.coverAttempted.delete(book.id);
    void ctx.fillBookCovers();
    return true;
  });
  // A single issue's page, from GCD — the series name, year and number only.
  // Its characters and creators are kept for reading stats.
  handle("nimbus:get-comic-issue", async (_event, series: unknown, year: unknown, number: unknown) => {
    const detail = await ctx.gcdCatalog.findIssue(series, year, number);
    if (detail && typeof series === "string" && Number.isInteger(number)) {
      const y = Number.isInteger(year) ? (year as number) : null;
      ctx.bookService.setIssueCredits(series, y, number as number, creditsFromGcd(detail));
    }
    return detail;
  });
  // Links out to the two comic databases. The page names what to look up;
  // the address is built here, for these two sites only, so the renderer
  // can never open an address of its choosing.
  handle("nimbus:open-comic-link", async (_event, site: unknown, lookup: unknown) => {
    const l = lookup && typeof lookup === "object" ? (lookup as Record<string, unknown>) : {};
    const words = typeof l.text === "string" ? l.text.replace(/\s+/g, " ").trim().slice(0, 150) : "";
    const gcdId =
      typeof l.gcdIssueId === "number" && Number.isInteger(l.gcdIssueId) && l.gcdIssueId > 0
        ? l.gcdIssueId
        : null;
    let url: string | null = null;
    if (site === "locg" && words) {
      url = `https://leagueofcomicgeeks.com/search?keyword=${encodeURIComponent(words)}`;
    } else if (site === "gcd" && gcdId) {
      url = `https://www.comics.org/issue/${gcdId}/`;
    } else if (site === "gcd" && words) {
      url = `https://www.comics.org/searchNew/?q=${encodeURIComponent(words)}&search_object=issue`;
    }
    if (!url) throw new Error("Nothing to look up.");
    await shell.openExternal(url);
    return true;
  });
  handle("nimbus:search-comic-series", (_event, name: unknown) => ctx.gcdCatalog.searchSeries(name));
  // A GCD volume, with its contents from Wikipedia's lists when GCD has none.
  handle("nimbus:get-comic-volume", async (_event, issueId: unknown) => {
    const volume = await ctx.gcdCatalog.getVolume(issueId);
    if (volume.runs.length || !volume.isbn)
      return { ...volume, contentsFrom: volume.runs.length ? "gcd" : null };
    try {
      const found = await ctx.wikipediaCollections.findByIsbn([volume.isbn]);
      if (found) return { ...volume, runs: found.runs, unread: found.unread, contentsFrom: found.list };
    } catch (err) {
      logger.debug("No contents from Wikipedia", { error: String(err) });
    }
    return { ...volume, contentsFrom: null };
  });
  // Contents for a book by its ISBN — for books typed in by hand, or found on
  // GCD before this lookup existed. The ISBN never leaves the PC: the lists
  // are downloaded whole and matched here.
  // Editions by title from Wikipedia's lists — searched on the PC; nothing is sent.
  handle("nimbus:search-book-editions", (_event, query: unknown) => ctx.wikipediaCollections.search(query));
  // The comics vault: this PC's folder, chosen in NIMBUS's own dialog, read and never written.
  comicsVault ??= new ComicsVault(() => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send("nimbus:comics-vault-changed");
  });
  const vault = comicsVault;
  handle("nimbus:get-comics-vault", () => vault.snapshot());
  handle("nimbus:choose-comics-vault", () => vault.choose(BrowserWindow.getFocusedWindow()));
  handle("nimbus:clear-comics-vault", () => vault.clear());
  handle("nimbus:open-vault-note", (_event, notePath: unknown) => vault.openNote(notePath));
  handle("nimbus:find-book-contents", (_event, isbn: unknown) =>
    typeof isbn === "string" && isbn.length <= 20 ? ctx.wikipediaCollections.findByIsbn([isbn]) : null
  );
  // Runs written without a series year ("Amazing Spider-Man #29-31") are
  // placed in the right volume from GCD, in the background after a comic is
  // saved (src/collections/books/seriesYears.ts). What can't be settled is
  // kept here for the book's page to ask about.
  const notifyBooksChanged = () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("nimbus:books-changed");
  };
  const bookYears = new Map<
    string,
    { working: boolean; settled: number; ambiguous: AmbiguousRun[]; paused: string | null }
  >();
  const workOutBookYears = async (id: string) => {
    const book = ctx.bookService.get(id);
    if (book.kind !== "comic" || !book.runs.some((run) => run.year === null)) {
      bookYears.delete(id);
      return null;
    }
    const current = bookYears.get(id);
    if (current?.working) return current;
    bookYears.set(id, { working: true, settled: 0, ambiguous: [], paused: null });
    notifyBooksChanged();
    let publicationYear: number | null = null;
    if (book.source?.startsWith("gcd:")) {
      try {
        const volume = await ctx.gcdCatalog.getVolume(Number(book.source.slice(4)));
        const year = Number(volume.publicationDate?.slice(0, 4));
        publicationYear = Number.isInteger(year) && year > 1800 ? year : null;
      } catch {
        // The era then comes from the book's runs alone.
      }
    }
    const result = await workOutRunYears(book.runs, book.publisher, ctx.gcdCatalog, publicationYear);
    const settled = ctx.bookService.setRunYears(
      id,
      [...result.years].map(([index, year]) => ({ index, series: book.runs[index].series, year }))
    );
    const state = { working: false, settled, ambiguous: result.ambiguous, paused: result.paused };
    bookYears.set(id, state);
    notifyBooksChanged();
    return state;
  };
  const afterSave = (saved: { book: { id: string } }) => {
    void workOutBookYears(saved.book.id).catch((err) =>
      logger.warn("Could not work out series years", { error: String(err) })
    );
    return saved;
  };
  handle("nimbus:add-book", (_event, input: unknown) => afterSave(ctx.bookService.add(input)));
  handle("nimbus:update-book", (_event, id: unknown, input: unknown) =>
    afterSave(ctx.bookService.update(String(id ?? ""), input))
  );
  handle("nimbus:get-book-years", (_event, id: unknown) => bookYears.get(String(id ?? "")) ?? null);
  handle("nimbus:work-out-book-years", (_event, id: unknown) => workOutBookYears(String(id ?? "")));
  handle("nimbus:set-run-year", (_event, id: unknown, index: unknown, series: unknown, year: unknown) => {
    const bookId = String(id ?? "");
    if (!Number.isInteger(index) || typeof series !== "string" || !Number.isInteger(year)) {
      throw new Error("Choose the series' year.");
    }
    const set = ctx.bookService.setRunYears(bookId, [
      { index: index as number, series, year: year as number },
    ]);
    const state = bookYears.get(bookId);
    if (state) state.ambiguous = state.ambiguous.filter((a) => a.index !== index);
    return set;
  });
  handle("nimbus:remove-book", (_event, id: unknown) => {
    const removed = ctx.bookService.remove(String(id ?? ""));
    if (removed) removeCoverFile(String(id));
    return removed;
  });
}
