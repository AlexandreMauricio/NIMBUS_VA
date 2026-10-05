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

/** Gathered saves not yet written — see DebouncedJsonFile. */
const pendingFiles = new Set<DebouncedJsonFile>();

/**
 * Saves of one file, gathered: the first save after the file was written
 * starts a short wait, every save during it only replaces the value, and
 * then the latest one is written once. For state saved many times in a
 * row — cooking a meal saves after each thing it changes — so the
 * work is one write, not a dozen.
 *
 * A save waits at most `delayMs`, so a crash loses at most that much.
 * `flushPendingWrites` writes every waiting file now: NIMBUS calls it
 * when it quits and before it exports or imports data, so what's on disk
 * is never behind what's in memory when it matters.
 */
export class DebouncedJsonFile {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private value: unknown = undefined;

  constructor(
    private readonly file: () => string,
    private readonly delayMs = 250
  ) {}

  save(value: unknown): void {
    this.value = value;
    this.pending = true;
    pendingFiles.add(this);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    // Never the reason the process stays up; quitting flushes anyway.
    this.timer.unref?.();
  }

  /** Writes the waiting value now, if there is one. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    pendingFiles.delete(this);
    if (!this.pending) return;
    this.pending = false;
    const value = this.value;
    this.value = undefined;
    saveJsonFile(this.file(), value);
  }
}

/** Writes every gathered save that is still waiting. */
export function flushPendingWrites(): void {
  for (const file of [...pendingFiles]) file.flush();
}
