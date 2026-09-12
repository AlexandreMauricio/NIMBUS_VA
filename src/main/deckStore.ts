import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { DeckState, DeckStore } from "../collections/decks/types";

/**
 * Persists decks (src/collections/decks/) to `decks.json`. Validated deck by
 * deck and card by card when read; an unreadable file is set aside rather
 * than overwritten.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "decks.json");
}

export class FileDeckStore implements DeckStore {
  load(): unknown {
    const file = filePath();
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      logger.warn("Could not read decks.json — setting it aside", { error: String(err) });
      try {
        fs.renameSync(file, path.join(path.dirname(file), `decks.unreadable-${Date.now()}.json`));
      } catch {
        // If it can't be moved, the warning stands; the next save replaces it.
      }
      return null;
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: DeckState): void {
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
      logger.warn("Could not save decks.json", { error: String(err) });
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
