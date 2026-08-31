#!/usr/bin/env python3
"""Chained img2img idle sheet generation (T-0250, HANDOFF §24-c).

Round 2 of the T-0227 character-pipeline bake-off continues the generative
path (Arm A/B) per @DennieSeth's authorship override (see
BAKEOFF_DECISION_T0231.md). §24-c's hypothesis: instead of asking the model
to independently re-derive the same character for every frame (§24-b/T-0249,
one fresh 384x384 KSampler call per frame conditioned only on that frame's
skeleton), **chain the frames** -- frame 1 is generated fresh; frame n is an
img2img pass from frame n-1's own decoded output at low denoise, with the
next pose applied. Each frame then starts from a figure that is already
correct, so identity is inherited rather than re-invented. That was the
original hypothesis; see the 2026-08-30 human-review revision below for
what actually ships.

This composes directly on top of §24-b, not a rewrite of it:
`build_chained_graph` calls `gen_pose_authority_idle_T0249.build_graph`
unchanged and patches only two things -- the latent source and denoise
(1.0 -> the swept value). Frame 0 uses `gen_pose_authority_idle_T0249.build_graph`
directly, unpatched. As shipped (2026-08-30 human-review fix, see below),
the latent source is EmptyLatentImage -> VAEEncode of **frame 0's own**
decoded output for every subsequent frame (a fixed anchor), not the
immediately preceding frame -- chaining from the predecessor let each
frame's own background speckle feed into the next frame's init image,
compounding across the sheet.

Two honest limits, inherited from §24-b and unchanged here:
  1. A pose skeleton is strong conditioning, not absolute control.
  2. This does not independently address costume drift -- that is §24-a's
     job (player_identity_v2, T-0248). Runs against v2, never v1, so §24-a's
     contribution is not masked.

A third limit specific to chaining: too low a denoise and the img2img pass
barely moves off its init image, so the authored pose stops reading as
motion; too high and drift returns, the same failure mode §24-b's per-frame
independent sampling already showed. `--write-sweep-report` measures this
band directly from a set of already-run attempts' frame-delta ranges.

Usage (from the repo root, against the WSL2->Windows ComfyUI host, after
player_identity_v2.safetensors -- T-0248 -- is loadable by ComfyUI's
LoraLoader):
    python3 assets/src/character/gen_chained_idle_T0250.py \
        --attempt 1 --seed 31416 --denoise 0.30
    python3 assets/src/character/gen_chained_idle_T0250.py \
        --promote-attempt 1 --denoise-justification "..."
    python3 assets/src/character/gen_chained_idle_T0250.py --write-sweep-report 1,2,3,4,5

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/chained_idle/attempt_<N>/frame_<i>_pose_skeleton_384.png  (x9)
    assets/out/chained_idle/attempt_<N>/frame_<i>_keypoints.json         (x9)
    assets/out/chained_idle/attempt_<N>/frame_<i>_main_384.png           (x9)
    assets/out/chained_idle/attempt_<N>/sheet_144_indexed.png
    assets/out/chained_idle/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_CHAINED_ATTEMPT_LOG_T0250.md (appended)

Promotion (only for the chosen attempt) re-homes that attempt's 9 per-frame
conditioning inputs from the gitignored assets/out/ into the committed
assets/src/character/pose_rig_idle_frame_evidence_T0250/ directory, since the
promoted provenance's frame_generation references must resolve on a fresh
clone.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
# comfy-client is not a declared dependency of this package's pyproject.toml
# (char-gen only lists pillow/numpy) -- same informal sys.path convention
# already used for asset-gate above, not a formal pip dependency, per
# gen_idle_v2_diffusers.py's existing precedent. CHR-1's shared
# apply_arm_c_benchmark_fields helper (T-0258) lives in
# comfy_client.provenance_sidecar, the established home for this pipeline's
# other shared provenance surface.
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused directly -- checkpoint/ControlNet identifiers, HTTP client helpers,
# the §3.1 descent chain, the single-figure prompt/graph and every node id
# are unchanged; §24-c only adds a second graph builder (build_chained_graph
# below) that patches build_graph's latent source for frames 1-8.
import gen_pose_authority_idle_T0249 as pose_authority  # noqa: E402
import pose_rig_T0249  # noqa: E402
from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402
from comfy_client.provenance_sidecar import apply_arm_c_benchmark_fields  # noqa: E402
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    _srgb_to_oklab,
    cleanup_orphans,
    enforce_cell_margin,
    fetch_save_image,
    quantize_to_palette,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

IDENTITY_LORA_NAME = pose_authority.IDENTITY_LORA_NAME
IDENTITY_LORA_PATH = pose_authority.IDENTITY_LORA_PATH
IDENTITY_LORA_PROVENANCE_PATH = pose_authority.IDENTITY_LORA_PROVENANCE_PATH

CONCEPT_SHEET_PATH = pose_authority.CONCEPT_SHEET_PATH
EXPECTED_CONCEPT_HASH = pose_authority.EXPECTED_CONCEPT_HASH
PALETTE_PATH = pose_authority.PALETTE_PATH
RIG_PATH = pose_authority.RIG_PATH

FINAL_CELL_PX = pose_authority.FINAL_CELL_PX
GEN_PX = pose_authority.GEN_PX
SHEET_PX = pose_authority.SHEET_PX
FRAME_COUNT = pose_authority.FRAME_COUNT
FRAME_ORDER = pose_authority.FRAME_ORDER

MAX_FRAME_DELTA_RATIO = pose_authority.MAX_FRAME_DELTA_RATIO
ARM_C_BENCHMARK = pose_authority.ARM_C_BENCHMARK

# 2026-08-30 human review: check_frame_consistency (inter-frame *delta*) passed
# a sheet whose background was visibly compounding noise every frame -- a
# growth-against-a-fixed-baseline failure a delta measure cannot see. 1.35 is
# derived from T-0249's own natural per-frame fluctuation (421-566px, no
# trend, ratio 566/421 ~= 1.34); the rejected attempt 6 sheet measured
# ~1.44x (1024px -> 1472px), above this bound. See
# tests/test_player_idle_chained_T0250_gate.py's matching constant for the
# full derivation.
MAX_BACKGROUND_GROWTH_RATIO = 1.35

# Rig generalisation evidence (the same rig drives 'move' with no code
# change) is inherited unchanged from §24-b -- nothing about chaining
# frames through img2img touches keypoint derivation, so re-emitting it
# would only duplicate already-committed evidence.
RIG_GENERALIZATION_EVIDENCE_PATH = pose_authority.RIG_GENERALIZATION_EVIDENCE_PATH

IDLE_FRAME_EVIDENCE_DIR = (
    REPO_ROOT / "assets" / "src" / "character" / "pose_rig_idle_frame_evidence_T0250"
)

MAIN_PROMPT = pose_authority.MAIN_PROMPT
MAIN_NEGATIVE = pose_authority.MAIN_NEGATIVE

# ── Extra graph node ids for the img2img chain (frame 0 reuses pose_authority's) ──
INIT_IMAGE_NODE_ID = "30"
VAE_ENCODE_NODE_ID = "31"


def build_chained_graph(
    seed: int,
    pose_skeleton_filename: str,
    init_image_filename: str,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
) -> dict:
    """Frame n>0: reuses pose_authority.build_graph unchanged for every node
    except the latent source -- EmptyLatentImage swapped for VAEEncode of the
    previous frame's own decoded output, denoise lowered from 1.0. This is
    the literal embodiment of "chain frames through img2img": frame n starts
    from frame n-1's already-correct figure instead of pure noise, with this
    frame's own pose skeleton still conditioning the ControlNet as before.
    """
    g = pose_authority.build_graph(
        seed=seed,
        pose_skeleton_filename=pose_skeleton_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        style_lora_weight=style_lora_weight,
        identity_lora_weight=identity_lora_weight,
        identity_lora_name=identity_lora_name,
    )
    del g[pose_authority.LATENT_NODE_ID]
    g[INIT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": init_image_filename},
    }
    g[VAE_ENCODE_NODE_ID] = {
        "class_type": "VAEEncode",
        "inputs": {
            "pixels": [INIT_IMAGE_NODE_ID, 0],
            "vae": [pose_authority.CHECKPOINT_NODE_ID, 2],
        },
    }
    g[pose_authority.SAMPLER_NODE_ID]["inputs"]["latent_image"] = [VAE_ENCODE_NODE_ID, 0]
    g[pose_authority.SAMPLER_NODE_ID]["inputs"]["denoise"] = denoise
    return g


BACKGROUND_MASK_MARGIN_FRAC = 0.14  # fraction of the figure's own bbox extent, each side
BACKGROUND_MASK_FEATHER_PX = 10  # soften the composite seam at the figure's silhouette edge


def background_hold_mask(points_norm: dict[int, tuple[float, float]], size: int) -> Image.Image:
    """A soft-edged 'L' mask, white (255) over this frame's own figure
    bounding box (keypoints + BACKGROUND_MASK_MARGIN_FRAC margin), black (0)
    everywhere else. `Image.composite(sampled, frame_0, mask)` then keeps
    the sampled pixels only inside the figure region and forces every
    background pixel to frame 0's own -- the 2026-08-30 human review's
    "mask/hold the background so noise cannot compound into it" fix
    direction, applied directly in pixel space rather than trusting a
    latent-space mask's polarity (untested on this ComfyUI host, and a
    wrong guess would waste one of the two attempts left under DL-21's
    8-per-arm cap)."""
    xs = [x for x, _ in points_norm.values()]
    ys = [y for _, y in points_norm.values()]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    w, h = x1 - x0, y1 - y0
    x0 = max(0.0, x0 - w * BACKGROUND_MASK_MARGIN_FRAC)
    x1 = min(1.0, x1 + w * BACKGROUND_MASK_MARGIN_FRAC)
    y0 = max(0.0, y0 - h * BACKGROUND_MASK_MARGIN_FRAC)
    y1 = min(1.0, y1 + h * BACKGROUND_MASK_MARGIN_FRAC)

    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle([x0 * size, y0 * size, x1 * size, y1 * size], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(BACKGROUND_MASK_FEATHER_PX))


def apply_background_hold(
    sampled: Image.Image, anchor: Image.Image, mask: Image.Image
) -> Image.Image:
    """Composite `sampled` (this frame's own generation) over `anchor`
    (frame 0's clean output) through `mask` -- every background pixel
    becomes byte-identical to frame 0's, every frame, so there is no chain
    of ever-degrading inputs for noise to accumulate along."""
    return Image.composite(sampled.convert("RGB"), anchor.convert("RGB"), mask)


# ── Background cutout (2026-08-30 second human review) ─────────────────────
#
# The frame-0-anchor + background-hold fix (above) bounded noise accumulation
# but the human-reviewed sheet still carried a visible background: a dark
# ground plane, a distinct grey slab and scattered green marks, none of them
# character. `docs/design/13-asset-pipeline.md`'s prop cutout path
# (`tools/comfy-client/src/comfy_client/cutout.py`) bakes RGBA alpha at
# *generation* time via a full-canvas SolidMask -- correct for a prop LoRA'd
# to fill its whole canvas, but a uniform full-canvas alpha cannot separate a
# character from the visible background margin this sheet's cells still
# have, so that mechanism does not apply here unmodified. This does the
# equivalent job -- opaque character, background forced to
# `background_index` -- as a genuine per-pixel segmentation of the already
# generated frame, applied per-frame BEFORE the frames are assembled into the
# sheet (per the review's explicit direction), not to the assembled sheet:
#
#   1. `border_flood_background_mask` -- a border-connected, tolerance-chained
#      region grow in Oklab space over that frame's own 384x384 sampled/held
#      image: every border pixel seeds the background region, and a neighbour
#      joins if it is within `CUTOUT_OKLAB_TOLERANCE` of the pixel it grows
#      from (not a single fixed seed colour), so a gradual background
#      gradient or artifact connected to the frame edge is swept regardless
#      of how many distinct palette indices it later quantizes to -- a
#      strict superset of the old corner-flood-on-exact-quantized-index
#      approach (`force_cell_corner_background`, now superseded here).
#   2. Unioned with "outside this frame's own keypoint bounding box +
#      `BACKGROUND_MASK_MARGIN_FRAC` margin" (the same constant the
#      background-hold mask already uses) -- catches clutter that is NOT
#      border-connected (a floor-plane wedge, faint side ghosting) by
#      position instead of colour, without risking the character (the margin
#      is the same one already proven, by the background-hold compositing
#      above, to contain the full figure across all 9 frames).
#
# Measured on the already-promoted attempt 8 frames before this shipped:
# tolerance 0.03 recovers a foreground fraction stable across frames
# (23.1-23.4% of the 384x384 frame) with no visible clipping of the figure's
# silhouette; below ~0.02 residual background survives, above ~0.08 the
# fraction becomes frame-inconsistent (0.070-0.131 across otherwise-identical
# frames) -- a sign the flood is starting to eat into the character
# unevenly.
CUTOUT_OKLAB_TOLERANCE = 0.03


def _oklab_grid(rgb_uint8: np.ndarray) -> np.ndarray:
    h, w = rgb_uint8.shape[:2]
    flat = _srgb_to_oklab(rgb_uint8.reshape(-1, 3).astype(np.float64))
    return flat.reshape(h, w, 3)


def border_flood_background_mask(img: Image.Image, tolerance: float) -> np.ndarray:
    """Boolean HxW array, True = background. Multi-source BFS seeded from
    every border pixel, growing through 4-connected neighbours whose Oklab
    distance to the pixel it grows *from* (not the original seed) is within
    `tolerance` -- a tolerance-chained ("magic wand, contiguous") flood, so a
    gradual gradient connected to the edge is swept even where no single
    pixel is close to the border's own colour."""
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    oklab = _oklab_grid(arr)
    visited = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if not visited[y, x]:
            visited[y, x] = True
            queue.append((y, x))

    for x in range(w):
        seed(0, x)
        seed(h - 1, x)
    for y in range(h):
        seed(y, 0)
        seed(y, w - 1)

    tol2 = tolerance * tolerance
    while queue:
        y, x = queue.popleft()
        cur = oklab[y, x]
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx]:
                diff = oklab[ny, nx] - cur
                if diff[0] * diff[0] + diff[1] * diff[1] + diff[2] * diff[2] <= tol2:
                    visited[ny, nx] = True
                    queue.append((ny, nx))
    return visited


def cutout_foreground_mask(
    img: Image.Image,
    points_norm: dict[int, tuple[float, float]],
    tolerance: float,
    bbox_margin_frac: float,
) -> np.ndarray:
    """Boolean HxW array, True = character. Background is the union of the
    border-connected tolerant flood and everything outside this frame's own
    keypoint bounding box (+margin); the character is the complement -- see
    the module-level comment above for why both are needed."""
    size = img.size[0]
    background = border_flood_background_mask(img, tolerance)

    xs = [x for x, _ in points_norm.values()]
    ys = [y for _, y in points_norm.values()]
    x0n, x1n = min(xs), max(xs)
    y0n, y1n = min(ys), max(ys)
    wn, hn = x1n - x0n, y1n - y0n
    x0n -= wn * bbox_margin_frac
    x1n += wn * bbox_margin_frac
    y0n -= hn * bbox_margin_frac
    y1n += hn * bbox_margin_frac
    x0, x1 = int(max(0.0, x0n) * size), int(min(1.0, x1n) * size)
    y0, y1 = int(max(0.0, y0n) * size), int(min(1.0, y1n) * size)

    outside_bbox = np.ones((size, size), dtype=bool)
    outside_bbox[y0:y1, x0:x1] = False
    return ~(background | outside_bbox)


def downscale_mask(fg_mask: np.ndarray, target_size: int) -> np.ndarray:
    """Area-downscale a boolean mask to `target_size`x`target_size` (matches
    the BOX filter already used for the RGB image itself) and re-threshold
    at 50% coverage."""
    mask_img = Image.fromarray((fg_mask * 255).astype(np.uint8))
    small = mask_img.resize((target_size, target_size), Image.Resampling.BOX)
    return np.array(small) >= 128


def apply_cutout_masks(
    indexed: Image.Image,
    fg_masks: dict[tuple[int, int], np.ndarray],
    cell_size: int,
    background_index: int,
) -> Image.Image:
    """Force every cell's non-character pixels (per that cell's own
    downscaled cutout mask) to `background_index`. Supersedes
    `force_cell_corner_background`: a per-frame content-aware segmentation
    is a strict superset of a same-index corner flood fill."""
    arr = np.array(indexed)
    out = arr.copy()
    for (r, c), mask in fg_masks.items():
        y0, x0 = r * cell_size, c * cell_size
        sub = out[y0 : y0 + cell_size, x0 : x0 + cell_size]
        sub[~mask] = background_index
    result = Image.fromarray(out, mode="P")
    result.putpalette(indexed.getpalette())
    return result


CUTOUT_METHOD_DESCRIPTION = (
    "Per-frame border-connected tolerant region-growing in Oklab space "
    f"(tolerance={CUTOUT_OKLAB_TOLERANCE}) over that frame's own 384x384 sampled/held image, "
    "seeded from every border pixel and grown through 4-connected neighbours within the "
    "tolerance of the pixel it grows from -- removes background clutter connected to the frame "
    "edge regardless of how many distinct palette indices it quantizes to. Unioned with "
    "'outside this frame's own keypoint bounding box + margin' (background_hold_mask's own "
    "BACKGROUND_MASK_MARGIN_FRAC) to remove disconnected clutter (a floor-plane wedge, faint "
    "side ghosting) by position. Applied to each frame's own image and downscaled alongside it "
    "BEFORE the frames are assembled into the sheet -- not to the assembled sheet. "
    "Character-foreground pixels keep their quantized palette index; every other pixel is "
    "forced to background_index=0. Supersedes force_cell_corner_background (a strict superset: "
    "content-aware per-frame segmentation vs. same-index corner flood fill)."
)


def compute_sheet_gates(indexed: Image.Image) -> dict:
    """DL-21 criterion 2 (frame-consistency) + the 2026-08-30 human-review
    background-growth gate, factored out so both a fresh generation run and
    a cutout-only reprocess of an already-sampled attempt compute identical
    gates the identical way."""
    cells = {}
    for r in range(3):
        for c in range(3):
            cells[(r, c)] = indexed.crop(
                (
                    c * FINAL_CELL_PX,
                    r * FINAL_CELL_PX,
                    c * FINAL_CELL_PX + FINAL_CELL_PX,
                    r * FINAL_CELL_PX + FINAL_CELL_PX,
                )
            )
    frame_deltas = []
    for a, b in zip(FRAME_ORDER, FRAME_ORDER[1:]):
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=MAX_FRAME_DELTA_RATIO
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    mechanical_gate_passed = all(d["passed"] for d in frame_deltas)
    ratios = [d["ratio"] for d in frame_deltas]
    beats_030_cap = max(ratios) <= MAX_FRAME_DELTA_RATIO

    background_growth_result = asset_gate_art.check_background_growth(
        [cells[c] for c in FRAME_ORDER],
        background_index=0,
        max_growth_ratio=MAX_BACKGROUND_GROWTH_RATIO,
    )
    gates = {
        "frame_deltas": frame_deltas,
        "mechanical_gate_passed": mechanical_gate_passed,
        "beats_030_cap": beats_030_cap,
        "background_growth": {
            "counts": background_growth_result.details["counts"],
            "baseline": background_growth_result.details["baseline"],
            "max_growth_ratio": MAX_BACKGROUND_GROWTH_RATIO,
            "passed": bool(background_growth_result.passed),
        },
        "passes_all_gates": bool(mechanical_gate_passed and background_growth_result.passed),
    }
    # CHR-1 (T-0258): frame_delta_range/arm_c_benchmark/beats_arm_c_benchmark
    # are derived and owned by the shared helper, not computed here.
    return apply_arm_c_benchmark_fields(gates, ratios)


def check_attempt_cap(attempt: int) -> None:
    if not (1 <= attempt <= 8):
        raise SystemExit("attempt cap is 8 per round (DL-21) -- refusing to run a 9th attempt")


ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_CHAINED_ATTEMPT_LOG_T0250.md"
)
OUT_ROOT = REPO_ROOT / "assets" / "out" / "chained_idle"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_chained_T0250.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_chained_T0250.provenance.json"

