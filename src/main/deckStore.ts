import * as path from "path";
import { app } from "electron";
import { DeckState, DeckStore } from "../collections/decks/types";
import { loadJsonOrSetAside, saveJsonFile } from "./jsonFile";

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
    return loadJsonOrSetAside(filePath());
  }

  save(state: DeckState): void {
    saveJsonFile(filePath(), state);
  }
}
