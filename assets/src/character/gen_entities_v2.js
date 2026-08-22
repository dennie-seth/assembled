#!/usr/bin/env node
/**
 * Generate concept-conditioned entity character sheets v2 (T-0214).
 * Node.js stdlib-only — no npm packages required.
 *
 * Produces 9 entity animation sheets conditioned on T-0210's entities concept
 * sheet (entities_concept_sheet_v1.png) via ComfyUI img2img + LoRA:
 *   - Watcher: idle (3×2, 6 frames), move (4×2, 8 frames), trapped (2×2, 4 frames)
 *   - Sound:   idle (3×2), move (4×2), trapped (2×2)
 *   - Still Air: idle (3×2), move (4×2), trapped (2×2)
 *
 * Pipeline (13-asset-pipeline.md §3.1, §6.11):
 *   crop concept section -> tile to gen dims -> upload to ComfyUI ->
 *   img2img + LoRA (SDXL) -> fetch raw output -> descend cell-by-cell
 *   (8×, 384->48px, Oklab quantize + orphan cleanup) -> stitch sheet ->
 *   write indexed PNG (mode P / PLTE) + provenance JSON.
 */

'use strict';
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const http   = require('http');

// ── Paths ──────────────────────────────────────────────────────────────────────

const REPO_ROOT    = path.resolve(__dirname, '../../..');
const CONCEPT_PNG  = path.join(REPO_ROOT, 'assets/src/concept/entities_concept_sheet_v1.png');
const CONCEPT_PROV = path.join(REPO_ROOT, 'assets/src/concept/entities_concept_sheet_v1.provenance.json');
const PALETTE_JSON = path.join(REPO_ROOT, 'assets/final/palette/home_palette.json');
const ENTITY_OUT   = path.join(REPO_ROOT, 'assets/final/entity');
const OUT_RAW      = path.join(REPO_ROOT, 'assets/out/entity_v2_raw');

// ── ComfyUI ────────────────────────────────────────────────────────────────────

const COMFYUI_HOST = '172.18.192.1';
const COMFYUI_PORT = 8188;
const CHECKPOINT   = 'sd_xl_base_1.0.safetensors';
const LORA_NAME    = 'soviet_brutalism_style_v1.safetensors';
const LORA_WEIGHT  = 0.70;
const MODEL_HASH   = '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b';
const LORA_HASH    = '2dab82287f6d36a98a142dae5199df47e001d86d4c9507a0524742b4d34f2b9f';
const CLIENT_ID    = `T-0214-entities-v2-${crypto.randomBytes(4).toString('hex')}`;

// ── Generation constants ───────────────────────────────────────────────────────

const CELL_NATIVE = 48;
const CELL_GEN    = 384;  // = CELL_NATIVE × 8

const NEGATIVE_PROMPT = (
  'humanoid, arms, legs, head on humanoid body, multiple different entities, ' +
  'perspective, vanishing point, three-quarter view, atmospheric haze, depth of field, ' +
  'blurry, low quality, photorealistic, watermark, text, UI, background clutter, ' +
  'bright saturated colors, cartoon, cheerful, scene composition, player character, ' +
  'single isolated entity without context, busy background'
);

// ── Concept crop boxes ─────────────────────────────────────────────────────────
// Panel layout from gen_entities_concept.js:
//   MARGIN=16, GUTTER=8, PW=PH=492, SEC_W=164
//   Panel IDLE:    x=[16,508],  y=[16,508]
//   Panel MOVE:    x=[524,1016], y=[16,508]
//   Panel TRAPPED: x=[16,508],  y=[524,1016]
//   Watcher:  x_offset=[0,164]   Sound:  x_offset=[164,328]  Still Air: x_offset=[328,492]

const CONCEPT_CROPS = {
  'watcher/idle':      [16,  16,  180, 508],
  'watcher/move':      [524, 16,  688, 508],
  'watcher/trapped':   [16,  524, 180, 1016],
  'sound/idle':        [180, 16,  344, 508],
  'sound/move':        [688, 16,  852, 508],
  'sound/trapped':     [180, 524, 344, 1016],
  'still_air/idle':    [344, 16,  508, 508],
  'still_air/move':    [852, 16,  1016, 508],
  'still_air/trapped': [344, 524, 508, 1016],
};

