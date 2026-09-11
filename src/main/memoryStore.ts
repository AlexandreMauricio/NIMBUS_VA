import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/logger";
import { MemoryItem, MemoryOrigin, MemoryStateStore } from "../memory/types";

/**
 * Memory on disk: one file per tier in a `memory` folder under NIMBUS's
 * data directory — explicit.json, learned.json, observed.json — so the
 * user's own memories never share a file with what NIMBUS worked out.
 *
 * Same conventions as the other state files: plain JSON (nothing here is
 * a credential), written to a temp file, fsynced, then renamed. A file
 * that can't be parsed is moved aside (`<tier>.unreadable-<time>.json`)
 * rather than overwritten, so nothing is lost to a bad write or a hand
 * edit. The folder is passed in, so this has no Electron dependency.
 */
export class FileMemoryStore implements MemoryStateStore {
  constructor(private readonly directory: string) {}

  private file(origin: MemoryOrigin): string {
    return path.join(this.directory, `${origin}.json`);
  }

  load(origin: MemoryOrigin): unknown {
    const file = this.file(origin);
    if (!fs.existsSync(file)) return [];
    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(text) as { version?: unknown; items?: unknown };
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.items : parsed;
    } catch (err) {
      const aside = path.join(this.directory, `${origin}.unreadable-${Date.now()}.json`);
      logger.warn(`Could not read ${origin} memory — setting the file aside`, { error: String(err) });
      try {
        fs.renameSync(file, aside);
      } catch {
        // If it can't be moved, the next save replaces it; the warning above stands.
      }
      return [];
    }
  }

  save(origin: MemoryOrigin, items: MemoryItem[]): void {
    const file = this.file(origin);
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const fd = fs.openSync(temp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, items }), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    } catch (err) {
      logger.warn(`Could not save ${origin} memory`, { error: String(err) });
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
