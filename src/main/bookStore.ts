import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { BookState, BookStore } from "../collections/books/types";

/**
 * Persists the shelf (src/collections/books/) to `books.json`: titles,
 * formats and the issue runs typed or looked up for each book. Validated
 * book by book when read; an unreadable file is set aside rather than
 * overwritten, since the contents were often typed by hand.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "books.json");
}

export class FileBookStore implements BookStore {
  load(): unknown {
    const file = filePath();
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      logger.warn("Could not read books.json — setting it aside", { error: String(err) });
      try {
        fs.renameSync(file, path.join(path.dirname(file), `books.unreadable-${Date.now()}.json`));
      } catch {
        // If it can't be moved, the warning stands; the next save replaces it.
      }
      return null;
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: BookState): void {
    const file = filePath();
    const temp = `${file}.tmp`;
    try {
      const fd = fs.openSync(temp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(state), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    } catch (err) {
      logger.warn("Could not save books.json", { error: String(err) });
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