// ── Entity specs ───────────────────────────────────────────────────────────────

const ENTITY_SPECS = [
  // Watcher — wide compact surveillance orb
  {
    entity: 'watcher', state: 'idle', cols: 3, rows: 2, seed: 21401, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, wide compact surveillance orb entity, flat side-on ' +
      'orthographic, six frame cells arranged in a 3x2 grid, same entity in every cell, ' +
      'subtle idle float animation between cells, wide horizontal orb silhouette with ' +
      'scanner lens detail on lower face, concrete grey body with institutional green ' +
      'accent lens, no limbs, non-humanoid foreign entity, Soviet brutalist interior ' +
      'aesthetic, muted desaturated home palette, value-separated pixel art silhouette, ' +
      'clean readable pixel outline, no perspective, no vanishing point, no background ' +
      'elements, no multiple different entities, no text, no UI'
    ),
  },
  {
    entity: 'watcher', state: 'move', cols: 4, rows: 2, seed: 21402, denoise: 0.85,
    prompt: (
      'pixel art sprite sheet, wide compact surveillance orb entity horizontal drift ' +
      'animation, flat side-on orthographic, eight frame cells arranged in a 4x2 grid, ' +
      'same entity in every cell, entity position drifts left and right across cells ' +
      'in a smooth horizontal glide cycle, wide horizontal orb silhouette with scanner ' +
      'lens, concrete grey body with institutional green accent, no limbs, non-humanoid, ' +
      'Soviet brutalist aesthetic, muted desaturated palette, value-separated pixel art, ' +
      'no perspective, no text'
    ),
  },
  {
    entity: 'watcher', state: 'trapped', cols: 2, rows: 2, seed: 21403, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, wide compact surveillance orb entity constrained/trapped ' +
      'state, flat side-on orthographic, four frame cells arranged in a 2x2 grid, same ' +
      'entity in every cell, entity appears contained or delayed with subtle micro-float ' +
      'variation, wide horizontal orb silhouette with scanner lens, concrete grey body ' +
      'with institutional green accent, no limbs, non-humanoid, Soviet brutalist aesthetic, ' +
      'muted desaturated palette, value-separated pixel art, no perspective, no text'
    ),
  },
  // Sound — wide flat wave-band
  {
    entity: 'sound', state: 'idle', cols: 3, rows: 2, seed: 21404, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, wide flat wave-band entity, flat side-on orthographic, ' +
      'six frame cells arranged in a 3x2 grid, same entity in every cell, subtle idle ' +
      'float animation, wide horizontal ripple band silhouette with lighter crest accent ' +
      'on upper edge, desaturated institutional green tones, no limbs, ambient and ' +
      'expansive non-humanoid entity, Soviet brutalist aesthetic, muted desaturated ' +
      'home palette, value-separated pixel art silhouette, no perspective, no text'
    ),
  },
  {
    entity: 'sound', state: 'move', cols: 4, rows: 2, seed: 21405, denoise: 0.85,
    prompt: (
      'pixel art sprite sheet, wide flat wave-band entity horizontal drift animation, ' +
      'flat side-on orthographic, eight frame cells arranged in a 4x2 grid, same entity ' +
      'in every cell, entity position drifts left and right across cells, wide horizontal ' +
      'ripple band with lighter crest accent on top, desaturated institutional green ' +
      'tones, no limbs, non-humanoid, Soviet brutalist aesthetic, muted desaturated ' +
      'palette, value-separated pixel art, no perspective, no text'
    ),
  },
  {
    entity: 'sound', state: 'trapped', cols: 2, rows: 2, seed: 21406, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, wide flat wave-band entity constrained/trapped state, ' +
      'flat side-on orthographic, four frame cells arranged in a 2x2 grid, same entity ' +
      'in every cell, subtle micro-float variation, wide horizontal ripple band with ' +
      'lighter crest accent, desaturated institutional green tones, no limbs, ' +
      'non-humanoid, Soviet brutalist aesthetic, muted palette, pixel art, no text'
    ),
  },
  // Still Air — tall narrow atmospheric column
  {
    entity: 'still_air', state: 'idle', cols: 3, rows: 2, seed: 21407, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, tall narrow atmospheric column entity, flat side-on ' +
      'orthographic, six frame cells arranged in a 3x2 grid, same entity in every cell, ' +
      'subtle idle float animation, tall narrow vertical pillar silhouette with pale ' +
      'glowing cap at top, pale concrete grey tones, no limbs, inevitable and silent ' +
      'non-humanoid entity, Soviet brutalist aesthetic, muted desaturated home palette, ' +
      'value-separated pixel art silhouette, no perspective, no text'
    ),
  },
  {
    entity: 'still_air', state: 'move', cols: 4, rows: 2, seed: 21408, denoise: 0.85,
    prompt: (
      'pixel art sprite sheet, tall narrow atmospheric column entity horizontal sway ' +
      'animation, flat side-on orthographic, eight frame cells arranged in a 4x2 grid, ' +
      'same entity in every cell, entity position sways left and right with subtle ' +
      'horizontal drift across cells, tall narrow pillar silhouette with pale cap at ' +
      'top, pale concrete grey tones, no limbs, non-humanoid, Soviet brutalist aesthetic, ' +
      'muted desaturated palette, value-separated pixel art, no perspective, no text'
    ),
  },
  {
    entity: 'still_air', state: 'trapped', cols: 2, rows: 2, seed: 21409, denoise: 0.80,
    prompt: (
      'pixel art sprite sheet, tall narrow atmospheric column entity constrained/trapped ' +
      'state, flat side-on orthographic, four frame cells arranged in a 2x2 grid, same ' +
      'entity in every cell, subtle micro-float variation, tall narrow pillar silhouette ' +
      'with pale cap at top, pale concrete grey tones, no limbs, non-humanoid, Soviet ' +
      'brutalist aesthetic, muted palette, pixel art, no text'
    ),
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// PNG utilities
// ══════════════════════════════════════════════════════════════════════════════

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
  const lenBuf    = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf    = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Parse PNG file buffer. Returns { width, height, channels, pixels (Buffer, RGB or RGBA) }.
 * Supports color types 2 (RGB) and 6 (RGBA), 8-bit depth.
 */
function parsePNG(buf) {
  // Verify signature
  const sig = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('Not a PNG file');

  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < buf.length) {
    const len  = buf.readUInt32BE(offset); offset += 4;
    const type = buf.slice(offset, offset + 4).toString('ascii'); offset += 4;
    const data = buf.slice(offset, offset + len); offset += len;
    offset += 4; // skip CRC

    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}`);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width == null) throw new Error('PNG missing IHDR chunk');
  const channels   = colorType === 6 ? 4 : 3;
  const stride     = width * channels;
  const compressed = Buffer.concat(idatChunks);
  const raw        = zlib.inflateSync(compressed);

  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterByte = raw[y * (1 + stride)];
    const rowSrc     = y * (1 + stride) + 1;
    const rowDst     = y * stride;
    const prevDst    = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const byte = raw[rowSrc + x];
      const a    = x >= channels    ? pixels[rowDst + x - channels] : 0;
      const b    = y > 0            ? pixels[prevDst + x]           : 0;
      const c    = y > 0 && x >= channels ? pixels[prevDst + x - channels] : 0;

      let val;
      switch (filterByte) {
        case 0: val = byte;                                    break; // None
        case 1: val = byte + a;                                break; // Sub
        case 2: val = byte + b;                                break; // Up
        case 3: val = byte + Math.floor((a + b) / 2);         break; // Average
        case 4: val = byte + paethPredictor(a, b, c);         break; // Paeth
        default: throw new Error(`Unknown PNG filter: ${filterByte}`);
      }
      pixels[rowDst + x] = val & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/** Encode raw RGB pixels (no alpha) as a PNG buffer. */
function encodeRGBPNG(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride  = width * 3;
  const rawRows = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + stride)] = 0; // filter: None
    pixels.copy(rawRows, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(rawRows, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Encode an index buffer (uint8, palette indices) as an indexed PNG with PLTE.
 * palette: array of [r,g,b] triples.
 */
function encodeIndexedPNG(indices, width, height, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // color type 3 = indexed

  const plte = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i*3] = palette[i][0]; plte[i*3+1] = palette[i][1]; plte[i*3+2] = palette[i][2];
  }

  const rawRows = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + width)] = 0; // filter: None
    indices.copy(rawRows, y * (1 + width) + 1, y * width, (y + 1) * width);
  }
  const idat = zlib.deflateSync(rawRows, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Image utilities (crop, resize, tile, box downscale)
// ══════════════════════════════════════════════════════════════════════════════

/** Crop a region from an RGB image. Returns Buffer of (cw*ch*3) bytes. */
function cropRGB(pixels, srcW, srcH, x0, y0, x1, y1) {
  const cw = x1 - x0, ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * srcW + (x0 + x)) * 3;
      const di = (y * cw + x) * 3;
      out[di] = pixels[si]; out[di+1] = pixels[si+1]; out[di+2] = pixels[si+2];
    }
  }
  return { pixels: out, width: cw, height: ch };
}

/** Bilinear resize RGB image. */
function bilinearResize(pixels, srcW, srcH, dstW, dstH) {
  const out    = Buffer.alloc(dstW * dstH * 3);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      const sy = (dy + 0.5) * yRatio - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const y1 = Math.min(srcH - 1, y0 + 1);
      const wx = sx - x0, wy = sy - y0;

      for (let c = 0; c < 3; c++) {
        const tl = pixels[(y0 * srcW + x0) * 3 + c];
        const tr = pixels[(y0 * srcW + x1) * 3 + c];
        const bl = pixels[(y1 * srcW + x0) * 3 + c];
        const br = pixels[(y1 * srcW + x1) * 3 + c];
        out[(dy * dstW + dx) * 3 + c] = Math.round(tl*(1-wx)*(1-wy) + tr*wx*(1-wy) + bl*(1-wx)*wy + br*wx*wy);
      }
    }
  }
  return out;
}

/** Tile a cell image (cellW×cellH) into a sheet of (cols×cellW × rows×cellH). */
function tileRGB(cellPixels, cellW, cellH, cols, rows) {
  const sheetW = cols * cellW, sheetH = rows * cellH;
  const out = Buffer.alloc(sheetW * sheetH * 3);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (let y = 0; y < cellH; y++) {
        const srcOff = y * cellW * 3;
        const dstOff = ((row * cellH + y) * sheetW + col * cellW) * 3;
        cellPixels.copy(out, dstOff, srcOff, srcOff + cellW * 3);
      }
    }
  }
  return out;
}

/**
 * Box-average downscale by integer factor.
 * Each output pixel averages a (scale×scale) block of input pixels.
 */
function boxDownscale(pixels, srcW, srcH, scale) {
  const dstW = Math.floor(srcW / scale);
  const dstH = Math.floor(srcH / scale);
  const out  = Buffer.alloc(dstW * dstH * 3);
  const n    = scale * scale;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < scale; ky++) {
        for (let kx = 0; kx < scale; kx++) {
          const si = ((dy * scale + ky) * srcW + (dx * scale + kx)) * 3;
          r += pixels[si]; g += pixels[si+1]; b += pixels[si+2];
        }
      }
      const di = (dy * dstW + dx) * 3;
      out[di] = Math.round(r / n); out[di+1] = Math.round(g / n); out[di+2] = Math.round(b / n);
    }
  }
  return { pixels: out, width: dstW, height: dstH };
}

// ══════════════════════════════════════════════════════════════════════════════
// Oklab quantization
// ══════════════════════════════════════════════════════════════════════════════

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToOklab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708*rl + 0.5363325363*gl + 0.0514459929*bl);
  const m_ = Math.cbrt(0.2119034982*rl + 0.6806995451*gl + 0.1073969566*bl);
  const s_ = Math.cbrt(0.0883024619*rl + 0.2817188376*gl + 0.6299787005*bl);
  return [
    0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
    1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
    0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_,
  ];
}

/**
 * Quantize RGB pixels to nearest palette entry in Oklab space.
 * Returns a Buffer of uint8 palette indices.
 */
function quantizeOklab(pixels, width, height, palette, paletteOklab) {
  const indices = Buffer.alloc(width * height);
  const nPal    = paletteOklab.length;

  for (let i = 0; i < width * height; i++) {
    const [L, A, B] = rgbToOklab(pixels[i*3], pixels[i*3+1], pixels[i*3+2]);
    let best = 0, bestDist = Infinity;
    for (let j = 0; j < nPal; j++) {
      const [pL, pA, pB] = paletteOklab[j];
      const d = (L-pL)**2 + (A-pA)**2 + (B-pB)**2;
      if (d < bestDist) { bestDist = d; best = j; }
    }
    indices[i] = best;
  }
  return indices;
}

/**
 * Single-pass orphan cleanup: any pixel whose index doesn't match any cardinal
 * neighbour gets replaced by the most common neighbour index.
 */
function cleanupOrphans(indices, width, height) {
  const out = Buffer.from(indices);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      const neighbours = [];
      if (y > 0)          neighbours.push(indices[(y-1)*width + x]);
      if (y < height - 1) neighbours.push(indices[(y+1)*width + x]);
      if (x > 0)          neighbours.push(indices[y*width + (x-1)]);
      if (x < width - 1)  neighbours.push(indices[y*width + (x+1)]);
      if (neighbours.length === 0 || neighbours.includes(idx)) continue;
      // Replace with mode of neighbours
      const counts = {};
      let best = neighbours[0], bestN = 0;
      for (const n of neighbours) {
        counts[n] = (counts[n] || 0) + 1;
        if (counts[n] > bestN) { bestN = counts[n]; best = n; }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// ComfyUI HTTP API (using Node.js http module)
// ══════════════════════════════════════════════════════════════════════════════

function httpRequest(method, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: COMFYUI_HOST, port: COMFYUI_PORT,
      path: reqPath, method,
      headers: { 'Content-Length': body ? body.length : 0, ...headers },
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${method} ${reqPath}: ${buf.toString('utf8').slice(0, 200)}`));
        } else {
          resolve(buf);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function comfyGetJSON(reqPath) {
  const buf = await httpRequest('GET', reqPath, null, {});
  return JSON.parse(buf.toString('utf8'));
}

async function comfyPostJSON(reqPath, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf  = await httpRequest('POST', reqPath, body, { 'Content-Type': 'application/json' });
  return JSON.parse(buf.toString('utf8'));
}

/**
 * Upload a PNG buffer to ComfyUI /upload/image endpoint.
 * Returns the server-assigned filename.
 */
async function uploadImage(imageBytes, filename) {
  const boundary = crypto.randomBytes(16).toString('hex');
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    imageBytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(parts);
  const buf  = await httpRequest('POST', '/upload/image', body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });
  const result = JSON.parse(buf.toString('utf8'));
  return result.name;
}

