"""Player idle sheet -- hybrid (T-0252, HANDOFF §24-e) -- T-0102 gate validation.

`docs/design/13-asset-pipeline.md` §3.5 (Characters -- the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall (DL-21 output spec,
  unchanged from round 1 -- round-2 rules forbid redefining the gate, the
  subject or the spec to fit a result).

Round 2 of the T-0227 character-pipeline bake-off tests the hybrid
hypothesis: exactly one idle frame generated through the full SDXL stack
(style LoRA + identity LoRA + IP-Adapter + ControlNet), every other frame
derived from that single generated frame by
`char_gen.synth_entities.generate_player_idle_sheet_hybrid_T0252` -- Arm C's
own committed `_player_pose_offsets` (T-0230), reused unchanged, applied to
the generated raster instead of a hardcoded shape.

Mirrors test_player_idle_arm_c_gate.py / test_player_idle_pose_authority_T0249_gate.py's
structure and thresholds, with provenance checks split across this round's
two-halves recipe -- see test_exactly_one_generation (the field that encodes
what actually makes this different from every other round-2 mechanism: there
is only ever one SDXL call) and test_arm_c_script_reused_not_forked (Arm C's
generator is reused, not duplicated).

RED state:  assets/final/character/player_idle_sheet_hybrid_T0252.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: sheet present, mode P, 144x144; passes palette-membership,
             index-semantics, cell-fit (3x3, 48x48), orphan-pixel per cell,
             frame-consistency (DL-21 criterion 2's mechanical delta gate)
             across all 8 adjacent-cell transitions, and provenance resolves
             both halves (generated source frame + script-derived frames),
             with the measured frame-delta range reported against both the
             0.30 cap and Arm C's 0.072-0.112 benchmark.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from gen_arm_a_idle_T0228 import _POSE_KEYPOINTS_NORM  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.provenance.json"
SOURCE_FRAME_PATH = FINAL_CHARACTER_DIR / "player_idle_frame_hybrid_source_T0252.png"
JUDGING_PREVIEW_PATH = FINAL_CHARACTER_DIR / "hybrid_judging_preview_T0252.gif"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference DL-21 pins for every bake-off round.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 3
ROWS = 3

FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]
ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30  # round-2 rule: same 0.30 cap as round 1 (DL-21 criterion 2)
ARM_C_BENCHMARK_UPPER = 0.112  # round-2 rule: the real bar to beat, not the pass/fail floor
ORPHAN_SIZE_THRESHOLD = 4  # blobs < 4 connected px are orphans (downscale noise)

# 2026-08-30 second human review: force_cell_corner_background (an exact-index,
# corner-connected flood) left a near-black halo around the figure -- a different
# quantized palette index from background_index but visually indistinguishable --
# counted as "foreground", inflating check_frame_consistency's union denominator
# (measured: 1470px of a 2304px cell, i.e. only 63.8% background). A real per-pixel
# cutout (gen_chained_idle_T0250.cutout_foreground_mask, reused unchanged, T-0250's
# own fix for the identical defect) leaves the great majority of the cell as
# background_index; Arm C's own committed frames measure background fraction
# 72.7%-73.4% (union 613-629px of 2304). 0.65 sits well above the broken 63.8%
# and comfortably below Arm C's own range, so it separates "cutout applied" from
# "cutout absent/broken" without being brittle to minor pose/seed variation.
MIN_BACKGROUND_FRACTION = 0.65
# A 40px-tall figure at DL-21's spec cannot legitimately collapse to a handful of
# pixels -- guards against a cutout so aggressive it erases the character along
# with the background.
MIN_FOREGROUND_PIXELS = 50
# The production cutout computes its keypoint bbox at 384x384 and downscales the
# resulting mask via an area filter; this test recomputes the same bbox directly
# at the 48x48 cell scale for an independent check, so the two can disagree by a
# pixel or two from rounding/downscale-threshold effects alone without that being
# residual background clutter.
BBOX_TEST_PIXEL_BUFFER = 3


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"hybrid idle sheet not found: {SHEET_PATH}\n"
        "Run gen_hybrid_source_idle_T0252.py against the ComfyUI host to produce the "
        "single source frame, then gen_hybrid_idle_T0252.py --promote to assemble and "
        "promote the sheet."
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
# Source-frame half (P-7, "full stack", "exactly one generation")
# ---------------------------------------------------------------------------


def test_source_frame_committed_and_indexed() -> None:
    assert SOURCE_FRAME_PATH.exists(), f"generated source frame not committed: {SOURCE_FRAME_PATH}"
    img = Image.open(SOURCE_FRAME_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (CELL_SIZE, CELL_SIZE)


def test_source_frame_concept_hash_resolves(provenance: dict) -> None:
    source = provenance.get("source_frame")
    assert source, "provenance missing 'source_frame' block"
    assert source.get("concept_hash") == EXPECTED_CONCEPT_HASH


def test_source_frame_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash must be non-null."""
    source = provenance["source_frame"]
    assert source.get("model_hash"), "source_frame.model_hash missing or null (P-7)"


