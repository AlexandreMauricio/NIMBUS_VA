import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/logger";

/**
 * The one way NIMBUS writes and reads its state files.
 *
 * Writes go to a sibling temp file, are flushed to disk, then renamed over
 * the real file — an atomic replace on NTFS, since a sibling is always on
 * the same volume. A plain `writeFileSync` to the real path truncates it
 * first, so a crash mid-write would leave half a file, which reads back as
 * corruption. The fsync matters too: without it the rename can land ahead
 * of the data. So the real file is only ever the old complete version or
 * the new complete one.
 *
 * No Electron here — callers pass full paths — so it is tested with plain
 * `node --test`.
 */

/** Writes `data` to `file` atomically. Throws on failure, leaving no temp file behind. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const temp = `${file}.tmp`;
  try {
    const fd = fs.openSync(temp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (err) {
    // Never leave a stray temp file to be mistaken for real state.
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // Best effort — the write already failed and the caller hears of it.
    }
    throw err;
  }
}

/**
 * `writeFileAtomic` of a value as JSON, for stores whose failed save is
 * logged and lived with: the state stays in memory and the next save tries
 * again. Returns whether it was written.
 */
export function saveJsonFile(
  file: string,
  value: unknown,
  failure = `Could not save ${path.basename(file)}`,
  level: "warn" | "error" = "warn"
): boolean {
  try {
    writeFileAtomic(file, JSON.stringify(value));
    return true;
  } catch (err) {
    logger[level](failure, { error: String(err) });
    return false;
  }
}

/**
 * Reads a JSON state file whose contents were mostly typed by hand. A
 * missing file is `null`; one that can't be read or parsed is moved aside
 * to `<name>.unreadable-<time>.json` rather than left to be overwritten by
 * the next save, and is `null` too.
 */
export function loadJsonOrSetAside(file: string): unknown {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    const name = path.basename(file);
    const aside = path.join(
      path.dirname(file),
      `${name.replace(/\.json$/, "")}.unreadable-${Date.now()}.json`
    );
    logger.warn(`Could not read ${name} — setting it aside`, { error: String(err) });
    try {
      fs.renameSync(file, aside);
    } catch {
      // If it can't be moved, the warning stands; the next save replaces it.
    }
    return null;
  }
}
