#!/usr/bin/env node
// T-0361: build the six committed motion-gate negative-control fixtures
// under tools/asset-gate/tests/fixtures/negative_controls/.
//
// Written in Node, not Python, because the Agent Runner session that
// authored this card (the `infra` persona) has no Python execution grant at
// all (Bash is scoped to node/npm/npx vitest/git only) -- confirmed live,
// not assumed: `python3 -m venv` and `python3 -c "import PIL"` both required
// approval that no human was present to grant. `tools/asset-gate` is a
// Python package everywhere else (see `.claude/rules/python.md`); this
// script exists ONLY because that tool gap made the real generator
// unusable this session. It deterministically reimplements the same rig
// math (`assets/src/character/pose_rig_walk_T0259.py`'s gait model, copied
// as inert reference data the same way
// `tests/test_character_gate_pixel_recompute_T0357.py`'s own
// `_BASE_POSE_NORM` already treats it) and *attempts* the same
// capsule-silhouette geometry `asset_gate.art.render_rig_silhouette` draws.
//
// **Known divergence (found by VALIDATION, 2026-09-17): this script's own
// pose-fidelity/part-identity numbers are NOT the real gate's numbers.**
// `render_rig_silhouette` draws each limb with PIL's `ImageDraw.line(...,
// width=line_width)` plus a round end-cap ellipse -- PIL's own thick-line
// rasterizer, which for a non-axis-aligned segment is not the same
// raster as this script's `pointSegDist(...) <= radius` per-pixel capsule
// test, even though both are "a thick line with round caps" in concept.
// `identity_stability_range` does not depend on the rendered capsule at all
// (it compares each control's own actual frames to each other, never to a
// predicted silhouette), so it happens to match the real gate exactly;
// `pose_fidelity_range`/`part_identity_range` both measure actual-vs-
// predicted-silhouette overlap and so inherit the rasterization mismatch.
// **This script's own `pose_fidelity_range`/`part_identity_range` output is
// therefore reference-only, not authoritative** -- do not transcribe it into
// docs or tests without cross-checking against a live `sweep_character_gate`
// run first; see docs/character-motion-negative-controls-T0361.md's
// "Tooling note" and `test_control_metric_ranges_match_the_committed_
// calibration_table` in test_character_negative_controls_T0361.py, which
// pin the real, Python-gate-measured numbers instead. Re-running this
// script always produces byte-identical fixture output (no Math.random, no
// Date.now) -- that determinism, not the calibration numbers it also
// prints, is what this script is relied on for.
//
// Usage: node generate_negative_controls_T0361.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal indexed-PNG encoder (2-colour palette: index 0 = background,
// index 1 = foreground -- the same convention every asset_gate.art check
// uses via its `background_index` parameter).
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

