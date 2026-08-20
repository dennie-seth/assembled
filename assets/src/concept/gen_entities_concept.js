#!/usr/bin/env node
/**
 * Synthetic entities concept sheet generator for T-0210.
 * Node.js version using only built-in modules (no npm packages).
 *
 * Produces a 1024×1024 full-colour (RGB) PNG concept sheet at:
 *   assets/src/concept/entities_concept_sheet_v1.png
 *
 * Three entities: Watcher, Sound, Still Air.
 * Three states: IDLE | MOVE | TRAPPED (2×2 panel layout).
 *
 * Entity silhouettes match synth_entities.py (T-0200) cell geometry:
 *   Watcher:   wide compact orb     (rows 14:34, cols 10:38 in 48×48 cell)
 *   Sound:     wide flat wave-band  (rows 18:30, cols  8:40 in 48×48 cell)
 *   Still Air: tall narrow column   (rows  8:40, cols 20:28 in 48×48 cell)
 *
 * docs/design/13-asset-pipeline.md §6.9 (concept-sheet requirements):
 *   - Flat side-on elevation, no perspective
 *   - Reference-layout panels (not a composed scene)
 *   - Hard value separation: darks dark, lights light
 *   - Full-colour RGB, 1024×1024
 */

'use strict';
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

// ── Paths ────────────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUT_PNG   = path.join(REPO_ROOT, 'assets/src/concept/entities_concept_sheet_v1.png');
const OUT_PROV  = path.join(REPO_ROOT, 'assets/src/concept/entities_concept_sheet_v1.provenance.json');

// ── Home palette ─────────────────────────────────────────────────────────────
const PAL = {
  ramp00: [0x12, 0x11, 0x0e],
  ramp01: [0x1a, 0x19, 0x16],
  ramp02: [0x0b, 0x2d, 0x18],
  ramp03: [0x12, 0x3c, 0x23],
  ramp04: [0x3d, 0x3b, 0x31],
  ramp05: [0x22, 0x4d, 0x32],
  ramp06: [0x49, 0x49, 0x3b],
  ramp07: [0x4c, 0x55, 0x3a],
  ramp08: [0x58, 0x55, 0x4c],
  ramp09: [0x5a, 0x60, 0x42],
  ramp10: [0x64, 0x62, 0x58],
  ramp11: [0x61, 0x67, 0x47],
  ramp12: [0x71, 0x6f, 0x66],
  ramp13: [0x7e, 0x7c, 0x74],
  ramp14: [0x8f, 0x8b, 0x86],
  ramp15: [0xa8, 0xa4, 0xa0],
};

const CANVAS        = PAL.ramp00;  // near-black outer bg
const BG            = PAL.ramp01;  // panel fill — deep shadow
const BORDER        = PAL.ramp04;  // panel / cage border
const WATCHER_BODY  = PAL.ramp06;  // concrete mid
const WATCHER_LENS  = PAL.ramp04;  // darker concrete (lens/sensor accent)
const SOUND_BODY    = PAL.ramp07;  // institutional green mid
const SOUND_CREST   = PAL.ramp11;  // institutional green light (crest)
const STILLAIR_BODY = PAL.ramp08;  // concrete mid-light
const STILLAIR_CAP  = PAL.ramp14;  // near-white shadow (cap glow)
const CAGE_BAR      = PAL.ramp12;  // concrete pale — trap/lock cage bars

// ── Canvas ───────────────────────────────────────────────────────────────────
const W = 1024, H = 1024;
const pixels = Buffer.alloc(W * H * 3);

// Fill with canvas background
for (let i = 0; i < W * H; i++) {
  pixels[i * 3]     = CANVAS[0];
  pixels[i * 3 + 1] = CANVAS[1];
  pixels[i * 3 + 2] = CANVAS[2];
}

function setPixel(x, y, rgb) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2];
}

function fillRect(x0, y0, x1, y1, rgb) {
  x0 = Math.max(0, x0); x1 = Math.min(W - 1, x1);
  y0 = Math.max(0, y0); y1 = Math.min(H - 1, y1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) setPixel(x, y, rgb);
}

function drawBorder(x0, y0, x1, y1, rgb, thick = 1) {
  for (let t = 0; t < thick; t++) {
    for (let x = x0 + t; x <= x1 - t; x++) {
      setPixel(x, y0 + t, rgb); setPixel(x, y1 - t, rgb);
    }
    for (let y = y0 + t; y <= y1 - t; y++) {
      setPixel(x0 + t, y, rgb); setPixel(x1 - t, y, rgb);
    }
  }
}