SWEEP_REPORT_PATH = REPO_ROOT / "assets" / "src" / "character" / "DENOISE_SWEEP_REPORT_T0250.md"
SWEEP_DATA_PATH = REPO_ROOT / "assets" / "src" / "character" / "DENOISE_SWEEP_T0250.json"

ATTEMPT_LOG_HEADER = (
    "# Chained img2img attempt log (T-0250, HANDOFF §24-c, round 2)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half) across all 8 "
    "adjacent-cell transitions of the assembled sheet. Runs against `player_identity_v2` "
    "(T-0248) -- §24-a's contribution, not masked -- and composes on top of §24-b's "
    "per-frame pose-authority generation (T-0249): frame 0 is generated exactly as §24-b "
    "would, frames 1-8 are img2img-chained from their predecessor.\n\n"
    "| Attempt | Seed | Denoise | ControlNet strength/end | Style LoRA weight | "
    "Identity LoRA weight | Frame-delta range | GPU seconds | Mechanical gate | "
    "Beats Arm C (0.072-0.112) | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    lo, hi = provenance["frame_delta_range"]
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} | {provenance['denoise_value']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['style_lora_weight']} | {provenance['identity_lora_weight']} "
        f"| {lo:.4f}-{hi:.4f} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance['beats_arm_c_benchmark'] else 'no'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} "
        f"| {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