/** Build the SDXL img2img + LoRA workflow graph. */
function buildWorkflow(prompt, initImageName, seed, denoise) {
  return {
    '4':  { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
    '12': {
      class_type: 'LoraLoader',
      inputs: { model: ['4', 0], clip: ['4', 1], lora_name: LORA_NAME,
                strength_model: LORA_WEIGHT, strength_clip: LORA_WEIGHT },
    },
    '6':  { class_type: 'CLIPTextEncode', inputs: { text: prompt,           clip: ['12', 1] } },
    '7':  { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_PROMPT,  clip: ['12', 1] } },
    '10': { class_type: 'LoadImage',      inputs: { image: initImageName } },
    '11': { class_type: 'VAEEncode',      inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    '3':  {
      class_type: 'KSampler',
      inputs: {
        seed, steps: 30, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal',
        denoise, model: ['12', 0], positive: ['6', 0], negative: ['7', 0],
        latent_image: ['11', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'entity_v2/assembled', images: ['8', 0] } },
  };
}

function workflowHash(graph) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(graph, Object.keys(graph).sort()))
    .digest('hex');
}

/** Poll /history/{promptId} until completed or timeout (ms). */
async function pollUntilDone(promptId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let interval   = 2000;
  while (true) {
    const history = await comfyGetJSON(`/history/${promptId}`);
    const entry   = history[promptId];
    if (entry) {
      const status = entry.status || {};
      if (status.completed || status.status_str === 'success') return entry;
      if (status.status_str === 'error') throw new Error(`ComfyUI job ${promptId} error: ${JSON.stringify(status)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ComfyUI job ${promptId} timed out`);
    process.stdout.write(`  polling ${promptId.slice(0, 8)}... (${Math.round((deadline - Date.now())/1000)}s left)\n`);
    await new Promise(r => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 10000);
  }
}

/** Fetch the first image from a completed job result. Returns raw PNG bytes. */
async function fetchOutput(jobResult) {
  const outputs = jobResult.outputs || {};
  for (const nodeOut of Object.values(outputs)) {
    const images = nodeOut.images;
    if (images && images.length > 0) {
      const img      = images[0];
      const fname    = encodeURIComponent(img.filename);
      const subfolder = img.subfolder ? encodeURIComponent(img.subfolder) : '';
      const type     = img.type || 'output';
      const reqPath  = `/view?filename=${fname}&subfolder=${subfolder}&type=${type}`;
      return await httpRequest('GET', reqPath, null, {});
    }
  }
  throw new Error(`No image outputs in job result: ${JSON.stringify(jobResult).slice(0, 200)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Generation pipeline
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Crop the entity/state section from the concept sheet pixels,
 * resize to CELL_GEN×CELL_GEN, tile across the sheet, return RGB PNG bytes.
 */
function makeInitImage(conceptImg, entity, state, cols, rows) {
  const key = `${entity}/${state}`;
  const [cx0, cy0, cx1, cy1] = CONCEPT_CROPS[key];
  const crop = cropRGB(conceptImg.pixels, conceptImg.width, conceptImg.height, cx0, cy0, cx1, cy1);

  // Resize crop to CELL_GEN×CELL_GEN
  const cellPixels = bilinearResize(crop.pixels, crop.width, crop.height, CELL_GEN, CELL_GEN);

  // Tile across cols×rows
  const sheetW     = cols * CELL_GEN;
  const sheetH     = rows * CELL_GEN;
  const tiled      = tileRGB(cellPixels, CELL_GEN, CELL_GEN, cols, rows);

  return encodeRGBPNG(tiled, sheetW, sheetH);
}

/** Descend a raw cell buffer (CELL_GEN×CELL_GEN, RGB) to indexed 48×48. */
function descendCell(cellPixels, palette, paletteOklab) {
  // Box-average 384→48 (factor 8)
  const { pixels: small, width: w, height: h } = boxDownscale(cellPixels, CELL_GEN, CELL_GEN, 8);
  // Quantize to palette
  let indices = quantizeOklab(small, w, h, palette, paletteOklab);
  // Orphan cleanup
  indices = cleanupOrphans(indices, w, h);
  return indices;  // Buffer of w*h uint8 indices
}

/** Stitch descended 48×48 index buffers into a final sheet index buffer. */
function stitchSheet(indexCells, cols, rows) {
  const sheetW  = cols * CELL_NATIVE;
  const sheetH  = rows * CELL_NATIVE;
  const out     = Buffer.alloc(sheetW * sheetH);
  for (let i = 0; i < indexCells.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x0  = col * CELL_NATIVE;
    const y0  = row * CELL_NATIVE;
    for (let cy = 0; cy < CELL_NATIVE; cy++) {
      indexCells[i].copy(out, (y0 + cy) * sheetW + x0, cy * CELL_NATIVE, (cy + 1) * CELL_NATIVE);
    }
  }
  return { indices: out, width: sheetW, height: sheetH };
}

async function generateEntitySheet(spec, conceptImg, palette, paletteOklab, conceptHash) {
  const { entity, state, cols, rows, seed, denoise, prompt } = spec;
  const sheetName = `${entity}_${state}_sheet_v2`;
  const outPng    = path.join(ENTITY_OUT, `${sheetName}.png`);
  const outProv   = path.join(ENTITY_OUT, `${sheetName}.provenance.json`);

  console.log(`\n=== Generating ${sheetName} (${cols}×${rows} grid, ${cols*CELL_GEN}×${rows*CELL_GEN}px) ===`);

  // 1. Prepare init image
  const initBytes    = makeInitImage(conceptImg, entity, state, cols, rows);
  const initFilename = `entity_v2_init_${entity}_${state}.png`;
  console.log(`  Init image: ${cols*CELL_GEN}×${rows*CELL_GEN}px tiled from concept crop`);

  // 2. Upload init image
  console.log(`  Uploading init image...`);
  const uploadedName = await uploadImage(initBytes, initFilename);
  console.log(`  Uploaded as: ${uploadedName}`);

  // 3. Build and submit workflow
  const graph      = buildWorkflow(prompt, uploadedName, seed, denoise);
  const graphHash  = workflowHash(graph);
  const payload    = { prompt: graph, client_id: CLIENT_ID };
  console.log(`  Submitting workflow (seed=${seed}, denoise=${denoise})...`);
  const submitResult = await comfyPostJSON('/prompt', payload);
  const promptId     = submitResult.prompt_id;
  console.log(`  prompt_id: ${promptId}`);

  // 4. Poll until complete
  const jobResult = await pollUntilDone(promptId);
  console.log(`  Generation complete.`);

  // 5. Fetch raw output
  const rawBytes = await fetchOutput(jobResult);
  console.log(`  Fetched raw output: ${rawBytes.length} bytes`);

  // Save raw for reproducibility
  fs.mkdirSync(OUT_RAW, { recursive: true });
  const rawPath = path.join(OUT_RAW, `${sheetName}_raw_${seed}.png`);
  fs.writeFileSync(rawPath, rawBytes);
  console.log(`  Saved raw to assets/out/entity_v2_raw/${sheetName}_raw_${seed}.png`);

  // 6. Parse raw output
  const rawImg = parsePNG(rawBytes);
  const expectedW = cols * CELL_GEN, expectedH = rows * CELL_GEN;
  if (rawImg.width !== expectedW || rawImg.height !== expectedH) {
    // Shouldn't happen, but defensive resize
    console.warn(`  Warning: raw size ${rawImg.width}×${rawImg.height} != expected ${expectedW}×${expectedH}`);
  }

  // Extract RGB-only pixels (strip alpha if present)
  let rawRGB = rawImg.pixels;
  if (rawImg.channels === 4) {
    rawRGB = Buffer.alloc(rawImg.width * rawImg.height * 3);
    for (let i = 0; i < rawImg.width * rawImg.height; i++) {
      rawRGB[i*3]   = rawImg.pixels[i*4];
      rawRGB[i*3+1] = rawImg.pixels[i*4+1];
      rawRGB[i*3+2] = rawImg.pixels[i*4+2];
    }
  }

  // 7. Descend each cell
  const indexCells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Crop cell from raw sheet
      const x0 = col * CELL_GEN, y0 = row * CELL_GEN;
      const { pixels: cellPx } = cropRGB(rawRGB, rawImg.width, rawImg.height, x0, y0, x0 + CELL_GEN, y0 + CELL_GEN);
      const indices = descendCell(cellPx, palette, paletteOklab);
      indexCells.push(indices);
    }
  }
  console.log(`  Descended ${indexCells.length} cells to ${CELL_NATIVE}×${CELL_NATIVE}px`);

  // 8. Stitch sheet
  const { indices: sheetIndices, width: sheetW, height: sheetH } = stitchSheet(indexCells, cols, rows);
  const finalPngBytes = encodeIndexedPNG(sheetIndices, sheetW, sheetH, palette);
  fs.mkdirSync(ENTITY_OUT, { recursive: true });
  fs.writeFileSync(outPng, finalPngBytes);
  console.log(`  Saved final sheet: assets/final/entity/${sheetName}.png`);

  // 9. Write provenance
  const entityDisplay = entity.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const cropBox       = CONCEPT_CROPS[`${entity}/${state}`];
  const prov = {
    model:           `${CHECKPOINT} + LoRA ${LORA_NAME} (weight ${LORA_WEIGHT})`,
    model_license:   'CreativeML Open RAIL++-M (SDXL base) / CreativeML OpenRAIL++-M (LoRA)',
    model_hash:      MODEL_HASH,
    lora_hash:       LORA_HASH,
    prompt,
    negative_prompt: NEGATIVE_PROMPT,
    seed,
    steps:           30,
    cfg:             7.0,
    sampler:         'euler',
    scheduler:       'normal',
    denoise,
    concept_hash:    conceptHash,
    concept_source:  'assets/src/concept/entities_concept_sheet_v1.png',
    concept_card:    'T-0210',
    method: (
      `img2img concept-conditioned via ComfyUI HTTP API ` +
      `(SDXL KSampler, euler/normal, denoise=${denoise}); ` +
      `entity section cropped from T-0210 entities_concept_sheet_v1.png ` +
      `(${entity}/${state} crop [${cropBox.join(',')}]), ` +
      `scaled to ${CELL_GEN}×${CELL_GEN}px and tiled ${cols}×${rows} ` +
      `at ${cols*CELL_GEN}×${rows*CELL_GEN}px as img2img init. ` +
      `Descent: box-average 8× (${CELL_GEN}→${CELL_NATIVE}px) + Oklab nearest-colour ` +
      `palette quantize + orphan cleanup → indexed PNG (mode P, PLTE). ` +
      `Workflow hash: ${graphHash}. ` +
      `Generator: assets/src/character/gen_entities_v2.js`
    ),
    img2img_denoise:   denoise,
    init_tiled_dims:   `${cols}x${rows} (${cols*CELL_GEN}x${rows*CELL_GEN}px per sheet, ${CELL_GEN}x${CELL_GEN}px per cell)`,
    concept_crop_box:  cropBox,
    lora_name:         LORA_NAME,
    lora_weight:       LORA_WEIGHT,
    lora_license:      'CreativeML OpenRAIL++-M',
    workflow_hash:     graphHash,
    comfyui_prompt_id: promptId,
    generator:         'assets/src/character/gen_entities_v2.js',
    card:              'T-0214',
    spec:              'docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) §6.11 (concept conditioning)',
    layout: {
      sheet_px:    [cols * CELL_NATIVE, rows * CELL_NATIVE],
      cell_px:     CELL_NATIVE,
      cols,
      rows,
      entity:      entityDisplay,
      state,
      frame_count: cols * rows,
    },
    palette_source: 'assets/final/palette/home_palette.json',
  };
  fs.writeFileSync(outProv, JSON.stringify(prov, null, 2));
  console.log(`  Saved provenance: assets/final/entity/${sheetName}.provenance.json`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Entry point
// ══════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('T-0214 Entity Sheets v2 Generation');
  console.log(`ComfyUI: http://${COMFYUI_HOST}:${COMFYUI_PORT}`);
  console.log(`Concept:  ${CONCEPT_PNG}`);

  // Load concept hash from T-0210 provenance
  const conceptProv = JSON.parse(fs.readFileSync(CONCEPT_PROV, 'utf8'));
  const conceptHash = conceptProv.concept_hash;
  console.log(`Concept hash: ${conceptHash}`);

  // Load home palette
  const palData = JSON.parse(fs.readFileSync(PALETTE_JSON, 'utf8'));
  const palette = palData.slots
    .sort((a, b) => a.index - b.index)
    .map(s => {
      const h = s.hex.replace('#', '');
      return [parseInt(h.slice(0,2), 16), parseInt(h.slice(2,4), 16), parseInt(h.slice(4,6), 16)];
    });
  console.log(`Loaded palette: ${palette.length} colours`);

  // Pre-compute Oklab for palette (reused per cell descent)
  const paletteOklab = palette.map(([r,g,b]) => rgbToOklab(r, g, b));

  // Verify ComfyUI is reachable
  const sysStats = await comfyGetJSON('/system_stats');
  console.log(`ComfyUI version: ${sysStats.system.comfyui_version} ✓`);

  // Load concept sheet
  console.log(`Loading concept sheet...`);
  const conceptBuf = fs.readFileSync(CONCEPT_PNG);
  const conceptImg = parsePNG(conceptBuf);
  if (conceptImg.channels === 4) {
    // Convert RGBA → RGB in-place
    const rgb = Buffer.alloc(conceptImg.width * conceptImg.height * 3);
    for (let i = 0; i < conceptImg.width * conceptImg.height; i++) {
      rgb[i*3] = conceptImg.pixels[i*4]; rgb[i*3+1] = conceptImg.pixels[i*4+1]; rgb[i*3+2] = conceptImg.pixels[i*4+2];
    }
    conceptImg.pixels  = rgb;
    conceptImg.channels = 3;
  }
  console.log(`Concept sheet: ${conceptImg.width}×${conceptImg.height}px`);

  // Generate all 9 sheets
  for (const spec of ENTITY_SPECS) {
    await generateEntitySheet(spec, conceptImg, palette, paletteOklab, conceptHash);
  }

  console.log('\n✓ All 9 entity v2 sheets generated.');
  console.log(`  assets/final/entity/ contains the indexed PNGs + provenance JSONs`);
})().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
