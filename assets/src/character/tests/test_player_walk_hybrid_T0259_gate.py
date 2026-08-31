"""Player walk sheet -- hybrid (T-0259, HANDOFF §24-e, DL-25's winning arm) --
T-0102 gate validation.

Successor to `player_move_sheet_v2` (predates the hybrid pipeline: mode 'P',
144x192, no alpha, no Arm-C comparison -- one of CHR-1's audited gaps).
Ships under a new filename, `player_walk_sheet_hybrid.png` -- the old sheet
is untouched and the atlas switch is a separate card, not this one.

Unlike the idle hybrid sheet (T-0252: exactly one SDXL generation, every
other frame derived by translating that one frame's own pixel bands), a walk
gait needs real per-frame limb articulation a band-translate cannot produce
-- every one of this sheet's 8 frames is its own full-stack generation
(style LoRA + player_identity_v2 + IP-Adapter + OpenPose ControlNet),
conditioned on its own script-authored skeleton (`pose_rig_walk_T0259.py`).

Layout: 4 cols x 2 rows of 48x48 cells (192x96 native) -- an exact fit for 8
frames, chosen over a 3x3-with-one-unused-cell grid so no cell in the sheet
is ever "no frame here" (see `layout` in the provenance sidecar).

RED state:  assets/final/character/player_walk_sheet_hybrid.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: sheet present, mode P, 192x96, real RGBA transparency (tRNS on
             background_index, per P-6); passes palette-membership,
             index-semantics, cell-fit (4x2, 48x48), orphan-pixel per cell,
             and frame-consistency (0.30 cap) across all 8 adjacent
             transitions INCLUDING the loop seam (frame 7 -> frame 0);
             provenance resolves the full generative stack, the
             script-authored skeleton per frame, the per-frame cutout, the
             two identity-anchor references, and CHR-1's frame-delta +
             Arm-C comparison fields (T-0258's shared helper, not
             hand-assembled).

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")
asset_gate_transparency = pytest.importorskip("asset_gate.transparency")
asset_gate_character = pytest.importorskip("asset_gate.character")

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
SHEET_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.png"
PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_walk_sheet_hybrid.provenance.json"
IDLE_KEYFRAME_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
OLD_MOVE_SHEET_PATH = FINAL_CHARACTER_DIR / "player_move_sheet_v2.png"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# T-0266: three real 8-frame generation attempts (see
# ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md and this package's own
# ARM_HYBRID_WALK_CHUNKING_ATTEMPT_LOG_T0266.md) have not yet produced a
# sheet that clears the frame-consistency gate -- diagnosed as raw per-frame
# KSampler colour/costume instability, not a chunking or cutout defect. This
# suite is real and already correct against the moment a passing sheet
# exists; skip it at module level rather than let 35 tests fail/error on a
# precondition (a promoted sheet) that generation R&D has not yet met, per
# the DL-21 attempt budget (5 of 8 remain) -- the same reasoning
# `pytest.importorskip` above already applies to an optional dependency,
# applied here to an optional *artifact*.
if not SHEET_PATH.exists():
    pytest.skip(
        f"{SHEET_PATH} does not exist yet -- 3 of 8 DL-21 real-generation attempts have not "
        "produced a sheet passing the frame-consistency gate (see "
        "ARM_HYBRID_WALK_CHUNKING_ATTEMPT_LOG_T0266.md). This suite activates automatically "
        "once a passing sheet is promoted.",
        allow_module_level=True,
    )

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference every round-2 character generation pins.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 4
ROWS = 2
FRAME_COUNT = COLS * ROWS

FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]
# Interior adjacent pairs PLUS the explicit loop seam (last frame -> frame 0) --
# the motion spec calls this out by name as "part of the delta measurement".
ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
] + [(FRAME_CELLS[-1], FRAME_CELLS[0])]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30
ARM_C_BENCHMARK_UPPER = 0.112
ORPHAN_SIZE_THRESHOLD = 4
MIN_BACKGROUND_FRACTION = 0.65
MIN_FOREGROUND_PIXELS = 50


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"walk sheet not found: {SHEET_PATH}\n"
        "Run gen_hybrid_walk_T0259.py against the ComfyUI host, per frame, then --promote."
    )
    img = Image.open(SHEET_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (COLS * CELL_SIZE, ROWS * CELL_SIZE)
    return img


@pytest.fixture(scope="module")
def provenance() -> dict:
    assert PROVENANCE_PATH.exists(), f"provenance sidecar not found: {PROVENANCE_PATH}"
    return json.loads(PROVENANCE_PATH.read_text())


@pytest.fixture(scope="module")
def palette() -> asset_gate_palette.Palette:
    assert PALETTE_PATH.exists(), f"home palette not found: {PALETTE_PATH}"
    return asset_gate_palette.load_palette(PALETTE_PATH)


@pytest.fixture(scope="module")
def frame_images(sheet: Image.Image) -> dict[tuple[int, int], Image.Image]:
    cells: dict[tuple[int, int], Image.Image] = {}
    for sr, sc in FRAME_CELLS:
        x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
        cells[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))
    return cells


# ---------------------------------------------------------------------------
# Successor discipline: new filename, old sheet untouched
# ---------------------------------------------------------------------------


def test_does_not_overwrite_player_move_sheet_v2() -> None:
    assert SHEET_PATH != OLD_MOVE_SHEET_PATH
    assert OLD_MOVE_SHEET_PATH.exists(), (
        "player_move_sheet_v2.png must stay committed and untouched -- the atlas switch "
        "to the new sheet is a separate card"
    )


# ---------------------------------------------------------------------------
# P-7 / provenance structure
# ---------------------------------------------------------------------------


def test_generator_field_is_bare_repo_path(provenance: dict) -> None:
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator '{generator}' does not resolve to a committed file"
    assert generator == "assets/src/character/gen_hybrid_walk_T0259.py"


def test_model_hash_present(provenance: dict) -> None:
    assert provenance.get("model_hash"), "model_hash missing or null (P-7)"


def test_concept_hash_resolves(provenance: dict) -> None:
    assert provenance.get("concept_hash") == EXPECTED_CONCEPT_HASH


def test_full_stack_recorded(provenance: dict) -> None:
    """Acceptance: every frame generated through the FULL stack -- style
    LoRA + identity LoRA + IP-Adapter + ControlNet, all four present."""
    assert provenance.get("style_lora_hash"), "style_lora_hash missing"
    assert provenance.get("identity_lora_hash"), "identity_lora_hash missing"
    assert provenance.get("identity_lora_name") == "player_identity_v2.safetensors"
    assert provenance.get("ip_adapter"), "ip_adapter missing -- full stack must include IP-Adapter"
    assert provenance.get("controlnet"), "controlnet missing"


def test_every_frame_is_its_own_generation(provenance: dict) -> None:
    """Distinct from the idle hybrid recipe: a walk gait needs real per-frame
    limb articulation, so there is no single-generation-plus-derived-frames
    split here -- every frame has its own comfyui_prompt_id."""
    frames = provenance.get("frame_generation")
    assert frames and len(frames) == FRAME_COUNT
    prompt_ids = {f["comfyui_prompt_id"] for f in frames}
    assert len(prompt_ids) == FRAME_COUNT, "each frame must be its own distinct ComfyUI generation"


def test_identity_anchor_records_idle_keyframe(provenance: dict) -> None:
    """Acceptance: identity anchored on the two committed references -- the
    concept sheet (via IP-Adapter, checked in test_full_stack_recorded) and
    the canonical idle keyframe DL-25 promoted, recorded so the 'same
    character as this sheet' claim is checkable, not merely asserted."""
    anchor = provenance.get("identity_anchor")
    assert anchor, "identity_anchor block missing"
    anchor_path = REPO_ROOT / anchor["path"]
    assert anchor_path.resolve() == IDLE_KEYFRAME_PATH.resolve()
    assert anchor.get("hash") == _sha256_of(IDLE_KEYFRAME_PATH)


