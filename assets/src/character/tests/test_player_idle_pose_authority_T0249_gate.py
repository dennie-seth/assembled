"""Player idle sheet -- pose authority (T-0249, HANDOFF §24-b / §24.4) --
T-0102 gate validation.

`docs/design/13-asset-pipeline.md` §3.5 (Characters -- the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall (DL-21 output spec,
  unchanged from round 1 -- round-2 rules forbid redefining the gate, the
  subject or the spec to fit a result).

Round 2 of the T-0227 character-pipeline bake-off, reframed by HANDOFF §24.4:
"the script becomes the pose authority" -- a deterministic script emits an
OpenPose-format 18-keypoint COCO skeleton per frame (reusing Arm A's
`draw_pose_skeleton_cell` renderer, parametrised) and every frame is
generated as its own 384x384 image (not a cell of a shared grid) with
identical seed/initial-latent/prompt, conditioned only on that frame's
skeleton. Runs against `player_identity_v2` (T-0248), stacking on top of
§24-a rather than replacing it.

Mirrors test_player_idle_arm_b_gate.py's structure and thresholds (DL-21
pins the same output spec and judging conditions to every round), with the
provenance checks swapped for this round's per-frame pose-authority
mechanism -- see test_frames_generated_identically_except_pose, the field
that encodes what actually makes this different from Arm A/B's shared-grid
mechanism, and test_identity_lora_is_v2, which guards Limit 2 (this must not
silently run against player_identity_v1, which would mask §24-a's
contribution).

RED state:  assets/final/character/player_idle_sheet_pose_authority_T0249.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: sheet present, mode P, 144x144; passes palette-membership,
             index-semantics, cell-fit (3x3, 48x48), orphan-pixel per cell,
             frame-consistency (DL-21 criterion 2's mechanical delta gate)
             across all 8 adjacent-cell transitions, and provenance resolves
             concept_hash / identity LoRA / animation-rig / generalisation
             evidence, with the measured frame-delta range reported against
             both the 0.30 cap and Arm C's 0.072-0.112 benchmark.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

REPO_ROOT = Path(__file__).resolve().parents[4]
CHARACTER_DIR = REPO_ROOT / "assets" / "src" / "character"
SHEET_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_pose_authority_T0249.png"
)
PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "final"
    / "character"
    / "player_idle_sheet_pose_authority_T0249.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference DL-21 pins for every bake-off round. This round traces
# it through player_identity_v2's own training provenance, same as Arm B.
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


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"pose-authority idle sheet not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_pose_authority_idle_T0249.py against the ComfyUI "
        "host (style LoRA + player_identity_v2 + OpenPose ControlNet, one 384x384 "
        "generation per frame conditioned on that frame's emitted skeleton) to produce it."
    )
    img = Image.open(SHEET_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (COLS * CELL_SIZE, ROWS * CELL_SIZE), (
        f"sheet size {img.size} != expected ({COLS * CELL_SIZE}, {ROWS * CELL_SIZE})"
    )
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
# Provenance checks (DL-21 output spec + P-7 + HANDOFF §24.4 acceptance)
# ---------------------------------------------------------------------------


def test_concept_hash(provenance: dict) -> None:
    assert "concept_hash" in provenance, "provenance JSON missing 'concept_hash' field"
    assert provenance["concept_hash"] == EXPECTED_CONCEPT_HASH


def test_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash must be non-null (DL-21 output spec)."""
    assert provenance.get("model_hash"), "model_hash missing or null in provenance JSON (P-7)"


def test_identity_lora_is_v2(provenance: dict) -> None:
    """Limit 2: runs on top of §24-a's player_identity_v2, not v1 -- masking
    §24-a's contribution would teach round 2 nothing about which change did
    the work."""
    assert provenance.get("identity_lora_name") == "player_identity_v2.safetensors"
    assert provenance.get("identity_lora_hash"), "identity_lora_hash missing"


