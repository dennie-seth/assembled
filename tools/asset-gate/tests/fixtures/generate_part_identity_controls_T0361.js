#!/usr/bin/env node
// T-0361 (2026-09-17 Codex fix): build the two committed part-identity
// proof fixtures under tools/asset-gate/tests/fixtures/positive_controls/
// and tools/asset-gate/tests/fixtures/part_identity_negative_controls/
// swapped_limb_colors/ -- a directory deliberately separate from
// negative_controls/ (the six T-0361 motion-gate controls), whose own
// suite pins EXACT pose-fidelity/identity-stability numbers per fixture
// (test_control_metric_ranges_match_the_committed_calibration_table) that
// only a real PIL recompute can produce; this fixture's own tests assert
// character_part_identity specifically and do not depend on those numbers.
//
// Written in Node for the same reason generate_negative_controls_T0361.js
// is (see that file's own header): the `infra` persona's Bash grant has no
// Python at all in this session.
//
// Purpose: Codex's review found character_part_identity's ORIGINAL design
// compared a frame's real pixels against a rendered rig silhouette, which
// always uses ONE fixed foreground palette index -- so the check measured
// agreement with that index, not identity (the same exact silhouette
// passed recoloured at palette index 1 and failed at index 2). The fix
// (asset_gate.art.check_region_identity_against_reference,
// asset_gate.character._recompute_part_identity_from_frames) compares each
// frame's own named regions against a REAL reference frame (this sheet's
// own frame 0) instead. These two fixtures prove the fix through the
// PRODUCTION gate (sweep_character_gate / the character-gate CLI), not
// just a unit test of the comparator:
//
//   - positive_controls/multi_color_identity: every frame colours each
//     part (head/torso/near_limb/far_limb) with its OWN distinct palette
//     index, correct motion (the rig-commanded regions really do move
//     frame to frame) -- must PASS character_part_identity.
//   - part_identity_negative_controls/swapped_limb_colors: IDENTICAL geometry (frame 0
//     is byte-identical to the positive fixture's frame 0), but frames 1-7
//     swap which colour near_limb/far_limb use -- the whole-frame palette
//     histogram is exactly preserved (near/far boxes are always the same
//     size, by mirror construction, so swapping which colour each uses
//     exchanges equal-sized populations) while character_part_identity,
//     which compares each frame's OWN near/far region against frame 0's
//     real content for that SAME region, must FAIL.
//
// Both fixtures use bespoke, deliberately disjoint named-region boxes (not
// the real walk gait) so this script does not need to replicate PIL's own
// capsule-line rasterization (a known JS/PIL divergence -- see
// generate_negative_controls_T0361.js's own header) to get
// character_part_identity's box math exactly right: the four regions here
// are flat rectangle fills, not rendered capsules, so their content is
// exactly what asset_gate.character._named_region_boxes_px will
// independently recompute from the SAME committed rig keypoints. Neither
// fixture asserts character_motion_fidelity's own pose-fidelity number
// (which DOES depend on PIL's rig-silhouette rasterization) -- the two
// tests these fixtures feed assert character_part_identity specifically,
// named in the acceptance criteria this card fixes.
//
// Usage: node generate_part_identity_controls_T0361.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal indexed-PNG encoder, palette parameterised (5 colours here vs.
// generate_negative_controls_T0361.js's fixed 2) -- otherwise identical.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeIndexedPng(width, height, indexArray, paletteRgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: palette
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const plte = Buffer.from(paletteRgb.flat());

  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = indexArray[y * width + x];
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Geometry -- CELL_PX=40 (matches test_character_part_identity_T0361.py's
// own CELL_PX), 4x2 grid (8 frames), matching the six negative controls'
// own layout for consistency (not a requirement of the check itself).
// Box math below mirrors asset_gate.character._joint_group_box_px /
// _torso_region_px / _named_region_boxes_px exactly (PART_IDENTITY_REGION_PAD_PX=3,
// TORSO_ANCHOR_POINTS_NORM) so the reference frame's own recomputed boxes
// match what was actually painted here.
// ---------------------------------------------------------------------------

const CELL_PX = 40;
const COLS = 4;
const ROWS = 2;
const FRAME_COUNT = COLS * ROWS;
const PAD = 3;

// TORSO_ANCHOR_POINTS_NORM, copied verbatim from asset_gate.character.
const TORSO_ANCHOR_POINTS_NORM = {
  2: [0.417, 0.225],
  5: [0.583, 0.225],
  8: [0.446, 0.57],
  11: [0.554, 0.57],
};

function torsoBoxPx(cellPx) {
  const xs = Object.values(TORSO_ANCHOR_POINTS_NORM).map((p) => p[0] * cellPx);
  const ys = Object.values(TORSO_ANCHOR_POINTS_NORM).map((p) => p[1] * cellPx);
  return [
    Math.round(Math.min(...xs)),
    Math.round(Math.min(...ys)),
    Math.round(Math.max(...xs)),
    Math.round(Math.max(...ys)),
  ];
}

function jointGroupBoxPx(points, indices, cellPx, pad = PAD) {
  const xs = indices.map((j) => points[j][0] * cellPx);
  const ys = indices.map((j) => points[j][1] * cellPx);
  const x0 = Math.max(0, Math.round(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.round(Math.min(...ys)) - pad);
  const x1 = Math.min(cellPx, Math.round(Math.max(...xs)) + pad);
  const y1 = Math.min(cellPx, Math.round(Math.max(...ys)) + pad);
  return [x0, y0, x1, y1];
}

const HEAD_JOINT_INDICES = [0, 14, 15, 16, 17];
const NEAR_LIMB_JOINT_INDICES = [2, 3, 4, 8, 9, 10];
const FAR_LIMB_JOINT_INDICES = [5, 6, 7, 11, 12, 13];

// Per-frame keypoints (normalised, /CELL_PX). Deliberately NOT the real
// walk gait -- these positions are chosen purely so the four named regions
// (head/torso/near_limb/far_limb) are pairwise disjoint at every frame
// (verified below), so a flat rectangle fill of each region's own box is
// exactly and only that region's content, with no ambiguity from overlap.
// near_limb/far_limb are horizontal mirrors of each other about the cell's
// x=CELL_PX/2 centreline (so their boxes are always the SAME size --
// verified below -- which is what makes the colour swap in
// swapped_limb_colors exactly whole-frame-histogram-preserving) and move
// together in y across frames (real, tracked "motion").
const OFFSETS_PX = [0, 1, 2, 3, 4, 3, 2, 1];

function keypointsForFrame(i) {
  const off = OFFSETS_PX[i];
  const points = {};
  // Head: fixed, well above the fixed torso box.
  points[0] = [20 / CELL_PX, 2 / CELL_PX];
  points[14] = [20 / CELL_PX, 6 / CELL_PX];
  points[15] = [20 / CELL_PX, 2 / CELL_PX];
  points[16] = [20 / CELL_PX, 6 / CELL_PX];
  points[17] = [20 / CELL_PX, 4 / CELL_PX];
  // Joint 1 (neck/spine root) -- unused by any named region, but required
  // by RIG_LIMB_JOINT_PAIRS (character_motion_fidelity's own recompute
  // path, which sweep_character_gate always runs too); any in-bounds value
  // keeps that recompute from raising, its own pose-fidelity NUMBER is not
  // asserted by either test this fixture feeds.
  points[1] = [20 / CELL_PX, 7 / CELL_PX];
  // Near limb: bottom-right cluster.
  points[2] = [27 / CELL_PX, (27 + off) / CELL_PX];
  points[3] = [30 / CELL_PX, (30 + off) / CELL_PX];
  points[4] = [33 / CELL_PX, (33 + off) / CELL_PX];
  points[8] = [27 / CELL_PX, (27 + off) / CELL_PX];
  points[9] = [30 / CELL_PX, (30 + off) / CELL_PX];
  points[10] = [33 / CELL_PX, (33 + off) / CELL_PX];
  // Far limb: bottom-left cluster, exact horizontal mirror of near (about
  // x=20px) at the SAME y -- same box size every frame.
  points[5] = [13 / CELL_PX, (27 + off) / CELL_PX];
  points[6] = [10 / CELL_PX, (30 + off) / CELL_PX];
  points[7] = [7 / CELL_PX, (33 + off) / CELL_PX];
  points[11] = [13 / CELL_PX, (27 + off) / CELL_PX];
  points[12] = [10 / CELL_PX, (30 + off) / CELL_PX];
  points[13] = [7 / CELL_PX, (33 + off) / CELL_PX];
  return points;
}

function namedRegionBoxes(points) {
  return {
    head: jointGroupBoxPx(points, HEAD_JOINT_INDICES, CELL_PX),
    torso: torsoBoxPx(CELL_PX),
    near_limb: jointGroupBoxPx(points, NEAR_LIMB_JOINT_INDICES, CELL_PX),
    far_limb: jointGroupBoxPx(points, FAR_LIMB_JOINT_INDICES, CELL_PX),
  };
}

function boxesOverlap(a, b) {
  const [ax0, ay0, ax1, ay1] = a;
  const [bx0, by0, bx1, by1] = b;
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}

function boxArea([x0, y0, x1, y1]) {
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

// ---- self-check: disjoint regions + equal near/far area every frame ----
for (let i = 0; i < FRAME_COUNT; i++) {
  const boxes = namedRegionBoxes(keypointsForFrame(i));
  const names = Object.keys(boxes);
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      if (boxesOverlap(boxes[names[a]], boxes[names[b]])) {
        throw new Error(
          `frame ${i}: regions ${names[a]} ${JSON.stringify(boxes[names[a]])} and ` +
            `${names[b]} ${JSON.stringify(boxes[names[b]])} overlap`
        );
      }
    }
  }
  const nearArea = boxArea(boxes.near_limb);
  const farArea = boxArea(boxes.far_limb);
  if (nearArea !== farArea) {
    throw new Error(`frame ${i}: near_limb area ${nearArea} != far_limb area ${farArea}`);
  }
}

// ---------------------------------------------------------------------------
// Render: flat rectangle fill per named region (never a capsule/line --
// see this file's own header for why).
// ---------------------------------------------------------------------------

const HEAD_COLOR = 1;
const TORSO_COLOR = 2;
const NEAR_COLOR = 3;
const FAR_COLOR = 4;
const PALETTE_RGB = [
  [0, 0, 0], // 0 background
  [255, 0, 0], // 1 head
  [0, 255, 0], // 2 torso
  [0, 0, 255], // 3 near_limb (canonical colour)
  [255, 255, 0], // 4 far_limb (canonical colour)
];

function fillBox(arr, cellPx, [x0, y0, x1, y1], color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      arr[y * cellPx + x] = color;
    }
  }
}

