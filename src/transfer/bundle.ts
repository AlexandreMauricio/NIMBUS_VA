/**
 * Moving your data to another PC — the export file's shape, and the checks
 * an import passes before anything is written. Pure: the main process
 * (src/main/dataTransfer.ts) reads and writes the files.
 *
 * An export is one JSON file: each section's data files as text, and its
 * pictures (book covers, recipe photos) as base64. Only these sections, by
 * these names, ever go in or come out — settings, passwords, tokens and
 * things that belong to one PC (the comics vault's folder, usage history)
 * never do.
 */

export const TRANSFER_FORMAT = "nimbus-data";
export const TRANSFER_VERSION = 1;

/** An import file bigger than this isn't one NIMBUS wrote. */
export const MAX_TRANSFER_BYTES = 300 * 1024 * 1024;
const MAX_FOLDER_FILES = 5000;

export interface SectionSpec {
  label: string;
  /** Data files in userData, by name. */
  files: string[];
  /** A folder in userData, and the file names allowed in it. */
  folder: { name: string; pattern: RegExp } | null;
}

/** Everything that moves, and nothing else. */
export const SECTIONS = {
  meals: {
    label: "Meals — recipes, pantry, plan, shopping, purchases, prices (and recipe photos)",
    files: ["meals.json"],
    folder: { name: "recipe-photos", pattern: /^[A-Za-z0-9_-]{1,80}\.jpg$/ },
  },
  books: {
    label: "Books — comics, manga and novels, reading log (and chosen covers)",
    files: ["books.json"],
    folder: { name: "book-covers", pattern: /^[A-Za-z0-9_-]{1,80}\.jpg$/ },
  },
  cards: { label: "Cards — your card collection", files: ["collection.json"], folder: null },
  decks: { label: "Decks", files: ["decks.json"], folder: null },
  memory: {
    label: "Memory — what you told NIMBUS and what it learned",
    files: [],
    folder: { name: "memory", pattern: /^(explicit|learned|observed)\.json$/ },
  },
} satisfies Record<string, SectionSpec>;

export type SectionId = keyof typeof SECTIONS;
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

/** One file in an export: text as is, pictures as base64. */
export interface TransferFile {
  /** "meals.json" or "recipe-photos/abc.jpg" — always one of the section's own. */
  path: string;
  encoding: "utf8" | "base64";
  data: string;
}

export interface TransferBundle {
  format: typeof TRANSFER_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  sections: Partial<Record<SectionId, TransferFile[]>>;
}

/** What an import file holds, for you to choose from before anything changes. */
export interface SectionSummary {
  id: SectionId;
  label: string;
  /** "recipes 12 · pantry 30" — the lists in its data files, counted. */
  detail: string;
  files: number;
}

/** Whether `path` may belong to section `id`: one of its data files, or a file in its folder. */
export function allowedPath(id: SectionId, path: string): boolean {
  const spec: SectionSpec = SECTIONS[id];
  if (spec.files.includes(path)) return true;
  if (!spec.folder) return false;
  const [folder, name, ...rest] = path.split("/");
  return rest.length === 0 && folder === spec.folder.name && spec.folder.pattern.test(name ?? "");
}

/** "recipes 12 · pantry 30": the top-level lists of a data file, counted. */
function describe(text: string): string {
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return `${value.length} entries`;
    if (!value || typeof value !== "object") return "";
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => Array.isArray(entry) && entry.length > 0)
      .map(([key, entry]) => `${key} ${(entry as unknown[]).length}`)
      .join(" · ");
  } catch {
    return "";
  }
}

/**
 * Checks an import file — the format, every path against its section, every
 * data file as JSON — and says what's in it. Throws with a plain reason when
 * it's not something NIMBUS can import; nothing is written either way.
 */
export function readBundle(text: string): { bundle: TransferBundle; summary: SectionSummary[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a NIMBUS export (it isn't JSON).");
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.format !== TRANSFER_FORMAT) throw new Error("That file isn't a NIMBUS export.");
  if (typeof r.version !== "number" || r.version > TRANSFER_VERSION)
    throw new Error("That export is from a newer NIMBUS — update this one first.");
  const sections = (r.sections ?? {}) as Record<string, unknown>;
  const bundle: TransferBundle = {
    format: TRANSFER_FORMAT,
    version: r.version,
    appVersion: typeof r.appVersion === "string" ? r.appVersion.slice(0, 40) : "unknown",
    exportedAt: typeof r.exportedAt === "string" ? r.exportedAt.slice(0, 40) : "",
    sections: {},
  };
  const summary: SectionSummary[] = [];
  for (const [id, entries] of Object.entries(sections)) {
    if (!SECTION_IDS.includes(id as SectionId))
      throw new Error(`That export has a part this NIMBUS doesn't know ("${id.slice(0, 40)}").`);
    if (!Array.isArray(entries) || entries.length > MAX_FOLDER_FILES + 5)
      throw new Error(`The ${id} part of that export is damaged.`);
    const files: TransferFile[] = [];
    for (const entry of entries) {
      const f = (entry ?? {}) as Record<string, unknown>;
      if (
        typeof f.path !== "string" ||
        typeof f.data !== "string" ||
        (f.encoding !== "utf8" && f.encoding !== "base64") ||
        !allowedPath(id as SectionId, f.path)
      )
        throw new Error(`The ${id} part of that export has a file that doesn't belong there.`);
      if (f.encoding === "utf8") {
        try {
          JSON.parse(f.data);
        } catch {
          throw new Error(`${f.path} in that export is damaged.`);
        }
      } else if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))
        throw new Error(`${f.path} in that export is damaged.`);
      files.push({ path: f.path, encoding: f.encoding, data: f.data });
    }
    if (!files.length) continue;
    bundle.sections[id as SectionId] = files;
    const spec: SectionSpec = SECTIONS[id as SectionId];
    const data = files.filter((file) => file.encoding === "utf8");
    const pictures = files.length - data.length;
    summary.push({
      id: id as SectionId,
      label: spec.label,
      detail: [
        ...data.map((file) => describe(file.data)).filter(Boolean),
        pictures ? `${pictures} picture${pictures === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      files: files.length,
    });
  }
  if (!summary.length) throw new Error("That export has nothing in it to import.");
  return { bundle, summary };
}
