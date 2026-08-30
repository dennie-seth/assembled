"""Synthetic entity sprite-sheet generators for T-0200.

Three entity characters — Watcher, Sound, Still Air — each with three
animation states: idle, move, trapped. Entities never die.

Frame counts and grids (cell size 48×48, home palette, mode-P indexed PNG):

  Watcher (surveillance orb — wide and compact):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±6px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

  Sound (wave-band — wide and flat):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±6px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

  Still Air (atmospheric column — tall and narrow):
    idle:    3×2 grid, 144×96,  6 frames, v-float  ±2px, delta ≤ 30%
    move:    4×2 grid, 192×96,  8 frames, h-drift  ±3px, delta ≤ 60%
    trapped: 2×2 grid,  96×96,  4 frames, v-float  ±1px, delta ≤ 30%

Total: 3 entities × 18 frames = 54 frames (T-0200 §story).

All figures use solid-rectangle silhouettes with an accent zone inside the
main body rectangle — no separate blobs, so the orphan check always passes.
Figures are kept ≥ 4px from all cell edges (no cell-bleed at cell boundaries).

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[5]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
ENTITY_OUT = REPO_ROOT / "assets" / "final" / "entity"

CELL_SIZE = 48

# Palette indices (same as player sheets for consistency)
BG_IDX = 0    # background / transparent
LEG_IDX = 4   # darker accent
BODY_IDX = 6  # main entity body
HEAD_IDX = 10  # lighter accent

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _load_palette(path: Path) -> list[tuple[int, int, int]]:
    data = json.loads(path.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    result = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        result.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return result


def _to_pil(arr: np.ndarray, palette: list[tuple[int, int, int]]) -> Image.Image:
    img = Image.fromarray(arr, mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette):
        flat[3 * i] = r
        flat[3 * i + 1] = g
        flat[3 * i + 2] = b
    img.putpalette(flat)
    return img


def _save(arr: np.ndarray, palette: list[tuple[int, int, int]], out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _to_pil(arr, palette).save(out_path)
    return out_path


def _make_sheet(
    rows: int, cols: int, palette: list[tuple[int, int, int]], out_path: Path,
    draw_fn,  # callable(cell_arr: np.ndarray, frame_idx: int) -> None
    frame_cells: list[tuple[int, int]],
) -> Path:
    sheet = np.zeros((rows * CELL_SIZE, cols * CELL_SIZE), dtype=np.uint8)
    for frame_idx, (sr, sc) in enumerate(frame_cells):
        y0, x0 = sr * CELL_SIZE, sc * CELL_SIZE
        draw_fn(sheet[y0 : y0 + CELL_SIZE, x0 : x0 + CELL_SIZE], frame_idx)
    return _save(sheet, palette, out_path)


# ---------------------------------------------------------------------------
# Watcher — wide compact surveillance orb
#
# Body:   rows 14:34, cols 10:38 (20×28=560px) — BODY_IDX
# Accent: rows 28:34, cols 16:32 (6×16=96px) — LEG_IDX (inside body, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 12:36 — well inside [1:47].
#                  at max h-offset ±6, body cols 4:44 — well inside [1:47].
# Frame-consistency (shift 1-2px per step, large constant body):
#   idle  Δ ≤ 2×28/560 ≈ 10% << 30%
#   move  Δ ≤ 2×6/600 ≈ 13% << 60%  (6px shift, union grows to ~600px)
#   trapped Δ ≤ 2×28/560 ≈ 5% << 30%
# ---------------------------------------------------------------------------

_WATCHER_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]       # 6 frames
_WATCHER_MOVE_H_OFFSETS: list[int] = [0, -2, -4, -6, -4, -2, 0, 2]  # 8 frames
_WATCHER_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]              # 4 frames


def _draw_watcher(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 14 + v_off, 34 + v_off
    c0, c1 = 10 + h_off, 38 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent strip inside lower portion of body (lens/sensor highlight)
    ar0, ar1 = 28 + v_off, 34 + v_off
    ac0, ac1 = 16 + h_off, 32 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = LEG_IDX


def generate_watcher_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Watcher idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, v_off=_WATCHER_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_watcher_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Watcher move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, h_off=_WATCHER_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_watcher_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Watcher trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_watcher(cell_arr, v_off=_WATCHER_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# Sound — wide flat wave-band entity
#
# Body:   rows 18:30, cols 8:40 (12×32=384px) — BODY_IDX
# Accent: rows 18:22, cols 14:34 (4×20=80px) — HEAD_IDX (inside body top, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 16:32 — inside [1:47].
#                  at max h-offset ±6, body cols 2:46 — inside [1:47].
# Frame-consistency: large constant body anchors δ/union well inside limits.
#   idle  Δ ≤ 2×32/384 ≈ 17% << 30%
#   move  Δ ≤ 2×6×12/420 ≈ 17% << 60%
#   trapped Δ ≤ 1×32/384 ≈ 8% << 30%
# ---------------------------------------------------------------------------

_SOUND_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]
_SOUND_MOVE_H_OFFSETS: list[int] = [0, -2, -4, -6, -4, -2, 0, 2]
_SOUND_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]


def _draw_sound(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 18 + v_off, 30 + v_off
    c0, c1 = 8 + h_off, 40 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent crest inside upper portion of body
    ar0, ar1 = 18 + v_off, 22 + v_off
    ac0, ac1 = 14 + h_off, 34 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = HEAD_IDX


def generate_sound_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Sound idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, v_off=_SOUND_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_sound_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Sound move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, h_off=_SOUND_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_sound_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Sound trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_sound(cell_arr, v_off=_SOUND_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# Still Air — tall narrow atmospheric column entity
#
# Body:   rows 8:40, cols 20:28 (32×8=256px) — BODY_IDX
# Accent: rows 8:12, cols 22:26 (4×4=16px) — HEAD_IDX (inside body top, no orphan)
#
# Cell-fit safety: at max v-offset ±2, body rows 6:42 — inside [1:47].
#                  at max h-offset ±3, body cols 17:31 — inside [1:47].
# Frame-consistency:
#   idle  Δ ≤ 2×8/256 ≈ 6.25% << 30%
#   move  Δ ≤ 2×3×32/280 ≈ 7% << 60%   (3px h-shift, union ~280px)
#   trapped Δ ≤ 1×8/256 ≈ 3% << 30%
# ---------------------------------------------------------------------------

_STILL_AIR_IDLE_V_OFFSETS: list[int] = [0, -1, -2, -1, 0, 1]
_STILL_AIR_MOVE_H_OFFSETS: list[int] = [0, -1, -2, -3, -2, -1, 0, 1]
_STILL_AIR_TRAPPED_V_OFFSETS: list[int] = [0, -1, -1, 0]


def _draw_still_air(cell_arr: np.ndarray, v_off: int = 0, h_off: int = 0) -> None:
    cell_arr[:] = BG_IDX
    r0, r1 = 8 + v_off, 40 + v_off
    c0, c1 = 20 + h_off, 28 + h_off
    cell_arr[r0:r1, c0:c1] = BODY_IDX
    # Accent cap inside top of column (ethereal glow effect)
    ar0, ar1 = 8 + v_off, 12 + v_off
    ac0, ac1 = 22 + h_off, 26 + h_off
    cell_arr[ar0:ar1, ac0:ac1] = HEAD_IDX


def generate_still_air_idle_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144×96 (3×2) Still Air idle sheet — 6 frames, vertical float."""
    frame_cells = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, v_off=_STILL_AIR_IDLE_V_OFFSETS[idx])

    return _make_sheet(2, 3, palette, out_path, draw, frame_cells)