function encodeIndexedPng(width, height, indexArray) {
  // indexArray: Uint8Array of length width*height, row-major, values 0/1.
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: palette
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const plte = Buffer.from([0, 0, 0, 255, 255, 255]); // index 0 black, 1 white

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
// Gait model -- a JS reimplementation of
// assets/src/character/pose_rig_walk_T0259.py's walk_keypoints_for_frame,
// using the same base pose, amplitude constants and joint numbering. Not a
// byte-identical port (the double hip-bob accumulation on shoulder joints
// in the original is an artifact of its own statement order, harmless
// either way here): nothing downstream compares this script's output
// against a live re-run of pose_rig_walk_T0259.py -- the committed rig
// keypoints JSON files below ARE the recorded rig evidence, and the
// character-gate recompute path (asset_gate.character) only ever reads
// those files back, never re-derives them from the generator script. What
// matters is that this function is deterministic and internally consistent
// between the "reference" (correct) keypoints and the "actual" pixels each
// control renders from them.
// ---------------------------------------------------------------------------

// Mirrors gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM (18-joint COCO
// standing-idle base pose) -- same inert copy
// tests/test_character_gate_pixel_recompute_T0357.py's `_BASE_POSE_NORM` uses.
const BASE_POSE_NORM = {
  0: [0.5, 0.095],
  1: [0.5, 0.21],
  2: [0.417, 0.225],
  3: [0.402, 0.39],
  4: [0.387, 0.54],
  5: [0.583, 0.225],
  6: [0.598, 0.39],
  7: [0.613, 0.54],
  8: [0.446, 0.57],
  9: [0.44, 0.75],
  10: [0.435, 0.93],
  11: [0.554, 0.57],
  12: [0.56, 0.75],
  13: [0.565, 0.93],
  14: [0.476, 0.075],
  15: [0.524, 0.075],
  16: [0.452, 0.09],
  17: [0.548, 0.09],
};

const STRIDE_EXTENT_NORM = 0.145;
const KNEE_LIFT_NORM = 0.085;
const ARM_SWING_EXTENT_NORM = 0.09;
const HIP_BOB_NORM = 0.02;
const BODY_BOB_JOINTS = [0, 1, 2, 5, 14, 15, 16, 17];
const R_SHOULDER = 2,
  R_ELBOW = 3,
  R_WRIST = 4,
  L_SHOULDER = 5,
  L_ELBOW = 6,
  L_WRIST = 7;
const R_HIP = 8,
  R_KNEE = 9,
  R_ANKLE = 10,
  L_HIP = 11,
  L_KNEE = 12,
  L_ANKLE = 13;

function legSwing(t) {
  return Math.sin(2 * Math.PI * t) + 0.25 * Math.sin(4 * Math.PI * t);
}
function kneeLift(t) {
  return Math.max(0, legSwing(t));
}
function hipBob(t) {
  return -Math.abs(Math.cos(2 * Math.PI * t)) * HIP_BOB_NORM;
}

function walkKeypointsForFrame(frameIndex, frameCount) {
  const t = (((frameIndex % frameCount) + frameCount) % frameCount) + 0.5;
  const tt = t / frameCount;
  const points = {};
  for (const k of Object.keys(BASE_POSE_NORM)) points[k] = BASE_POSE_NORM[k].slice();

  const rightPhase = legSwing(tt);
  const leftPhase = legSwing(tt + 0.5);
  const rightLift = kneeLift(tt);
  const leftLift = kneeLift(tt + 0.5);
  const bob = hipBob(tt);

  for (const [hip, knee, ankle, phase, lift] of [
    [R_HIP, R_KNEE, R_ANKLE, rightPhase, rightLift],
    [L_HIP, L_KNEE, L_ANKLE, leftPhase, leftLift],
  ]) {
    points[hip][1] += bob;
    points[knee][0] += phase * STRIDE_EXTENT_NORM * 0.5;
    points[knee][1] += bob - lift * KNEE_LIFT_NORM * 0.5;
    points[ankle][0] += phase * STRIDE_EXTENT_NORM;
    points[ankle][1] += bob - lift * KNEE_LIFT_NORM;
  }

  for (const [shoulder, elbow, wrist, phase] of [
    [R_SHOULDER, R_ELBOW, R_WRIST, leftPhase],
    [L_SHOULDER, L_ELBOW, L_WRIST, rightPhase],
  ]) {
    points[shoulder][1] += bob;
    points[elbow][0] += phase * ARM_SWING_EXTENT_NORM * 0.5;
    points[elbow][1] += bob;
    points[wrist][0] += phase * ARM_SWING_EXTENT_NORM;
    points[wrist][1] += bob;
  }

  for (const j of BODY_BOB_JOINTS) points[j][1] += bob;

  return points;
}

// RIG_LIMB_JOINT_PAIRS, copied verbatim from asset_gate.character.
const RIG_LIMB_JOINT_PAIRS = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
];

const HEAD_JOINT_INDICES = [0, 14, 15, 16, 17];
const NEAR_LIMB_JOINT_INDICES = [2, 3, 4, 8, 9, 10];
const FAR_LIMB_JOINT_INDICES = [5, 6, 7, 11, 12, 13];
const TORSO_ANCHOR_JOINTS = [2, 5, 8, 11];

const CELL_PX = 48;
const COLS = 4;
const ROWS = 2;
const FRAME_COUNT = COLS * ROWS;
const CAPSULE_RADIUS_PX = 2.5;

function pointSegDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0,
    dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x0 + t * dx,
    cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function limbsPx(points, cellPx, pairs) {
  return pairs.map(([a, b]) => [
    [points[a][0] * cellPx, points[a][1] * cellPx],
    [points[b][0] * cellPx, points[b][1] * cellPx],
  ]);
}

