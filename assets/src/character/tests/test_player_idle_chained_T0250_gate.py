"""Player idle sheet -- chained img2img (T-0250, HANDOFF §24-c) -- T-0102 gate
validation.

`docs/design/13-asset-pipeline.md` §3.5 (Characters -- the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall (DL-21 output spec,
  unchanged from round 1 -- round-2 rules forbid redefining the gate, the
  subject or the spec to fit a result).

Round 2 of the T-0227 character-pipeline bake-off, §24-c: instead of asking
the model to independently re-derive the same character for every frame
(T-0249's §24-b, one fresh 384x384 generation per frame conditioned only on
that frame's skeleton), frame 1 onward is an **img2img pass from its
predecessor's own output** at low denoise, so appearance is inherited rather
than re-invented each frame. Frame 0 is still generated fresh -- there is no
predecessor to chain from. Composes directly on top of §24-b: this module
reuses `gen_pose_authority_idle_T0249.build_graph` unchanged for frame 0 and
patches only the latent source (EmptyLatentImage -> VAEEncode of the previous
frame) and denoise for frames 1-8.

Mirrors test_player_idle_pose_authority_T0249_gate.py's structure and
thresholds (DL-21 pins the same output spec and judging conditions to every
round), with additional checks specific to this round's hypothesis: frame 0
must be fresh and every other frame must be recorded as chained from its
immediate predecessor, the denoise value must be recorded and justified, and
a denoise-sweep report/data file (covering the ~0.25-0.35 band plus both
failure-mode edges) must be committed and resolvable.

RED state:  assets/final/character/player_idle_sheet_chained_T0250.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests
            ERROR.
GREEN state: sheet present, mode P, 144x144; passes palette-membership,
             index-semantics, cell-fit (3x3, 48x48), orphan-pixel per cell,
             frame-consistency (DL-21 criterion 2's mechanical delta gate)
             across all 8 adjacent-cell transitions, frame 0 recorded fresh
             and frames 1-8 recorded chained, denoise value + justification
             + sweep report/data resolve, and provenance resolves
             concept_hash / identity LoRA / animation-rig / generalisation
             evidence, with the measured frame-delta range reported against
             both the 0.30 cap and Arm C's 0.072-0.112 benchmark.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

REPO_ROOT = Path(__file__).resolve().parents[4]
CHARACTER_DIR = REPO_ROOT / "assets" / "src" / "character"
SHEET_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_chained_T0250.png"
)
PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_chained_T0250.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
SWEEP_REPORT_PATH = CHARACTER_DIR / "DENOISE_SWEEP_REPORT_T0250.md"
SWEEP_DATA_PATH = CHARACTER_DIR / "DENOISE_SWEEP_T0250.json"

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

# 2026-08-30 human review: check_frame_consistency (inter-frame silhouette delta)
# passed a sheet that was visually unusable -- background noise accumulating frame
# over frame, invisible to a *relative* delta measure. 1.35 is the T-0249 (§24-b,
# independent per-frame generation, no chaining) baseline shape: non-background
# pixel count fluctuates 421-566px across its 9 frames with no trend, a ratio of
# 566/421 ~= 1.34. The promoted attempt this review rejected measured 1280->832
# *clean* background pixels (i.e. non-background 1024px->1472px, ratio ~1.44) --
# above this bound. 1.35 sits just above ordinary pose-driven fluctuation and
# below the rejected sheet's measured growth, so it separates the two.
MAX_BACKGROUND_GROWTH_RATIO = 1.35

SWEEP_BAND_LOW = 0.25
SWEEP_BAND_HIGH = 0.35


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"chained idle sheet not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_chained_idle_T0250.py against the ComfyUI host "
        "(frame 0 fresh, frames 1-8 img2img-chained from their predecessor at low "
        "denoise) to produce it."
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


def _is_git_tracked(path: Path) -> bool:
    """A file that only exists in the untracked working tree (e.g. under the
    gitignored assets/out/) would pass a bare path.is_file() check on this
    machine and still dangle on a fresh clone -- P-3/P-7 require the
    referenced bytes to actually be committed, not merely present here."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "--error-unmatch", str(path)],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


# ---------------------------------------------------------------------------
# Provenance checks (DL-21 output spec + P-7 + HANDOFF §24-c acceptance)
# ---------------------------------------------------------------------------


def test_concept_hash(provenance: dict) -> None:
    assert "concept_hash" in provenance, "provenance JSON missing 'concept_hash' field"
    assert provenance["concept_hash"] == EXPECTED_CONCEPT_HASH


