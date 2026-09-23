import * as os from "os";
import * as path from "path";
import { PSM, createWorker } from "tesseract.js";

/**
 * The text of a photographed receipt, read with tesseract.js on this PC —
 * the Portuguese model ships with NIMBUS, so nothing is downloaded or sent.
 *
 * OCR on thermal paper is rough, which is why every line it produces goes
 * into the purchase review unchecked: this only gets the words in, you
 * decide what they are.
 *
 * No Electron here. Inside a packaged app the worker script, the wasm core
 * and the language data are unpacked from app.asar (a worker thread can't
 * load from inside the archive), so their paths are pointed there.
 */

/** A path inside app.asar, as its unpacked copy — unchanged outside a packaged app. */
function unpacked(file: string): string {
  return file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/** Reads the text of a receipt image (PNG or JPEG bytes). */
export async function readImageText(
  image: Buffer,
  cacheDir: string = path.join(os.tmpdir(), "nimbus-ocr")
): Promise<string> {
  const langPath = path.join(
    unpacked(path.dirname(require.resolve("@tesseract.js-data/por/package.json"))),
    "4.0.0_best_int"
  );
  const worker = await createWorker("por", 1, {
    langPath,
    cachePath: cacheDir,
    gzip: true,
    workerPath: unpacked(require.resolve("tesseract.js/src/worker-script/node/index.js")),
  });
  try {
    // A receipt is one block of text in columns; keep the gap before the price.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