function renderCapsuleSilhouette(cellPx, limbs, radius) {
  const arr = new Uint8Array(cellPx * cellPx);
  for (let y = 0; y < cellPx; y++) {
    for (let x = 0; x < cellPx; x++) {
      const cx = x + 0.5,
        cy = y + 0.5;
      let fg = 0;
      for (const [[x0, y0], [x1, y1]] of limbs) {
        if (pointSegDist(cx, cy, x0, y0, x1, y1) <= radius) {
          fg = 1;
          break;
        }
      }
      arr[y * cellPx + x] = fg;
    }
  }
  return arr;
}

function jointGroupBoxPx(points, indices, cellPx, pad = 3) {
  const xs = indices.map((j) => points[j][0] * cellPx);
  const ys = indices.map((j) => points[j][1] * cellPx);
  const x0 = Math.max(0, Math.round(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.round(Math.min(...ys)) - pad);
  const x1 = Math.min(cellPx, Math.round(Math.max(...xs)) + pad);
  const y1 = Math.min(cellPx, Math.round(Math.max(...ys)) + pad);
  return [x0, y0, x1, y1];
}

function torsoRegionPx(cellPx) {
  return jointGroupBoxPx(
    { 2: BASE_POSE_NORM[2], 5: BASE_POSE_NORM[5], 8: BASE_POSE_NORM[8], 11: BASE_POSE_NORM[11] },
    TORSO_ANCHOR_JOINTS,
    cellPx,
    0
  );
}

function namedRegionBoxes(points, cellPx) {
  return {
    head: jointGroupBoxPx(points, HEAD_JOINT_INDICES, cellPx),
    torso: torsoRegionPx(cellPx),
    near_limb: jointGroupBoxPx(points, NEAR_LIMB_JOINT_INDICES, cellPx),
    far_limb: jointGroupBoxPx(points, FAR_LIMB_JOINT_INDICES, cellPx),
  };
}

// ---------------------------------------------------------------------------
// Calibration arithmetic -- mirrors asset_gate.art exactly (IoU,
// palette-histogram total-variation distance) so the numbers this script
// prints are the same numbers the real Python gate would compute.
// ---------------------------------------------------------------------------

function iou(actual, predicted, cellPx) {
  let inter = 0,
    union = 0;
  for (let i = 0; i < cellPx * cellPx; i++) {
    const a = actual[i] !== 0,
      p = predicted[i] !== 0;
    if (a && p) inter++;
    if (a || p) union++;
  }
  return union ? inter / union : 1.0;
}

function histogramDistance(frame, region, cellPx) {
  const [x0, y0, x1, y1] = region;
  let fg = 0,
    total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (frame[y * cellPx + x] !== 0) fg++;
    }
  }
  return { fg, total };
}

function tvDistance(frameA, frameB, region, cellPx) {
  const a = histogramDistance(frameA, region, cellPx);
  const b = histogramDistance(frameB, region, cellPx);
  const pA = a.fg / a.total,
    pB = b.fg / b.total;
  return 0.5 * (Math.abs(pA - pB) + Math.abs(1 - pA - (1 - pB)));
}

// ---------------------------------------------------------------------------
// Build the reference (correct, unperturbed) sequence.
// ---------------------------------------------------------------------------

const referenceKeypoints = [];
const referenceSilhouette = [];
for (let i = 0; i < FRAME_COUNT; i++) {
  const points = walkKeypointsForFrame(i, FRAME_COUNT);
  referenceKeypoints.push(points);
  referenceSilhouette.push(
    renderCapsuleSilhouette(CELL_PX, limbsPx(points, CELL_PX, RIG_LIMB_JOINT_PAIRS), CAPSULE_RADIUS_PX)
  );
}

// ---------------------------------------------------------------------------
// The six named negative controls. Each returns { actualFrames } -- an
// array of FRAME_COUNT Uint8Array silhouettes (the "actual" rendered
// pixels). The committed rig-keypoints files always record
// `referenceKeypoints` (what the rig SHOULD have commanded) regardless of
// control, so the recompute path's predicted silhouette is always the
// correct one -- the control is entirely in how `actualFrames` deviates
// from it.
// ---------------------------------------------------------------------------

const CONTROLS = {};

