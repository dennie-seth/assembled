#!/usr/bin/env node
/**
 * T-0213: Generate concept-conditioned player state sheets via ComfyUI img2img.
 *
 * Generates move (3×4), crouch-hide (3×3), and die (3×3) sheets img2img-seeded
 * from T-0212's player_idle_sheet_v2.png. Mirrors gen_idle_v2_comfyui.js but
 * adapted for state-specific grids, prompts, and the idle-v2 seed instead of
 * the concept sheet.
 *
 * Uses only Node.js built-ins: no npm packages required.
 *
 * Usage:
 *   node assets/src/character/gen_states_v2_comfyui.js [move|crouch_hide|die|all]
 *
 * Writes (per state):
 *   assets/final/character/player_{state}_sheet_v2.png
 *   assets/final/character/player_{state}_sheet_v2.provenance.json
 *
 * docs/design/13-asset-pipeline.md §3.5 (Characters) + §6 (archetype-first coherence guard)
 */

'use strict';
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const zlib   = require('zlib');
const crypto = require('crypto');

const COMFYUI_HOST = '172.18.192.1';
const COMFYUI_PORT = 8188;

const REPO_ROOT     = path.resolve(__dirname, '../../..');
const IDLE_V2_PATH  = path.join(REPO_ROOT, 'assets/final/character/player_idle_sheet_v2.png');
const PALETTE_PATH  = path.join(REPO_ROOT, 'assets/final/palette/home_palette.json');

// SHA-256 of player_idle_sheet_v2.png (T-0212 output — computed at generation time)
const EXPECTED_IDLE_V2_HASH = 'fc8262a4701e535e6f1c1b6dac9200a604b79df5004bfb5783922eae4d23dddc';

const CELL_NATIVE = 48;  // native cell size in pixels
const STEPS       = 30;
const CFG         = 7.0;
const LORA_WEIGHT = 0.70;

const NEGATIVE_PROMPT = (
  'multiple characters, different costumes, costume sheet, turnaround, ' +
  'perspective, three-quarter view, vanishing point, diagonal composition, ' +
  'depth of field, atmospheric haze, blurry, low quality, photorealistic, ' +
  'watermark, text, UI, background clutter, bright colours, neon'
);