def test_source_frame_full_stack_recorded(provenance: dict) -> None:
    """Acceptance: one frame generated through the FULL stack -- style LoRA +
    identity LoRA + IP-Adapter + ControlNet, all four present."""
    source = provenance["source_frame"]
    assert source.get("style_lora_hash"), "style_lora_hash missing"
    assert source.get("identity_lora_hash"), "identity_lora_hash missing"
    assert source.get("identity_lora_name") == "player_identity_v2.safetensors"
    assert source.get("ip_adapter"), "ip_adapter missing -- full stack must include IP-Adapter"
    assert source.get("controlnet"), "controlnet missing"


def test_exactly_one_generation(provenance: dict) -> None:
    """Acceptance: exactly one frame is generated through the full SDXL
    stack; every other frame is derived by the deterministic script -- no
    second generation anywhere in the pipeline."""
    source = provenance["source_frame"]
    assert isinstance(source.get("comfyui_prompt_id"), str) and source["comfyui_prompt_id"], (
        "source_frame.comfyui_prompt_id must be a single non-empty id string"
    )
    derived = provenance["derived_frames"]
    forbidden = ("comfyui_prompt_id", "model_hash", "lora_hash", "controlnet", "ip_adapter")
    present = [f for f in forbidden if f in derived]
    assert not present, f"derived_frames records diffusion-model field(s) {present}"
    assert provenance.get("total_comfyui_generations") == 1


def test_derived_frames_generator_resolves_to_committed_code(provenance: dict) -> None:
    derived = provenance["derived_frames"]
    generator = derived.get("generator", "")
    assert generator, "derived_frames.generator field missing"
    path_part = generator.split(":")[0]
    resolved = (REPO_ROOT / path_part).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"derived_frames.generator '{generator}' does not resolve"


def test_arm_c_script_reused_not_forked(provenance: dict) -> None:
    """Acceptance: Arm C's committed script is reused and extended, not
    forked or rewritten."""
    derived = provenance["derived_frames"]
    assert "char_gen/synth_entities.py" in derived.get("generator", ""), (
        "derived frames must come from the same committed char_gen.synth_entities module "
        "Arm C uses, extended -- not a forked copy"
    )


