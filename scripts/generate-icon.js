// One-off generator for NIMBUS's placeholder icon (src/assets/icon.png).
// Builds a raw PNG by hand (IHDR/IDAT/IEND via Node's built-in zlib) so no
// image-processing dependency is needed for a simple flat-color glyph.
// Not part of the normal build — run manually if the icon needs to change:
//   node scripts/generate-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 32;
const BG = [0x4f, 0xc3, 0xf7, 255]; // accent blue, matches src/ui/styles.css
const FG = [0x0b, 0x0f, 0x14, 255]; // dark glyph, matches --bg

// 5x7 bitmap glyph for "N", scaled up and centered.
const GLYPH = [
  "10001",
  "11001",
  "10101",
  "10101",
  "10011",
  "10001",
  "10001",
];
const SCALE = 3;
const glyphW = GLYPH[0].length * SCALE;
const glyphH = GLYPH.length * SCALE;
const offsetX = Math.floor((SIZE - glyphW) / 2);
const offsetY = Math.floor((SIZE - glyphH) / 2);

function isGlyphPixel(x, y) {
  const gx = x - offsetX;
  const gy = y - offsetY;
  if (gx < 0 || gy < 0 || gx >= glyphW || gy >= glyphH) return false;
  return GLYPH[Math.floor(gy / SCALE)][Math.floor(gx / SCALE)] === "1";
}

function isInsideCircle(x, y) {
  const cx = SIZE / 2 - 0.5;
  const cy = SIZE / 2 - 0.5;
  const r = SIZE / 2;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = [0]; // filter type 0 (none)
  for (let x = 0; x < SIZE; x++) {
    const inside = isInsideCircle(x, y);
    const px = !inside ? [0, 0, 0, 0] : isGlyphPixel(x, y) ? FG : BG;
    row.push(...px);
  }
  rows.push(Buffer.from(row));
}
const raw = Buffer.concat(rows);
const compressed = zlib.deflateSync(raw);

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", compressed),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, "..", "src", "assets");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), png);
console.log("Wrote", path.join(outDir, "icon.png"));