function renderFrame(points, { nearColor, farColor }) {
  const arr = new Uint8Array(CELL_PX * CELL_PX);
  const boxes = namedRegionBoxes(points);
  fillBox(arr, CELL_PX, boxes.torso, TORSO_COLOR);
  fillBox(arr, CELL_PX, boxes.head, HEAD_COLOR);
  fillBox(arr, CELL_PX, boxes.near_limb, nearColor);
  fillBox(arr, CELL_PX, boxes.far_limb, farColor);
  return arr;
}

function buildSheet(frames) {
  const sheetW = CELL_PX * COLS;
  const sheetArr = new Uint8Array(sheetW * (CELL_PX * ROWS));
  for (let idx = 0; idx < FRAME_COUNT; idx++) {
    const row = Math.floor(idx / COLS);
    const col = idx % COLS;
    const frame = frames[idx];
    for (let y = 0; y < CELL_PX; y++) {
      for (let x = 0; x < CELL_PX; x++) {
        sheetArr[(row * CELL_PX + y) * sheetW + (col * CELL_PX + x)] = frame[y * CELL_PX + x];
      }
    }
  }
  return { sheetArr, sheetW, sheetH: CELL_PX * ROWS };
}

function writeFixture(dir, frames, description, modelTag) {
  const characterDir = path.join(dir, 'character');
  const rigDir = path.join(characterDir, 'rig');
  fs.mkdirSync(rigDir, { recursive: true });

  const { sheetArr, sheetW, sheetH } = buildSheet(frames);
  const png = encodeIndexedPng(sheetW, sheetH, sheetArr, PALETTE_RGB);
  fs.writeFileSync(path.join(characterDir, 'sheet.png'), png);

  const frameGeneration = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const relKeypoints = `character/rig/frame_${i}.json`;
    const points = keypointsForFrame(i);
    const payload = Object.keys(points)
      .map(Number)
      .sort((a, b) => a - b)
      .map((j) => ({ joint: j, x: points[j][0], y: points[j][1] }));
    fs.writeFileSync(path.join(rigDir, `frame_${i}.json`), JSON.stringify(payload));
    frameGeneration.push({ frame_index: i, pose_keypoints_file: relKeypoints });
  }

  const provenance = {
    model: modelTag,
    seed: 0,
    motion_class: 'locomotion',
    negative_control_description: description,
    layout: { cols: COLS, rows: ROWS, cell_px: CELL_PX },
    frame_generation: frameGeneration,
    frame_delta_range: [0.05, 0.09],
    arm_c_benchmark: [0.072, 0.112],
    beats_arm_c_benchmark: true,
  };
  fs.writeFileSync(
    path.join(characterDir, 'sheet.provenance.json'),
    JSON.stringify(provenance, null, 2)
  );
}

