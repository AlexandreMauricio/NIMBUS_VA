import * as path from "path";
import { app } from "electron";
import { MealsState, MealsStore } from "../meals/types";
import { loadJsonOrSetAside, saveJsonFile } from "./jsonFile";

/**
 * Persists Meals (src/meals/) to `meals.json`: ingredients, recipes, the
 * pantry, leftovers, the plan and the household's preferences. Validated
 * entry by entry when read (`parseState`); an unreadable file is set aside
 * rather than overwritten, because most of what's in it was typed by hand.
 */
function filePath(): string {
  return path.join(app.getPath("userData"), "meals.json");
}

export class FileMealStore implements MealsStore {
  load(): unknown {
    return loadJsonOrSetAside(filePath());
  }

  save(state: MealsState): void {
    saveJsonFile(filePath(), state);
  }
}