// ── State configs ─────────────────────────────────────────────────────────────
const STATES = {
  move: {
    outputPath:     path.join(REPO_ROOT, 'assets/final/character/player_move_sheet_v2.png'),
    provenancePath: path.join(REPO_ROOT, 'assets/final/character/player_move_sheet_v2.provenance.json'),
    cols: 3, rows: 4,
    nativeW: 144, nativeH: 192,
    genW: 1152,   genH: 1536,
    seed: 31417, denoise: 0.85,
    uploadFilename: 'player_move_v2_template.png',
    outputPrefix:   'player_move_v2',
    frameCells:  ['(0,0)','(0,1)','(0,2)','(1,0)','(1,1)','(1,2)','(2,0)','(2,1)','(2,2)','(3,0)'],
    spareCells:  ['(3,1)','(3,2)'],
    prompt: (
      'pixel art walk cycle animation sprite sheet, Soviet brutalist soldier ' +
      'in standard military uniform, flat side-on orthographic side view, ' +
      'twelve frame cells arranged in a 3x4 grid, same single character in every cell, ' +
      'walk cycle animation with leg stride variation between frames, ' +
      'left and right leg alternating forward and back across adjacent frames, ' +
      'body upright and stable, arms swinging slightly, ' +
      'institutional grey concrete background, muted olive-green and grey military palette, ' +
      'value-separated pixel art silhouette, clean readable pixel outline, ' +
      'no perspective, no vanishing point, no action poses other than walking, ' +
      'no multiple characters, no UI, no text'
    ),
  },
  crouch_hide: {
    outputPath:     path.join(REPO_ROOT, 'assets/final/character/player_crouch_hide_sheet_v2.png'),
    provenancePath: path.join(REPO_ROOT, 'assets/final/character/player_crouch_hide_sheet_v2.provenance.json'),
    cols: 3, rows: 3,
    nativeW: 144, nativeH: 144,
    genW: 1152,   genH: 1152,
    seed: 31418, denoise: 0.80,
    uploadFilename: 'player_crouch_hide_v2_template.png',
    outputPrefix:   'player_crouch_hide_v2',
    frameCells:  ['(0,0)','(0,1)','(0,2)','(1,0)','(1,1)','(1,2)','(2,0)','(2,1)','(2,2)'],
    spareCells:  [],
    prompt: (
      'pixel art crouch and hide animation sprite sheet, Soviet brutalist soldier ' +
      'in standard military uniform, flat side-on orthographic side view, ' +
      'nine frame cells arranged in a 3x3 grid, same single character in every cell, ' +
      'progressive crouching sequence across frames from standing to fully crouched, ' +
      'figure compresses vertically as character descends into hiding position, ' +
      'character partially hidden behind imagined cover by final frames, ' +
      'institutional grey concrete background, muted olive-green and grey military palette, ' +
      'value-separated pixel art silhouette, clean readable pixel outline, ' +
      'no perspective, no vanishing point, no action poses other than crouching, ' +
      'no multiple characters, no UI, no text'
    ),
  },
  die: {
    outputPath:     path.join(REPO_ROOT, 'assets/final/character/player_die_sheet_v2.png'),
    provenancePath: path.join(REPO_ROOT, 'assets/final/character/player_die_sheet_v2.provenance.json'),
    cols: 3, rows: 3,
    nativeW: 144, nativeH: 144,
    genW: 1152,   genH: 1152,
    seed: 31419, denoise: 0.85,
    uploadFilename: 'player_die_v2_template.png',
    outputPrefix:   'player_die_v2',
    frameCells:  ['(0,0)','(0,1)','(0,2)','(1,0)','(1,1)','(1,2)','(2,0)','(2,1)','(2,2)'],
    spareCells:  [],
    prompt: (
      'pixel art death animation sprite sheet, Soviet brutalist soldier ' +
      'in standard military uniform, flat side-on orthographic side view, ' +
      'nine frame cells arranged in a 3x3 grid, same single character in every cell, ' +
      'progressive death fall sequence across frames from standing to collapsed, ' +
      'figure gradually falls sideways and collapses to ground across frames, ' +
      'figure becomes horizontal by final frames, dramatic fall animation, ' +
      'institutional grey concrete background, muted olive-green and grey military palette, ' +
      'value-separated pixel art silhouette, clean readable pixel outline, ' +
      'no perspective, no vanishing point, no action poses other than falling, ' +
      'no multiple characters, no UI, no text'
    ),
  },
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: COMFYUI_HOST, port: COMFYUI_PORT, path: urlPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const req = http.request(
      { host: COMFYUI_HOST, port: COMFYUI_PORT, path: urlPath, method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': bodyBuf.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── PNG codec ─────────────────────────────────────────────────────────────────

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Parse PNG → { width, height, pixels: Uint8Array (RGB), palette?: [[r,g,b]...] }.
 *  Supports colorType 2 (RGB), 6 (RGBA), and 3 (indexed/palette). */
function parsePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG file');
  }

  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];
  let plteData = null;

  while (offset < buf.length) {
    const len  = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth: ${bitDepth}`);
      if (![2, 3, 6].includes(colorType))
        throw new Error(`unsupported PNG color type: ${colorType}`);
    } else if (type === 'PLTE') {
      plteData = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === undefined) throw new Error('IHDR chunk not found');

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));

  if (colorType === 3) {
    // Indexed (palette) PNG
    if (!plteData) throw new Error('indexed PNG missing PLTE chunk');
    const palette = [];
    for (let i = 0; i < plteData.length; i += 3)
      palette.push([plteData[i], plteData[i + 1], plteData[i + 2]]);

    const stride  = 1 + width;
    const indices = new Uint8Array(width * height);
    const priorRow = new Uint8Array(width);
    for (let y = 0; y < height; y++) {
      const filterType = inflated[y * stride];
      const thisRow    = inflated.slice(y * stride + 1, (y + 1) * stride);
      const outRow     = indices.subarray(y * width, (y + 1) * width);
      for (let x = 0; x < width; x++) {
        const byte = thisRow[x];
        const a = x > 0 ? outRow[x - 1] : 0;
        const b = priorRow[x];
        const c = x > 0 ? priorRow[x - 1] : 0;
        switch (filterType) {
          case 0: outRow[x] = byte; break;
          case 1: outRow[x] = (byte + a) & 0xff; break;
          case 2: outRow[x] = (byte + b) & 0xff; break;
          case 3: outRow[x] = (byte + Math.floor((a + b) / 2)) & 0xff; break;
          case 4: outRow[x] = (byte + paethPredictor(a, b, c)) & 0xff; break;
          default: throw new Error(`unknown filter type ${filterType} at row ${y}`);
        }
      }
      priorRow.set(outRow);
    }
    // Convert indices to RGB
    const rgbPixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const [r, g, b] = palette[indices[i]] || [0, 0, 0];
      rgbPixels[i * 3] = r; rgbPixels[i * 3 + 1] = g; rgbPixels[i * 3 + 2] = b;
    }
    return { width, height, pixels: rgbPixels, paletteIndices: indices, palette };
  }

  // RGB or RGBA
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes  = channels * width;
  const rawPixels = new Uint8Array(height * rowBytes);
  const priorRow  = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const rowStart   = y * (rowBytes + 1);
    const filterType = inflated[rowStart];
    const thisRow    = inflated.slice(rowStart + 1, rowStart + 1 + rowBytes);
    const outRow     = rawPixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const byte = thisRow[i];
      const a = i >= channels ? outRow[i - channels] : 0;
      const b = priorRow[i];
      const c = i >= channels ? priorRow[i - channels] : 0;
      switch (filterType) {
        case 0: outRow[i] = byte; break;
        case 1: outRow[i] = (byte + a) & 0xff; break;
        case 2: outRow[i] = (byte + b) & 0xff; break;
        case 3: outRow[i] = (byte + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: outRow[i] = (byte + paethPredictor(a, b, c)) & 0xff; break;
        default: throw new Error(`unknown filter type ${filterType} at row ${y}`);
      }
    }
    priorRow.set(outRow);
  }

  const rgbPixels = new Uint8Array(height * width * 3);
  if (channels === 3) {
    rgbPixels.set(rawPixels);
  } else {
    for (let i = 0; i < width * height; i++) {
      rgbPixels[i * 3]     = rawPixels[i * 4];
      rgbPixels[i * 3 + 1] = rawPixels[i * 4 + 1];
      rgbPixels[i * 3 + 2] = rawPixels[i * 4 + 2];
    }
  }
  return { width, height, pixels: rgbPixels };
}

// ── Palette helpers ───────────────────────────────────────────────────────────

function loadHomePalette() {
  const data = JSON.parse(fs.readFileSync(PALETTE_PATH, 'utf8'));
  const byIdx = {};
  for (const slot of data.slots) {
    const h = slot.hex.replace('#', '');
    byIdx[parseInt(slot.index)] = [
      parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
    ];
  }
  const n = Object.keys(byIdx).length;
  return Array.from({ length: n }, (_, i) => byIdx[i]);
}

function quantize(width, height, rgbPixels, palette) {
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgbPixels[i * 3], g = rgbPixels[i * 3 + 1], b = rgbPixels[i * 3 + 2];
    let best = 0, bestDist = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const d = (r - palette[j][0]) ** 2 + (g - palette[j][1]) ** 2 + (b - palette[j][2]) ** 2;
      if (d < bestDist) { bestDist = d; best = j; }
    }
    indices[i] = best;
  }
  return indices;
}

function cleanupOrphans(width, height, indices) {
  const out = new Uint8Array(indices);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      const neighbours = [];
      if (y > 0)          neighbours.push(indices[(y - 1) * width + x]);
      if (y < height - 1) neighbours.push(indices[(y + 1) * width + x]);
      if (x > 0)          neighbours.push(indices[y * width + x - 1]);
      if (x < width - 1)  neighbours.push(indices[y * width + x + 1]);
      if (neighbours.length > 0 && !neighbours.includes(idx)) {
        const counts = {};
        for (const n of neighbours) counts[n] = (counts[n] || 0) + 1;
        const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        out[y * width + x] = parseInt(majority);
      }
    }
  }
  return out;
}

function clearCellBorders(width, height, indices, cols, rows) {
  for (let c = 1; c < cols; c++) {
    const x0 = c * CELL_NATIVE - 1, x1 = c * CELL_NATIVE;
    for (let y = 0; y < height; y++) {
      if (x0 < width) indices[y * width + x0] = 0;
      if (x1 < width) indices[y * width + x1] = 0;
    }
  }
  for (let r = 1; r < rows; r++) {
    const y0 = r * CELL_NATIVE - 1, y1 = r * CELL_NATIVE;
    for (let x = 0; x < width; x++) {
      if (y0 < height) indices[y0 * width + x] = 0;
      if (y1 < height) indices[y1 * width + x] = 0;
    }
  }
}

// ── Indexed PNG encoder ───────────────────────────────────────────────────────

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function encodeIndexedPng(width, height, indices, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 3;  // indexed

  const plte = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i][0]; plte[i * 3 + 1] = palette[i][1]; plte[i * 3 + 2] = palette[i][2];
  }

  const rawRows = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + width)] = 0;
    for (let x = 0; x < width; x++)
      rawRows[y * (1 + width) + 1 + x] = indices[y * width + x];
  }
  const compressed = zlib.deflateSync(rawRows, { level: 6 });

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Template builder ──────────────────────────────────────────────────────────

/** Scale a srcW×srcH RGB cell to dstW×dstH using nearest-neighbor. */
function scaleNearestNeighbor(srcPixels, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 3);
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.floor(dx * srcW / dstW);
      const sy = Math.floor(dy * srcH / dstH);
      const si = (sy * srcW + sx) * 3;
      const di = (dy * dstW + dx) * 3;
      out[di] = srcPixels[si]; out[di + 1] = srcPixels[si + 1]; out[di + 2] = srcPixels[si + 2];
    }
  }
  return out;
}

/** Encode RGB Uint8Array as PNG (IHDR colorType=2). */
function encodeRgbPng(width, height, rgbPixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;  // RGB

  const rawRows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 3;
      const di = y * (1 + width * 3) + 1 + x * 3;
      rawRows[di] = rgbPixels[si]; rawRows[di + 1] = rgbPixels[si + 1]; rawRows[di + 2] = rgbPixels[si + 2];
    }
  }
  const compressed = zlib.deflateSync(rawRows, { level: 6 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildTemplate(cfg, idleRgb) {
  const { cols, rows, genW, genH } = cfg;
  const cellGenW = genW / cols;
  const cellGenH = genH / rows;

  // Crop cell (0,0) from idle sheet: top-left 48×48 in RGB
  const cellRgb = new Uint8Array(CELL_NATIVE * CELL_NATIVE * 3);
  for (let y = 0; y < CELL_NATIVE; y++) {
    for (let x = 0; x < CELL_NATIVE; x++) {
      const si = (y * 144 + x) * 3;  // idle sheet is 144px wide
      const di = (y * CELL_NATIVE + x) * 3;
      cellRgb[di] = idleRgb[si]; cellRgb[di + 1] = idleRgb[si + 1]; cellRgb[di + 2] = idleRgb[si + 2];
    }
  }

  // Scale to gen cell size (nearest-neighbor)
  const cellScaled = scaleNearestNeighbor(cellRgb, CELL_NATIVE, CELL_NATIVE, cellGenW, cellGenH);

  // Tile to full gen grid
  const templateRgb = new Uint8Array(genW * genH * 3);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (let cy = 0; cy < cellGenH; cy++) {
        for (let cx = 0; cx < cellGenW; cx++) {
          const si = (cy * cellGenW + cx) * 3;
          const dx = col * cellGenW + cx;
          const dy = row * cellGenH + cy;
          const di = (dy * genW + dx) * 3;
          templateRgb[di] = cellScaled[si]; templateRgb[di + 1] = cellScaled[si + 1]; templateRgb[di + 2] = cellScaled[si + 2];
        }
      }
    }
  }

  return encodeRgbPng(genW, genH, templateRgb);
}

// ── ComfyUI API ───────────────────────────────────────────────────────────────

async function uploadImage(imageBytes, filename) {
  const boundary = '----FormBoundary' + Date.now().toString(16);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
    imageBytes,
    `\r\n--${boundary}--\r\n`,
  ];
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
  const res = await httpPost('/upload/image', body, `multipart/form-data; boundary=${boundary}`);
  if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${res.body.toString()}`);
  return JSON.parse(res.body.toString());
}

