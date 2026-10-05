import * as path from "path";
import { app } from "electron";
import { CollectionState, CollectionStore } from "../collections/types";
import { loadJsonOrSetAside, saveJsonFile } from "./jsonFile";

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
    return loadJsonOrSetAside(filePath());
  }

  save(state: CollectionState): void {
    saveJsonFile(filePath(), state);
  }
}
