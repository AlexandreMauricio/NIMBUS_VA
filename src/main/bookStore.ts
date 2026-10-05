import * as path from "path";
import { app } from "electron";
import { BookState, BookStore } from "../collections/books/types";
import { loadJsonOrSetAside, saveJsonFile } from "./jsonFile";

/**
 * Persists the shelf (src/collections/books/) to `books.json`: titles,
 * formats and the issue runs typed or looked up for each book. Validated
 * book by book when read; an unreadable file is set aside rather than
 * overwritten, since the contents were often typed by hand.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "books.json");
}

export class FileBookStore implements BookStore {
  load(): unknown {
    return loadJsonOrSetAside(filePath());
  }

  save(state: BookState): void {
    saveJsonFile(filePath(), state);
  }
}