DEFAULT_DENOISE_JUSTIFICATION = (
    "SUPERSEDED BY 2026-08-30 HUMAN REVIEW. The original justification (attempts 1-6, "
    "chain-from-predecessor mechanism) chose denoise=0.15/seed=31420 because it cleared the "
    "0.30 cap (0.0301-0.2134) -- but that sheet was rejected on human review for compounding "
    "background noise every frame (clean background pixels 1280->832 across the sheet), a "
    "failure check_frame_consistency's relative delta cannot see. The fix applied here -- "
    "anchoring every frame to frame 0's own decoded output (not its immediate predecessor) "
    "plus a hard pixel-space background hold -- removes that compounding by construction "
    "(background_growth now 1.0-1.05x frame 0's baseline across both re-measured denoise "
    "values, attempts 7-8, well inside the 1.35x bound). denoise=0.30 (attempt 8) is chosen "
    "over attempt 7's 0.15 only because it is the value actually inside the round's mandated "
    "~0.25-0.35 sweep band; it is NOT chosen because it demonstrates better motion. Both "
    "re-measured points are honestly indistinguishable on the property that matters: frame-delta "
    "collapsed to 0.0000-0.0299 (denoise 0.15) and 0.0000-0.0286 (denoise 0.30), and direct visual "
    "comparison of frame 0 against frame 4 at both values shows the pose has not visibly moved. "
    "This is the low-edge 'motion stops reading' failure mode the sweep was designed to detect, "
    "now occurring throughout the tested range instead of only below it -- background-holding a "
    "sheet whose idle motion amplitude is already tiny by design (pose_rig_T0249.json: "
    "breathing_amplitude_norm 0.012, weight_shift_extent_norm 0.018) removes the only channel "
    "(background speckle) that was previously registering as inter-frame delta. The DL-21 "
    "8-attempt cap was reached confirming this at two points; whether a higher denoise (>0.35) "
    "restores legible motion before drift returns under the new mechanism is untested and would "
    "need a fresh attempt allocation to answer -- see ROUND2_CHAINED_REPORT_T0250.md's 'Human "
    "review' section for the full account. Both re-measured points, as originally sampled "
    "pre-cutout, cleared both the 0.30 cap and Arm C's 0.072-0.112 benchmark, but only because "
    "motion had stalled, not because the chaining hypothesis produced a legible-motion, "
    "drift-free result. A separate, additive fix (per-frame background cutout, 2026-08-30 "
    "second human review) was then applied on top of the promoted attempt 8 sheet, with no "
    "seed or denoise change and no new GPU work; because it genuinely removes the sheet's "
    "static background, check_frame_consistency's ratio denominator shrinks and the "
    "frame-delta measurement on this currently-promoted, cutout-reprocessed sheet moved to "
    "0.0000-0.1763 (see cutout_reprocess_note above). This sheet clears the 0.30 cap but does "
    "not beat Arm C's 0.072-0.112 benchmark (max ratio 0.1763 > 0.112) -- report this as a "
    "qualified pass on the mechanical gate and a fail against Arm C, not a win, per round-2 "
    "rule §23-b."
)


