"""Player idle sheet — Arm C (T-0230, HANDOFF §23-f) — T-0102 gate validation.

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall.

Arm C of the T-0227 character-pipeline bake-off (`docs/decision-log.md`
DL-21): **no diffusion model anywhere in the generation path**. A seeded,
deterministic script (`char_gen.synth_entities.generate_player_idle_sheet_arm_c`,
invoked via `gen_arm_c_idle_T0230.py`) renders a real articulated player
figure — head, neck, torso, two-segment arms, two-segment legs — directly
at 144x144 with palette indices assigned by construction, never quantised
after the fact.

Mirrors test_player_idle_arm_a_gate.py / test_player_idle_arm_b_gate.py's
structure and thresholds (DL-21 pins the same output spec and judging
conditions to every arm), with the provenance checks swapped for Arm C's
no-model architecture — see test_no_diffusion_model_conditioning (the test
that encodes what actually makes this a different arm) and
test_deterministic_double_render (the mechanical proof of this arm's own
acceptance criterion: "the same seed produces a byte-identical sheet").

RED state:  assets/final/character/player_idle_sheet_arm_c_T0230.png absent
            -> SHEET_PATH fixture raises AssertionError, all tests ERROR;
            generate_player_idle_sheet_arm_c does not exist yet in
            char_gen.synth_entities -> the determinism test's import fails too.
GREEN state: sheet present, mode P, 144x144; passes palette-membership,
             index-semantics, cell-fit (3x3, 48x48), orphan-pixel per cell,
             frame-consistency (DL-21 criterion 2's mechanical delta gate)
             across all 8 adjacent-cell transitions, concept_hash in
             provenance JSON resolves to T-0209's approved sheet, and the
             generator reproduces byte-identical output across two calls
             with the same seed.

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
asset_gate_determinism = pytest.importorskip("asset_gate.determinism")

REPO_ROOT = Path(__file__).resolve().parents[4]
SHEET_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_c_T0230.png"
PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_c_T0230.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference DL-21 pins for every bake-off arm. Arm C has no live
# conditioning step (no model at all) so this is recorded for provenance
# resolution only (DL-21's "no arm substitutes its own" clause), the same
# treatment T-0209's proportions/palette got when this figure was designed.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 3
ROWS = 3

FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]

ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30  # 30% max silhouette change between adjacent cells (DL-21 criterion 2)
ORPHAN_SIZE_THRESHOLD = 4  # blobs < 4 connected px are orphans (downscale noise)


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"Arm C idle sheet not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_arm_c_idle_T0230.py --promote to produce it "
        "(deterministic script, no ComfyUI/GPU required)."
    )
    img = Image.open(SHEET_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (COLS * CELL_SIZE, ROWS * CELL_SIZE), (
        f"sheet size {img.size} != expected ({COLS * CELL_SIZE}, {ROWS * CELL_SIZE})"
    )
    return img


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
# Provenance checks (DL-21 output spec + P-7)
# ---------------------------------------------------------------------------


def test_concept_hash() -> None:
    """DL-21: all three arms trace back to T-0209's approved sheet -- Arm C
    has no live conditioning step, so this is a provenance-resolution record
    (the shared reference every arm cites), not an input to generation."""
    assert PROVENANCE_PATH.exists(), (
        f"provenance sidecar not found: {PROVENANCE_PATH}\n"
        "Commit player_idle_sheet_arm_c_T0230.provenance.json with a concept_hash field."
    )
    data = json.loads(PROVENANCE_PATH.read_text())
    assert "concept_hash" in data, "provenance JSON missing 'concept_hash' field"
    got = data["concept_hash"]
    assert got == EXPECTED_CONCEPT_HASH, (
        f"concept_hash mismatch:\n  got:      {got}\n  expected: {EXPECTED_CONCEPT_HASH}"
    )


def test_model_hash_present() -> None:
    """P-7: model_hash must be non-null (DL-21 output spec). Arm C has no
    diffusion model, so model_hash pins the exact committed generator source
    instead of a checkpoint -- still a real, non-null, resolvable hash."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("model_hash"), "model_hash missing or null in provenance JSON (P-7)"


