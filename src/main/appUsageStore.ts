import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { AppUsageState, AppUsageStateStore } from "../activity/appUsage";

/**
 * Persists the opt-in app-usage tally (src/activity/appUsage.ts): per
 * program, its name, minutes per day for the last two weeks, and the
 * user's answers to "make it an activity?". Plain JSON — no window titles
 * or content, nothing that needs encrypting.
 */
function stateFilePath(): string {
  return path.join(app.getPath("userData"), "app-usage.json");
}

export class FileAppUsageStore implements AppUsageStateStore {
  load(): AppUsageState {
    const filePath = stateFilePath();
    try {
      if (!fs.existsSync(filePath)) return { apps: {} };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<AppUsageState>;
      const apps = parsed.apps && typeof parsed.apps === "object" ? parsed.apps : {};
      // A hand-edited or truncated entry is dropped rather than half-used.
      const clean: AppUsageState["apps"] = {};
      for (const [name, record] of Object.entries(apps)) {
        if (!record || typeof record !== "object" || typeof record.dayMinutes !== "object") continue;
        clean[name] = {
          name: typeof record.name === "string" ? record.name : null,
          dayMinutes: record.dayMinutes,
          lastOpenedAt: typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : null,
          declines: typeof record.declines === "number" ? record.declines : 0,
          snoozedUntil: typeof record.snoozedUntil === "string" ? record.snoozedUntil : null,
          never: record.never === true,
        };
      }
      return { apps: clean };
    } catch (err) {
      logger.warn("Could not read app-usage.json — starting fresh", { error: String(err) });
      return { apps: {} };
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: AppUsageState): void {
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
      logger.warn("Could not save app-usage.json", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