def promote_attempt(
    out_dir: Path, provenance: dict, denoise_justification: str = DEFAULT_DENOISE_JUSTIFICATION
) -> None:
    """Copy this attempt's indexed sheet + provenance into
    assets/final/character/. Only called for the attempt chosen from the
    sweep -- a discarded attempt's bytes never land in assets/final/, even
    transiently. Also re-homes this attempt's 9 per-frame conditioning
    inputs from the gitignored assets/out/ into a committed evidence
    directory under assets/src/.
    """
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())

    IDLE_FRAME_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    promoted = dict(provenance)
    promoted_frames = []
    for frame in provenance["frame_generation"]:
        i = frame["frame_index"]
        keypoints_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_keypoints.json"
        skeleton_dst = IDLE_FRAME_EVIDENCE_DIR / f"frame_{i}_pose_skeleton_384.png"
        keypoints_dst.write_bytes((out_dir / f"frame_{i}_keypoints.json").read_bytes())
        skeleton_dst.write_bytes((out_dir / f"frame_{i}_pose_skeleton_384.png").read_bytes())
        promoted_frame = dict(frame)
        promoted_frame["pose_keypoints_file"] = str(keypoints_dst.relative_to(REPO_ROOT))
        promoted_frame["pose_skeleton_file"] = str(skeleton_dst.relative_to(REPO_ROOT))
        promoted_frames.append(promoted_frame)
    promoted["frame_generation"] = promoted_frames

    promoted["denoise_justification"] = denoise_justification
    promoted["denoise_sweep_report"] = str(SWEEP_REPORT_PATH.relative_to(REPO_ROOT))
    promoted["denoise_sweep_data"] = str(SWEEP_DATA_PATH.relative_to(REPO_ROOT))
    promoted["promoted"] = True
    FINAL_PROVENANCE_PATH.write_text(json.dumps(promoted, indent=2) + "\n")


