/**
 * Receipt and invoice text → purchase lines.
 *
 * What comes in is text, however it was got — typed, extracted from a PDF
 * invoice, or read off a photo — so this is one pure parser for all three.
 * It knows the shape Portuguese supermarket receipts share:
 *
 *   COXA FRANGO KG
 *       1,210 kg x 5,49 EUR/kg          6,65 C
 *   IOG GREGO NAT 4X125G                 2,49 A
 *   2 x 0,79                             1,58
 *   QJ MOZ 125G
 *   DESCONTO                            -0,20
 *   TOTAL                               42,87
 *
 * — a description, a price at the end of the line (often followed by the
 * VAT rate's letter), weight and multiple lines that belong to the item
 * above or below them, discounts that reduce the item before them, and a
 * tail of totals, VAT and payment lines that are not items at all.
 *
 * Nothing here decides what food a line is: that's `matchLine`, and you
 * check it. This only gets the text into lines with the right numbers.
 */

export interface ReceiptLine {
  raw: string;
  quantity: number | null;
  unit: string | null;
  price: number | null;
}

export interface ParsedReceipt {
  store: string | null;
  date: string | null;
  lines: ReceiptLine[];
  total: number | null;
}

/** Stores recognised in a receipt's header, as they're usually printed. */
const KNOWN_STORES: Array<[RegExp, string]> = [
  [/continente/i, "Continente"],
  [/pingo\s*doce/i, "Pingo Doce"],
  [/\blidl\b/i, "Lidl"],
  [/\baldi\b/i, "Aldi"],
  [/intermarch/i, "Intermarché"],
  [/\bauchan\b/i, "Auchan"],
  [/minipre[çc]o/i, "Minipreço"],
  [/mercadona/i, "Mercadona"],
  [/el\s*corte\s*ingl/i, "El Corte Inglés"],
  [/\bspar\b/i, "Spar"],
  [/\bfroiz\b/i, "Froiz"],
  [/\bmakro\b/i, "Makro"],
  [/\bdia\b/i, "Dia"],
];

/** Lines that are never an item: totals, VAT, payment, the till's own chatter. */
const NOT_ITEMS =
  /\b(sub-?total|total|iva|taxa|base\s+trib|multibanco|mb|visa|mastercard|cart[aã]o|numer[aá]rio|dinheiro|troco|entregue|pagamento|contribuinte|nif|contrib|atendid[oa]|operador[a]?|tal[aã]o|fatura|factura|doc|obrigad[oa]|volte\s+sempre|saldo|pontos|cup[aã]o\s+emitido|www|tel|telefone|morada|lda)\b/i;

const DISCOUNT = /\b(desc(onto)?|poupan[çc]a|promo(c[aã]o)?|oferta|desconto\s+cart[aã]o|reduc)/i;

/** "6,65", "6.65", "-0,20" — a money amount with two decimals. */
const MONEY = /(-?\d{1,5}[.,]\d{2})(?!\d)/;

/** A price at the very end of a line, optionally followed by a VAT letter or "EUR"/"€". */
const TRAILING_PRICE = /(-?\d{1,5}[.,]\d{2})\s*(?:€|eur)?\s*(?:[A-F]|\(?\d{1,2}%\)?)?\s*$/i;

/** "1,210 kg x 5,49" — a weighed item. */
const WEIGHED = /(\d+[.,]\d{1,3})\s*(kg|g)\s*[x×*]\s*(\d+[.,]\d{2})/i;

/** "2 x 0,79" or "2 UN x 0,79" — several of the same. */
const MULTIPLE = /^\s*(\d{1,3})\s*(?:un\.?|und\.?|x)?\s*[x×*]\s*(\d+[.,]\d{2})/i;

const num = (value: string) => Number(value.replace(",", "."));

/** A pack size written in the description: "4X125G" is 500 g, "1KG" is 1 kg, "1,5L" is 1.5 l. */
export function sizeFromDescription(text: string): { quantity: number; unit: string } | null {
  const units: Record<string, string> = { kg: "kg", g: "g", gr: "g", l: "l", lt: "l", ml: "ml", cl: "cl" };
  const multi = /(\d{1,2})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml|cl)\b/i.exec(text);
  if (multi) {
    const unit = units[multi[3].toLowerCase()];
    return { quantity: Math.round(num(multi[1]) * num(multi[2]) * 1000) / 1000, unit };
  }
  const single = /(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml|cl)\b/i.exec(text);
  if (single) return { quantity: num(single[1]), unit: units[single[2].toLowerCase()] };
  return null;
}