def test_generator_field_is_bare_repo_path() -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative path,
    no free-text annotation suffix."""
    data = json.loads(PROVENANCE_PATH.read_text())
    generator = data.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator '{generator}' does not resolve to a committed file"


def test_no_diffusion_model_conditioning() -> None:
    """The load-bearing architectural claim of Arm C (DL-21 §23-f): no
    diffusion model anywhere in the generation path -- no checkpoint sampling,
    no LoRA, no IP-Adapter, no ControlNet. A provenance sidecar carrying any
    of these fields would mean Arm C silently reverted to Arm A/B's
    mechanism, not a valid Arm C result."""
    data = json.loads(PROVENANCE_PATH.read_text())
    forbidden = (
        "lora_hash",
        "style_lora_hash",
        "identity_lora_hash",
        "controlnet",
        "ip_adapter",
        "comfyui_prompt_id",
        "steps",
        "cfg",
        "sampler",
        "scheduler",
        "denoise",
    )
    present = [f for f in forbidden if f in data]
    assert not present, (
        f"provenance records diffusion-model field(s) {present} -- Arm C must use no model "
        "at all, the figure is rendered directly by a seeded script"
    )


def test_no_post_hoc_quantization() -> None:
    """Acceptance: palette indices assigned by construction, never quantised
    after the fact -- the provenance sidecar must say so explicitly, not
    just happen to pass the palette checks below."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("palette_assignment") == "by_construction", (
        "provenance must record palette_assignment == 'by_construction' -- Arm C's drawing "
        "code writes palette indices directly, it never quantises a rendered image"
    )
    assert data.get("quantization") in (None, "none"), (
        "provenance records a quantization step -- Arm C must not quantise; indices are "
        "assigned by construction, not guessed post-hoc"
    )


def test_deterministic_double_render(tmp_path: Path, palette: asset_gate_palette.Palette) -> None:
    """Acceptance: the same seed produces a byte-identical sheet, proven by
    running the generator twice and comparing bytes -- not merely asserted
    in a report. Reuses asset_gate.determinism.check_reproducible, the same
    harness the atlas-packing and one-shot-SFX determinism checks use."""
    from char_gen.synth_entities import generate_player_idle_sheet_arm_c

    data = json.loads(PROVENANCE_PATH.read_text())
    seed = data.get("seed")
    assert seed is not None, "provenance missing 'seed' -- cannot prove determinism without it"

    palette_rgb = [palette.rgb_by_index[i] for i in range(palette.size)]
    counter = {"n": 0}

    def _produce() -> bytes:
        out = tmp_path / f"render_{counter['n']}.png"
        counter["n"] += 1
        generate_player_idle_sheet_arm_c(seed, palette_rgb, out)
        return out.read_bytes()

    result = asset_gate_determinism.check_reproducible(
        "player_idle_arm_c_determinism", _produce, runs=2
    )
    assert result.passed, result.reason


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
# Frame-consistency (DL-21 criterion 2 — the mechanical half of "identity stable")
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cell_a,cell_b", ADJACENT_PAIRS)
def test_frame_consistency(
    cell_a: tuple[int, int],
    cell_b: tuple[int, int],
    frame_images: dict[tuple[int, int], Image.Image],
) -> None:
    """Silhouette delta between adjacent cells must stay within MAX_FRAME_DELTA_RATIO.

    DL-21 criterion 2 is explicit that this mechanical gate is only half of
    "identity stable" — the human drift verdict (recorded in
    ARM_C_ATTEMPT_LOG_T0230.md) is the other, required half. For Arm C this
    gate is expected to pass by construction: every per-frame pose offset is
    drawn from a hand-verified pattern whose adjacent-frame steps never
    exceed 1px (see _PLAYER_POSE_PATTERNS in char_gen/synth_entities.py).
    """
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