def run_attempt(
    attempt: int,
    seed: int,
    denoise: float,
    controlnet_strength: float,
    controlnet_end: float,
    style_lora_weight: float,
    identity_lora_weight: float,
    *,
    identity_lora_name: str = IDENTITY_LORA_NAME,
    state_name: str = "idle",
) -> dict:
    if not (0.0 < denoise < 1.0):
        raise ValueError(f"denoise must be in (0, 1) -- got {denoise}")
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )
    if not IDENTITY_LORA_PATH.exists():
        raise RuntimeError(
            f"trained identity LoRA not found: {IDENTITY_LORA_PATH} -- run T-0248's training first"
        )
    if not IDENTITY_LORA_PROVENANCE_PATH.exists():
        raise RuntimeError(
            f"identity LoRA provenance sidecar not found: {IDENTITY_LORA_PROVENANCE_PATH}"
        )
    if not RIG_GENERALIZATION_EVIDENCE_PATH.exists():
        raise RuntimeError(
            f"{RIG_GENERALIZATION_EVIDENCE_PATH} missing -- inherited from T-0249, should "
            "already be committed on this branch"
        )

    style_lora_hash = sha256_of(LORA_PATH)
    identity_lora_hash = sha256_of(IDENTITY_LORA_PATH)

    out_dir = OUT_ROOT / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    rig = pose_rig_T0249.load_rig()
    state = rig["states"][state_name]

    t0 = time.monotonic()
    frame_records = []
    cell_images: dict[tuple[int, int], Image.Image] = {}
    frame_main_images: dict[tuple[int, int], Image.Image] = {}
    frame_points: dict[tuple[int, int], dict[int, tuple[float, float]]] = {}
    prompt_ids = []
    frame0_main_path: Path | None = None
    frame0_main_img: Image.Image | None = None

    for i, cell in enumerate(FRAME_ORDER):
        points = pose_rig_T0249.keypoints_for_frame(state, i, FRAME_COUNT)
        skeleton_img = pose_rig_T0249.render_pose_frame(points, GEN_PX)
        skeleton_path = out_dir / f"frame_{i}_pose_skeleton_384.png"
        skeleton_img.save(skeleton_path)

        keypoints_path = out_dir / f"frame_{i}_keypoints.json"
        keypoints_path.write_text(
            json.dumps(pose_rig_T0249.keypoints_to_coco_list(points), indent=2) + "\n"
        )

        skeleton_filename = upload_image(skeleton_path)

        if i == 0:
            graph = pose_authority.build_graph(
                seed=seed,
                pose_skeleton_filename=skeleton_filename,
                controlnet_strength=controlnet_strength,
                controlnet_end=controlnet_end,
                style_lora_weight=style_lora_weight,
                identity_lora_weight=identity_lora_weight,
                identity_lora_name=identity_lora_name,
            )
            frame_denoise = 1.0
            generation_mode = "fresh"
            chained_from = None
        else:
            # 2026-08-30 human review fix: anchor every frame to frame 0's own
            # clean output, not the immediately preceding frame -- chaining
            # from the predecessor let each frame's own background speckle
            # feed into the next frame's init image, compounding across the
            # sheet (measured: clean background pixels 1280->832). Anchoring
            # to a fixed, never-degrading source bounds that by construction.
            assert frame0_main_path is not None
            init_image_filename = upload_image(frame0_main_path)
            graph = build_chained_graph(
                seed=seed,
                pose_skeleton_filename=skeleton_filename,
                init_image_filename=init_image_filename,
                denoise=denoise,
                controlnet_strength=controlnet_strength,
                controlnet_end=controlnet_end,
                style_lora_weight=style_lora_weight,
                identity_lora_weight=identity_lora_weight,
                identity_lora_name=identity_lora_name,
            )
            frame_denoise = denoise
            generation_mode = "img2img_chained"
            chained_from = 0

        prompt_id = submit_prompt(graph)
        info = wait_for_completion(prompt_id, timeout_s=300)
        prompt_ids.append(prompt_id)

        main_bytes = fetch_save_image(info, pose_authority.MAIN_SAVE_NODE_ID)
        sampled_img = Image.open(io.BytesIO(main_bytes)).convert("RGB")

        frame_points[cell] = points

        if i == 0:
            frame0_main_path = out_dir / f"frame_{i}_main_384.png"
            frame0_main_path.write_bytes(main_bytes)
            frame0_main_img = sampled_img
            frame_main_images[cell] = sampled_img
            cell_bytes = fetch_save_image(info, pose_authority.CELL_SAVE_NODE_ID)
            cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
            cell_raw_path.write_bytes(cell_bytes)
            cell_images[cell] = Image.open(cell_raw_path).convert("RGB")
        else:
            # Background hold: force every background pixel to frame 0's own,
            # pixel-space, after decode -- see apply_background_hold's
            # docstring for why this is done here rather than via an
            # in-graph latent mask.
            assert frame0_main_img is not None
            raw_sampled_path = out_dir / f"frame_{i}_main_384_raw_sampled.png"
            raw_sampled_path.write_bytes(main_bytes)
            mask = background_hold_mask(points, GEN_PX)
            mask.save(out_dir / f"frame_{i}_background_hold_mask.png")
            held_img = apply_background_hold(sampled_img, frame0_main_img, mask)
            main_path = out_dir / f"frame_{i}_main_384.png"
            held_img.save(main_path)
            frame_main_images[cell] = held_img
            cell_raw_path = out_dir / f"frame_{i}_cell_48_raw.png"
            # Locally computed area-downscale of the held (background-composited)
            # image -- ComfyUI's own CELL_SAVE_NODE_ID output was area-descended
            # from the *raw sampled* image, before the background hold, so it
            # would silently reintroduce the noise this fix removes.
            cell_img = held_img.resize((FINAL_CELL_PX, FINAL_CELL_PX), Image.Resampling.BOX)
            cell_img.save(cell_raw_path)
            cell_images[cell] = cell_img

        frame_records.append(
            {
                "frame_index": i,
                "cell": list(cell),
                "seed": seed,
                "width": GEN_PX,
                "height": GEN_PX,
                "prompt": MAIN_PROMPT,
                "negative_prompt": MAIN_NEGATIVE,
                "pose_keypoints_file": str(keypoints_path.relative_to(REPO_ROOT)),
                "pose_skeleton_file": str(skeleton_path.relative_to(REPO_ROOT)),
                "comfyui_prompt_id": prompt_id,
                "generation_mode": generation_mode,
                "chained_from_frame": chained_from,
                "denoise": frame_denoise,
            }
        )

    gpu_seconds = time.monotonic() - t0

    raw_sheet = Image.new("RGB", (SHEET_PX, SHEET_PX))
    for (r, c), cell_img in cell_images.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))
    raw_sheet.save(out_dir / "sheet_144_raw.png")

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    indexed = quantize_to_palette(raw_sheet, palette)

    # 2026-08-30 second human review: cut the character out of its background
    # per-frame, before assembly -- see the module-level comment above
    # border_flood_background_mask for the full rationale. Supersedes
    # force_cell_corner_background.
    cutout_masks = {
        cell: downscale_mask(
            cutout_foreground_mask(
                frame_main_images[cell],
                frame_points[cell],
                CUTOUT_OKLAB_TOLERANCE,
                BACKGROUND_MASK_MARGIN_FRAC,
            ),
            FINAL_CELL_PX,
        )
        for cell in FRAME_ORDER
    }
    indexed = apply_cutout_masks(indexed, cutout_masks, cell_size=FINAL_CELL_PX, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    save_sprite_sheet(indexed, out_dir / "sheet_144_indexed.png")

    gates = compute_sheet_gates(indexed)
    frame_deltas = gates["frame_deltas"]
    mechanical_gate_passed = gates["mechanical_gate_passed"]
    frame_delta_range = gates["frame_delta_range"]
    beats_030_cap = gates["beats_030_cap"]
    beats_arm_c_benchmark = gates["beats_arm_c_benchmark"]
    arm_c_benchmark = gates["arm_c_benchmark"]

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight}) "
        f"+ LoRA {identity_lora_name} (player identity, weight {identity_lora_weight}) "
        f"+ ControlNet {CONTROLNET_NAME} (per-frame script-authored pose skeleton) "
        f"+ img2img chaining (frames 1-8 anchored to frame 0's own output, "
        f"background held out of the feedback path, denoise {denoise}) "
        f"+ per-frame background cutout before sheet assembly (Oklab border-flood "
        f"tolerance={CUTOUT_OKLAB_TOLERANCE})"
    )
    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": identity_lora_weight,
        "identity_lora_license": "CreativeML OpenRAIL++-M",
        "identity_lora_provenance": str(IDENTITY_LORA_PROVENANCE_PATH.relative_to(REPO_ROOT)),
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "pose_source": (
            "script (assets/src/character/pose_rig_T0249.py) -- deterministic per-frame "
            "OpenPose-format 18-keypoint COCO skeleton, emitted directly by the script, with "
            "no derivation step in between (this ComfyUI host has no DWPose/OpenPose node "
            "that could have derived it from an image)"
        ),
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "animation_params": str(RIG_PATH.relative_to(REPO_ROOT)),
        "animation_state": state_name,
        "rig_generalization_evidence": str(
            RIG_GENERALIZATION_EVIDENCE_PATH.relative_to(REPO_ROOT)
        ),
        "frame_generation": frame_records,
        "denoise_value": denoise,
        "composes_with_pose_authority_T0249": True,
        "based_on_card": "T-0249",
        "chaining_anchor_frame": 0,
        "background_held": True,
        "background_mask_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
        "background_mask_feather_px": BACKGROUND_MASK_FEATHER_PX,
        "chaining_method": (
            "Frame 1 (index 0) generated fresh via "
            "gen_pose_authority_idle_T0249.build_graph unchanged (EmptyLatentImage, "
            "denoise=1.0). Frames 2-9 (index 1-8) img2img-chained from a FIXED anchor -- "
            "frame 0's own decoded 384x384 output, via VAEEncode -- at "
            f"denoise={denoise}, with each frame's own script-authored ControlNet skeleton "
            "still conditioning the sample on top -- build_chained_graph patches only the "
            "latent source and denoise on the reused build_graph, nothing else. Anchoring to "
            "frame 0 (not the immediate predecessor, the original hypothesis text) and holding "
            "the background out of the feedback path are both 2026-08-30 human-review fixes: "
            "the original predecessor-chaining mechanism let each frame's own background "
            "speckle feed into the next frame's init image, compounding across the sheet until "
            "the figure visibly dissolved into noise (measured: clean background pixels "
            "1280->832 across the promoted attempt 6 sheet). After each frame is sampled, "
            "apply_background_hold composites the sampled figure (via a soft-edged mask over "
            "that frame's own keypoint bounding box, background_hold_mask) onto frame 0's own "
            "background, pixel-space, after decode -- so every frame's background is "
            "byte-anchored to frame 0's, not merely hoped to stay similar. An in-graph "
            "SetLatentNoiseMask was considered but not used: its polarity convention was "
            "unverified on this ComfyUI host, and a wrong guess would have wasted one of the "
            "two attempts remaining under DL-21's 8-per-arm cap; the pixel-space composite "
            "gives the same guarantee without that risk."
        ),
        "method": (
            "pose_rig_T0249 derives 18-keypoint COCO frame keypoints from committed animation "
            "parameters (pose_rig_T0249.json) -> gen_arm_a_idle_T0228.draw_pose_skeleton_cell "
            "renders each frame's skeleton (384x384, reused renderer, not re-authored) -> "
            "frame 0: ControlNetApplyAdvanced (xinsir OpenPose) conditions a single-figure "
            "KSampler generation at 384x384 from pure noise -> frames 1-8: frame 0's own "
            "decoded output (a fixed anchor, not the immediately preceding frame) is "
            f"VAE-encoded and used as the KSampler's latent source at denoise={denoise}, with "
            "this frame's own skeleton still ControlNet-conditioning the sample -> the sampled "
            "output is composited back onto frame 0's own background through a soft-edged mask "
            "over this frame's keypoint bounding box (apply_background_hold), so every "
            "background pixel is byte-anchored to frame 0's -> per-frame area descent to 48x48 "
            "(same x8 ratio as the grid path, computed locally from the held/composited image "
            "for frames 1-8) -> frames assembled into a 144x144 sheet -> Oklab-nearest palette "
            "quantization (dithering off, §3.1) -> orphan cleanup."
        ),
        "generator": "assets/src/character/gen_chained_idle_T0250.py",
        "card": "T-0250",
        "bake_off_arm": (
            "round 2, chained img2img (HANDOFF §24-c), stacked on top of §24-a's "
            "player_identity_v2 and §24-b's pose-authority per-frame generation -- not a new "
            "bake-off arm competing on DL-21's original criteria"
        ),
        "spec": (
            "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5 + HANDOFF §24.3"
        ),
        "comfyui_prompt_ids": prompt_ids,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "frame_delta_range": frame_delta_range,
        "beats_030_cap": beats_030_cap,
        "beats_arm_c_benchmark": beats_arm_c_benchmark,
        "arm_c_benchmark": arm_c_benchmark,
        "background_growth": gates["background_growth"],
        "passes_all_gates": gates["passes_all_gates"],
        "background_cutout_applied": True,
        "cutout_method": CUTOUT_METHOD_DESCRIPTION,
        "cutout_oklab_tolerance": CUTOUT_OKLAB_TOLERANCE,
        "cutout_bbox_margin_frac": BACKGROUND_MASK_MARGIN_FRAC,
        "layout": {
            "sheet_px": [SHEET_PX, SHEET_PX],
            "cell_px": FINAL_CELL_PX,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in FRAME_ORDER],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def reprocess_attempt_cutout(attempt: int) -> dict:
    """Re-derive `attempt`'s indexed sheet with the background-cutout step
    (2026-08-30 second human review) from that attempt's ALREADY SAMPLED
    per-frame images on disk -- no new ComfyUI calls, no seed or denoise
    change, no re-sweep. Additive on top of the frame-0-anchor +
    background-hold fix per the review's explicit direction: "This is
    additive ... do not re-sweep denoise, do not change the identity
    re-anchoring or masking that fixed the accumulation, and do not regress
    the frame-delta result."

    Reads back frame_{i}_cell_48_raw.png (the exact pixels the previous run
    assembled into the sheet), frame_{i}_main_384.png (that frame's own
    sampled/held image, for the cutout mask) and frame_{i}_keypoints.json
    from `attempt`'s own out_dir, rebuilds the sheet through
    quantize -> cutout -> margin -> orphan-cleanup, recomputes the gates on
    the result, and overwrites both `sheet_144_indexed.png` and
    `provenance_candidate.json` in place. `--promote-attempt` then promotes
    the result exactly as for a fresh run.
    """
    out_dir = OUT_ROOT / f"attempt_{attempt}"
    candidate_path = out_dir / "provenance_candidate.json"
    provenance = json.loads(candidate_path.read_text())

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    cell_images: dict[tuple[int, int], Image.Image] = {}
    frame_main_images: dict[tuple[int, int], Image.Image] = {}
    frame_points: dict[tuple[int, int], dict[int, tuple[float, float]]] = {}
    for i, cell in enumerate(FRAME_ORDER):
        cell_images[cell] = Image.open(out_dir / f"frame_{i}_cell_48_raw.png").convert("RGB")
        frame_main_images[cell] = Image.open(out_dir / f"frame_{i}_main_384.png").convert("RGB")
        coco_list = json.loads((out_dir / f"frame_{i}_keypoints.json").read_text())
        frame_points[cell] = {p["joint"]: (p["x"], p["y"]) for p in coco_list}

    raw_sheet = Image.new("RGB", (SHEET_PX, SHEET_PX))
    for (r, c), cell_img in cell_images.items():
        raw_sheet.paste(cell_img, (c * FINAL_CELL_PX, r * FINAL_CELL_PX))

    indexed = quantize_to_palette(raw_sheet, palette)
    cutout_masks = {
        cell: downscale_mask(
            cutout_foreground_mask(
                frame_main_images[cell],
                frame_points[cell],
                CUTOUT_OKLAB_TOLERANCE,
                BACKGROUND_MASK_MARGIN_FRAC,
            ),
            FINAL_CELL_PX,
        )
        for cell in FRAME_ORDER
    }
    indexed = apply_cutout_masks(indexed, cutout_masks, cell_size=FINAL_CELL_PX, background_index=0)
    indexed = enforce_cell_margin(indexed, cell_size=FINAL_CELL_PX, margin=2, background_index=0)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    save_sprite_sheet(indexed, out_dir / "sheet_144_indexed.png")

    gates = compute_sheet_gates(indexed)

    # Rebuild the chaining clause fresh rather than trusting whatever the
    # on-disk candidate's `model` string currently says: this gitignored
    # out_dir file predates 516241d's model-field-wording fix (it still says
    # "from their predecessor" on this ComfyUI host's disk, even though the
    # COMMITTED sidecar was hand-corrected) -- an append-only patch would
    # have left that stale clause in place, reproducing the exact P-7 defect
    # 516241d already fixed once.
    denoise_value = provenance["denoise_value"]
    prefix = provenance["model"].split(" + img2img chaining")[0]
    model = (
        f"{prefix} + img2img chaining (frames 1-8 anchored to frame 0's own output, "
        f"background held out of the feedback path, denoise {denoise_value}) "
        f"+ per-frame background cutout before sheet assembly (Oklab border-flood "
        f"tolerance={CUTOUT_OKLAB_TOLERANCE})"
    )

    provenance = dict(provenance)
    provenance["model"] = model
    provenance["mechanical_gate_passed"] = gates["mechanical_gate_passed"]
    provenance["frame_deltas"] = gates["frame_deltas"]
    provenance["frame_delta_range"] = gates["frame_delta_range"]
    provenance["beats_030_cap"] = gates["beats_030_cap"]
    provenance["beats_arm_c_benchmark"] = gates["beats_arm_c_benchmark"]
    provenance["background_growth"] = gates["background_growth"]
    provenance["passes_all_gates"] = gates["passes_all_gates"]
    provenance["background_cutout_applied"] = True
    provenance["cutout_method"] = CUTOUT_METHOD_DESCRIPTION
    provenance["cutout_oklab_tolerance"] = CUTOUT_OKLAB_TOLERANCE
    provenance["cutout_bbox_margin_frac"] = BACKGROUND_MASK_MARGIN_FRAC
    provenance["cutout_reprocessed_from_attempt"] = attempt
    provenance["cutout_reprocess_note"] = (
        "2026-08-30 second human review: the frame-0-anchor + background-hold fix (attempt "
        f"{attempt}) bounded noise accumulation but still shipped a visible background (dark "
        "ground, a distinct grey slab, scattered green marks). This reprocesses the SAME "
        "already-sampled per-frame pixels from that attempt with a per-frame background-cutout "
        "step added before sheet assembly -- no new ComfyUI sampling, no seed or denoise "
        "change, the identity re-anchoring and background-hold masking are unchanged. "
        "frame_delta_range/beats_030_cap/beats_arm_c_benchmark above are recomputed on the "
        "cutout sheet, not carried over from the pre-cutout candidate."
    )
    candidate_path.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def write_sweep_report(attempts: list[int], chosen_attempt: int) -> None:
    """Reads each listed attempt's already-written provenance_candidate.json
    and assembles the committed sweep report + data file the acceptance
    criteria require -- the measured frame-delta (and, since the 2026-08-30
    human review, background-growth) per sampled denoise value, not a
    single chosen value asserted after the fact.

    Attempts 1-6 (seed-primary sweep + seed-sensitivity check) used the
    original chain-from-predecessor mechanism and predate the
    background-growth gate -- their `background_growth_*` fields are
    `None`, not zero, since that quantity was never measured for them, not
    because it was measured as zero. Attempts 7+ use the human-review fix
    (frame-0 anchor + background hold, see gen_chained_idle_T0250's module
    docstring and `apply_background_hold`) and do carry it. The two
    mechanisms are reported separately below the combined table so neither
    is silently averaged into the other.
    """
    points = []
    for attempt in attempts:
        candidate_path = OUT_ROOT / f"attempt_{attempt}" / "provenance_candidate.json"
        candidate = json.loads(candidate_path.read_text())
        bg = candidate.get("background_growth")
        bg_ratio = None
        if bg and bg.get("baseline"):
            bg_ratio = round(max(c / bg["baseline"] for c in bg["counts"]), 4)
        points.append(
            {
                "attempt": attempt,
                "denoise": candidate["denoise_value"],
                "seed": candidate["seed"],
                "mechanism": (
                    "anchor_frame0_background_held"
                    if candidate.get("background_held")
                    else "chain_from_predecessor"
                ),
                "frame_delta_range": candidate["frame_delta_range"],
                "mechanical_gate_passed": candidate["mechanical_gate_passed"],
                "beats_030_cap": candidate["beats_030_cap"],
                "beats_arm_c_benchmark": candidate["beats_arm_c_benchmark"],
                "background_growth_max_ratio": bg_ratio,
                "background_growth_bounded": bg["passed"] if bg else None,
            }
        )
    points.sort(key=lambda p: p["denoise"])

    old_points = [p for p in points if p["mechanism"] == "chain_from_predecessor"]
    new_points = [p for p in points if p["mechanism"] == "anchor_frame0_background_held"]
    chosen = next(p for p in points if p["attempt"] == chosen_attempt)
    lowest, highest = points[0], points[-1]

    def _bg_clause(p: dict) -> str:
        if p["background_growth_max_ratio"] is None:
            return (
                "background growth not measured (this attempt predates the "
                "background-growth gate)"
            )
        bounded = "bounded" if p["background_growth_bounded"] else "EXCEEDS"
        return (
            f"background-growth ratio {p['background_growth_max_ratio']:.3f}x frame 0's "
            f"non-background pixel count ({bounded} the {MAX_BACKGROUND_GROWTH_RATIO}x cap)"
        )

    def _edge_prose(p: dict, edge: str) -> str:
        return (
            f"At denoise={p['denoise']} (seed {p['seed']}, mechanism={p['mechanism']}, "
            f"attempt {p['attempt']}), measured frame-delta range "
            f"{p['frame_delta_range'][0]:.4f}-{p['frame_delta_range'][1]:.4f} "
            f"({'clears' if p['mechanical_gate_passed'] else 'does NOT clear'} the 0.30 cap), "
            f"{_bg_clause(p)}. This is the {edge} denoise value sampled across both mechanisms."
        )

    failure_mode_low = _edge_prose(lowest, "lowest") + (
        " Motion reads as a stalled sheet (pose stops visibly changing between adjacent "
        "cells) only if the frame-delta range collapses toward its lower bound at this point "
        "relative to higher-denoise points in the same mechanism; a low frame-delta range here "
        "alone is not sufficient evidence of that -- it is also exactly what a working "
        "background hold plus a genuinely small pose change would produce. See the per-mechanism "
        "tables below for the comparison this edge value needs to be read against."
        + (
            " CONFIRMED under the new mechanism: attempts 7 (denoise 0.15) and 8 (denoise 0.30) "
            "both collapse to frame-delta ranges of 0.0000-0.0299 and 0.0000-0.0286 respectively "
            "-- direct visual comparison of frame 0 against frame 4 at both values shows the "
            "figure has not visibly moved. Holding the background static (the human review's own "
            "required fix) removed the background speckle that was previously registering as "
            "inter-frame delta on this sheet's already-tiny idle motion (breathing_amplitude_norm "
            "0.012, weight_shift_extent_norm 0.018), so the low-denoise stalled-motion failure "
            "mode this sweep was designed to find now occurs at every denoise value the 8-attempt "
            "cap allowed testing under the fixed mechanism, not only below the ~0.25-0.35 band."
            if new_points
            else ""
        )
    )
    failure_mode_high = _edge_prose(highest, "highest") + (
        " The high-denoise drift-returns failure mode was already established on the original "
        "mechanism's own sweep (attempts 1-5): the same (0,1)->(0,2) transition's ratio rose "
        "monotonically with denoise from 0.308 at 0.15 to 0.417 at 0.45. Re-establishing that "
        "finding under the new mechanism was not attempted here -- only 2 attempts remained "
        "under DL-21's 8-per-arm cap after the human review, and both were spent confirming the "
        "fix at/below the original 0.15 floor per the review's explicit direction, not "
        "re-verifying an already-answered high edge."
    )

    data = {
        "card": "T-0250",
        "based_on_card": "T-0249",
        "points": points,
        "band_low": 0.25,
        "band_high": 0.35,
        "chosen_denoise": chosen["denoise"],
        "chosen_attempt": chosen_attempt,
        "chosen_mechanism": chosen["mechanism"],
        "failure_mode_low": failure_mode_low,
        "failure_mode_high": failure_mode_high,
        "arm_c_benchmark": list(ARM_C_BENCHMARK),
        "max_frame_delta_cap": MAX_FRAME_DELTA_RATIO,
        "max_background_growth_ratio": MAX_BACKGROUND_GROWTH_RATIO,
        "human_review_fix_attempts": [p["attempt"] for p in new_points],
    }
    SWEEP_DATA_PATH.write_text(json.dumps(data, indent=2) + "\n")

    lines = [
        "# Denoise sweep -- chained img2img idle sheet (T-0250, HANDOFF §24-c)\n\n",
        "Frame 0 generated fresh; frames 1-8 chained at the swept denoise value, everything "
        "else (seed, ControlNet strength/end, style/identity LoRA weights) held constant "
        "across every sampled point, per the round-2 rules (HANDOFF §24.3). Attempts 1-6 use "
        "the original chain-from-predecessor mechanism (superseded, see "
        "ROUND2_CHAINED_REPORT_T0250.md's Human review section); attempts 7+ use the "
        "2026-08-30 human-review fix (frame-0 anchor + background hold). Both are reported "
        "together below, tagged by mechanism, so neither is silently averaged into the "
        "other.\n\n",
        "| Attempt | Seed | Denoise | Mechanism | Frame-delta range | Gate (0.30 cap) | "
        "Beats Arm C | Background growth (max ratio / bounded) |\n",
        "|---|---|---|---|---|---|---|---|\n",
    ]
    for p in points:
        lo, hi = p["frame_delta_range"]
        if p["background_growth_max_ratio"] is not None:
            bounded_cell = "yes" if p["background_growth_bounded"] else "NO"
            bg_cell = f"{p['background_growth_max_ratio']:.3f}x / {bounded_cell}"
        else:
            bg_cell = "not measured"
        lines.append(
            f"| {p['attempt']} | {p['seed']} | {p['denoise']} | {p['mechanism']} "
            f"| {lo:.4f}-{hi:.4f} "
            f"| {'PASS' if p['mechanical_gate_passed'] else 'FAIL'} "
            f"| {'yes' if p['beats_arm_c_benchmark'] else 'no'} "
            f"| {bg_cell} |\n"
        )
    lines.append("\n## Failure mode, lowest denoise sampled\n\n")
    lines.append(failure_mode_low + "\n\n")
    lines.append("## Failure mode, highest denoise sampled (drift returns)\n\n")
    lines.append(failure_mode_high + "\n")
    if old_points:
        lines.append(
            "\n## Original mechanism (chain-from-predecessor, attempts 1-6) -- superseded\n\n"
            "Never cleared the 0.30 cap on its own swept seed (31416) at any denoise; the one "
            "passing attempt (6, seed 31420 off-sweep) passed the frame-delta gate but was "
            "rejected on human review for accumulating background noise every frame -- a "
            "failure the frame-delta gate cannot see (it measures inter-frame delta, not "
            "growth against a fixed baseline). Full detail: ARM_CHAINED_ATTEMPT_LOG_T0250.md, "
            "ROUND2_CHAINED_REPORT_T0250.md.\n"
        )
    if new_points:
        lines.append("\n## Human-review fix (frame-0 anchor + background hold)\n\n")
        for p in new_points:
            lo, hi = p["frame_delta_range"]
            lines.append(
                f"- Attempt {p['attempt']}: denoise={p['denoise']}, seed={p['seed']} -- "
                f"frame-delta {lo:.4f}-{hi:.4f} "
                f"({'PASS' if p['mechanical_gate_passed'] else 'FAIL'} 0.30 cap), {_bg_clause(p)}\n"
            )
    lines.append(
        f"\n## Chosen value: denoise={chosen['denoise']}, seed={chosen['seed']}, "
        f"mechanism={chosen['mechanism']} (attempt {chosen_attempt})\n\n"
    )
    lines.append(DEFAULT_DENOISE_JUSTIFICATION + "\n\n")
    lo, hi = chosen["frame_delta_range"]
    lines.append(
        f"Measured frame-delta range at the chosen value: **{lo:.4f}-{hi:.4f}**. "
        f"{'Beats' if chosen['beats_030_cap'] else 'Does not beat'} the 0.30 cap. "
        f"{'Beats' if chosen['beats_arm_c_benchmark'] else 'Does not beat'} Arm C's "
        f"0.072-0.112 benchmark. {_bg_clause(chosen)}.\n"
    )
    SWEEP_REPORT_PATH.write_text("".join(lines))
    print(f"wrote {SWEEP_DATA_PATH} and {SWEEP_REPORT_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=int, help="attempt number, 1..8 (DL-21 cap)")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--denoise", type=float, help="img2img denoise for frames 1-8")
    parser.add_argument("--controlnet-strength", type=float, default=1.3)
    parser.add_argument("--controlnet-end", type=float, default=1.0)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=0.50)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's output to assets/final/character/ and exit",
    )
    parser.add_argument(
        "--denoise-justification",
        type=str,
        default=DEFAULT_DENOISE_JUSTIFICATION,
        help="only used with --promote-attempt",
    )
    parser.add_argument(
        "--write-sweep-report",
        type=str,
        help="comma-separated attempt numbers to summarise, e.g. 1,2,3,4,5",
    )
    parser.add_argument(
        "--chosen-attempt",
        type=int,
        help="which --write-sweep-report attempt was chosen/promoted",
    )
    parser.add_argument(
        "--reprocess-attempt",
        type=int,
        help=(
            "re-derive an existing attempt's sheet with the background-cutout step from its "
            "already-sampled per-frame images -- no new ComfyUI calls -- then exit"
        ),
    )
    args = parser.parse_args()

    if args.reprocess_attempt is not None:
        provenance = reprocess_attempt_cutout(args.reprocess_attempt)
        print(json.dumps(provenance, indent=2))
        return

    if args.write_sweep_report is not None:
        attempts = [int(a) for a in args.write_sweep_report.split(",")]
        chosen = args.chosen_attempt if args.chosen_attempt is not None else attempts[-1]
        write_sweep_report(attempts, chosen)
        return

    if args.promote_attempt is not None:
        out_dir = OUT_ROOT / f"attempt_{args.promote_attempt}"
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(out_dir, provenance, args.denoise_justification)
        print(f"promoted attempt {args.promote_attempt} -> {FINAL_SHEET_PATH}")
        return

    if args.attempt is None or args.seed is None or args.denoise is None:
        parser.error("--attempt, --seed and --denoise are required for a generation run")

    check_attempt_cap(args.attempt)

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        denoise=args.denoise,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
    )
    provenance["promoted"] = False
    out_dir = OUT_ROOT / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