function cleanDescription(text: string): string {
  return text
    .replace(TRAILING_PRICE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s*#.-]+|[\s*#.-]+$/g, "")
    .trim();
}

/** Reads a date in the formats receipts use: 19-09-2026, 19/09/26, 2026-09-19. */
export function readDate(text: string): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (!dmy) return null;
  const day = Number(dmy[1]);
  const month = Number(dmy[2]);
  let year = Number(dmy[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * OCR's usual misreads at the end of a receipt line, where the price is:
 * letters for digits ("O" for 0, "l" for 1, "S" for 5, "B" for 8), a
 * missing decimal comma ("1286" for 12,86 — a number set apart after a
 * wide gap, three or four digits), and a VAT letter read as a digit
 * ("2,484" for 2,48 A). Only the last word of a line is touched, and every
 * line read from a photo is checked by you anyway.
 */
export function repairOcrLine(row: string): string {
  const match = /^(.*?\S)(\s{2,}|\s+[=:]?\s*)(\S+)$/.exec(row.trimEnd());
  if (!match) return row;
  const [, head, gap] = match;
  let last = match[3];
  if (/^[\dOoIlSBEs.,]+$/.test(last) && /\d/.test(last))
    last = last.replace(/[Oo]/g, "0").replace(/[Il]/g, "1").replace(/[Ss]/g, "5").replace(/B/g, "8");
  if (/^\d+[.,]\d{3}$/.test(last)) last = last.slice(0, -1);
  else if (/^\d{3,4}$/.test(last) && gap.length >= 2) last = `${last.slice(0, -2)},${last.slice(-2)}`;
  return `${head}${gap}${last}`;
}

export function parseReceiptText(text: string, options: { ocr?: boolean } = {}): ParsedReceipt {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.replace(/\t/g, "  ").replace(/\s+$/, ""))
    .map((row) => (options.ocr ? repairOcrLine(row) : row))
    .filter((row) => row.trim());

  let store: string | null = null;
  for (const row of rows.slice(0, 12)) {
    const known = KNOWN_STORES.find(([pattern]) => pattern.test(row));
    if (known) {
      store = known[1];
      break;
    }
  }
  let date: string | null = null;
  for (const row of rows) {
    date = readDate(row);
    if (date) break;
  }

  const lines: ReceiptLine[] = [];
  let total: number | null = null;
  // A description waiting for its price on a following line.
  let pending: string | null = null;
  // Until the first priced item, unpriced lines are the header (the shop's
  // name and address); after the total, everything is the footer.
  let seenItem = false;
  let afterTotal = false;
  const flushPending = () => {
    if (pending && seenItem) lines.push({ raw: pending, quantity: null, unit: null, price: null });
    pending = null;
  };

  for (const row of rows) {
    const trimmed = row.trim();
    if (afterTotal) continue;
    // Read off a photo, a price may be lost: after the date line, a line
    // without one is still a line to fill in, not the shop's header.
    if (options.ocr && !seenItem && readDate(trimmed)) {
      seenItem = true;
      pending = null;
      continue;
    }
    if (/^\s*total\b/i.test(trimmed) && !/sub-?total/i.test(trimmed)) {
      const money = TRAILING_PRICE.exec(trimmed) ?? MONEY.exec(trimmed);
      if (money) total = num(money[1]);
      flushPending();
      afterTotal = seenItem;
      continue;
    }

    const priceMatch = TRAILING_PRICE.exec(trimmed);
    const price = priceMatch ? num(priceMatch[1]) : null;

    // A discount: take it off the item before it. Checked before the
    // payment lines, since "DESCONTO CARTÃO" names the card too.
    if (
      DISCOUNT.test(trimmed) ||
      (price !== null && price < 0 && !/[a-z]{4,}/i.test(cleanDescription(trimmed)))
    ) {
      const last = lines[lines.length - 1];
      if (last && price !== null && last.price !== null)
        last.price = Math.round((last.price - Math.abs(price)) * 100) / 100;
      pending = null;
      continue;
    }
    if (NOT_ITEMS.test(trimmed)) {
      pending = null;
      continue;
    }

    // "1,210 kg x 5,49 ... 6,65": the weight of the item above (or on this line).
    const weighed = WEIGHED.exec(trimmed);
    if (weighed) {
      const quantity = num(weighed[1]);
      const unit = weighed[2].toLowerCase();
      const described = cleanDescription(trimmed.slice(0, weighed.index));
      const lineTotal = price ?? Math.round(quantity * num(weighed[3]) * 100) / 100;
      const raw = described || pending;
      if (raw) {
        lines.push({ raw, quantity, unit, price: lineTotal });
        seenItem = true;
        pending = null;
      } else {
        const last = lines[lines.length - 1];
        if (last && last.price === null) Object.assign(last, { quantity, unit, price: lineTotal });
      }
      continue;
    }

    // "2 x 0,79   1,58": how many of the item above, or of the one it waits for.
    const multiple = MULTIPLE.exec(trimmed);
    if (multiple && !/[a-z]{3,}/i.test(trimmed.replace(/\b(un|und|eur)\b/gi, ""))) {
      const count = Number(multiple[1]);
      const lineTotal = price ?? Math.round(count * num(multiple[2]) * 100) / 100;
      if (pending) {
        const size = sizeFromDescription(pending);
        lines.push({
          raw: pending,
          quantity: size ? Math.round(size.quantity * count * 1000) / 1000 : count,
          unit: size ? size.unit : "piece",
          price: lineTotal,
        });
        seenItem = true;
        pending = null;
      } else {
        const last = lines[lines.length - 1];
        if (last) {
          const size = sizeFromDescription(last.raw);
          last.quantity = size ? Math.round(size.quantity * count * 1000) / 1000 : count;
          last.unit = size ? size.unit : "piece";
          last.price = lineTotal;
        }
      }
      continue;
    }

    const description = cleanDescription(trimmed);
    if (!description || !/[a-zà-ÿ]{2,}/i.test(description)) continue;
    if (price === null) {
      // A description alone: its price is on the next line.
      flushPending();
      pending = description;
      continue;
    }
    flushPending();
    const size = sizeFromDescription(description);
    lines.push({ raw: description, quantity: size?.quantity ?? 1, unit: size?.unit ?? "piece", price });
    seenItem = true;
  }
  flushPending();

  return { store, date, lines: lines.filter((line) => line.raw.length >= 2), total };
}

/** What the lines add up to, and whether that matches the printed total. */
export function reconcile(
  lines: Array<{ price: number | null }>,
  total: number | null
): { sum: number; matches: boolean | null; unpriced: number } {
  const sum = Math.round(lines.reduce((acc, line) => acc + (line.price ?? 0), 0) * 100) / 100;
  const unpriced = lines.filter((line) => line.price === null).length;
  return { sum, matches: total === null ? null : Math.abs(sum - total) < 0.015, unpriced };
}

/** A piece of text on a page, where the PDF put it (x from the left, y from the bottom). */
export interface PlacedText {
  text: string;
  x: number;
  y: number;
  page: number;
}

/**
 * A PDF gives text as placed pieces, not lines. Pieces at the same height
 * (within a couple of points) are one line, read left to right, with a
 * wide gap kept as a double space so a price still reads as the end of
 * its line; pages follow one another, top to bottom.
 */
export function linesFromPlacedText(pieces: PlacedText[]): string {
  const rows: Array<{ page: number; y: number; items: PlacedText[] }> = [];
  for (const piece of pieces) {
    if (!piece.text.trim()) continue;
    const row = rows.find((r) => r.page === piece.page && Math.abs(r.y - piece.y) <= 2);
    if (row) row.items.push(piece);
    else rows.push({ page: piece.page, y: piece.y, items: [piece] });
  }
  rows.sort((a, b) => a.page - b.page || b.y - a.y);
  return rows
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text.trim())
        .join("  ")
    )
    .join("\n");
}
