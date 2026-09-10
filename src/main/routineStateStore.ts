import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../logging/logger";
import { RoutineRuntimeState, RoutineStateStore } from "../routines/types";

/**
 * Persists the routine engine's runtime state — today, just when each
 * routine last fired.
 *
 * Kept out of settings.json on purpose. settings.json is what the *user*
 * configured and is meant to stay readable and hand-editable; this is
 * machine bookkeeping that changes every time a routine fires, and
 * mixing the two would churn a file people are invited to inspect.
 *
 * Not encrypted, unlike SecretStore: a timestamp saying "routine X last
 * ran at 20:15" is not a credential, and using safeStorage here would
 * mean the file could not be read until the app is ready — a trap this
 * codebase has already been bitten by once (see settingsManager's
 * hydrateCredentials). Plain JSON can be read during startApp, which is
 * exactly when RoutineService is constructed.
 *
 * Windows-specific only in that it uses Electron's userData path, so it
 * lives under src/main/ and is injected into Core as a RoutineStateStore.
 */

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "routine-state.json");
}

const EMPTY: RoutineRuntimeState = { lastTriggeredAt: {} };

export class FileRoutineStateStore implements RoutineStateStore {
  /** Never throws: a missing or corrupt file just means cooldowns start fresh. */
  load(): RoutineRuntimeState {
    const filePath = stateFilePath();
    try {
      if (!fs.existsSync(filePath)) return { lastTriggeredAt: {} };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<RoutineRuntimeState>;
      // A timestamp from a tampered or truncated file must not poison
      // cooldown maths — anything that isn't a real number is dropped.
      const numbersOnly = (record: Record<string, unknown> | undefined): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const [routineId, at] of Object.entries(record ?? {})) {
          if (typeof at === "number" && Number.isFinite(at)) out[routineId] = at;
        }
        return out;
      };
      return {
        lastTriggeredAt: numbersOnly(parsed.lastTriggeredAt),
        awaitingStop: numbersOnly(parsed.awaitingStop),
      };
    } catch (err) {
      logger.warn("Could not read routine-state.json — cooldowns start fresh", {
        error: String(err),
      });
      return { lastTriggeredAt: {} };
    }
  }

  /**
   * Same temp-file-then-rename write settings.json uses: this is written
   * every time a routine fires, so a crash mid-write is a real
   * possibility, and a truncated file would read back as "no cooldowns"
   * — precisely the spam cooldowns exist to prevent.
   */
  save(state: RoutineRuntimeState): void {
    const filePath = stateFilePath();
    const tempPath = `${filePath}.tmp`;
    try {
      const fd = fs.openSync(tempPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(state ?? EMPTY), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.warn("Could not write routine-state.json", { error: String(err) });
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort — the write already failed and was logged above.
      }
    }
  }
}