def test_generator_field_is_bare_repo_path(provenance: dict) -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative
    path, no free-text annotation suffix."""
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator '{generator}' does not resolve to a committed file"


def test_recipe_records_seed_and_transform_params(provenance: dict) -> None:
    """Acceptance: the recipe is committed end to end -- generation
    parameters + seed for the single source frame, and the transform
    parameters for each derived frame."""
    source = provenance["source_frame"]
    derived = provenance["derived_frames"]
    assert source.get("seed") is not None, "source_frame.seed missing"
    assert derived.get("seed") is not None, "derived_frames.seed missing"
    offsets = derived.get("offsets")
    assert offsets and len(offsets) == 9, (
        "derived_frames.offsets must record all 9 per-frame (head, arm, leg) offsets"
    )
    assert offsets[0] == [0, 0, 0], "frame 0 must be the untouched source frame (offset (0,0,0))"


def test_frame_delta_range_reported_against_both_bars(provenance: dict) -> None:
    """Round-2 rule: report the measured range against both 0.30 and Arm C's
    0.072-0.112, and say plainly which bar it beat."""
    frame_deltas = provenance.get("frame_deltas")
    assert frame_deltas and len(frame_deltas) == len(ADJACENT_PAIRS)
    ratios = [d["ratio"] for d in frame_deltas]
    measured_min, measured_max = min(ratios), max(ratios)

    assert provenance.get("frame_delta_range") == [
        pytest.approx(measured_min),
        pytest.approx(measured_max),
    ]
    assert provenance.get("beats_030_cap") == (measured_max <= MAX_FRAME_DELTA_RATIO)
    assert provenance.get("beats_arm_c_benchmark") == (measured_max <= ARM_C_BENCHMARK_UPPER)


def test_source_frame_background_cutout_applied(provenance: dict) -> None:
    """Acceptance (2026-08-30 second human review, same defect T-0250 already
    fixed once): the generated source frame must be cut out of its background
    with a real per-pixel segmentation, not a same-index corner flood --
    checkable via the provenance record, not merely asserted in prose."""
    source = provenance["source_frame"]
    assert source.get("background_cutout_applied") is True
    method = source.get("cutout_method")
    assert method and len(method) > 40, "cutout_method missing or too short"
    assert isinstance(source.get("cutout_oklab_tolerance"), int | float)
    assert isinstance(source.get("cutout_bbox_margin_frac"), int | float)
    assert 0.0 < source["cutout_bbox_margin_frac"] < 1.0


def test_source_frame_background_is_mostly_clean() -> None:
    """The committed source frame's own background pixels must actually be
    background_index, not merely a lower-delta shade of background clutter --
    a real per-pixel cutout leaves the great majority of the cell as
    background_index."""
    img = Image.open(SOURCE_FRAME_PATH)
    arr = np.array(img)
    bg_fraction = float((arr == BACKGROUND_INDEX).mean())
    assert bg_fraction >= MIN_BACKGROUND_FRACTION, (
        f"source frame: only {bg_fraction:.2%} background -- expected >= "
        f"{MIN_BACKGROUND_FRACTION:.0%}, residual background clutter likely survived cutout"
    )


def test_source_frame_silhouette_not_erased() -> None:
    """Acceptance ('do not clip the character during cutout'): the source
    frame must retain a plausible amount of character silhouette."""
    img = Image.open(SOURCE_FRAME_PATH)
    arr = np.array(img)
    fg_count = int((arr != BACKGROUND_INDEX).sum())
    assert fg_count >= MIN_FOREGROUND_PIXELS, (
        f"source frame: only {fg_count}px of character survived cutout (floor "
        f"{MIN_FOREGROUND_PIXELS}px) -- the cutout likely clipped the figure itself"
    )


def test_source_frame_no_foreground_outside_keypoint_bbox(provenance: dict) -> None:
    """No residual background clutter may survive far from the character: every
    non-background pixel in the source frame must fall within the fixed
    standing-idle pose's own keypoint bounding box (`_POSE_KEYPOINTS_NORM`,
    the same skeleton `draw_pose_skeleton_cell` rendered for this generation),
    expanded by the same margin the cutout itself used."""
    margin = provenance["source_frame"]["cutout_bbox_margin_frac"]
    xs = [x for x, _ in _POSE_KEYPOINTS_NORM.values()]
    ys = [y for _, y in _POSE_KEYPOINTS_NORM.values()]
    x0n, x1n = min(xs), max(xs)
    y0n, y1n = min(ys), max(ys)
    wn, hn = x1n - x0n, y1n - y0n
    x0n = max(0.0, x0n - wn * margin)
    x1n = min(1.0, x1n + wn * margin)
    y0n = max(0.0, y0n - hn * margin)
    y1n = min(1.0, y1n + hn * margin)

    arr = np.array(Image.open(SOURCE_FRAME_PATH))
    size = arr.shape[0]
    px0 = max(0, int(x0n * size) - BBOX_TEST_PIXEL_BUFFER)
    px1 = min(size, int(x1n * size) + BBOX_TEST_PIXEL_BUFFER)
    py0 = max(0, int(y0n * size) - BBOX_TEST_PIXEL_BUFFER)
    py1 = min(size, int(y1n * size) + BBOX_TEST_PIXEL_BUFFER)

    fg = arr != BACKGROUND_INDEX
    outside = fg.copy()
    outside[py0:py1, px0:px1] = False
    stray = int(outside.sum())
    assert stray == 0, (
        f"source frame: {stray} foreground px outside the keypoint bbox+margin "
        f"({px0},{py0})-({px1},{py1}) -- residual background clutter survived cutout"
    )


def test_judging_preview_gif_committed() -> None:
    """DL-21 judging conditions: at 40px, in motion, inside the T-0192
    blockout room -- not at native generation resolution, not as a static
    contact sheet."""
    assert JUDGING_PREVIEW_PATH.exists(), f"judging preview not found: {JUDGING_PREVIEW_PATH}"


# ---------------------------------------------------------------------------
# Whole-sheet checks
# ---------------------------------------------------------------------------


def test_palette_membership(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """All used pixel colours must be exact members of the home palette (P-4)."""
    result = asset_gate_palette.check_palette_membership(sheet, palette)
    assert result.passed, result.reason


def test_index_semantics(sheet: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """P-4: index N must resolve to the same RGB as home_palette slot N in every asset."""
    result = asset_gate_palette.check_index_semantics(sheet, palette)
    assert result.passed, result.reason


def test_cell_fit() -> None:
    """Each cell must not bleed foreground pixels into a neighbouring cell
    (13-asset-pipeline.md §2 cell-fit check)."""
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


def test_sheet_background_is_mostly_clean(
    frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    """Every derived frame only translates the source frame's own already-
    cutout-clean bands (transform_player_frame_from_source never re-quantizes
    or reintroduces background), so this must hold across all 9 assembled
    cells, not just the single source frame."""
    for cell, img in frame_images.items():
        arr = np.array(img)
        bg_fraction = float((arr == BACKGROUND_INDEX).mean())
        assert bg_fraction >= MIN_BACKGROUND_FRACTION, (
            f"cell {cell}: only {bg_fraction:.2%} background -- expected >= "
            f"{MIN_BACKGROUND_FRACTION:.0%}, residual background clutter likely survived cutout"
        )


# ---------------------------------------------------------------------------
# Per-frame checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell", FRAME_CELLS)
def test_orphan_pixels(
    cell: tuple[int, int], frame_images: dict[tuple[int, int], Image.Image]
) -> None:
    """No orphan pixel blobs smaller than ORPHAN_SIZE_THRESHOLD in any cell."""
    result = asset_gate_art.check_orphan_pixels(
        frame_images[cell],
        background_index=BACKGROUND_INDEX,
        size_threshold=ORPHAN_SIZE_THRESHOLD,
    )
    assert result.passed, f"cell {cell}: {result.reason}"


# ---------------------------------------------------------------------------
# Frame-consistency (DL-21 criterion 2 -- the mechanical half of "identity stable")
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell_a,cell_b", ADJACENT_PAIRS)
def test_frame_consistency(
    cell_a: tuple[int, int],
    cell_b: tuple[int, int],
    frame_images: dict[tuple[int, int], Image.Image],
) -> None:
    """Silhouette delta between adjacent cells must stay within
    MAX_FRAME_DELTA_RATIO -- the round-2 pass/fail floor. Beating Arm C's
    0.072-0.112 benchmark is the separate, harder bar
    (test_frame_delta_range_reported_against_both_bars)."""
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
