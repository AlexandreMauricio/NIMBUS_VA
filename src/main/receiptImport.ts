import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, dialog } from "electron";
import { logger } from "../logging/logger";
import { parseReceiptText } from "../meals/receiptText";
import { readPdfText } from "./pdfText";
import type { ParsedReceipt } from "../meals/receiptText";

/**
 * Reading a receipt or an invoice on this PC — nothing is sent anywhere.
 *
 * The file is chosen in the main process's own dialog (the renderer never
 * names a path), read here, turned into text, and parsed by the same pure
 * parser typed text goes through (src/meals/receiptText.ts). What comes
 * out is a purchase held for review: nothing changes in the kitchen until
 * each line has been checked and the purchase confirmed.
 *
 * Invoice PDFs are read with pdfjs-dist — their text, not their pictures.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface ReadReceipt extends ParsedReceipt {
  source: "pdf" | "photo";
  fileName: string;
}

/** Opens the dialog and reads the chosen receipt or invoice. Null if cancelled. */
export async function chooseAndReadReceipt(parent: BrowserWindow | null): Promise<ReadReceipt | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a receipt or an invoice",
    properties: ["openFile"],
    filters: [{ name: "Invoice PDFs", extensions: ["pdf"] }],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("That file is too big (over 20 MB).");
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".pdf") throw new Error("That isn't a PDF.");
  const text = await readPdfText(new Uint8Array(fs.readFileSync(file)));
  if (!text.trim())
    throw new Error(
      "That PDF has no text in it — it's probably a scanned picture. Try it as a photo instead."
    );
  const parsed = parseReceiptText(text);
  logger.info("Read a receipt", { kind: "pdf", lines: parsed.lines.length, store: parsed.store });
  return { ...parsed, source: "pdf", fileName: path.basename(file) };
}
