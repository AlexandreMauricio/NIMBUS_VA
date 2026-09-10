import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { ActivityHistoryState, ActivityStateStore } from "../activity/types";

/**
 * Persists the recent-activity list.
 *
 * Same reasoning as routineStateStore: machine bookkeeping rather than
 * user configuration, so it lives in its own file instead of churning
 * settings.json. Plain JSON, not safeStorage — an activity name and two
 * timestamps are not credentials, and safeStorage cannot be read before
 * the app is ready.
 *
 * What lands here is only what NIMBUS concluded: an activity name, the
 * matched source value, and timestamps. No page contents, no full window
 * titles beyond the value a user's own mapping matched, nothing typed.
 */

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "activity-history.json");
}

export class FileActivityStateStore implements ActivityStateStore {
  load(): ActivityHistoryState {
    const filePath = stateFilePath();
    try {
      if (!fs.existsSync(filePath)) return { sessions: [] };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<ActivityHistoryState>;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      // A truncated or hand-edited file must not put half-built sessions
      // into the history where they would render as blanks.
      return {
        sessions: sessions.filter(
          (s) =>
            s && typeof s.id === "string" && typeof s.activity === "string" && typeof s.startedAt === "string"
        ),
      };
    } catch (err) {
      logger.warn("Could not read activity-history.json — starting with no history", {
        error: String(err),
      });
      return { sessions: [] };
    }
  }

  /** Temp-file-then-rename, like the other state files: written often enough that a torn write is a real possibility. */
  save(state: ActivityHistoryState): void {
    const filePath = stateFilePath();
    const tempPath = `${filePath}.tmp`;
    try {
      const fd = fs.openSync(tempPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(state), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.warn("Could not write activity-history.json", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the write already failed and was logged above.
      }
    }
  }
}