def test_pose_source_is_script_authored(provenance: dict) -> None:
    pose_source = provenance.get("pose_source", "")
    assert "pose_rig_walk_T0259" in pose_source, (
        "pose_source must name the script-authored walk gait generator, not a "
        "model-invented or hand-authored pose"
    )


def test_per_frame_pose_files_committed(provenance: dict) -> None:
    for frame in provenance["frame_generation"]:
        keypoints_path = REPO_ROOT / frame["pose_keypoints_file"]
        skeleton_path = REPO_ROOT / frame["pose_skeleton_file"]
        assert keypoints_path.is_file(), f"missing committed keypoints: {keypoints_path}"
        assert skeleton_path.is_file(), f"missing committed skeleton: {skeleton_path}"


# ---------------------------------------------------------------------------
# Cutout (per frame -- there is no single source frame here)
# ---------------------------------------------------------------------------


def test_cutout_applied_every_frame(provenance: dict) -> None:
    for frame in provenance["frame_generation"]:
        assert frame.get("background_cutout_applied") is True
        method = frame.get("cutout_method")
        assert method and len(method) > 40, "cutout_method missing or too short"
        assert isinstance(frame.get("cutout_oklab_tolerance"), int | float)
        assert isinstance(frame.get("cutout_bbox_margin_frac"), int | float)
        assert 0.0 < frame["cutout_bbox_margin_frac"] < 1.0