// 1. frozen_frame: every cell repeats frame 0's render -- no motion at all.
CONTROLS.frozen_frame = {
  description:
    'Every one of the 8 cells renders frame 0s commanded pose, regardless of ' +
    'index -- the sheet never moves. Rig evidence still records the correct, ' +
    'varying per-frame keypoints, so the recompute sees frames 1-7 badly ' +
    'mismatched against what they were supposed to show.',
  actualFrames: Array.from({ length: FRAME_COUNT }, () => referenceSilhouette[0]),
};

// 2. wrong_phase: cell i renders the pose for a different frame index.
const PHASE_SHIFT = 3;
CONTROLS.wrong_phase = {
  description:
    `Cell i renders frame (i + ${PHASE_SHIFT}) mod 8's commanded pose instead ` +
    'of frame i own -- a constant timing offset, as if the sheet were ' +
    'exported one-and-a-half beats early. Rig evidence records the correct, ' +
    'unshifted per-frame keypoints.',
  actualFrames: Array.from(
    { length: FRAME_COUNT },
    (_, i) => referenceSilhouette[(i + PHASE_SHIFT) % FRAME_COUNT]
  ),
};

// 3. swapped_limbs: horizontal mirror of the correct render. Because the
// standing base pose (and therefore every rig-commanded frame) is bilaterally
// symmetric in x about the cell centre, a horizontal pixel-mirror is exactly
// equivalent to a frame where the R/L phase-driving functions were crossed
// -- the "layer swap" bug this control names, expressed as an exact pixel
// transform instead of an approximation. (An earlier draft of this control
// tried swapping just the near_limb/far_limb region CONTENTS directly, but
// those two regions -- each spanning shoulder-to-ankle on their own side --
// overlap the fixed torso box at the shoulder line, so that version also
// corrupted torso pixels; the clean, isolated proof that the swap is
// invisible to a whole-frame/fixed-torso histogram lives in
// test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses in
// test_art.py, using boxes chosen not to overlap.)
CONTROLS.swapped_limbs = {
  description:
    'Each cell is the horizontal mirror of the correctly-rendered frame -- ' +
    'equivalent to crossing which side phase drives which leg/arm. Rig ' +
    'evidence records the correct, unmirrored per-frame keypoints. The torso ' +
    'box sits at the cell horizontal centre, so mirroring maps it onto ' +
    'itself: the fixed-torso identity-stability check (measured below at ' +
    'exactly 0.0) cannot see this swap.',
  actualFrames: Array.from({ length: FRAME_COUNT }, (_, i) => {
    const src = referenceSilhouette[i];
    const out = new Uint8Array(CELL_PX * CELL_PX);
    for (let y = 0; y < CELL_PX; y++) {
      for (let x = 0; x < CELL_PX; x++) {
        out[y * CELL_PX + x] = src[y * CELL_PX + (CELL_PX - 1 - x)];
      }
    }
    return out;
  }),
};

// 4. detached_joint: the WHOLE far-side limb layer (left arm: shoulder(5)->
// elbow(6)->wrist(7); left leg: hip(11)->knee(12)->ankle(13)) is never drawn
// attached to the body -- all four segments reappear, unchanged in shape,
// floating well away from where they should extend from -- a limb LAYER
// detached from its own chain, not merely nudged. (The hip(11) itself stays
// put -- only the leg BELOW it detaches -- so this is distinct from
// `swapped_limbs`, which mirrors the whole frame including the torso/hip
// line.)
CONTROLS.detached_joint = {
  description:
    'The whole far-side limb layer (left arm: shoulder 5 -> elbow 6 -> ' +
    'wrist 7; left leg: hip 11 -> knee 12 -> ankle 13) is never drawn ' +
    'attached to the body -- all four segments reappear, unchanged in ' +
    'shape, 20px right / 14px down of their commanded positions, connected ' +
    'to nothing and to each other only via the same offset. Rig evidence ' +
    'records the correct, fully-connected per-frame keypoints.',
  actualFrames: Array.from({ length: FRAME_COUNT }, (_, i) => {
    const points = referenceKeypoints[i];
    const detachedPairs = [
      [5, 6],
      [6, 7],
      [11, 12],
      [12, 13],
    ];
    const pairs = RIG_LIMB_JOINT_PAIRS.filter(
      ([a, b]) => !detachedPairs.some(([da, db]) => da === a && db === b)
    );
    const limbs = limbsPx(points, CELL_PX, pairs);
    const OFFSET_X = 20,
      OFFSET_Y = 14;
    for (const [a, b] of detachedPairs) {
      limbs.push([
        [points[a][0] * CELL_PX + OFFSET_X, points[a][1] * CELL_PX + OFFSET_Y],
        [points[b][0] * CELL_PX + OFFSET_X, points[b][1] * CELL_PX + OFFSET_Y],
      ]);
    }
    return renderCapsuleSilhouette(CELL_PX, limbs, CAPSULE_RADIUS_PX);
  }),
};

