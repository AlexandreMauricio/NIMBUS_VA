import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { MealsState, MealsStore } from "../meals/types";

/**
 * Persists Meals (src/meals/) to `meals.json`: ingredients, recipes, the
 * pantry, leftovers, the plan and the household's preferences. Validated
 * entry by entry when read (`parseState`); an unreadable file is set aside
 * rather than overwritten, because most of what's in it was typed by hand.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "meals.json");
}

export class FileMealStore implements MealsStore {
  load(): unknown {
    const file = filePath();
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (err) {
      logger.warn("Could not read meals.json — setting it aside", { error: String(err) });
      try {
        fs.renameSync(file, path.join(path.dirname(file), `meals.unreadable-${Date.now()}.json`));
      } catch {
        // If it can't be moved, the warning stands; the next save replaces it.
      }
      return null;
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: MealsState): void {
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
      logger.warn("Could not save meals.json", { error: String(err) });
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
