import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, app, dialog, nativeImage, protocol } from "electron";
import { logger } from "../logging/logger";

/**
 * Covers you choose for books. The picture is picked in the main process's
 * own file dialog, resized to at most 600 px wide, saved as a JPEG in
 * `<userData>/book-covers/<book id>.jpg`, and shown through the
 * `nimbus-cover://cover/<book id>.jpg` scheme — so the renderer never names
 * a path and nothing outside that folder can be served.
 */

const MAX_WIDTH = 600;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;

function coversDir(): string {
  return path.join(app.getPath("userData"), "book-covers");
}

function coverPath(bookId: string): string | null {
  return SAFE_ID.test(bookId) ? path.join(coversDir(), `${bookId}.jpg`) : null;
}

/** Opens the picker and saves the chosen picture as the book's cover. False if cancelled. */
export async function chooseCoverFile(parent: BrowserWindow | null, bookId: string): Promise<boolean> {
  const target = coverPath(bookId);
  if (!target) throw new Error("That book can't have a cover.");
  const options: Electron.OpenDialogOptions = {
    title: "Choose a cover",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return false;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("That picture is too big (over 30 MB).");
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error("That file isn't a picture NIMBUS can read.");
  if (image.getSize().width > MAX_WIDTH) image = image.resize({ width: MAX_WIDTH, quality: "best" });
  fs.mkdirSync(coversDir(), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, image.toJPEG(85));
  fs.renameSync(temp, target);
  logger.info("Book cover chosen", { bookId });
  return true;
}

export function removeCoverFile(bookId: string): void {
  const target = coverPath(bookId);
  if (!target) return;
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err) {
    logger.warn("Could not remove a book cover", { error: String(err) });
  }
}

/** Serves `nimbus-cover://cover/<book id>.jpg` from the covers folder, and nothing else. */
export function registerCoverProtocol(): void {
  protocol.handle("nimbus-cover", async (request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([A-Za-z0-9-]{1,80})\.jpg$/);
    const target = url.hostname === "cover" && match ? coverPath(match[1]) : null;
    if (!target || !fs.existsSync(target)) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(target), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
    });
  });
}
