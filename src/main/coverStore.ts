import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, app, dialog, nativeImage, protocol } from "electron";
import { logger } from "../logging/logger";

/**
 * Pictures you choose: covers for books and photos for recipes. The
 * picture is picked in the main process's own file dialog, resized, saved
 * as a JPEG in its own folder under userData (`book-covers/<id>.jpg`,
 * `recipe-photos/<id>.jpg`), and shown through the `nimbus-cover://<kind>/
 * <id>.jpg` scheme — so the renderer never names a path and nothing outside
 * those folders can be served.
 */

export type PictureKind = "cover" | "recipe";

const KINDS: Record<PictureKind, { folder: string; maxWidth: number; title: string }> = {
  cover: { folder: "book-covers", maxWidth: 600, title: "Choose a cover" },
  recipe: { folder: "recipe-photos", maxWidth: 1200, title: "Choose a photo" },
};

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;

function folderOf(kind: PictureKind): string {
  return path.join(app.getPath("userData"), KINDS[kind].folder);
}

function picturePath(kind: PictureKind, id: string): string | null {
  return SAFE_ID.test(id) ? path.join(folderOf(kind), `${id}.jpg`) : null;
}

/** Opens the picker and saves the chosen picture for `id`. False if cancelled. */
export async function choosePictureFile(
  kind: PictureKind,
  parent: BrowserWindow | null,
  id: string
): Promise<boolean> {
  const target = picturePath(kind, id);
  if (!target) throw new Error("That can't have a picture.");
  const options: Electron.OpenDialogOptions = {
    title: KINDS[kind].title,
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return false;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("That picture is too big (over 30 MB).");
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error("That file isn't a picture NIMBUS can read.");
  if (image.getSize().width > KINDS[kind].maxWidth)
    image = image.resize({ width: KINDS[kind].maxWidth, quality: "best" });
  fs.mkdirSync(folderOf(kind), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, image.toJPEG(85));
  fs.renameSync(temp, target);
  logger.info("Picture chosen", { kind, id });
  return true;
}

export function removePictureFile(kind: PictureKind, id: string): void {
  const target = picturePath(kind, id);
  if (!target) return;
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err) {
    logger.warn("Could not remove a picture", { kind, error: String(err) });
  }
}

/** A book's cover: the original, book-only name for the same thing. */
export function chooseCoverFile(parent: BrowserWindow | null, bookId: string): Promise<boolean> {
  return choosePictureFile("cover", parent, bookId);
}

export function removeCoverFile(bookId: string): void {
  removePictureFile("cover", bookId);
}

/** Serves `nimbus-cover://<cover|recipe>/<id>.jpg` from its folder, and nothing else. */
export function registerCoverProtocol(): void {
  protocol.handle("nimbus-cover", async (request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([A-Za-z0-9-]{1,80})\.jpg$/);
    const kind = url.hostname === "cover" || url.hostname === "recipe" ? url.hostname : null;
    const target = kind && match ? picturePath(kind, match[1]) : null;
    if (!target || !fs.existsSync(target)) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(target), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
    });
  });
}