// ── Panel layout ─────────────────────────────────────────────────────────────
const MARGIN = 16, GUTTER = 8;
const PW = Math.floor((W - 2 * MARGIN - GUTTER) / 2);  // 492
const PH = Math.floor((H - 2 * MARGIN - GUTTER) / 2);  // 492
const SEC_W = Math.floor(PW / 3);                        // 164 — entity section width
const SCALE = 4;

function panelOrigin(row, col) {
  return [MARGIN + col * (PW + GUTTER), MARGIN + row * (PH + GUTTER)];
}

function panelFrame(x0, y0) {
  fillRect(x0, y0, x0 + PW - 1, y0 + PH - 1, BG);
  drawBorder(x0, y0, x0 + PW - 1, y0 + PH - 1, BORDER, 2);
}

function sectionDividers(x0, y0) {
  for (const i of [1, 2]) {
    const sx = x0 + SEC_W * i;
    fillRect(sx, y0 + 2, sx, y0 + PH - 3, BORDER);
  }
}

function entityCentres(px0, py0) {
  const cy = py0 + Math.floor(PH / 2);
  return [0, 1, 2].map(i => [px0 + SEC_W * i + Math.floor(SEC_W / 2), cy]);
}

// ── Entity drawing (all relative to cell centre (cx, cy) at scale s) ─────────
//
// Geometry derived from synth_entities.py (T-0200):
//   Cell 48×48, centre at (24,24). Relative to centre:
//   Watcher body [14:34, 10:38] → rows [-10,+10], cols [-14,+14]  (20h×28w)
//   Watcher lens [28:34, 16:32] → rows [+4,+10],  cols [-8,+8]    (6h×16w)
//   Sound body   [18:30,  8:40] → rows [-6,+6],   cols [-16,+16]  (12h×32w)
//   Sound crest  [18:22, 14:34] → rows [-6,-2],   cols [-10,+10]  (4h×20w)
//   StillAir body[ 8:40, 20:28] → rows [-16,+16], cols [-4,+4]    (32h×8w)
//   StillAir cap [ 8:12, 22:26] → rows [-16,-12], cols [-2,+2]    (4h×4w)

function drawWatcher(cx, cy, s, hOff = 0) {
  fillRect(cx - 14*s + hOff, cy - 10*s, cx + 14*s + hOff, cy + 10*s, WATCHER_BODY);
  fillRect(cx -  8*s + hOff, cy +  4*s, cx +  8*s + hOff, cy + 10*s, WATCHER_LENS);
}

function drawSound(cx, cy, s, hOff = 0) {
  fillRect(cx - 16*s + hOff, cy - 6*s, cx + 16*s + hOff, cy + 6*s, SOUND_BODY);
  fillRect(cx - 10*s + hOff, cy - 6*s, cx + 10*s + hOff, cy - 2*s, SOUND_CREST);
}

function drawStillAir(cx, cy, s, hOff = 0) {
  fillRect(cx - 4*s + hOff, cy - 16*s, cx + 4*s + hOff, cy + 16*s, STILLAIR_BODY);
  fillRect(cx - 2*s + hOff, cy - 16*s, cx + 2*s + hOff, cy - 12*s, STILLAIR_CAP);
}

function drawCage(cx, cy, halfW, halfH, s) {
  const pad = 2 * s;
  const x0 = cx - halfW - pad, x1 = cx + halfW + pad;
  const y0 = cy - halfH - pad, y1 = cy + halfH + pad;
  drawBorder(x0, y0, x1, y1, CAGE_BAR, 1);
  const third = Math.floor((x1 - x0) / 3);
  fillRect(x0 + third,     y0, x0 + third + 1,     y1, CAGE_BAR);
  fillRect(x0 + 2 * third, y0, x0 + 2 * third + 1, y1, CAGE_BAR);
}

// ── Render panels ─────────────────────────────────────────────────────────────

// Draw all panel frames first
for (let r = 0; r < 2; r++)
  for (let c = 0; c < 2; c++) {
    const [x0, y0] = panelOrigin(r, c);
    panelFrame(x0, y0);
  }

// Panel (0,0) — IDLE: all three entities at neutral centred position
{
  const [x0, y0] = panelOrigin(0, 0);
  sectionDividers(x0, y0);
  const cs = entityCentres(x0, y0);
  drawWatcher(  ...cs[0], SCALE);
  drawSound(    ...cs[1], SCALE);
  drawStillAir( ...cs[2], SCALE);
}

// Panel (0,1) — MOVE: entities at max horizontal drift offset
// Max native offsets from synth_entities.py: Watcher ±6px, Sound ±6px, Still Air ±3px
{
  const [x0, y0] = panelOrigin(0, 1);
  sectionDividers(x0, y0);
  const cs = entityCentres(x0, y0);
  drawWatcher(  ...cs[0], SCALE, 6 * SCALE);   // rightward drift
  drawSound(    ...cs[1], SCALE, 6 * SCALE);
  drawStillAir( ...cs[2], SCALE, 3 * SCALE);
}