// 5. foot_sliding: the right hip/knee/ankle are pinned to a fixed position
// (frame 0's commanded position, shifted an extra 10px further back) for
// EVERY frame instead of tracking the gait -- the foot never leaves that
// spot while the rest of the body walks normally, exactly the "planted foot
// doesn't track the body" bug the name describes.
CONTROLS.foot_sliding = {
  description:
    'The right hip/knee/ankle (joints 8/9/10) are pinned to a single fixed ' +
    'position (frame 0s commanded position, shifted an extra 10px further ' +
    'back in x) on every frame -- the right foot never leaves that spot ' +
    'while the left leg, arms, torso and head all follow the normal gait. ' +
    'Rig evidence records the correct, fully-animated per-frame keypoints ' +
    '(right leg included).',
  actualFrames: Array.from({ length: FRAME_COUNT }, (_, i) => {
    const points = {};
    for (const k of Object.keys(referenceKeypoints[i])) points[k] = referenceKeypoints[i][k].slice();
    for (const j of [8, 9, 10]) {
      const [x, y] = referenceKeypoints[0][j];
      points[j] = [x - 10 / CELL_PX, y];
    }
    return renderCapsuleSilhouette(CELL_PX, limbsPx(points, CELL_PX, RIG_LIMB_JOINT_PAIRS), CAPSULE_RADIUS_PX);
  }),
};

// 6. loop_seam_jump: every frame renders correctly except the last, which
// pops the whole body +8px in x / +5px in y -- a discontinuity concentrated
// exactly at the seam the cycle must match itself back up across (7 -> 0).
CONTROLS.loop_seam_jump = {
  description:
    'Frames 0-6 render their own commanded pose correctly. Frame 7 shifts ' +
    'the whole rendered body +8px in x / +5px in y -- an abrupt pop ' +
    'concentrated exactly at the pair (7 -> 0) the loop must match itself ' +
    'back up across. Rig evidence records the correct, unshifted keypoints ' +
    'for every frame including 7.',
  actualFrames: Array.from({ length: FRAME_COUNT }, (_, i) => {
    if (i !== FRAME_COUNT - 1) return referenceSilhouette[i];
    const points = {};
    for (const k of Object.keys(referenceKeypoints[i])) {
      const [x, y] = referenceKeypoints[i][k];
      points[k] = [x + 8 / CELL_PX, y + 5 / CELL_PX];
    }
    return renderCapsuleSilhouette(CELL_PX, limbsPx(points, CELL_PX, RIG_LIMB_JOINT_PAIRS), CAPSULE_RADIUS_PX);
  }),
};

// ---------------------------------------------------------------------------
// Write fixtures + compute the calibration numbers for docs/character-motion
// -negative-controls-T0361.md.
// ---------------------------------------------------------------------------

const FIXTURES_ROOT = path.join(__dirname, 'negative_controls');
const calibration = {};

