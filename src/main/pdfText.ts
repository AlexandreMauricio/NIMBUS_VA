import * as path from "path";
import { PlacedText, linesFromPlacedText } from "../meals/receiptText";

/**
 * The text of a PDF, read with pdfjs-dist on this PC. No Electron here, so
 * it runs under plain `node --test` too.
 */

/**
 * `import()` that tsc leaves alone. The project compiles to CommonJS,
 * which would turn a plain `import()` into `require()` — and pdfjs-dist
 * ships only as ES modules.
 */
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

interface PdfTextItem {
  str?: string;
  transform?: number[];
}

interface PdfJs {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

/** The text of a PDF, a line per row of text, pages in order. */
export async function readPdfText(data: Uint8Array): Promise<string> {
  const pdfjs = (await nativeImport("pdfjs-dist/legacy/build/pdf.mjs")) as PdfJs;
  // pdfjs wants its fonts folder with forward slashes and a trailing one.
  const fonts =
    path
      .join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")
      .split(path.sep)
      .join("/") + "/";
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: fonts,
    stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const pieces: PlacedText[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 20); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== "string" || !item.transform) continue;
        pieces.push({ text: item.str, x: item.transform[4], y: item.transform[5], page: n });
      }
    }
    return linesFromPlacedText(pieces);
  } finally {
    await task.destroy();
  }
}
