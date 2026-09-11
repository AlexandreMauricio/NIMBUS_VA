import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { SiteUsageState, SiteUsageStateStore } from "../activity/siteUsage";

/**
 * Persists the opt-in site tally (src/activity/siteUsage.ts): per site, the
 * name taken from the end of its titles, minutes per day for two weeks,
 * and the user's answers to "make it an activity?". Never whole titles or
 * addresses. Validated record by record when read.
 */
function stateFilePath(): string {
  return path.join(app.getPath("userData"), "site-usage.json");
}

export class FileSiteUsageStore implements SiteUsageStateStore {
  load(): unknown {
    const filePath = stateFilePath();
    try {
      if (!fs.existsSync(filePath)) return { sites: {} };
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      logger.warn("Could not read site-usage.json — starting fresh", { error: String(err) });
      return { sites: {} };
    }
  }

  /** Temp-file-then-rename, like the other state files. */
  save(state: SiteUsageState): void {
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
      logger.warn("Could not save site-usage.json", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the failure was already logged.
      }
    }
  }
}
