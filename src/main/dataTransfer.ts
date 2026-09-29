/**
 * Export and import of your data, to move it to NIMBUS on another PC.
 *
 * Export writes one file — the sections in src/transfer/bundle.ts, read
 * from userData — wherever you choose in NIMBUS's save dialog. Import reads
 * a file you choose, checks it (bundle.ts), and tells the Settings page
 * what's in it; nothing is written until you pick the sections and
 * confirm. Then this PC's copy of those sections is backed up to
 * `<userData>/backups/<time>/`, the imported files replace them, and NIMBUS
 * restarts at once — `app.exit` skips the quit handlers, so nothing held in
 * memory writes the old data back over the new.
 *
 * The renderer never names a path: dialogs are the main process's, and a
 * pending import is kept here, not sent back and forth.
 */

import { app, dialog } from "electron";
import type { BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/logger";
import {
  MAX_TRANSFER_BYTES,
  SECTIONS,
  SECTION_IDS,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  allowedPath,
  readBundle,
} from "../transfer/bundle";
import type {
  SectionId,
  SectionSpec,
  SectionSummary,
  TransferBundle,
  TransferFile,
} from "../transfer/bundle";

const userData = () => app.getPath("userData");

/** The files of one section as they are on this PC now. */
function sectionFiles(id: SectionId): TransferFile[] {
  const spec: SectionSpec = SECTIONS[id];
  const files: TransferFile[] = [];
  for (const name of spec.files) {
    const full = path.join(userData(), name);
    if (fs.existsSync(full))
      files.push({ path: name, encoding: "utf8", data: fs.readFileSync(full, "utf-8") });
  }
  if (spec.folder) {
    const dir = path.join(userData(), spec.folder.name);
    if (fs.existsSync(dir))
      for (const name of fs.readdirSync(dir)) {
        const relative = `${spec.folder.name}/${name}`;
        if (!allowedPath(id, relative)) continue;
        const full = path.join(dir, name);
        const text = name.endsWith(".json");
        files.push({
          path: relative,
          encoding: text ? "utf8" : "base64",
          data: text ? fs.readFileSync(full, "utf-8") : fs.readFileSync(full).toString("base64"),
        });
      }
  }
  return files;
}

/** What this PC has in each section — for the Settings page. */
export function localSummary(): Array<{ id: SectionId; label: string; files: number }> {
  return SECTION_IDS.map((id) => ({ id, label: SECTIONS[id].label, files: sectionFiles(id).length }));
}

/** Everything exportable, to a file you choose. Returns where it went, or null if cancelled. */
export async function exportData(parent: BrowserWindow | null): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  const options = {
    title: "Export your NIMBUS data",
    defaultPath: path.join(app.getPath("documents"), `NIMBUS data ${day}.nimbus.json`),
    filters: [{ name: "NIMBUS data", extensions: ["json"] }],
  };
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return null;
  const bundle: TransferBundle = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    appVersion: app.getVersion(),
    exportedAt: new Date().toISOString(),
    sections: {},
  };
  for (const id of SECTION_IDS) {
    const files = sectionFiles(id);
    if (files.length) bundle.sections[id] = files;
  }
  fs.writeFileSync(picked.filePath, JSON.stringify(bundle), "utf-8");
  logger.info("Data exported", { sections: Object.keys(bundle.sections).length });
  return picked.filePath;
}

/** An import file read and checked, waiting for you to choose what to take from it. */
let pending: TransferBundle | null = null;

/** Opens an export file and says what's in it. Nothing is written. Null if cancelled. */
export async function readImport(
  parent: BrowserWindow | null
): Promise<{ summary: SectionSummary[]; appVersion: string; exportedAt: string } | null> {
  const options = {
    title: "Import NIMBUS data",
    properties: ["openFile" as const],
    filters: [{ name: "NIMBUS data", extensions: ["json"] }],
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;
  const file = picked.filePaths[0];
  if (fs.statSync(file).size > MAX_TRANSFER_BYTES)
    throw new Error("That file is too big to be a NIMBUS export.");
  const { bundle, summary } = readBundle(fs.readFileSync(file, "utf-8"));
  pending = bundle;
  return { summary, appVersion: bundle.appVersion, exportedAt: bundle.exportedAt };
}

/** Forget a read import without applying it. */
export function cancelImport(): void {
  pending = null;
}

/**
 * Replaces the chosen sections with the pending import: backs this PC's
 * up first, writes the new files, and restarts NIMBUS.
 */
export function applyImport(chosen: unknown): { backup: string } {
  if (!pending) throw new Error("Choose an export file first.");
  const ids = (Array.isArray(chosen) ? chosen : []).filter(
    (id): id is SectionId =>
      SECTION_IDS.includes(id as SectionId) && Boolean(pending!.sections[id as SectionId])
  );
  if (!ids.length) throw new Error("Tick at least one part to import.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(userData(), "backups", `before-import-${stamp}`);
  fs.mkdirSync(backup, { recursive: true });

  for (const id of ids) {
    const spec: SectionSpec = SECTIONS[id];
    // This PC's copy, kept.
    for (const file of sectionFiles(id)) {
      const target = path.join(backup, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.data, file.encoding === "utf8" ? "utf-8" : "base64"));
    }
    // Replaced: data files, and the folder emptied of its own kind of file first.
    for (const name of spec.files) fs.rmSync(path.join(userData(), name), { force: true });
    if (spec.folder) {
      const dir = path.join(userData(), spec.folder.name);
      if (fs.existsSync(dir))
        for (const name of fs.readdirSync(dir))
          if (allowedPath(id, `${spec.folder.name}/${name}`))
            fs.rmSync(path.join(dir, name), { force: true });
    }
    for (const file of pending.sections[id] ?? []) {
      if (!allowedPath(id, file.path)) continue;
      const target = path.join(userData(), ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.importing`;
      fs.writeFileSync(temp, Buffer.from(file.data, file.encoding === "utf8" ? "utf-8" : "base64"));
      fs.renameSync(temp, target);
    }
  }
  logger.info("Data imported; restarting", { sections: ids.length });
  pending = null;
  // Restart in the same step: what's in memory now is the old data, and a
  // background save (the credits queue, a reading) must not get a chance to
  // write it back over the new. The page goes with the restart.
  app.relaunch();
  app.exit(0);
  return { backup };
}