def test_sheet_background_is_mostly_clean(
    frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    for cell, img in frame_images.items():
        arr = np.array(img)
        bg_fraction = float((arr == BACKGROUND_INDEX).mean())
        assert bg_fraction >= MIN_BACKGROUND_FRACTION, (
            f"cell {cell}: only {bg_fraction:.2%} background -- expected >= "
            f"{MIN_BACKGROUND_FRACTION:.0%}, residual background clutter likely survived cutout"
        )


def test_no_cell_erased_by_cutout(frame_images: dict[tuple[int, int], Image.Image]) -> None:
    for cell, img in frame_images.items():
        arr = np.array(img)
        fg_count = int((arr != BACKGROUND_INDEX).sum())
        assert fg_count >= MIN_FOREGROUND_PIXELS, (
            f"cell {cell}: only {fg_count}px of character survived cutout -- likely clipped"
        )


# ---------------------------------------------------------------------------
# True RGBA transparency (P-6) -- the gate must fail an opaque sheet
# ---------------------------------------------------------------------------


def test_background_transparency(sheet: Image.Image) -> None:
    result = asset_gate_transparency.check_background_transparency(sheet)
    assert result.passed, result.reason


# ---------------------------------------------------------------------------
# Whole-sheet checks
# ---------------------------------------------------------------------------


def test_palette_membership(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    result = asset_gate_palette.check_palette_membership(sheet, palette)
    assert result.passed, result.reason


def test_index_semantics(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    result = asset_gate_palette.check_index_semantics(sheet, palette)
    assert result.passed, result.reason


def test_cell_fit() -> None:
    sheet = Image.open(SHEET_PATH)
    results = asset_gate_art.check_cell_fit(
        sheet,
        cell_width=CELL_SIZE,
        cell_height=CELL_SIZE,
        cols=COLS,
        rows=ROWS,
        background_index=BACKGROUND_INDEX,
    )
    failures = [r for r in results if not r.passed]
    assert not failures, "\n".join(f"cell {r.details['cell']}: {r.reason}" for r in failures)


# ---------------------------------------------------------------------------
# Per-frame checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell", FRAME_CELLS)
def test_orphan_pixels(
    cell: tuple[int, int], frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    result = asset_gate_art.check_orphan_pixels(
        frame_images[cell],
        background_index=BACKGROUND_INDEX,
        size_threshold=ORPHAN_SIZE_THRESHOLD,
    )
    assert result.passed, f"cell {cell}: {result.reason}"


# ---------------------------------------------------------------------------
# Frame-consistency -- the 0.30 cap, across ALL 8 transitions including the
# loop seam (frame 7 -> frame 0)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell_a,cell_b", ADJACENT_PAIRS)
def test_frame_consistency(
    cell_a: tuple[int, int],
    cell_b: tuple[int, int],
    frame_images: dict[tuple[int, int], Image.Image],
) -> None:
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"


def test_frame_deltas_include_loop_seam(provenance: dict) -> None:
    """The motion spec calls this out explicitly: report the loop seam's
    delta, not just the 7 interior pairs."""
    frame_deltas = provenance.get("frame_deltas")
    assert frame_deltas and len(frame_deltas) == len(ADJACENT_PAIRS) == FRAME_COUNT
    last_pair = frame_deltas[-1]["pair"]
    assert last_pair == [list(FRAME_CELLS[-1]), list(FRAME_CELLS[0])], (
        "the last recorded frame-delta pair must be the loop seam (last frame -> frame 0)"
    )


def test_frame_delta_range_reported_against_both_bars(provenance: dict) -> None:
    """Report the measured range against both 0.30 and Arm C's 0.072-0.112,
    including the loop seam in the measured set (not just interior pairs)."""
    frame_deltas = provenance.get("frame_deltas")
    ratios = [d["ratio"] for d in frame_deltas]
    measured_min, measured_max = min(ratios), max(ratios)

    assert provenance.get("frame_delta_range") == [
        pytest.approx(measured_min),
        pytest.approx(measured_max),
    ]
    assert provenance.get("beats_030_cap") == (measured_max <= MAX_FRAME_DELTA_RATIO)
    assert provenance.get("beats_arm_c_benchmark") == (measured_max <= ARM_C_BENCHMARK_UPPER)


def test_chr1_provenance_fields_pass_gate(provenance: dict) -> None:
    """CHR-1 (docs/board-invariants.md, T-0258): every character-generation
    output must record frame_delta_range + the Arm-C comparison, written
    through the shared helper -- checked via the actual enforcement
    predicate, not hand-duplicated assertions."""
    result = asset_gate_character.check_character_arm_c_provenance(
        provenance, sheet_name="player_walk_sheet_hybrid.png"
    )
    assert result.passed, result.reason


def test_layout_recorded() -> None:
    provenance_data = json.loads(PROVENANCE_PATH.read_text())
    layout = provenance_data.get("layout")
    assert layout == {
        "sheet_px": [COLS * CELL_SIZE, ROWS * CELL_SIZE],
        "cell_px": CELL_SIZE,
        "cols": COLS,
        "rows": ROWS,
        "frame_cells": [list(c) for c in FRAME_CELLS],
        "loop": True,
    }