// Panel (1,0) — TRAPPED: entities at neutral with cage overlay
{
  const [x0, y0] = panelOrigin(1, 0);
  sectionDividers(x0, y0);
  const cs = entityCentres(x0, y0);
  drawWatcher(  ...cs[0], SCALE);
  drawSound(    ...cs[1], SCALE);
  drawStillAir( ...cs[2], SCALE);
  drawCage(...cs[0], 14 * SCALE, 10 * SCALE, SCALE);
  drawCage(...cs[1], 16 * SCALE,  6 * SCALE, SCALE);
  drawCage(...cs[2],  4 * SCALE, 16 * SCALE, SCALE);
}

// Panel (1,1) — SCALE REF: ×2 roster comparison + palette swatches
{
  const [x0, y0] = panelOrigin(1, 1);
  sectionDividers(x0, y0);
  const cs = entityCentres(x0, y0);
  const cyOff = -30;
  drawWatcher(  cs[0][0], cs[0][1] + cyOff, 2);
  drawSound(    cs[1][0], cs[1][1] + cyOff, 2);
  drawStillAir( cs[2][0], cs[2][1] + cyOff, 2);

  // Palette swatches
  const slots = Object.values(PAL);
  const swW = 32, swH = 24, swGap = 4;
  const total = slots.length * (swW + swGap) - swGap;
  let swX = x0 + Math.floor((PW - total) / 2);
  const swY = y0 + PH - swH - 20;
  for (const rgb of slots) {
    fillRect(swX, swY, swX + swW - 1, swY + swH - 1, rgb);
    swX += swW + swGap;
  }
}

// ── PNG encoding ─────────────────────────────────────────────────────────────

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const rawRows = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  rawRows[rowOff] = 0;  // filter byte: None
  pixels.copy(rawRows, rowOff + 1, y * W * 3, (y + 1) * W * 3);
}
const compressed = zlib.deflateSync(rawRows, { level: 6 });

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

// ── Write output ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
fs.writeFileSync(OUT_PNG, pngBytes);

const conceptHash = crypto.createHash('sha256').update(pngBytes).digest('hex');

const provenance = {
  model: 'synth -- programmatic Node.js generation (T-0210 fallback; SDXL blocked by WSL->Windows Firewall)',
  model_license: 'N/A -- no AI model used; Node.js built-ins only (zlib, crypto, fs)',
  model_hash: null,
  prompt: (
    'flat side-on entity concept reference sheet, three entities: Watcher, Sound, Still Air. ' +
    '2x2 panel layout (four 492x492px panels). ' +
    'Watcher: wide compact surveillance orb silhouette (20px tall, 28px wide in 48x48 cell), ' +
    'concrete-grey body, darker lens/sensor accent on lower body. ' +
    'Sound: wide flat wave-band silhouette (12px tall, 32px wide in 48x48 cell), ' +
    'institutional green body, lighter crest accent on upper body. ' +
    'Still Air: tall narrow atmospheric column silhouette (32px tall, 8px wide in 48x48 cell), ' +
    'concrete-grey body, near-white cap accent at top. ' +
    'Panel 0 (IDLE): all three entities at neutral centred position. ' +
    'Panel 1 (MOVE): all three entities at maximum horizontal drift ' +
    '(Watcher/Sound 6px, Still Air 3px native). ' +
    'Panel 2 (TRAPPED): all three entities at neutral with cage/containment overlay bars. ' +
    'Panel 3 (SCALE REF): all three entities at 2x scale with home palette swatches. ' +
    'Soviet brutalist interior aesthetic. Hard value separation, flat even lighting. ' +
    'No perspective, no vanishing point, no scene composition.'
  ),
  negative_prompt: (
    'perspective, vanishing point, atmospheric haze, depth of field, ' +
    'bright saturated colors, photorealistic, 3d render, scene composition'
  ),
  seed: 0,
  steps: null,
  cfg: null,
  width: W,
  height: H,
  workflow_hash: null,
  prompt_id: 'synth-T-0210',
  concept_hash: conceptHash,
  _note: (
    'Synthetic reference -- replace with SDXL generation via ' +
    'entities_concept_sheet_v1.recipe.json once WSL->ComfyUI is accessible. ' +
    'Same swap path as T-0209 player concept sheet. ' +
    'Entity silhouettes match synth_entities.py (T-0200) cell geometry exactly.'
  ),
};

fs.writeFileSync(OUT_PROV, JSON.stringify(provenance, null, 2));

console.log(`wrote ${OUT_PNG} (${pngBytes.length} bytes)`);
console.log(`wrote ${OUT_PROV}`);
console.log(`concept_hash: ${conceptHash}`);
