#!/usr/bin/env node
/**
 * Synthetic player character concept sheet generator for T-0209.
 * Node.js version using only built-in modules (no npm packages).
 *
 * Produces a 1024×1024 full-colour (RGB) PNG concept sheet at:
 *   assets/src/concept/player_character_concept_sheet_v1.png
 *
 * Uses the same programmatic fallback as T-0198/T-0199:
 * ComfyUI is not reachable from WSL (Windows Firewall).
 *
 * Implements docs/design/13-asset-pipeline.md §6.9:
 *   - Flat side-on elevation, no perspective
 *   - Reference-layout panels (idle, walk, crouch-hide, scale reference)
 *   - Hard value separation: darks dark, lights light
 *   - Full-colour RGB, 1024×1024
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ── Paths ──────────────────────────────────────────────────────────────────
const REPO_ROOT   = path.resolve(__dirname, '../../..');
const OUT_PNG     = path.join(REPO_ROOT, 'assets/src/concept/player_character_concept_sheet_v1.png');
const OUT_PROV    = path.join(REPO_ROOT, 'assets/src/concept/player_character_concept_sheet_v1.provenance.json');

// ── Home palette (from assets/final/palette/home_palette.json) ─────────────
const PAL = {
  ramp00: [0x12, 0x11, 0x0e],  // near-black
  ramp01: [0x1a, 0x19, 0x16],  // deep shadow
  ramp02: [0x0b, 0x2d, 0x18],  // inst. green shadow
  ramp03: [0x12, 0x3c, 0x23],  // inst. green dark
  ramp04: [0x3d, 0x3b, 0x31],  // concrete dark
  ramp05: [0x22, 0x4d, 0x32],  // inst. green mid-dark
  ramp06: [0x49, 0x49, 0x3b],  // concrete mid
  ramp07: [0x4c, 0x55, 0x3a],  // inst. green mid
  ramp08: [0x58, 0x55, 0x4c],  // concrete mid-light
  ramp09: [0x5a, 0x60, 0x42],  // inst. green mid-light
  ramp10: [0x64, 0x62, 0x58],  // concrete light
  ramp11: [0x61, 0x67, 0x47],  // inst. green light
  ramp12: [0x71, 0x6f, 0x66],  // concrete pale
  ramp13: [0x7e, 0x7c, 0x74],  // concrete lightest
  ramp14: [0x8f, 0x8b, 0x86],  // near-white shadow
  ramp15: [0xa8, 0xa4, 0xa0],  // lightest
};

// Colour assignments
const BG       = PAL.ramp01;  // panel background
const CANVAS   = PAL.ramp00;  // canvas outer background
const BORDER   = PAL.ramp04;  // panel border
const SHADOW   = PAL.ramp02;  // figure ground shadow
const BODY_DRK = PAL.ramp05;  // clothing shadow
const BODY_MID = PAL.ramp07;  // clothing mid (institutional green)
const BODY_HI  = PAL.ramp09;  // clothing highlight
const HEAD_DRK = PAL.ramp08;  // head shadow
const HEAD_MID = PAL.ramp10;  // head mid
const HEAD_HI  = PAL.ramp12;  // head highlight
const LABEL    = PAL.ramp13;  // label colour

// ── Canvas ──────────────────────────────────────────────────────────────────
const W = 1024, H = 1024;
// 3 bytes per pixel (RGB)
const pixels = Buffer.alloc(W * H * 3);

function setPixel(x, y, rgb) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  pixels[i]     = rgb[0];
  pixels[i + 1] = rgb[1];
  pixels[i + 2] = rgb[2];
}

function fillRect(x0, y0, x1, y1, rgb) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      setPixel(x, y, rgb);
    }
  }
}

function drawHLine(x0, x1, y, rgb) {
  for (let x = x0; x <= x1; x++) setPixel(x, y, rgb);
}
function drawVLine(x, y0, y1, rgb) {
  for (let y = y0; y <= y1; y++) setPixel(x, y, rgb);
}

function drawRect(x0, y0, x1, y1, rgb, w = 1) {
  for (let t = 0; t < w; t++) {
    drawHLine(x0 + t, x1 - t, y0 + t, rgb);
    drawHLine(x0 + t, x1 - t, y1 - t, rgb);
    drawVLine(x0 + t, y0 + t, y1 - t, rgb);
    drawVLine(x1 - t, y0 + t, y1 - t, rgb);
  }
}

// Tiny 5×7 pixel font for labels (uppercase + digits + space + dash)
// Encoded as 5×7 bitmask arrays (row-major, top-to-bottom)
const FONT5X7 = {
  ' ': [0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0],
  'A': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1],
  'B': [1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,0],
  'C': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,1, 0,1,1,1,0],
  'D': [1,1,1,0,0, 1,0,0,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,1,0, 1,1,1,0,0],
  'E': [1,1,1,1,1, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,0, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,1],
  'F': [1,1,1,1,1, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0],
  'G': [0,1,1,1,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,1,1,1, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  'H': [1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1],
  'I': [0,1,1,1,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,1,1,1,0],
  'K': [1,0,0,1,0, 1,0,1,0,0, 1,1,0,0,0, 1,0,1,0,0, 1,0,0,1,0, 1,0,0,0,1, 1,0,0,0,1],
  'L': [1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,1],
  'M': [1,0,0,0,1, 1,1,0,1,1, 1,0,1,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1],
  'N': [1,0,0,0,1, 1,1,0,0,1, 1,0,1,0,1, 1,0,0,1,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1],
  'O': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  'P': [1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,0, 1,0,0,0,0, 1,0,0,0,0, 1,0,0,0,0],
  'R': [1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 1,1,1,1,0, 1,0,1,0,0, 1,0,0,1,0, 1,0,0,0,1],
  'S': [0,1,1,1,1, 1,0,0,0,0, 1,0,0,0,0, 0,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 1,1,1,1,0],
  'T': [1,1,1,1,1, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0],
  'U': [1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  'V': [1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 0,1,0,1,0, 0,1,0,1,0, 0,0,1,0,0],
  'W': [1,0,0,0,1, 1,0,0,0,1, 1,0,0,0,1, 1,0,1,0,1, 1,1,0,1,1, 1,0,0,0,1, 1,0,0,0,1],
  'X': [1,0,0,0,1, 0,1,0,1,0, 0,1,0,1,0, 0,0,1,0,0, 0,1,0,1,0, 0,1,0,1,0, 1,0,0,0,1],
  'Z': [1,1,1,1,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,1],
  '-': [0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 1,1,1,1,1, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0],
  '+': [0,0,0,0,0, 0,0,1,0,0, 0,0,1,0,0, 1,1,1,1,1, 0,0,1,0,0, 0,0,1,0,0, 0,0,0,0,0],
  '3': [0,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 0,0,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 0,1,1,1,0],
  '4': [0,0,0,1,0, 0,0,1,1,0, 0,1,0,1,0, 1,0,0,1,0, 1,1,1,1,1, 0,0,0,1,0, 0,0,0,1,0],
  '8': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  'x': [0,0,0,0,0, 0,0,0,0,0, 1,0,0,0,1, 0,1,0,1,0, 0,0,1,0,0, 0,1,0,1,0, 1,0,0,0,1],
  '×': [0,0,0,0,0, 0,0,0,0,0, 1,0,0,0,1, 0,1,0,1,0, 0,0,1,0,0, 0,1,0,1,0, 1,0,0,0,1],
  '·': [0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,1,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0],
};

function drawChar(ch, ox, oy, rgb) {
  const bm = FONT5X7[ch.toUpperCase()] || FONT5X7[ch] || FONT5X7[' '];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (bm[row * 5 + col]) setPixel(ox + col, oy + row, rgb);
    }
  }
}

function drawText(text, cx, y, rgb) {
  const charW = 6;  // 5px + 1px gap
  const totalW = text.length * charW - 1;
  let ox = cx - Math.floor(totalW / 2);
  for (const ch of text) {
    drawChar(ch, ox, y, rgb);
    ox += charW;
  }
}

// ── Layout ──────────────────────────────────────────────────────────────────
const MARGIN = 16;
const GUTTER = 8;
const COLS = 2, ROWS = 2;
const PW = Math.floor((W - 2 * MARGIN - (COLS - 1) * GUTTER) / COLS);  // 496
const PH = Math.floor((H - 2 * MARGIN - (ROWS - 1) * GUTTER) / ROWS);  // 496

function panelOrigin(row, col) {
  return {
    px: MARGIN + col * (PW + GUTTER),
    py: MARGIN + row * (PH + GUTTER),
  };
}

function panelFrame(px, py) {
  fillRect(px, py, px + PW - 1, py + PH - 1, BG);
  drawRect(px, py, px + PW - 1, py + PH - 1, BORDER, 2);
}

// ── Figure drawing ──────────────────────────────────────────────────────────
// All figures centred at (cx, cy), drawn at given scale s.
// Proportions: 40px native → figure occupies rows -20..+20 relative to cy
// (head top = cy-20s, feet bottom = cy+20s)

function drawIdle(cx, cy, s) {
  // Ground shadow
  fillRect(cx - 9*s, cy + 19*s, cx + 9*s, cy + 20*s, SHADOW);

  // Legs (two pillars)
  fillRect(cx - 8*s, cy + 5*s,  cx - 3*s, cy + 19*s, BODY_DRK);
  fillRect(cx + 3*s, cy + 5*s,  cx + 8*s, cy + 19*s, BODY_DRK);
  fillRect(cx - 7*s, cy + 6*s,  cx - 4*s, cy + 18*s, BODY_MID);
  fillRect(cx + 4*s, cy + 6*s,  cx + 7*s, cy + 18*s, BODY_MID);

  // Torso
  fillRect(cx - 9*s, cy - 8*s,  cx + 9*s, cy + 5*s,  BODY_DRK);
  fillRect(cx - 8*s, cy - 7*s,  cx + 8*s, cy + 4*s,  BODY_MID);
  fillRect(cx - 6*s, cy - 7*s,  cx - 3*s, cy + 3*s,  BODY_HI);

  // Arms
  fillRect(cx - 13*s, cy - 8*s, cx - 9*s, cy + 3*s, BODY_DRK);
  fillRect(cx + 9*s,  cy - 8*s, cx + 13*s, cy + 3*s, BODY_DRK);

  // Neck
  fillRect(cx - 3*s, cy - 12*s, cx + 3*s, cy - 8*s, HEAD_DRK);

  // Head
  fillRect(cx - 6*s, cy - 20*s, cx + 6*s, cy - 12*s, HEAD_DRK);
  fillRect(cx - 5*s, cy - 19*s, cx + 5*s, cy - 13*s, HEAD_MID);
  fillRect(cx - 4*s, cy - 19*s, cx - 1*s, cy - 14*s, HEAD_HI);
}

function drawWalk(cx, cy, s) {
  // Ground shadow
  fillRect(cx - 10*s, cy + 19*s, cx + 10*s, cy + 20*s, SHADOW);

  // Rear leg
  fillRect(cx + 1*s,  cy + 4*s, cx + 6*s, cy + 19*s, BODY_DRK);
  fillRect(cx + 2*s,  cy + 5*s, cx + 5*s, cy + 18*s, BODY_MID);

  // Torso
  fillRect(cx - 9*s, cy - 8*s,  cx + 9*s, cy + 5*s,  BODY_DRK);
  fillRect(cx - 8*s, cy - 7*s,  cx + 8*s, cy + 4*s,  BODY_MID);
  fillRect(cx - 6*s, cy - 7*s,  cx - 3*s, cy + 3*s,  BODY_HI);

  // Front leg (stepping forward)
  fillRect(cx - 8*s,  cy + 4*s, cx - 3*s, cy + 19*s, BODY_DRK);
  fillRect(cx - 7*s,  cy + 5*s, cx - 4*s, cy + 18*s, BODY_MID);

  // Arms (opposite swing)
  fillRect(cx - 14*s, cy - 5*s, cx - 9*s, cy + 5*s, BODY_DRK);
  fillRect(cx + 9*s,  cy - 8*s, cx + 14*s, cy + 1*s, BODY_DRK);

  // Neck + head
  fillRect(cx - 3*s, cy - 12*s, cx + 3*s, cy - 8*s, HEAD_DRK);
  fillRect(cx - 6*s, cy - 20*s, cx + 6*s, cy - 12*s, HEAD_DRK);
  fillRect(cx - 5*s, cy - 19*s, cx + 5*s, cy - 13*s, HEAD_MID);
  fillRect(cx - 4*s, cy - 19*s, cx - 1*s, cy - 14*s, HEAD_HI);
}

function drawCrouch(cx, cy, s) {
  // Ground shadow (wider)
  fillRect(cx - 12*s, cy + 9*s, cx + 12*s, cy + 10*s, SHADOW);

  // Bent legs
  fillRect(cx - 12*s, cy - 2*s, cx - 5*s,  cy + 9*s, BODY_DRK);
  fillRect(cx + 5*s,  cy - 2*s, cx + 12*s, cy + 9*s, BODY_DRK);
  fillRect(cx - 11*s, cy - 1*s, cx - 6*s,  cy + 8*s, BODY_MID);
  fillRect(cx + 6*s,  cy - 1*s, cx + 11*s, cy + 8*s, BODY_MID);

  // Torso (compressed)
  fillRect(cx - 10*s, cy - 10*s, cx + 10*s, cy + 0, BODY_DRK);
  fillRect(cx - 9*s,  cy - 9*s,  cx + 9*s,  cy - 1*s, BODY_MID);
  fillRect(cx - 7*s,  cy - 9*s,  cx - 4*s,  cy - 2*s, BODY_HI);

  // Arms folded low
  fillRect(cx - 14*s, cy - 8*s, cx - 10*s, cy + 0, BODY_DRK);
  fillRect(cx + 10*s, cy - 8*s, cx + 14*s, cy + 0, BODY_DRK);

  // Neck + head (tucked lower)
  fillRect(cx - 3*s, cy - 14*s, cx + 3*s, cy - 10*s, HEAD_DRK);
  fillRect(cx - 6*s, cy - 22*s, cx + 6*s, cy - 14*s, HEAD_DRK);
  fillRect(cx - 5*s, cy - 21*s, cx + 5*s, cy - 15*s, HEAD_MID);
  fillRect(cx - 4*s, cy - 21*s, cx - 1*s, cy - 16*s, HEAD_HI);
}

// ── Panel 0,0 — Idle ────────────────────────────────────────────────────────
{
  const { px, py } = panelOrigin(0, 0);
  panelFrame(px, py);
  const cx = px + PW / 2 | 0;
  const cy = (py + PH / 2 + 40) | 0;
  drawIdle(cx, cy, 8);
  drawText('IDLE  SIDE-ON ELEVATION', cx, py + 10, LABEL);
}

// ── Panel 0,1 — Walk ────────────────────────────────────────────────────────
{
  const { px, py } = panelOrigin(0, 1);
  panelFrame(px, py);
  const cx = px + PW / 2 | 0;
  const cy = (py + PH / 2 + 40) | 0;
  drawWalk(cx, cy, 8);
  drawText('WALK  MID-STRIDE', cx, py + 10, LABEL);
}

// ── Panel 1,0 — Crouch-hide ─────────────────────────────────────────────────
{
  const { px, py } = panelOrigin(1, 0);
  panelFrame(px, py);
  const cx = px + PW / 2 | 0;
  const cy = (py + PH / 2 + 20) | 0;
  drawCrouch(cx, cy, 8);
  drawText('CROUCH-HIDE', cx, py + 10, LABEL);
}

// ── Panel 1,1 — Scale reference + palette ───────────────────────────────────
{
  const { px, py } = panelOrigin(1, 1);
  panelFrame(px, py);
  const cx = px + PW / 2 | 0;

  drawText('SCALE REF + PALETTE', cx, py + 10, LABEL);

  // 3×3 cell grid at ×4 scale (192px per cell)
  const S4 = 4;
  const cellDisp = 48 * S4;  // 192px
  const gridL = cx - (3 * cellDisp) / 2 | 0;
  const gridT = py + 30;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const gx = gridL + col * cellDisp;
      const gy = gridT + row * cellDisp;
      fillRect(gx, gy, gx + cellDisp - 1, gy + cellDisp - 1, BG);
      drawRect(gx, gy, gx + cellDisp - 1, gy + cellDisp - 1, BORDER, 1);
    }
  }

  // Draw ×4 idle figure in cell (0,0) — scale reference pose
  const figCx = gridL + cellDisp / 2 | 0;
  const figCy = gridT + cellDisp / 2 + 6 * S4 | 0;
  drawIdle(figCx, figCy, S4);

  drawText('3x3 GRID  48x48 CELL  40PX FIG', cx, gridT + 3 * cellDisp + 10, LABEL);

  // Palette swatches (all 16 slots)
  const paletteSlots = Object.values(PAL);
  const swW = 32, swH = 24, swGap = 4;
  const total = paletteSlots.length * (swW + swGap) - swGap;
  let swX = cx - total / 2 | 0;
  const swY = gridT + 3 * cellDisp + 26;
  for (const rgb of paletteSlots) {
    fillRect(swX, swY, swX + swW - 1, swY + swH - 1, rgb);
    swX += swW + swGap;
  }
  drawText('HOME PALETTE REFERENCE', cx, swY + swH + 6, LABEL);
}

// ── PNG encode ───────────────────────────────────────────────────────────────

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

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crcData = Buffer.concat([typeBytes, data]);
  crcBuf.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8]  = 8;   // bit depth
ihdr[9]  = 2;   // colour type: RGB truecolour
ihdr[10] = 0;   // compression
ihdr[11] = 0;   // filter method
ihdr[12] = 0;   // interlace

// IDAT: filter each row with filter byte 0 (None)
const rawRows = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  rawRows[rowOff] = 0;  // filter byte: None
  const srcOff = y * W * 3;
  pixels.copy(rawRows, rowOff + 1, srcOff, srcOff + W * 3);
}
const compressed = zlib.deflateSync(rawRows, { level: 6 });

// Assemble PNG
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

// ── Write files ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
fs.writeFileSync(OUT_PNG, pngBytes);

const conceptHash = crypto.createHash('sha256').update(pngBytes).digest('hex');

const provenance = {
  model: 'synth — programmatic Node.js generation (T-0209 fallback; SDXL blocked by WSL→Windows Firewall)',
  model_license: 'N/A — no AI model used; Node.js built-ins only (zlib, crypto)',
  model_hash: null,
  prompt: (
    'flat side-on character concept sheet, 4 reference panels: idle standing, ' +
    'walk mid-stride, crouch-hide, scale reference + palette family. ' +
    'Player figure: 40px tall in 48x48 cell, institutional green clothing, ' +
    'concrete-grey head/skin, deep shadow values. ' +
    'Soviet brutalist interior aesthetic. Hard value separation, flat lighting. ' +
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
  prompt_id: 'synth-T-0209',
  concept_hash: conceptHash,
  _note: (
    'Synthetic reference — replace with SDXL generation via ' +
    'player_character_concept_sheet_v1.recipe.json once WSL→ComfyUI is accessible. ' +
    'Same swap path as T-0198/T-0199 sprite sheets.'
  ),
};

fs.writeFileSync(OUT_PROV, JSON.stringify(provenance, null, 2));

console.log(`wrote ${OUT_PNG}`);
console.log(`wrote ${OUT_PROV}`);
console.log(`concept_hash: ${conceptHash}`);