for (const [name, control] of Object.entries(CONTROLS)) {
  const controlDir = path.join(FIXTURES_ROOT, name, 'character');
  const rigDir = path.join(controlDir, 'rig');
  fs.mkdirSync(rigDir, { recursive: true });

  // Assemble the 4x2 sheet from actualFrames, row-major.
  const sheetArr = new Uint8Array(CELL_PX * COLS * (CELL_PX * ROWS));
  const sheetW = CELL_PX * COLS;
  for (let idx = 0; idx < FRAME_COUNT; idx++) {
    const row = Math.floor(idx / COLS);
    const col = idx % COLS;
    const frame = control.actualFrames[idx];
    for (let y = 0; y < CELL_PX; y++) {
      for (let x = 0; x < CELL_PX; x++) {
        sheetArr[(row * CELL_PX + y) * sheetW + (col * CELL_PX + x)] = frame[y * CELL_PX + x];
      }
    }
  }
  const png = encodeIndexedPng(sheetW, CELL_PX * ROWS, sheetArr);
  fs.writeFileSync(path.join(controlDir, 'sheet.png'), png);

  const frameGeneration = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const relKeypoints = `character/rig/frame_${i}.json`;
    const payload = Object.keys(referenceKeypoints[i])
      .map(Number)
      .sort((a, b) => a - b)
      .map((j) => ({ joint: j, x: referenceKeypoints[i][j][0], y: referenceKeypoints[i][j][1] }));
    fs.writeFileSync(path.join(rigDir, `frame_${i}.json`), JSON.stringify(payload));
    frameGeneration.push({ frame_index: i, pose_keypoints_file: relKeypoints });
  }

  const provenance = {
    model: 'synthetic-rig-capsule/v1',
    seed: 0,
    motion_class: 'locomotion',
    negative_control: name,
    negative_control_description: control.description,
    layout: { cols: COLS, rows: ROWS, cell_px: CELL_PX },
    frame_generation: frameGeneration,
    frame_delta_range: [0.05, 0.09],
    arm_c_benchmark: [0.072, 0.112],
    beats_arm_c_benchmark: true,
  };
  fs.writeFileSync(
    path.join(controlDir, 'sheet.provenance.json'),
    JSON.stringify(provenance, null, 2)
  );

  // ---- calibration numbers (mirrors asset_gate.character/art exactly) ----
  const poseIous = control.actualFrames.map((frame, i) => iou(frame, referenceSilhouette[i], CELL_PX));
  const torsoRegion = torsoRegionPx(CELL_PX);
  const identityDistances = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const j = (i + 1) % FRAME_COUNT;
    identityDistances.push(tvDistance(control.actualFrames[i], control.actualFrames[j], torsoRegion, CELL_PX));
  }
  const partWorstPerFrame = [];
  const partWorstRegionPerFrame = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const regions = namedRegionBoxes(referenceKeypoints[i], CELL_PX);
    let worst = -1,
      worstName = null;
    for (const [rname, region] of Object.entries(regions)) {
      const d = tvDistance(control.actualFrames[i], referenceSilhouette[i], region, CELL_PX);
      if (d > worst) {
        worst = d;
        worstName = rname;
      }
    }
    partWorstPerFrame.push(worst);
    partWorstRegionPerFrame.push(worstName);
  }

  calibration[name] = {
    pose_fidelity_range: [Math.min(...poseIous), Math.max(...poseIous)],
    identity_stability_range: [Math.min(...identityDistances), Math.max(...identityDistances)],
    part_identity_range: [Math.min(...partWorstPerFrame), Math.max(...partWorstPerFrame)],
    part_identity_worst_region: partWorstRegionPerFrame[partWorstPerFrame.indexOf(Math.max(...partWorstPerFrame))],
  };
}

// Reference (unperturbed) sequence, for sanity -- NOT a committed control.
{
  const poseIous = referenceSilhouette.map((frame, i) => iou(frame, referenceSilhouette[i], CELL_PX));
  const torsoRegion = torsoRegionPx(CELL_PX);
  const identityDistances = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const j = (i + 1) % FRAME_COUNT;
    identityDistances.push(tvDistance(referenceSilhouette[i], referenceSilhouette[j], torsoRegion, CELL_PX));
  }
  const partWorstPerFrame = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const regions = namedRegionBoxes(referenceKeypoints[i], CELL_PX);
    let worst = -1;
    for (const region of Object.values(regions)) {
      const d = tvDistance(referenceSilhouette[i], referenceSilhouette[i], region, CELL_PX);
      if (d > worst) worst = d;
    }
    partWorstPerFrame.push(worst);
  }
  calibration._reference_unperturbed = {
    pose_fidelity_range: [Math.min(...poseIous), Math.max(...poseIous)],
    identity_stability_range: [Math.min(...identityDistances), Math.max(...identityDistances)],
    part_identity_range: [Math.min(...partWorstPerFrame), Math.max(...partWorstPerFrame)],
  };
}

console.log(JSON.stringify(calibration, null, 2));
