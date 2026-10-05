import * as fs from "fs";
import * as path from "path";
import { loadJsonOrSetAside, saveJsonFile } from "./jsonFile";
import { MemoryItem, MemoryOrigin, MemoryStateStore } from "../memory/types";

/**
 * Memory on disk: one file per tier in a `memory` folder under NIMBUS's
 * data directory — explicit.json, learned.json, observed.json — so the
 * user's own memories never share a file with what NIMBUS worked out.
 *
 * Same conventions as the other state files: plain JSON (nothing here is
 * a credential), written to a temp file, fsynced, then renamed. A file
 * that can't be parsed is moved aside (`<tier>.unreadable-<time>.json`)
 * rather than overwritten, so nothing is lost to a bad write or a hand
 * edit. The folder is passed in, so this has no Electron dependency.
 */
export class FileMemoryStore implements MemoryStateStore {
  constructor(private readonly directory: string) {}

  private file(origin: MemoryOrigin): string {
    return path.join(this.directory, `${origin}.json`);
  }

  load(origin: MemoryOrigin): unknown {
    const parsed = loadJsonOrSetAside(this.file(origin)) as { version?: unknown; items?: unknown } | null;
    if (parsed === null) return [];
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.items : parsed;
  }

  save(origin: MemoryOrigin, items: MemoryItem[]): void {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
    } catch {
      // saveJsonFile below logs the failure this causes.
    }
    saveJsonFile(this.file(origin), { version: 1, items }, `Could not save ${origin} memory`);
  }
}
