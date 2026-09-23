import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, app, dialog, nativeImage } from "electron";
import { logger } from "../logging/logger";
import { parseReceiptText } from "../meals/receiptText";
import { readImageText } from "./ocrText";
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
 * Photos are read with tesseract.js (ocrText.ts), after scaling a small
 * picture up, since OCR reads small print badly.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
/** A photo narrower than this is scaled up before reading. */
const OCR_MIN_WIDTH = 1600;

export interface ReadReceipt extends ParsedReceipt {
  source: "pdf" | "photo";
  fileName: string;
}

/** Opens the dialog and reads the chosen receipt or invoice. Null if cancelled. */
export async function chooseAndReadReceipt(parent: BrowserWindow | null): Promise<ReadReceipt | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a receipt or an invoice",
    properties: ["openFile"],
    filters: [
      { name: "Receipts and invoices", extensions: ["pdf", ...PHOTO_EXTENSIONS.map((e) => e.slice(1))] },
      { name: "Invoice PDFs", extensions: ["pdf"] },
      { name: "Receipt photos", extensions: PHOTO_EXTENSIONS.map((e) => e.slice(1)) },
    ],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("That file is too big (over 20 MB).");
  const extension = path.extname(file).toLowerCase();

  if (extension === ".pdf") {
    const text = await readPdfText(new Uint8Array(fs.readFileSync(file)));
    if (!text.trim())
      throw new Error(
        "That PDF has no text in it — it's a scanned picture. Take a photo or a screenshot of it and upload that instead."
      );
    const parsed = parseReceiptText(text);
    logger.info("Read a receipt", { kind: "pdf", lines: parsed.lines.length, store: parsed.store });
    return { ...parsed, source: "pdf", fileName: path.basename(file) };
  }

  if (!PHOTO_EXTENSIONS.includes(extension)) throw new Error("That isn't a PDF or a photo.");
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error("That file isn't a picture NIMBUS can read.");
  if (image.getSize().width < OCR_MIN_WIDTH) image = image.resize({ width: OCR_MIN_WIDTH, quality: "best" });
  const text = await readImageText(image.toPNG(), path.join(app.getPath("userData"), "ocr-cache"));
  const parsed = parseReceiptText(text, { ocr: true });
  if (!parsed.lines.length)
    throw new Error("No purchase lines could be read from that photo — try a sharper, flatter one.");
  logger.info("Read a receipt", { kind: "photo", lines: parsed.lines.length, store: parsed.store });
  return { ...parsed, source: "photo", fileName: path.basename(file) };
}