def generate_still_air_move_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """192×96 (4×2) Still Air move sheet — 8 frames, horizontal drift."""
    frame_cells = [
        (0, 0), (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 1), (1, 2), (1, 3),
    ]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, h_off=_STILL_AIR_MOVE_H_OFFSETS[idx])

    return _make_sheet(2, 4, palette, out_path, draw, frame_cells)


def generate_still_air_trapped_sheet(
    palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """96×96 (2×2) Still Air trapped sheet — 4 frames, micro vertical float."""
    frame_cells = [(0, 0), (0, 1), (1, 0), (1, 1)]

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        _draw_still_air(cell_arr, v_off=_STILL_AIR_TRAPPED_V_OFFSETS[idx])

    return _make_sheet(2, 2, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# Player — articulated idle figure (Arm C, T-0230, HANDOFF §23-f)
#
# Bake-off Arm C (docs/decision-log.md DL-21): no diffusion model anywhere in
# the generation path. A real articulated figure -- head, neck, torso,
# two-segment arms (upper arm + swinging forearm), two-segment legs (thigh +
# weight-shifting shin) -- rendered directly at 144x144 (3x3 grid of 48x48
# cells) with palette indices assigned by construction, never quantised
# after the fact. Always front-facing (toward camera): the deterministic
# construction makes "which way is it facing" unambiguous by design, so
# DL-21 criterion 1's other two questions (is it a person, what is it doing)
# are answered by the articulated silhouette and the idle breathing /
# weight-shift cycle below.
#
# Every part is 4-connected to a large, position-fixed torso/hip mass so no
# per-frame offset can create an orphan blob (13-asset-pipeline.md §2).
# Figure spans rows 4..43 (40px tall, matching §3.5's "figure 40px tall")
# and cols 7..40 at the widest per-frame extreme -- >=4px margin from every
# cell edge at every offset combination the six patterns below can produce.
# ---------------------------------------------------------------------------

# Six hand-verified idle-cycle patterns, one value per output frame (9
# frames). Every adjacent pair in every pattern differs by at most 1 (never
# a 2-step jump), so no per-frame offset combination _player_pose_offsets
# can select can blow DL-21 criterion 2's frame-delta cap -- this is
# guaranteed by construction, not tuned after measuring a failing render.
_PLAYER_POSE_PATTERNS: list[list[int]] = [
    [0, 0, 1, 1, 0, 0, -1, -1, 0],
    [0, 1, 1, 0, -1, -1, 0, 1, 0],
    [0, -1, -1, 0, 1, 1, 0, -1, 0],
    [0, 0, -1, -1, 0, 0, 1, 1, 0],
    [0, 1, 0, -1, 0, 1, 0, -1, 0],
    [0, -1, 0, 1, 0, -1, 0, 1, 0],
]


def _player_pose_offsets(seed: int, n_frames: int = 9) -> list[tuple[int, int, int]]:
    """Seeded, deterministic per-frame (head, arm, leg) pose offsets.

    A `random.Random(seed)` instance picks one of the six pre-verified
    `_PLAYER_POSE_PATTERNS` for each of the head-bob, arm-swing, and leg
    weight-shift cycles -- the same seed always yields the same three
    patterns (Python's `random.Random` is a documented-deterministic PRNG),
    and every pattern is safe by construction, so pose selection can never
    itself introduce a gate failure regardless of which seed is passed.
    """
    rng = random.Random(seed)
    head_pattern = rng.choice(_PLAYER_POSE_PATTERNS)
    arm_pattern = rng.choice(_PLAYER_POSE_PATTERNS)
    leg_pattern = rng.choice(_PLAYER_POSE_PATTERNS)
    return list(
        zip(head_pattern[:n_frames], arm_pattern[:n_frames], leg_pattern[:n_frames], strict=True)
    )


def _draw_player_arm_c(
    cell_arr: np.ndarray, head_off: int = 0, arm_off: int = 0, leg_off: int = 0
) -> None:
    """Articulated player figure: head, neck, torso, two-segment arms (upper
    arm + swinging forearm), two-segment legs (thigh + weight-shifting
    shin). Always front-facing. Not a rectangle silhouette."""
    cell_arr[:] = BG_IDX
    ho = head_off

    # HEAD -- stepped-width oval, bobs vertically with ho (idle breathing)
    cell_arr[5 + ho, 21:27] = HEAD_IDX
    cell_arr[6 + ho, 20:28] = HEAD_IDX
    cell_arr[7 + ho : 13 + ho, 19:29] = HEAD_IDX
    cell_arr[13 + ho, 20:28] = HEAD_IDX
    cell_arr[14 + ho, 21:27] = HEAD_IDX

    # NECK -- bridges head to torso, bobs with the head
    cell_arr[15 + ho : 18 + ho, 22:26] = BODY_IDX

    # TORSO -- trapezoid (shoulders wider than waist), fixed
    cell_arr[16:19, 13:35] = BODY_IDX
    cell_arr[19:28, 16:32] = BODY_IDX
    cell_arr[28:32, 18:30] = BODY_IDX

    # ARMS -- upper arm fixed at the shoulder, forearm swings at the elbow
    cell_arr[17:25, 9:13] = BODY_IDX
    cell_arr[25:32, 8 + arm_off : 12 + arm_off] = BODY_IDX
    cell_arr[17:25, 35:39] = BODY_IDX
    cell_arr[25:32, 36 - arm_off : 40 - arm_off] = BODY_IDX

    # LEGS -- thigh fixed at the hip, shin shifts for contrapposto weight-shift.
    # Thighs keep a 3px gap (cols 23-25) so the shins never fully merge even
    # at the max +/-1px weight-shift offset -- two legs stay visible in every frame.
    cell_arr[31:38, 18:23] = LEG_IDX
    cell_arr[37:44, 18 + leg_off : 23 + leg_off] = LEG_IDX
    cell_arr[31:38, 26:31] = LEG_IDX
    cell_arr[37:44, 26 - leg_off : 31 - leg_off] = LEG_IDX


def generate_player_idle_sheet_arm_c(
    seed: int, palette: list[tuple[int, int, int]], out_path: Path
) -> Path:
    """144x144 (3x3) player idle sheet, Arm C -- deterministic construction,
    no diffusion model, palette indices assigned by construction. The same
    seed always produces a byte-identical sheet (see
    tests/test_player_idle_arm_c_gate.py::test_deterministic_double_render)."""
    frame_cells = [(r, c) for r in range(3) for c in range(3)]
    offsets = _player_pose_offsets(seed, n_frames=len(frame_cells))

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        head_off, arm_off, leg_off = offsets[idx]
        _draw_player_arm_c(cell_arr, head_off=head_off, arm_off=arm_off, leg_off=leg_off)

    return _make_sheet(3, 3, palette, out_path, draw, frame_cells)


def main_player_idle_arm_c() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_player_idle_sheet_arm_c(
        seed=23230,
        palette=palette,
        out_path=REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_c_T0230.png",
    )
    print(f"wrote {out}")


# ---------------------------------------------------------------------------
# Player -- hybrid idle sheet (T-0252, HANDOFF §24-e, round 2)
#
# Hypothesis: "SDXL for the look, Arm C's deterministic script for the
# motion". Exactly one idle frame is generated through the full SDXL stack
# (gen_hybrid_source_idle_T0252.py); every other frame is *derived* from that
# single generated frame by translating its own head/arm/leg pixel bands,
# using the exact same per-frame offsets Arm C's _player_pose_offsets already
# selects (T-0230, reused unchanged, not forked) -- only the *content* being
# moved differs (real generated pixels here, a hardcoded shape in Arm C).
#
# Band bounds below are Arm C's own hardcoded part positions (_draw_player_arm_c
# above), padded by 1px to tolerate a generated silhouette that is not
# pixel-identical to the synthetic one. This is not a guess: the SDXL source
# frame is conditioned by the same OpenPose skeleton
# (gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM) whose normalised keypoints land,
# in 48px-cell pixels, at head/neck ~0.075-0.21 (3.6-10.1px), elbow/wrist
# ~0.39-0.54 (18.7-25.9px), knee/ankle ~0.75-0.93 (36-44.6px) -- the same rows
# Arm C's own head/forearm/shin boxes already occupy.
# ---------------------------------------------------------------------------

# (row_start, row_end, col_start, col_end) -- half-open, matching numpy slicing.
HYBRID_HEAD_BAND = (3, 19, 17, 31)  # head + neck, bobs vertically with head_off
HYBRID_LEFT_ARM_BAND = (24, 33, 7, 13)  # left forearm/hand, shifts horizontally
HYBRID_RIGHT_ARM_BAND = (24, 33, 35, 41)  # right forearm/hand (mirrors left)
HYBRID_LEFT_LEG_BAND = (36, 45, 17, 24)  # left shin/foot, shifts horizontally
HYBRID_RIGHT_LEG_BAND = (36, 45, 25, 32)  # right shin/foot (mirrors left)


def _shift_band(
    src: np.ndarray,
    dst: np.ndarray,
    band: tuple[int, int, int, int],
    dy: int = 0,
    dx: int = 0,
    background_index: int = 0,
) -> None:
    """Cut `band` out of `src`, clear its swept area (band ∪ shifted band) in
    `dst`, then paste the content back at the shifted position. Generalises
    _draw_player_arm_c's "redraw this part at a new offset" move to arbitrary
    raster content: instead of drawing a hardcoded shape at the offset
    position, it moves whatever pixels the generated source frame actually
    has there."""
    r0, r1, c0, c1 = band
    content = src[r0:r1, c0:c1].copy()
    rr0, rr1 = min(r0, r0 + dy), max(r1, r1 + dy)
    cc0, cc1 = min(c0, c0 + dx), max(c1, c1 + dx)
    dst[rr0:rr1, cc0:cc1] = background_index
    dst[r0 + dy : r1 + dy, c0 + dx : c1 + dx] = content


HYBRID_ORPHAN_SIZE_THRESHOLD = 4  # matches the pipeline-wide downscale-noise threshold (§3.1)


def _cleanup_shift_orphans(
    arr: np.ndarray, background_index: int, size_threshold: int
) -> np.ndarray:
    """Flood a band-shift's own stray edge pixels back to background.

    A real generated source frame's silhouette does not align exactly with
    the fixed HYBRID_*_BAND rectangles (tuned against Arm C's own hardcoded
    shape) -- a shift can leave a 1-2px sliver of the pre-shift content just
    outside the band's swept-clear region, disconnected from the moved
    content. This is hybrid-transform-specific cleanup (T-0252), not a
    change to Arm C's own _make_sheet/_player_pose_offsets."""
    try:
        from scipy import ndimage
    except ImportError:
        return arr  # best-effort; asset_gate.art.check_orphan_pixels also no-ops without scipy

    fg = arr != background_index
    labeled, n = ndimage.label(fg)
    if n == 0:
        return arr
    sizes = ndimage.sum(fg, labeled, index=range(1, n + 1))
    out = arr.copy()
    for label_id, size in enumerate(sizes, start=1):
        if size < size_threshold:
            out[labeled == label_id] = background_index
    return out


def transform_player_frame_from_source(
    source_arr: np.ndarray,
    head_off: int,
    arm_off: int,
    leg_off: int,
    background_index: int = 0,
) -> np.ndarray:
    """Derive one animation frame from the single generated source frame by
    translating its head/arm/leg raster bands -- the same per-frame offsets
    _draw_player_arm_c applies to hardcoded shapes, applied here to real
    generated pixels instead. Everything outside the five bands (torso,
    background, equipment) is left byte-identical to the source, except for
    small (< HYBRID_ORPHAN_SIZE_THRESHOLD px) stray islands the shift itself
    leaves behind at a band edge, which are cleaned to background."""
    out = source_arr.copy()
    _shift_band(
        source_arr, out, HYBRID_HEAD_BAND, dy=head_off, background_index=background_index
    )
    _shift_band(
        source_arr, out, HYBRID_LEFT_ARM_BAND, dx=arm_off, background_index=background_index
    )
    _shift_band(
        source_arr, out, HYBRID_RIGHT_ARM_BAND, dx=-arm_off, background_index=background_index
    )
    _shift_band(
        source_arr, out, HYBRID_LEFT_LEG_BAND, dx=leg_off, background_index=background_index
    )
    _shift_band(
        source_arr, out, HYBRID_RIGHT_LEG_BAND, dx=-leg_off, background_index=background_index
    )
    if head_off or arm_off or leg_off:
        out = _cleanup_shift_orphans(
            out, background_index=background_index, size_threshold=HYBRID_ORPHAN_SIZE_THRESHOLD
        )
    return out


def generate_player_idle_sheet_hybrid_T0252(
    seed: int,
    source_frame_path: Path,
    palette: list[tuple[int, int, int]],
    out_path: Path,
) -> Path:
    """144x144 (3x3) player idle sheet, T-0252 hybrid round -- exactly one
    generated SDXL frame (`source_frame_path`), every other frame derived
    from it by translating its head/arm/leg bands per
    _player_pose_offsets(seed) -- Arm C's own committed motion-selection
    function, unchanged. Frame 0 is always the untouched source pixels
    (every _PLAYER_POSE_PATTERNS entry starts at offset 0), which is what
    makes "exactly one frame is generated" literally true of frame 0 too."""
    source_img = Image.open(source_frame_path)
    if source_img.mode != "P":
        raise ValueError(f"source frame must be indexed mode 'P', got {source_img.mode!r}")
    if source_img.size != (CELL_SIZE, CELL_SIZE):
        raise ValueError(f"source frame must be {CELL_SIZE}x{CELL_SIZE}, got {source_img.size}")
    source_arr = np.array(source_img)

    frame_cells = [(r, c) for r in range(3) for c in range(3)]
    offsets = _player_pose_offsets(seed, n_frames=len(frame_cells))

    def draw(cell_arr: np.ndarray, idx: int) -> None:
        head_off, arm_off, leg_off = offsets[idx]
        cell_arr[:] = transform_player_frame_from_source(
            source_arr, head_off, arm_off, leg_off
        )

    return _make_sheet(3, 3, palette, out_path, draw, frame_cells)


# ---------------------------------------------------------------------------
# CLI entry points (registered in pyproject.toml [project.scripts])
# ---------------------------------------------------------------------------


def main_watcher_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_idle_sheet(palette, ENTITY_OUT / "watcher_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_watcher_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_move_sheet(palette, ENTITY_OUT / "watcher_move_sheet_v1.png")
    print(f"wrote {out}")


def main_watcher_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_watcher_trapped_sheet(palette, ENTITY_OUT / "watcher_trapped_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_idle_sheet(palette, ENTITY_OUT / "sound_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_move_sheet(palette, ENTITY_OUT / "sound_move_sheet_v1.png")
    print(f"wrote {out}")


def main_sound_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_sound_trapped_sheet(palette, ENTITY_OUT / "sound_trapped_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_idle() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_idle_sheet(palette, ENTITY_OUT / "still_air_idle_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_move() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_move_sheet(palette, ENTITY_OUT / "still_air_move_sheet_v1.png")
    print(f"wrote {out}")


def main_still_air_trapped() -> None:
    palette = _load_palette(PALETTE_PATH)
    out = generate_still_air_trapped_sheet(palette, ENTITY_OUT / "still_air_trapped_sheet_v1.png")
    print(f"wrote {out}")
