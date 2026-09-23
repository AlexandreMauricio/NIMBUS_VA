import { test } from "node:test";
import assert from "node:assert/strict";
import { readPdfText } from "./pdfText";
import { linesFromPlacedText, parseReceiptText } from "../meals/receiptText";

/** A tiny text PDF: each [text, x, y] placed with Helvetica on one A4 page. */
function pdfWith(pieces: Array<[string, number, number]>): Uint8Array {
  const content = pieces.map(([text, x, y]) => `BT /F1 11 Tf ${x} ${y} Td (${text}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

test("pdf: placed pieces become lines — same height is one line, read left to right", () => {
  assert.equal(
    linesFromPlacedText([
      { text: "6,65", x: 400, y: 700, page: 1 },
      { text: "COXA FRANGO", x: 50, y: 701, page: 1 },
      { text: "CONTINENTE", x: 50, y: 780, page: 1 },
      { text: "TOTAL  6,65", x: 50, y: 500, page: 2 },
    ]),
    "CONTINENTE\nCOXA FRANGO  6,65\nTOTAL  6,65"
  );
});

test("pdf: an invoice's text is read on the PC and parses into lines", async () => {
  const data = pdfWith([
    ["CONTINENTE ONLINE", 50, 790],
    ["Data 12-09-2026", 50, 770],
    ["Iogurte grego natural 4x125g", 50, 700],
    ["2,49", 480, 700],
    ["Frango inteiro kg", 50, 680],
    ["1,450 kg x 3,99", 250, 680],
    ["5,79", 480, 680],
    ["TOTAL", 50, 600],
    ["8,28", 480, 600],
  ]);
  const text = await readPdfText(data);
  const receipt = parseReceiptText(text);
  assert.equal(receipt.store, "Continente");
  assert.equal(receipt.date, "2026-09-12");
  assert.equal(receipt.total, 8.28);
  assert.deepEqual(
    receipt.lines.map((line) => [line.raw, line.quantity, line.unit, line.price]),
    [
      ["Iogurte grego natural 4x125g", 500, "g", 2.49],
      ["Frango inteiro kg", 1.45, "kg", 5.79],
    ]
  );
});