function buildWorkflow(cfg, uploadedFilename) {
  const { genW, genH, nativeW, nativeH, seed, denoise, prompt, outputPrefix } = cfg;
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '12': {
      class_type: 'LoraLoader',
      inputs: { model: ['4', 0], clip: ['4', 1], lora_name: 'soviet_brutalism_style_v1.safetensors',
                strength_model: LORA_WEIGHT, strength_clip: LORA_WEIGHT },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['12', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE_PROMPT, clip: ['12', 1] } },
    '10': { class_type: 'LoadImage', inputs: { image: uploadedFilename } },
    '14': {
      class_type: 'ImageScale',
      inputs: { image: ['10', 0], upscale_method: 'lanczos', width: genW, height: genH, crop: 'disabled' },
    },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['14', 0], vae: ['4', 2] } },
    '3': {
      class_type: 'KSampler',
      inputs: { model: ['12', 0], positive: ['6', 0], negative: ['7', 0],
                latent_image: ['11', 0], seed, steps: STEPS, cfg: CFG,
                sampler_name: 'euler', scheduler: 'normal', denoise },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '13': {
      class_type: 'ImageScale',
      inputs: { image: ['8', 0], upscale_method: 'area', width: nativeW, height: nativeH, crop: 'disabled' },
    },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: outputPrefix, images: ['13', 0] } },
  };
}