// ---------------------------------------------------------------------------
// Fixture 1: positive_controls/multi_color_identity -- every frame coloured
// correctly (near=NEAR_COLOR, far=FAR_COLOR always).
// ---------------------------------------------------------------------------

const positiveFrames = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  positiveFrames.push(
    renderFrame(keypointsForFrame(i), { nearColor: NEAR_COLOR, farColor: FAR_COLOR })
  );
}

const POSITIVE_DIR = path.join(__dirname, 'positive_controls', 'multi_color_identity');
writeFixture(
  POSITIVE_DIR,
  positiveFrames,
  'Every frame colours head/torso/near_limb/far_limb with its own distinct ' +
    'palette index (1/2/3/4) at that frame\'s own rig-commanded region -- ' +
    'legitimately distinct per-part appearance, correct motion (regions ' +
    'move with the rig every frame), no defect. Positive control for ' +
    'character_part_identity (2026-09-17 Codex fix) -- lives outside ' +
    'negative_controls/ deliberately.',
  'synthetic-part-identity-rig/v1'
);

// ---------------------------------------------------------------------------
// Fixture 2: part_identity_negative_controls/swapped_limb_colors -- frame 0 identical to
// the positive fixture's frame 0; frames 1-7 swap which colour near_limb
// and far_limb use. near_limb/far_limb boxes are always equal-area (mirror
// construction, self-checked above), so this swap exactly preserves the
// whole-frame palette histogram for every frame.
// ---------------------------------------------------------------------------