def test_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash must be non-null (DL-21 output spec)."""
    assert provenance.get("model_hash"), "model_hash missing or null in provenance JSON (P-7)"


def test_identity_lora_is_v2(provenance: dict) -> None:
    """Limit 2 (inherited from T-0249): runs on top of §24-a's
    player_identity_v2, not v1 -- masking §24-a's contribution would teach
    round 2 nothing about which change did the work."""
    assert provenance.get("identity_lora_name") == "player_identity_v2.safetensors"
    assert provenance.get("identity_lora_hash"), "identity_lora_hash missing"


def test_controlnet_and_style_lora_recorded(provenance: dict) -> None:
    assert provenance.get("controlnet"), "controlnet field missing"
    assert provenance.get("style_lora_hash"), "style_lora_hash missing"


def test_controlnet_strength_recorded_honestly(provenance: dict) -> None:
    assert isinstance(provenance.get("controlnet_strength"), int | float)
    assert isinstance(provenance.get("controlnet_end_percent"), int | float)


def test_pose_source_is_script_not_a_preprocessor(provenance: dict) -> None:
    """Acceptance (inherited from §24-b): no dependency on a DWPose/OpenPose
    preprocessor node -- none is installed on this ComfyUI host."""
    pose_source = provenance.get("pose_source", "")
    assert "pose_rig_T0249" in pose_source
    assert "preprocessor" not in pose_source.lower()


def test_composes_with_pose_authority_stated_explicitly(provenance: dict) -> None:
    """Acceptance: whether this ran on top of §24-b's per-cell path must be
    stated explicitly, so the two changes are not confounded."""
    assert provenance.get("composes_with_pose_authority_T0249") is True
    assert provenance.get("based_on_card") == "T-0249"


def test_frame_zero_is_fresh(provenance: dict) -> None:
    """Acceptance: frame 1 (index 0) is generated fresh -- there is no
    predecessor to chain from."""
    frames = provenance.get("frame_generation")
    assert frames and len(frames) == 9, "provenance must record all 9 per-frame generations"
    frame0 = next(f for f in frames if f["frame_index"] == 0)
    assert frame0["generation_mode"] == "fresh"
    assert frame0["denoise"] == 1.0
    assert frame0.get("chained_from_frame") is None


def test_every_subsequent_frame_is_img2img_chained(provenance: dict) -> None:
    """Acceptance: every subsequent frame is an img2img pass with the next
    pose applied -- checkable via the provenance record, not merely
    asserted in prose.

    `chained_from_frame` is pinned to **0** (a fixed anchor), not
    `frame_index - 1`, per the 2026-08-30 human review: chaining from the
    immediate predecessor let each frame's own background speckle feed into
    the next frame's init image, compounding across the sheet until the
    figure dissolved into noise by row 3 -- confirmed objectively (clean
    background pixel count decayed monotonically 1280->832 across the
    promoted attempt 6 sheet). Anchoring every frame to frame 0's own clean
    output (`chaining_anchor_frame`) bounds that compounding by
    construction: there is no chain of ever-degrading inputs to accumulate
    along, only nine independent low-denoise passes off the same clean
    source. See `test_background_growth_bounded` for the direct measurement
    this fixes, and ROUND2_CHAINED_REPORT_T0250.md's "Human review" section
    for the full account.
    """
    frames = provenance["frame_generation"]
    denoise_value = provenance.get("denoise_value")
    assert isinstance(denoise_value, int | float) and 0.0 < denoise_value < 1.0
    assert provenance.get("chaining_anchor_frame") == 0, (
        "chaining_anchor_frame must be pinned to 0 -- chaining from the immediate "
        "predecessor is the mechanism the 2026-08-30 human review found causes "
        "background-noise accumulation"
    )
    for f in frames:
        if f["frame_index"] == 0:
            continue
        assert f["generation_mode"] == "img2img_chained", (
            f"frame {f['frame_index']} not chained: {f['generation_mode']!r}"
        )
        assert f["chained_from_frame"] == 0, (
            f"frame {f['frame_index']} chained from {f['chained_from_frame']!r}, expected the "
            "fixed anchor frame 0 (see this test's docstring)"
        )
        assert f["denoise"] == denoise_value


def test_background_held_out_of_the_feedback_path(provenance: dict) -> None:
    """Acceptance (2026-08-30 human review fix direction): the background is
    masked/held out of the img2img feedback path entirely, not merely
    hoped to stay clean. `background_held` records that a fixed
    background-hold mask was applied (in-graph via SetLatentNoiseMask,
    restricting denoising to the character bounding box, AND a hard
    pixel-space composite against frame 0's own background after decode --
    belt and suspenders, since the in-graph mask alone does not guarantee
    zero drift through the VAE's non-local receptive field)."""
    assert provenance.get("background_held") is True
    assert isinstance(provenance.get("background_mask_margin_frac"), int | float)
    assert 0.0 < provenance["background_mask_margin_frac"] < 1.0


def test_frames_share_seed_and_prompt_except_pose(provenance: dict) -> None:
    """Seed, initial latent size and prompt are identical across every
    frame's call by construction; only each frame's own skeleton differs."""
    frames = provenance["frame_generation"]
    seeds = {f["seed"] for f in frames}
    widths = {f["width"] for f in frames}
    heights = {f["height"] for f in frames}
    prompts = {f["prompt"] for f in frames}
    skeletons = {f["pose_keypoints_file"] for f in frames}
    assert len(seeds) == 1, "seed differs across frames"
    assert len(widths) == 1 and len(heights) == 1, "initial latent size differs across frames"
    assert len(prompts) == 1, "prompt differs across frames"
    assert len(skeletons) == 9, "every frame must reference its own distinct emitted skeleton"


def test_denoise_value_justified(provenance: dict) -> None:
    justification = provenance.get("denoise_justification")
    assert justification and len(justification) > 20, (
        "denoise_justification missing or too short -- the chosen denoise value must be "
        "justified, not merely asserted"
    )


def test_per_frame_keypoint_files_resolve(provenance: dict) -> None:
    for frame in provenance["frame_generation"]:
        for field in ("pose_keypoints_file", "pose_skeleton_file"):
            rel = frame[field]
            path = (REPO_ROOT / rel).resolve()
            path.relative_to(REPO_ROOT.resolve())
            assert path.is_file(), f"{rel} does not resolve to a file"
            assert not str(rel).startswith("assets/out/"), (
                f"{rel} points into the gitignored assets/out/ -- it must be committed "
                "under assets/src/ instead (P-3/P-7)"
            )
            assert _is_git_tracked(path), (
                f"{rel} exists on disk but is not committed -- it would dangle on a "
                "fresh clone of this branch"
            )
        keypoints = json.loads((REPO_ROOT / frame["pose_keypoints_file"]).read_text())
        assert len(keypoints) == 18, "each committed keypoint file must carry all 18 COCO joints"


def test_animation_parameters_committed_as_data(provenance: dict) -> None:
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
# Denoise sweep (acceptance: sweep run + reported per sampled value + both
# failure-mode edges reported)
# ---------------------------------------------------------------------------


def test_sweep_report_and_data_resolve(provenance: dict) -> None:
    for field, path in (
        ("denoise_sweep_report", SWEEP_REPORT_PATH),
        ("denoise_sweep_data", SWEEP_DATA_PATH),
    ):
        rel = provenance.get(field)
        assert rel, f"{field} field missing from provenance JSON"
        resolved = (REPO_ROOT / rel).resolve()
        assert resolved == path.resolve(), f"{field} does not point at {path}"
        assert resolved.is_file(), f"{rel} does not resolve to a committed file"
        assert _is_git_tracked(resolved), f"{rel} exists on disk but is not committed"


def test_sweep_covers_band_and_both_failure_mode_edges() -> None:
    data = json.loads(SWEEP_DATA_PATH.read_text())
    points = data["points"]
    assert len(points) >= 3, "sweep must sample at least 3 denoise values"

    denoise_values = sorted(p["denoise"] for p in points)
    assert any(SWEEP_BAND_LOW <= d <= SWEEP_BAND_HIGH for d in denoise_values), (
        "sweep must include at least one sample inside the ~0.25-0.35 band"
    )
    assert denoise_values[0] < SWEEP_BAND_LOW, (
        "sweep must include a sample below the band (too-low-denoise failure edge)"
    )
    assert denoise_values[-1] > SWEEP_BAND_HIGH, (
        "sweep must include a sample above the band (too-high-denoise failure edge)"
    )

    for p in points:
        assert "frame_delta_range" in p and len(p["frame_delta_range"]) == 2
        assert "beats_030_cap" in p
        assert "beats_arm_c_benchmark" in p

    assert data.get("failure_mode_low"), "failure mode at the low (too-low-denoise) edge missing"
    assert data.get("failure_mode_high"), "failure mode at the high (too-high-denoise) edge missing"
    assert len(data["failure_mode_low"]) > 20
    assert len(data["failure_mode_high"]) > 20
    assert data.get("chosen_denoise") == pytest.approx(
        json.loads(PROVENANCE_PATH.read_text())["denoise_value"]
    )


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


# ---------------------------------------------------------------------------
# Background-noise accumulation (2026-08-30 human review) -- a *relative*
# inter-frame delta gate can pass a sheet whose background is compounding
# noise every frame, because each step's delta is small even though the
# cumulative drift across the whole sheet is not. This measures growth
# against a fixed baseline (frame 0) instead.
# ---------------------------------------------------------------------------


def test_background_growth_bounded(frame_images: dict[tuple[int, int], Image.Image]) -> None:
    """Non-background pixel count must not grow past MAX_BACKGROUND_GROWTH_RATIO
    of frame 0's count in any frame -- catches the img2img-chaining
    compounding-noise failure the human review found and
    check_frame_consistency does not measure."""
    ordered_frames = [frame_images[cell] for cell in FRAME_CELLS]
    result = asset_gate_art.check_background_growth(
        ordered_frames,
        background_index=BACKGROUND_INDEX,
        max_growth_ratio=MAX_BACKGROUND_GROWTH_RATIO,
    )
    assert result.passed, result.reason
