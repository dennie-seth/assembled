"""Player idle sheet — Arm A (T-0228, HANDOFF §23-d) — T-0102 gate validation.

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall.

Arm A of the T-0227 character-pipeline bake-off (`docs/decision-log.md`
DL-21): style LoRA (T-0072) + IP-Adapter conditioned on T-0209's approved
concept sheet + OpenPose ControlNet pose grid, per §3.5 as written.

Differences from test_player_idle_v2_gate.py (T-0212, img2img-tiled — a
different arm's method, not this one):
  - Targets player_idle_sheet_arm_a_T0228.png, the Arm A bake-off candidate.
  - All 9 cells are declared frames (a real generative pass fills every
    cell; there is no procedural "leave 5 cells blank" step available to
    a diffusion pipeline the way there is to synth_sheet.py).
  - ADJACENT_PAIRS chains all 9 cells in row-major reading order, so the
    mechanical gate exercises every within-row *and* cross-row transition
    (T-0218's diagnosed identity_drift failure mode was specifically
    cross-row, e.g. cell (0,2)->(1,0)).

RED state:  assets/final/character/player_idle_sheet_arm_a_T0228.png absent
            -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: sheet present, mode P, 144x144; passes palette-membership,
             index-semantics, cell-fit (3x3, 48x48), orphan-pixel per cell,
             frame-consistency (DL-21 criterion 2's mechanical delta gate)
             across all 8 adjacent-cell transitions, and concept_hash in
             provenance JSON resolves to T-0209's approved sheet.

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
SHEET_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_a_T0228.png"
PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_a_T0228.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared IP-Adapter reference DL-21 pins for every bake-off arm.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
COLS = 3
ROWS = 3

# All 9 cells are declared frames for a generative arm — see module docstring.
FRAME_CELLS: list[tuple[int, int]] = [(r, c) for r in range(ROWS) for c in range(COLS)]

# Row-major reading-order chain over all 9 cells: 8 adjacent transitions,
# including every cross-row wrap ((0,2)->(1,0), (1,2)->(2,0)) — exactly the
# transitions where T-0218 observed identity_drift (costume changing between
# rows of an otherwise front-facing, ControlNet-conditioned sheet).
ADJACENT_PAIRS: list[tuple[tuple[int, int], tuple[int, int]]] = [
    (FRAME_CELLS[i], FRAME_CELLS[i + 1]) for i in range(len(FRAME_CELLS) - 1)
]

BACKGROUND_INDEX = 0
MAX_FRAME_DELTA_RATIO = 0.30  # 30% max silhouette change between adjacent cells (DL-21 criterion 2)
ORPHAN_SIZE_THRESHOLD = 4  # blobs < 4 connected px are orphans (downscale noise)


@pytest.fixture(scope="module")
def sheet() -> Image.Image:
    assert SHEET_PATH.exists(), (
        f"Arm A idle sheet not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_arm_a_idle_T0228.py against the ComfyUI host "
        "(LoRA + IP-Adapter + OpenPose ControlNet, per DL-21) to produce it."
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
    """Extract each of the 9 cells as a mode-P sub-image."""
    cells: dict[tuple[int, int], Image.Image] = {}
    for sr, sc in FRAME_CELLS:
        x0, y0 = sc * CELL_SIZE, sr * CELL_SIZE
        cells[(sr, sc)] = sheet.crop((x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE))
    return cells


# ---------------------------------------------------------------------------
# Provenance checks (DL-21 output spec + P-7)
# ---------------------------------------------------------------------------


def test_concept_hash() -> None:
    """Provenance JSON must record concept_hash resolving to T-0209's approved sheet.

    DL-21: "All three arms are conditioned on T-0209's approved player concept
    sheet... It is the shared reference; no arm substitutes its own."
    """
    assert PROVENANCE_PATH.exists(), (
        f"provenance sidecar not found: {PROVENANCE_PATH}\n"
        "Commit player_idle_sheet_arm_a_T0228.provenance.json with a concept_hash field."
    )
    data = json.loads(PROVENANCE_PATH.read_text())
    assert "concept_hash" in data, (
        "provenance JSON missing 'concept_hash' field — "
        "DL-21's output spec requires the IP-Adapter conditioning sheet's SHA-256."
    )
    got = data["concept_hash"]
    assert got == EXPECTED_CONCEPT_HASH, (
        f"concept_hash mismatch:\n  got:      {got}\n  expected: {EXPECTED_CONCEPT_HASH}\n"
        "Verify assets/src/concept/player_character_concept_sheet_v1.png is the T-0209 sheet."
    )


def test_model_hash_present() -> None:
    """P-7: model_hash must be non-null (DL-21 output spec)."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("model_hash"), "model_hash missing or null in provenance JSON (P-7)"


def test_ip_adapter_and_controlnet_recorded() -> None:
    """DL-21 requires all three components present: LoRA, IP-Adapter, ControlNet.

    Recorded distinctly from `model_hash` (the base checkpoint) so the
    provenance sidecar itself is evidence Arm A used all three, not just
    the base pipeline.
    """
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("lora_hash"), "lora_hash missing — T-0072 style LoRA must be recorded"
    assert data.get("ip_adapter"), "ip_adapter field missing — Arm A must record its IP-Adapter"
    assert data.get("controlnet"), "controlnet field missing — Arm A must record its OpenPose ControlNet"


def test_generator_field_is_bare_repo_path() -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative path,
    no free-text annotation suffix."""
    data = json.loads(PROVENANCE_PATH.read_text())
    generator = data.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())  # raises if it escapes the repo tree
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
    ARM_A_ATTEMPT_LOG_T0228.md) is the other, required half.
    """
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
