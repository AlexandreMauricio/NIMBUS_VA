/**
 * The comics vault on this PC: which folder it is, and what's in it.
 *
 * The folder is chosen in NIMBUS's own dialog and kept in
 * `<userData>/comics-vault.json` — this PC's alone, so a laptop and a
 * desktop can each point at their own copy. The renderer never names a
 * path: it asks for the vault's contents, or for a note it was given to be
 * opened in Obsidian.
 *
 * Read-only. Book notes are read from `Books/` (every `.md` below it) and
 * the Cart Planner from `Cart Planner.md`; the folder is watched, and a
 * change tells the Books tab to read it again.
 */

import { app, dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/logger";
import { parseFrontmatter, parsePlannerTables, vaultBook } from "../collections/books/vault";
import type { PlannerTable, VaultBook } from "../collections/books/vault";

/** More notes than this is not a comics vault. */
const MAX_NOTES = 3000;
/** A book note is a page of properties, not a novel. */
const MAX_NOTE_BYTES = 256 * 1024;

export interface VaultSnapshot {
  /** The folder, shown in the Books tab, or null when none is chosen. */
  folder: string | null;
  /** Why it couldn't be read ("The folder is gone"), or null. */
  problem: string | null;
  books: VaultBook[];
  planner: PlannerTable[];
  /** When the Cart Planner was last written (refresh.py's last run), or null. */
  plannerUpdated: string | null;
  readAt: string | null;
}

const configFile = () => path.join(app.getPath("userData"), "comics-vault.json");

function savedFolder(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as { folder?: unknown };
    return typeof raw.folder === "string" && path.isAbsolute(raw.folder) ? raw.folder : null;
  } catch {
    return null;
  }
}

function saveFolder(folder: string | null): void {
  fs.writeFileSync(configFile(), JSON.stringify({ folder }, null, 2), "utf-8");
}

/** Every `.md` below `Books/`, as vault-relative paths with forward slashes. */
function bookNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_NOTES) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "Books"));
  return out;
}

export class ComicsVault {
  private folder: string | null = savedFolder();
  private cache: VaultSnapshot | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: () => void) {
    this.watch();
  }

  /** What's in the vault now — read once and kept until the folder changes. */
  snapshot(): VaultSnapshot {
    if (!this.cache) this.cache = this.read();
    return this.cache;
  }

  /** NIMBUS's own folder dialog; the choice is this PC's. Returns the new snapshot, or null if cancelled. */
  async choose(parent: BrowserWindow | null): Promise<VaultSnapshot | null> {
    const options = {
      title: "Choose your comics vault folder",
      properties: ["openDirectory" as const],
      defaultPath: this.folder ?? app.getPath("desktop"),
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return null;
    const folder = picked.filePaths[0];
    if (!fs.existsSync(path.join(folder, "Books")))
      throw new Error(
        "That folder has no Books folder — choose the vault itself (the folder with Books/ in it)."
      );
    this.folder = folder;
    saveFolder(folder);
    this.changed();
    this.watch();
    logger.info("Comics vault chosen");
    return this.snapshot();
  }

  /** Forget the folder on this PC. The vault itself is untouched. */
  clear(): VaultSnapshot {
    this.folder = null;
    saveFolder(null);
    this.watch();
    this.changed();
    return this.snapshot();
  }

  /** Opens a note in Obsidian — only one of the vault's own book notes. */
  async openNote(notePath: unknown): Promise<boolean> {
    const known = this.snapshot().books.some((book) => book.path === notePath);
    if (!this.folder || typeof notePath !== "string" || !known) return false;
    const full = path.join(this.folder, ...notePath.split("/"));
    if (!full.startsWith(path.join(this.folder, "Books") + path.sep)) return false;
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(full)}`);
    return true;
  }

  private read(): VaultSnapshot {
    const empty = (problem: string | null): VaultSnapshot => ({
      folder: this.folder,
      problem,
      books: [],
      planner: [],
      plannerUpdated: null,
      readAt: new Date().toISOString(),
    });
    if (!this.folder) return empty(null);
    if (!fs.existsSync(path.join(this.folder, "Books")))
      return empty("The folder or its Books folder isn't there on this PC.");
    try {
      const books: VaultBook[] = [];
      for (const relative of bookNotes(this.folder)) {
        const full = path.join(this.folder, ...relative.split("/"));
        if (fs.statSync(full).size > MAX_NOTE_BYTES) continue;
        const props = parseFrontmatter(fs.readFileSync(full, "utf-8"));
        if (Object.keys(props).length) books.push(vaultBook(relative, props));
      }
      const plannerFile = path.join(this.folder, "Cart Planner.md");
      const hasPlanner = fs.existsSync(plannerFile);
      return {
        folder: this.folder,
        problem: null,
        books,
        planner: hasPlanner ? parsePlannerTables(fs.readFileSync(plannerFile, "utf-8")) : [],
        plannerUpdated: hasPlanner ? fs.statSync(plannerFile).mtime.toISOString() : null,
        readAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn("Comics vault couldn't be read", { error: String(err) });
      return empty("The vault couldn't be read — see the log.");
    }
  }

  private changed(): void {
    this.cache = null;
    this.onChange();
  }

  /** Watches the vault; a burst of saves (Obsidian, git pull) is one change. */
  private watch(): void {
    this.watcher?.close();
    this.watcher = null;
    if (!this.folder || !fs.existsSync(this.folder)) return;
    try {
      this.watcher = fs.watch(this.folder, { recursive: true }, (_event, file) => {
        const name = String(file ?? "");
        if (name.startsWith(".obsidian") || name.startsWith(".git")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.changed(), 500);
      });
    } catch (err) {
      logger.warn("Comics vault can't be watched; it's read when the tab asks", { error: String(err) });
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }
}
