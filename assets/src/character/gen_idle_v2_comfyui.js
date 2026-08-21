#!/usr/bin/env node
/**
 * Generate player_idle_sheet_v2.png via ComfyUI SDXL img2img + LoRA,
 * conditioned on the T-0209 concept sheet. Full descent: 1152x1152 -> 144x144 indexed.
 *
 * T-0212: concept-conditioned re-run of T-0198 (archetype-first coherence guard, T-0106).
 * Uses ComfyUI HTTP API at http://172.18.192.1:8188 (WSL2 gateway to Windows host).
 * ComfyUI is running on the Windows host with the RTX 3070 Ti Laptop GPU.
 * Firewall rule allowing WSL->Windows port 8188 was previously applied.
 *
 * Workflow: SDXL img2img + soviet_brutalism LoRA + ImageScale(144x144, area)
 * Descent: ComfyUI area-downscaled RGB 144x144 -> sRGB nearest-color palette quantize
 *          -> orphan cleanup -> indexed PNG (home palette embedded as PLTE)
 *
 * Writes:
 *   assets/out/player_idle_sheet_v2_raw.png    (ComfyUI 144x144 area-downscaled RGB)
 *   assets/final/character/player_idle_sheet_v2.png  (144x144 indexed mode-P)
 *   assets/final/character/player_idle_sheet_v2.provenance.json
 *
 * Usage (from worktree root):
 *   node assets/src/character/gen_idle_v2_comfyui.js
 *
 * docs/design/13-asset-pipeline.md §3.5 (Characters) + §6 (archetype-first coherence guard)
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const COMFYUI_HOST = '172.18.192.1';
const COMFYUI_PORT = 8188;
const CLIENT_ID    = 'T-0212-idle-v2-' + Date.now();

const REPO_ROOT     = path.resolve(__dirname, '../../..');
const CONCEPT_SHEET = path.join(REPO_ROOT, 'assets/src/concept/player_character_concept_sheet_v1.png');
const PALETTE_PATH  = path.join(REPO_ROOT, 'assets/final/palette/home_palette.json');
const RAW_OUT       = path.join(REPO_ROOT, 'assets/out/player_idle_sheet_v2_raw.png');
const FINAL_OUT     = path.join(REPO_ROOT, 'assets/final/character/player_idle_sheet_v2.png');
const PROVENANCE_OUT = path.join(REPO_ROOT, 'assets/final/character/player_idle_sheet_v2.provenance.json');
const ASSET_PROV_MD = path.join(REPO_ROOT, 'ASSET_PROVENANCE.md');

const EXPECTED_CONCEPT_HASH = '4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b';

// Recipe (player_idle_sheet_v2.recipe.json)
const PROMPT          = 'pixel art sprite sheet, Soviet brutalist soldier standing idle, flat side-on orthographic view, 3x3 grid layout nine equal panels, single standing figure per panel, subtle breathing pose variation, upright standing pose, institutional concrete interior background, muted grey-green palette, value-separated silhouette, clean readable outline, no perspective, no vanishing point, no diagonal composition, no text, no UI';
const NEGATIVE_PROMPT = 'perspective, three-quarter view, vanishing point, diagonal, depth of field, blurry, low quality, text, watermark, multiple characters per panel, action pose, background clutter, bright colours, photorealistic';
const SEED            = 31416;
const STEPS           = 30;
const CFG             = 7.0;
const DENOISE         = 0.7;
const LORA_WEIGHT     = 0.70;
const GEN_W           = 1152;  // generation res (x8 from 144)
const GEN_H           = 1152;
const TARGET_SIZE     = 144;   // native sheet size

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
      {
        host: COMFYUI_HOST,
        port: COMFYUI_PORT,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': bodyBuf.length },
      },
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function submitPrompt(graph) {
  const body = JSON.stringify({ prompt: graph, client_id: CLIENT_ID });
  const res = await httpPost('/prompt', body, 'application/json');
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${res.body.toString()}`);
  return JSON.parse(res.body.toString()).prompt_id;
}

async function waitForCompletion(promptId, timeoutMs = 300000, pollMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const res = await httpGet(`/history/${promptId}`);
    if (res.status !== 200) continue;
    const history = JSON.parse(res.body.toString());
    if (!history[promptId]) continue;
    const info = history[promptId];
    if (info.status && info.status.completed) return info;
    if (info.status && info.status.status_str === 'error') {
      throw new Error('ComfyUI job errored: ' + JSON.stringify(info.status));
    }
  }
  throw new Error(`timed out waiting for prompt ${promptId}`);
}

async function fetchOutput(jobResult) {
  // Find the SaveImage output (node 9)
  for (const nodeId of Object.keys(jobResult.outputs || {})) {
    const node = jobResult.outputs[nodeId];
    if (node.images && node.images.length > 0) {
      const img = node.images[0];
      const res = await httpGet(`/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`);
      if (res.status === 200) return res.body;
    }
  }
  throw new Error('no output image found in job result: ' + JSON.stringify(jobResult.outputs));
}

// ── Workflow builder ──────────────────────────────────────────────────────────

function buildWorkflow(uploadedFilename) {
  return {
    // CheckpointLoaderSimple
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
    },
    // LoraLoader (patches model + clip)
    '12': {
      class_type: 'LoraLoader',
      inputs: {
        model: ['4', 0],
        clip: ['4', 1],
        lora_name: 'soviet_brutalism_style_v1.safetensors',
        strength_model: LORA_WEIGHT,
        strength_clip: LORA_WEIGHT,
      },
    },
    // CLIPTextEncode positive
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: PROMPT, clip: ['12', 1] },
    },
    // CLIPTextEncode negative
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: NEGATIVE_PROMPT, clip: ['12', 1] },
    },
    // LoadImage (concept sheet — uploaded to ComfyUI input dir)
    '10': {
      class_type: 'LoadImage',
      inputs: { image: uploadedFilename },
    },
    // ImageScale: resize concept sheet to 1152x1152 for SDXL (from 1024x1024 native)
    '14': {
      class_type: 'ImageScale',
      inputs: {
        image: ['10', 0],
        upscale_method: 'lanczos',
        width: GEN_W,
        height: GEN_H,
        crop: 'disabled',
      },
    },
    // VAEEncode: encode the concept sheet into latent space
    '11': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['14', 0], vae: ['4', 2] },
    },
    // KSampler: img2img generation
    '3': {
      class_type: 'KSampler',
      inputs: {
        model: ['12', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['11', 0],
        seed: SEED,
        steps: STEPS,
        cfg: CFG,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: DENOISE,
      },
    },
    // VAEDecode: decode latent to pixels (1152x1152 RGB)
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    // ImageScale: area downscale to 144x144 (box average, matches descent chain step 1)
    '13': {
      class_type: 'ImageScale',
      inputs: {
        image: ['8', 0],
        upscale_method: 'area',
        width: TARGET_SIZE,
        height: TARGET_SIZE,
        crop: 'disabled',
      },
    },
    // SaveImage: save the 144x144 result
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'player_idle_sheet_v2', images: ['13', 0] },
    },
  };
}

// ── PNG decode ────────────────────────────────────────────────────────────────
// Minimal PNG decoder: reads IHDR, concatenates IDAT chunks, inflates,
// reverses scanline filters, returns { width, height, pixels: Uint8Array } RGB.

function parsePng(buf) {
  // Verify PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG file');
  }

  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < buf.length) {
    const len  = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth: ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported PNG color type: ${colorType} (need RGB or RGBA)`);
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width === undefined) throw new Error('IHDR chunk not found');

  const channels   = colorType === 6 ? 4 : 3;  // RGBA or RGB
  const rowBytes   = channels * width;
  const inflated   = zlib.inflateSync(Buffer.concat(idatChunks));
  const rawPixels  = new Uint8Array(height * rowBytes);
  const priorRow   = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const rowStart  = y * (rowBytes + 1);
    const filterType = inflated[rowStart];
    const thisRow   = inflated.slice(rowStart + 1, rowStart + 1 + rowBytes);
    const outRow    = rawPixels.subarray(y * rowBytes, (y + 1) * rowBytes);

    for (let i = 0; i < rowBytes; i++) {
      const byte = thisRow[i];
      const a = i >= channels ? outRow[i - channels] : 0;
      const b = priorRow[i];
      const c = i >= channels ? priorRow[i - channels] : 0;

      switch (filterType) {
        case 0:  outRow[i] = byte; break;  // None
        case 1:  outRow[i] = (byte + a) & 0xff; break;  // Sub
        case 2:  outRow[i] = (byte + b) & 0xff; break;  // Up
        case 3:  outRow[i] = (byte + Math.floor((a + b) / 2)) & 0xff; break;  // Average
        case 4:  outRow[i] = (byte + paethPredictor(a, b, c)) & 0xff; break;  // Paeth
        default: throw new Error(`unknown PNG filter type: ${filterType} at row ${y}`);
      }
    }
    priorRow.set(outRow);
  }

  // If RGBA, drop alpha channel
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

function paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ── Palette helpers ───────────────────────────────────────────────────────────

function loadPalette() {
  const data   = JSON.parse(fs.readFileSync(PALETTE_PATH, 'utf8'));
  const byIdx  = {};
  for (const slot of data.slots) {
    const h = slot.hex.replace('#', '');
    byIdx[parseInt(slot.index)] = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  const n = Object.keys(byIdx).length;
  return Array.from({ length: n }, (_, i) => byIdx[i]);
}

function nearestPaletteIndex(r, g, b, palette) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function quantize(width, height, rgbPixels, palette) {
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    indices[i] = nearestPaletteIndex(
      rgbPixels[i * 3], rgbPixels[i * 3 + 1], rgbPixels[i * 3 + 2], palette
    );
  }
  return indices;
}

function cleanupOrphans(width, height, indices, bgIndex) {
  // Replace pixels whose index matches none of their 4 orthogonal neighbours
  // with the majority neighbour. One pass (matches Python descent chain).
  const out = new Uint8Array(indices);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx  = indices[y * width + x];
      const neighbours = [];
      if (y > 0)         neighbours.push(indices[(y - 1) * width + x]);
      if (y < height - 1) neighbours.push(indices[(y + 1) * width + x]);
      if (x > 0)         neighbours.push(indices[y * width + x - 1]);
      if (x < width - 1) neighbours.push(indices[y * width + x + 1]);
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

// ── Indexed PNG encoder ───────────────────────────────────────────────────────
// Writes a mode-P (PLTE + 8-bit indices) PNG. Same structure as gen_player_concept.js.

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
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function encodeIndexedPng(width, height, indices, palette) {
  // IHDR: color_type=3 (indexed), bit_depth=8
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 3;  // color type: indexed
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // PLTE: palette RGB entries
  const plte = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3]     = palette[i][0];
    plte[i * 3 + 1] = palette[i][1];
    plte[i * 3 + 2] = palette[i][2];
  }

  // IDAT: filter-0 (None) scanlines
  const rawRows = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + width)] = 0;  // filter byte: None
    for (let x = 0; x < width; x++) {
      rawRows[y * (1 + width) + 1 + x] = indices[y * width + x];
    }
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

// ── Provenance ────────────────────────────────────────────────────────────────

function writeProvenance(promptId, workflowHash) {
  const conceptHash = crypto.createHash('sha256').update(fs.readFileSync(CONCEPT_SHEET)).digest('hex');
  if (conceptHash !== EXPECTED_CONCEPT_HASH) {
    throw new Error(`concept hash mismatch: got ${conceptHash}, expected ${EXPECTED_CONCEPT_HASH}`);
  }

  const prov = {
    model: `sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors (weight ${LORA_WEIGHT})`,
    model_license: 'CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)',
    model_hash: null,
    prompt: PROMPT,
    negative_prompt: NEGATIVE_PROMPT,
    seed: SEED,
    steps: STEPS,
    cfg: CFG,
    width: GEN_W,
    height: GEN_H,
    workflow_hash: workflowHash,
    prompt_id: promptId,
    concept_hash: conceptHash,
    concept_source: 'assets/src/concept/player_character_concept_sheet_v1.png',
    concept_card: 'T-0209',
    method: `ComfyUI SDXL img2img + LoRA (soviet_brutalism ${LORA_WEIGHT}) + area downscale to ${TARGET_SIZE}x${TARGET_SIZE}; T-0106 concept conditioning. IP-Adapter skipped (no weights in ComfyUI loras dir); img2img denoise=${DENOISE} used as T-0212 recipe fallback.`,
    img2img_denoise: DENOISE,
    lora_name: 'soviet_brutalism_style_v1.safetensors',
    lora_weight: LORA_WEIGHT,
    lora_license: 'CreativeML OpenRAIL++-M',
    generator: 'assets/src/character/gen_idle_v2_comfyui.js (Node.js, ComfyUI HTTP API)',
    card: 'T-0212',
    spec: 'docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + §6 (archetype-first coherence guard)',
    layout: {
      sheet_px: [TARGET_SIZE, TARGET_SIZE],
      cell_px: 48,
      cols: 3,
      rows: 3,
      figure_height_px: 40,
      frame_cells: [{ cell: '(0,0)' }, { cell: '(0,1)' }, { cell: '(0,2)' }, { cell: '(1,0)' }],
      spare_cells: ['(1,1)', '(1,2)', '(2,0)', '(2,1)', '(2,2)'],
    },
    palette_source: 'assets/final/palette/home_palette.json',
  };

  fs.writeFileSync(PROVENANCE_OUT, JSON.stringify(prov, null, 2));
  console.log(`  provenance written: ${PROVENANCE_OUT}`);
  return prov;
}

function appendAssetProvenance(prov) {
  const entry = [
    `\n## player_idle_sheet_v2.png (T-0212)\n`,
    `- **model:** ${prov.model}\n`,
    `- **license:** ${prov.model_license}\n`,
    `- **prompt:** ${prov.prompt}\n`,
    `- **seed:** ${prov.seed}\n`,
    `- **concept_hash:** ${prov.concept_hash} (T-0209 player concept sheet)\n`,
    `- **method:** ${prov.method}\n`,
    `- **card:** T-0212\n`,
  ].join('');
  fs.appendFileSync(ASSET_PROV_MD, entry);
  console.log(`  ASSET_PROVENANCE.md updated`);
}

// ── Workflow hash (mirrors comfy_client.workflow.workflow_hash) ───────────────
function computeWorkflowHash(graph) {
  const canonical = JSON.stringify(graph, Object.keys(graph).sort(), 0)
    .replace(/"([^"]+)":/g, (_, k) => `"${k}":`);
  // Use same approach as Python: JSON with sorted keys, no extra whitespace
  const sorted = {};
  for (const k of Object.keys(graph).sort()) sorted[k] = graph[k];
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Verify concept sheet hash
  const conceptBytes = fs.readFileSync(CONCEPT_SHEET);
  const conceptHash  = crypto.createHash('sha256').update(conceptBytes).digest('hex');
  if (conceptHash !== EXPECTED_CONCEPT_HASH) {
    throw new Error(`T-0209 concept sheet hash mismatch\n  got:  ${conceptHash}\n  want: ${EXPECTED_CONCEPT_HASH}`);
  }
  console.log(`T-0209 concept sheet verified: ${conceptHash}`);

  // 2. Check ComfyUI reachable
  console.log(`Checking ComfyUI at http://${COMFYUI_HOST}:${COMFYUI_PORT}/system_stats ...`);
  const statsRes = await httpGet('/system_stats');
  if (statsRes.status !== 200) throw new Error(`ComfyUI not reachable: ${statsRes.status}`);
  const stats = JSON.parse(statsRes.body.toString());
  const vramFree = stats.devices?.[0]?.vram_free || 0;
  console.log(`  ComfyUI OK, vram_free=${(vramFree / 1e9).toFixed(1)}GB`);

  // 3. Upload concept sheet to ComfyUI
  console.log('Uploading concept sheet to ComfyUI ...');
  const uploadResult = await uploadImage(conceptBytes, 'player_character_concept_sheet_v1.png');
  const uploadedName = uploadResult.name;
  console.log(`  uploaded as: ${uploadedName}`);

  // 4. Build and submit workflow
  const workflow = buildWorkflow(uploadedName);
  const wfHash   = computeWorkflowHash(workflow);
  console.log(`Submitting workflow (hash ${wfHash.slice(0,12)}...) ...`);
  const promptId = await submitPrompt(workflow);
  console.log(`  prompt_id: ${promptId}`);

  // 5. Poll for completion (SDXL 30 steps at 1152x1152 takes ~60-120s)
  console.log('Waiting for ComfyUI to finish generation (up to 5 min) ...');
  const jobResult = await waitForCompletion(promptId, 300000, 5000);
  console.log(`  job completed`);

  // 6. Fetch the 144x144 output PNG (area-downscaled by ComfyUI)
  console.log('Fetching 144x144 output from ComfyUI ...');
  const rawPngBytes = await fetchOutput(jobResult);
  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.writeFileSync(RAW_OUT, rawPngBytes);
  console.log(`  raw output saved: ${RAW_OUT} (${rawPngBytes.length} bytes)`);

  // 7. Decode raw PNG → RGB pixel array
  console.log('Decoding PNG ...');
  const { width, height, pixels: rgbPixels } = parsePng(rawPngBytes);
  if (width !== TARGET_SIZE || height !== TARGET_SIZE) {
    throw new Error(`unexpected raw PNG size: ${width}x${height} (expected ${TARGET_SIZE}x${TARGET_SIZE})`);
  }
  console.log(`  decoded: ${width}x${height} RGB`);

  // 8. Palette (sRGB nearest-color) quantization
  const palette = loadPalette();
  console.log(`Quantizing to home palette (${palette.length} colours, sRGB nearest-colour) ...`);
  let indices = quantize(width, height, rgbPixels, palette);

  // 9. Orphan pixel cleanup (matches descend.py _cleanup_orphans)
  console.log('Cleaning up orphan pixels ...');
  indices = cleanupOrphans(width, height, indices, 0);

  // 10. Encode as indexed PNG (mode-P, home palette as PLTE)
  console.log('Encoding indexed PNG ...');
  const pngBytes = encodeIndexedPng(width, height, indices, palette);
  fs.mkdirSync(path.dirname(FINAL_OUT), { recursive: true });
  fs.writeFileSync(FINAL_OUT, pngBytes);
  console.log(`  wrote: ${FINAL_OUT} (${pngBytes.length} bytes)`);

  // 11. Write provenance JSON
  console.log('Writing provenance ...');
  const prov = writeProvenance(promptId, wfHash);

  // 12. Append to ASSET_PROVENANCE.md
  appendAssetProvenance(prov);

  console.log('\nDone. Run gate tests:');
  console.log('  cd assets/src/character');
  console.log('  .venv/bin/pytest tests/test_player_idle_v2_gate.py -v');
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