const swapFrames = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  const colors = i === 0 ? { nearColor: NEAR_COLOR, farColor: FAR_COLOR } : { nearColor: FAR_COLOR, farColor: NEAR_COLOR };
  swapFrames.push(renderFrame(keypointsForFrame(i), colors));
}

// Sanity: frame 0 must be byte-identical between the two fixtures (the
// anchor-frame reference is only a meaningful proof if the defect is NOT
// already present in frame 0 itself -- see
// test_swap_present_uniformly_in_every_frame_is_invisible_to_the_anchor_reference).
for (let i = 0; i < positiveFrames[0].length; i++) {
  if (positiveFrames[0][i] !== swapFrames[0][i]) {
    throw new Error('frame 0 must be identical between the positive and swap fixtures');
  }
}

// Sanity: whole-frame (whole-sheet) histogram preserved exactly, frame by
// frame, between the two fixtures.
for (let i = 0; i < FRAME_COUNT; i++) {
  const histOf = (arr) => {
    const h = {};
    for (const v of arr) h[v] = (h[v] || 0) + 1;
    return h;
  };
  const a = JSON.stringify(histOf(positiveFrames[i]));
  const b = JSON.stringify(histOf(swapFrames[i]));
  if (a !== b) {
    throw new Error(`frame ${i}: whole-frame histogram NOT preserved by the swap (${a} vs ${b})`);
  }
}

const SWAP_DIR = path.join(__dirname, 'part_identity_negative_controls', 'swapped_limb_colors');
writeFixture(
  SWAP_DIR,
  swapFrames,
  'Frame 0 is byte-identical to positive_controls/multi_color_identity\'s ' +
    'own frame 0 (correct: near_limb=index 3, far_limb=index 4). Frames 1-7 ' +
    'swap which colour near_limb/far_limb use (near_limb=4, far_limb=3) -- ' +
    'geometry/motion is unperturbed (matches the correct rig keypoints ' +
    'exactly, same as the positive fixture), so pose-fidelity IoU is ' +
    'unaffected by the swap; near_limb/far_limb boxes are always equal-area ' +
    '(mirror construction), so the swap exactly preserves the whole-frame ' +
    'palette histogram every frame. Rig evidence records the correct, ' +
    'unswapped per-frame keypoints. Caught by character_part_identity, ' +
    'which compares each frame against frame 0\'s own real per-part pixels.',
  'synthetic-part-identity-rig/v1'
);

console.log('wrote', POSITIVE_DIR);
console.log('wrote', SWAP_DIR);
