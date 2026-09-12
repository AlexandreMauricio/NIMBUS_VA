import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { CollectionState, CollectionStore } from "../collections/types";

/**
 * Persists the card collection (src/collections/) to
 * `collection.json`. Plain JSON — card names, sets and quantities, nothing
 * that needs encrypting — validated entry by entry when read. A file that
 * can't be parsed is set aside rather than overwritten, since a collection
 * is typed in by hand and would be tedious to lose.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "collection.json");
}

export class FileCollectionStore implements CollectionStore {
  load(): unknown {
    const file = filePath();
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      const aside = path.join(path.dirname(file), `collection.unreadable-${Date.now()}.json`);
      logger.warn("Could not read collection.json — setting it aside", { error: String(err) });
      try {
        fs.renameSync(file, aside);
      } catch {
        // If it can't be moved, the warning stands; the next save replaces it.
      }
      return null;
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: CollectionState): void {
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
      logger.warn("Could not save collection.json", { error: String(err) });
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