async function submitPrompt(graph) {
  const body = JSON.stringify({ prompt: graph });
  const res = await httpPost('/prompt', body, 'application/json');
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${res.body.toString()}`);
  return JSON.parse(res.body.toString()).prompt_id;
}

async function waitForCompletion(promptId, timeoutMs = 600000, pollMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const res = await httpGet(`/history/${promptId}`);
    if (res.status !== 200) continue;
    const history = JSON.parse(res.body.toString());
    if (!history[promptId]) continue;
    const info = history[promptId];
    if (info.status && info.status.completed) return info;
    if (info.status && info.status.status_str === 'error')
      throw new Error('ComfyUI job errored: ' + JSON.stringify(info.status));
    const messages = info.status && info.status.messages || [];
    console.log(`  polling... last_msg=${JSON.stringify(messages[messages.length - 1] || null)}`);
  }
  throw new Error(`timed out waiting for prompt ${promptId}`);
}

async function fetchOutput(jobResult) {
  for (const nodeId of Object.keys(jobResult.outputs || {})) {
    const node = jobResult.outputs[nodeId];
    if (node.images && node.images.length > 0) {
      const img = node.images[0];
      const res = await httpGet(
        `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`
      );
      if (res.status === 200) return res.body;
    }
  }
  throw new Error('no output image found: ' + JSON.stringify(jobResult.outputs));
}

// ── Provenance ────────────────────────────────────────────────────────────────

function writeProvenance(cfg, stateName, conceptHash, promptId) {
  const { prompt, seed, denoise, genW, genH, nativeW, nativeH, cols, rows, frameCells, spareCells, provenancePath } = cfg;
  const cellGenW = genW / cols, cellGenH = genH / rows;
  const prov = {
    model: `sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors (weight ${LORA_WEIGHT})`,
    model_license: 'CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)',
    model_hash: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b',
    lora_hash: '2dab82287f6d36a98a142dae5199df47e001d86d4c9507a0524742b4d34f2b9f',
    prompt,
    negative_prompt: NEGATIVE_PROMPT,
    seed,
    steps: STEPS,
    cfg: CFG,
    width: genW,
    height: genH,
    concept_hash: conceptHash,
    concept_source: 'assets/final/character/player_idle_sheet_v2.png',
    concept_card: 'T-0212',
    method: (
      `img2img concept-conditioned via ComfyUI HTTP API (SDXL KSampler, euler/normal, denoise=${denoise}); ` +
      `idle-sheet-v2 cell (0,0) cropped from T-0212 player_idle_sheet_v2.png (48x48), scaled ` +
      `to ${cellGenW}x${cellGenH} and tiled ${cols}x${rows} at ${genW}x${genH} as img2img template ` +
      `so character identity is preserved across all cells. ComfyUI: ` +
      `assets/src/character/gen_states_v2_comfyui.js`
    ),
    img2img_denoise: denoise,
    idle_v2_crop: [0, 0, CELL_NATIVE, CELL_NATIVE],
    tile_grid: `${cols}x${rows} (${cellGenW}x${cellGenH}px per cell)`,
    lora_name: 'soviet_brutalism_style_v1.safetensors',
    lora_weight: LORA_WEIGHT,
    lora_license: 'CreativeML OpenRAIL++-M',
    comfyui_prompt_id: promptId,
    generator: 'assets/src/character/gen_states_v2_comfyui.js (Node.js, ComfyUI HTTP API)',
    card: 'T-0213',
    spec: 'docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + §6 (archetype-first coherence guard)',
    layout: {
      sheet_px: [nativeW, nativeH],
      cell_px: CELL_NATIVE,
      cols,
      rows,
      figure_height_px: 40,
      frame_cells: frameCells.map((c) => ({ cell: c })),
      spare_cells: spareCells,
    },
    palette_source: 'assets/final/palette/home_palette.json',
  };
  fs.writeFileSync(provenancePath, JSON.stringify(prov, null, 2));
  console.log(`  provenance written: ${provenancePath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function generateState(stateName) {
  const cfg = STATES[stateName];
  console.log(`\n=== T-0213: player_${stateName}_sheet_v2 — concept-conditioned ===\n`);

  // Verify idle v2 hash
  const idleBytes = fs.readFileSync(IDLE_V2_PATH);
  const conceptHash = crypto.createHash('sha256').update(idleBytes).digest('hex');
  if (conceptHash !== EXPECTED_IDLE_V2_HASH) {
    throw new Error(`idle-v2 hash mismatch\n  got:  ${conceptHash}\n  want: ${EXPECTED_IDLE_V2_HASH}`);
  }
  console.log(`T-0212 idle-sheet-v2 verified: ${conceptHash}`);

  // Check ComfyUI
  console.log(`Checking ComfyUI at http://${COMFYUI_HOST}:${COMFYUI_PORT} ...`);
  const statsRes = await httpGet('/system_stats');
  if (statsRes.status !== 200) throw new Error(`ComfyUI not reachable: ${statsRes.status}`);
  console.log(`  ComfyUI OK`);

  // Parse idle sheet, get RGB pixels
  console.log('Decoding idle-sheet-v2 ...');
  const { pixels: idleRgb } = parsePng(idleBytes);
  console.log(`  decoded`);

  // Build tiled template
  console.log(`Building ${cfg.cols}x${cfg.rows} tiled template ...`);
  const templatePng = buildTemplate(cfg, idleRgb);
  console.log(`  template built (${templatePng.length} bytes)`);

  // Upload template
  console.log('Uploading template to ComfyUI ...');
  const uploadResult = await uploadImage(templatePng, cfg.uploadFilename);
  const uploadedName = uploadResult.name;
  console.log(`  uploaded as: ${uploadedName}`);

  // Submit workflow
  const workflow = buildWorkflow(cfg, uploadedName);
  console.log(`Submitting img2img workflow (seed=${cfg.seed}, denoise=${cfg.denoise}) ...`);
  const promptId = await submitPrompt(workflow);
  console.log(`  prompt_id: ${promptId}`);

  // Poll for completion
  console.log('Waiting for ComfyUI to finish (up to 10 min) ...');
  const jobResult = await waitForCompletion(promptId, 600000, 5000);
  console.log(`  job completed`);

  // Fetch output
  console.log('Fetching output ...');
  const rawPngBytes = await fetchOutput(jobResult);
  console.log(`  fetched ${rawPngBytes.length} bytes`);

  // Descent: decode RGB → quantize → cleanup → cell-border → index
  console.log('Descent pipeline ...');
  const { width, height, pixels: rgbPixels } = parsePng(rawPngBytes);
  if (width !== cfg.nativeW || height !== cfg.nativeH)
    throw new Error(`unexpected output size: ${width}x${height} (expected ${cfg.nativeW}x${cfg.nativeH})`);
  const palette = loadHomePalette();
  let indices = quantize(width, height, rgbPixels, palette);
  indices = cleanupOrphans(width, height, indices);
  clearCellBorders(width, height, indices, cfg.cols, cfg.rows);
  console.log(`  quantized → cleaned → borders cleared`);

  // Encode and save indexed PNG
  const pngBytes = encodeIndexedPng(width, height, indices, palette);
  fs.mkdirSync(path.dirname(cfg.outputPath), { recursive: true });
  fs.writeFileSync(cfg.outputPath, pngBytes);
  console.log(`  saved: ${cfg.outputPath} (${pngBytes.length} bytes)`);

  // Write provenance
  writeProvenance(cfg, stateName, conceptHash, promptId);

  console.log(`\n=== DONE: ${stateName} ===`);
}

async function main() {
  const args = process.argv.slice(2);
  const states = (args.length === 0 || args[0] === 'all') ? Object.keys(STATES) : args;

  for (const s of states) {
    if (!STATES[s]) {
      console.error(`Unknown state '${s}'. Available: ${Object.keys(STATES).join(', ')}`);
      process.exit(1);
    }
  }

  for (const stateName of states) {
    await generateState(stateName);
  }

  console.log('\n=== ALL DONE ===');
  console.log('\nRun gate tests:');
  console.log('  cd assets/src/character');
  console.log('  .venv/bin/pytest tests/test_player_move_v2_gate.py tests/test_player_crouch_hide_v2_gate.py tests/test_player_die_v2_gate.py -v');
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
