/**
 * Generate the synthetic player idle sheet PNG using Node.js built-ins only.
 * Equivalent to assets/src/character/src/char_gen/synth_sheet.py — generates
 * the same 144x144 mode-P indexed PNG with the home palette.
 *
 * Usage: node gen_synth_png.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Repo root is 3 levels up from this script (assets/src/character -> assets/src -> assets -> root)
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PALETTE_PATH = path.join(REPO_ROOT, 'assets', 'final', 'palette', 'home_palette.json');
const OUT_PATH = path.join(REPO_ROOT, 'assets', 'final', 'character', 'player_idle_sheet_v1.png');

const CELL_SIZE = 48;
const COLS = 3;
const ROWS = 3;
const WIDTH = COLS * CELL_SIZE;   // 144
const HEIGHT = ROWS * CELL_SIZE;  // 144

const BG_IDX = 0;
const LEG_IDX = 4;
const BODY_IDX = 6;
const HEAD_IDX = 10;

// Load palette (sorted by index)
const paletteData = JSON.parse(fs.readFileSync(PALETTE_PATH, 'utf-8'));
const slots = paletteData.slots.slice().sort((a, b) => parseInt(a.index) - parseInt(b.index));
const palette = slots.map(s => {
  const h = s.hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
});

// Pixel buffer (row-major, indexed)
const pixels = new Uint8Array(WIDTH * HEIGHT).fill(BG_IDX);

function drawFigure(cellRow, cellCol, headOffset) {
  const x0 = cellCol * CELL_SIZE;
  const y0 = cellRow * CELL_SIZE;

  // Clear cell to background
  for (let r = y0; r < y0 + CELL_SIZE; r++)
    for (let c = x0; c < x0 + CELL_SIZE; c++)
      pixels[r * WIDTH + c] = BG_IDX;

  // HEAD (8px tall, 12px wide)
  for (let r = y0 + 4 + headOffset; r < y0 + 12 + headOffset; r++)
    for (let c = x0 + 18; c < x0 + 30; c++)
      pixels[r * WIDTH + c] = HEAD_IDX;

  // NECK (4px tall, 6px wide) — bridges head to torso
  for (let r = y0 + 11 + headOffset; r < y0 + 15 + headOffset; r++)
    for (let c = x0 + 21; c < x0 + 27; c++)
      pixels[r * WIDTH + c] = BODY_IDX;

  // TORSO (16px tall, 18px wide)
  for (let r = y0 + 14; r < y0 + 30; r++)
    for (let c = x0 + 15; c < x0 + 33; c++)
      pixels[r * WIDTH + c] = BODY_IDX;

  // LEFT ARM (10px tall, 4px wide)
  for (let r = y0 + 14; r < y0 + 24; r++)
    for (let c = x0 + 12; c < x0 + 16; c++)
      pixels[r * WIDTH + c] = BODY_IDX;

  // RIGHT ARM (10px tall, 4px wide)
  for (let r = y0 + 14; r < y0 + 24; r++)
    for (let c = x0 + 32; c < x0 + 36; c++)
      pixels[r * WIDTH + c] = BODY_IDX;

  // LEFT LEG (14px tall, 5px wide)
  for (let r = y0 + 29; r < y0 + 43; r++)
    for (let c = x0 + 17; c < x0 + 22; c++)
      pixels[r * WIDTH + c] = LEG_IDX;

  // RIGHT LEG (14px tall, 5px wide)
  for (let r = y0 + 29; r < y0 + 43; r++)
    for (let c = x0 + 26; c < x0 + 31; c++)
      pixels[r * WIDTH + c] = LEG_IDX;
}

// Draw 4 idle frames (same layout as synth_sheet.py)
for (const [sr, sc, ho] of [[0, 0, 0], [0, 1, 1], [0, 2, 0], [1, 0, 1]])
  drawFigure(sr, sc, ho);

// --- PNG encoding (PNG spec, RFC 2083) ---

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++)
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// IHDR chunk (13 bytes)
const ihdr = Buffer.allocUnsafe(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;  // bit depth 8
ihdr[9] = 3;  // color type: indexed
ihdr[10] = 0; // compression: deflate
ihdr[11] = 0; // filter method: adaptive
ihdr[12] = 0; // interlace: none

// PLTE chunk — palette.length * 3 bytes
// PIL's putpalette fills all 256 slots, but PNG PLTE only needs the active entries.
// We include all palette entries so PIL can match indices correctly.
const plteData = Buffer.alloc(palette.length * 3, 0);
for (let i = 0; i < palette.length; i++) {
  plteData[i * 3]     = palette[i][0];
  plteData[i * 3 + 1] = palette[i][1];
  plteData[i * 3 + 2] = palette[i][2];
}

// IDAT: filter type 0 (None) + pixel row, then zlib-compress (RFC 1950)
const rawRows = Buffer.allocUnsafe(HEIGHT * (1 + WIDTH));
for (let row = 0; row < HEIGHT; row++) {
  rawRows[row * (1 + WIDTH)] = 0; // filter: None
  for (let col = 0; col < WIDTH; col++)
    rawRows[row * (1 + WIDTH) + 1 + col] = pixels[row * WIDTH + col];
}
const idatData = zlib.deflateSync(rawRows, { level: 9 });

// Assemble PNG file
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  makeChunk('IHDR', ihdr),
  makeChunk('PLTE', plteData),
  makeChunk('IDAT', idatData),
  makeChunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, png);
console.log('wrote', OUT_PATH);
console.log('size:', WIDTH + 'x' + HEIGHT, '|', 'palette:', palette.length, 'entries', '|', 'bytes:', png.length);