def test_identity_lora_training_provenance_resolves(provenance: dict) -> None:
    identity_provenance = provenance.get("identity_lora_provenance")
    assert identity_provenance, "identity_lora_provenance field missing"
    resolved = (REPO_ROOT / identity_provenance).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), (
        f"identity_lora_provenance '{identity_provenance}' does not resolve to a committed file"
    )


def test_controlnet_and_style_lora_recorded(provenance: dict) -> None:
    assert provenance.get("controlnet"), "controlnet field missing"
    assert provenance.get("style_lora_hash"), "style_lora_hash missing"


def test_controlnet_strength_recorded_honestly(provenance: dict) -> None:
    """Limit 1: the ControlNet strength actually used must be reported, not
    just described in prose as 'strong'."""
    assert isinstance(provenance.get("controlnet_strength"), int | float)
    assert isinstance(provenance.get("controlnet_end_percent"), int | float)


def test_pose_source_is_script_not_a_preprocessor(provenance: dict) -> None:
    """Acceptance: no dependency on a DWPose/OpenPose preprocessor node --
    none is installed on this ComfyUI host."""
    pose_source = provenance.get("pose_source", "")
    assert "pose_rig_T0249" in pose_source
    assert "preprocessor" not in pose_source.lower()


def test_frames_generated_identically_except_pose(provenance: dict) -> None:
    """Acceptance: seed, initial latent and prompt provably identical across
    all frames -- the committed recipe makes this checkable via the
    provenance record, not merely asserted in prose."""
    frames = provenance.get("frame_generation")
    assert frames and len(frames) == 9, "provenance must record all 9 per-frame generations"
    seeds = {f["seed"] for f in frames}
    widths = {f["width"] for f in frames}
    heights = {f["height"] for f in frames}
    prompts = {f["prompt"] for f in frames}
    skeletons = {f["pose_keypoints_file"] for f in frames}
    assert len(seeds) == 1, "seed differs across frames"
    assert len(widths) == 1 and len(heights) == 1, "initial latent size differs across frames"
    assert len(prompts) == 1, "prompt differs across frames"
    assert len(skeletons) == 9, "every frame must reference its own distinct emitted skeleton"


def test_per_frame_keypoint_files_resolve(provenance: dict) -> None:
    for frame in provenance["frame_generation"]:
        path = (REPO_ROOT / frame["pose_keypoints_file"]).resolve()
        path.relative_to(REPO_ROOT.resolve())
        assert path.is_file(), (
            f"{frame['pose_keypoints_file']} does not resolve to a committed file"
        )
        keypoints = json.loads(path.read_text())
        assert len(keypoints) == 18, "each committed keypoint file must carry all 18 COCO joints"


def test_animation_parameters_committed_as_data(provenance: dict) -> None:
    """Acceptance: breathing amplitude, weight-shift extent, timing and
    easing are editable numbers in a committed file, not constants buried in
    code."""
    rig_path = provenance.get("animation_params")
    assert rig_path, "animation_params field missing"
    resolved = (REPO_ROOT / rig_path).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file()
    rig = json.loads(resolved.read_text())
    idle = rig["states"]["idle"]
    for key in ("breathing_amplitude_norm", "weight_shift_extent_norm", "easing", "frame_count"):
        assert key in idle, f"rig state missing directable parameter {key!r}"


def test_rig_generalisation_evidence_recorded(provenance: dict) -> None:
    """Acceptance: the card states explicitly whether the same skeleton
    generator can drive another state, with evidence."""
    evidence = provenance.get("rig_generalization_evidence")
    assert evidence, "rig_generalization_evidence field missing"
    resolved = (REPO_ROOT / evidence).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"{evidence} does not resolve to a committed file"


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


def test_generator_field_is_bare_repo_path(provenance: dict) -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative
    path, no free-text annotation suffix."""
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator '{generator}' does not resolve to a committed file"


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
