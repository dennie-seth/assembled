"""Player idle sheet — Arm B (T-0229, HANDOFF §23-e) — T-0102 gate validation.

docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class):
  cell 48x48, grid 3x3, native 144x144, figure 40px tall.

Arm B of the T-0227 character-pipeline bake-off (`docs/decision-log.md`
DL-21): §6.14 stage 2 -- instead of conditioning a general model per
generation (Arm A's IP-Adapter), a player-identity LoRA trained on figure
panels curated from T-0209's approved concept sheet is stacked with the
T-0072 style LoRA, driven by an OpenPose ControlNet pose grid.

Mirrors test_player_idle_arm_a_gate.py's structure and thresholds (DL-21
pins the same output spec and judging conditions to every arm), with the
provenance checks swapped for Arm B's two-LoRA-no-IP-Adapter architecture --
see test_no_ip_adapter_conditioning, the test that encodes what actually
makes this a different arm, not just a relabeled Arm A.

RED state:  assets/final/character/player_idle_sheet_arm_b_T0229.png absent
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
SHEET_PATH = REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_b_T0229.png"
PROVENANCE_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_arm_b_T0229.provenance.json"
)
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference DL-21 pins for every bake-off arm. Arm B traces this
# through its curation manifest / trained LoRA rather than a live IP-Adapter
# node -- see test_no_ip_adapter_conditioning.
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
        f"Arm B idle sheet not found: {SHEET_PATH}\n"
        "Run assets/src/character/gen_arm_b_idle_T0229.py against the ComfyUI host "
        "(style LoRA + player-identity LoRA + OpenPose ControlNet, per DL-21 §6.14 "
        "stage 2) to produce it."
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
    """DL-21: all three arms trace back to T-0209's approved sheet -- Arm B
    does this through curation/training rather than live conditioning."""
    assert PROVENANCE_PATH.exists(), (
        f"provenance sidecar not found: {PROVENANCE_PATH}\n"
        "Commit player_idle_sheet_arm_b_T0229.provenance.json with a concept_hash field."
    )
    data = json.loads(PROVENANCE_PATH.read_text())
    assert "concept_hash" in data, "provenance JSON missing 'concept_hash' field"
    got = data["concept_hash"]
    assert got == EXPECTED_CONCEPT_HASH, (
        f"concept_hash mismatch:\n  got:      {got}\n  expected: {EXPECTED_CONCEPT_HASH}"
    )


def test_model_hash_present() -> None:
    """P-7: model_hash must be non-null (DL-21 output spec)."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("model_hash"), "model_hash missing or null in provenance JSON (P-7)"


def test_style_and_identity_lora_and_controlnet_recorded() -> None:
    """§6.14 stage 2's three required components: style LoRA, player-identity
    LoRA, and the OpenPose ControlNet pose grid -- all three, distinctly
    recorded, or Arm B has not actually run its own recipe."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert data.get("style_lora_hash"), (
        "style_lora_hash missing — T-0072 style LoRA must be recorded"
    )
    assert data.get("identity_lora_hash"), (
        "identity_lora_hash missing — the trained player-identity LoRA (T-0229) must be recorded"
    )
    assert data.get("controlnet"), (
        "controlnet field missing — Arm B must record its OpenPose ControlNet"
    )


def test_no_ip_adapter_conditioning() -> None:
    """The load-bearing architectural claim of Arm B: identity is trained
    into weights INSTEAD OF conditioned per generation (§6.14 stage 2). A
    provenance sidecar that still carries an ip_adapter field would mean Arm
    B silently reverted to Arm A's mechanism -- not a valid Arm B result."""
    data = json.loads(PROVENANCE_PATH.read_text())
    assert "ip_adapter" not in data, (
        "provenance records ip_adapter — Arm B must not condition generation on the "
        "concept sheet via IP-Adapter; identity comes from the trained LoRA only"
    )


def test_identity_lora_training_provenance_resolves() -> None:
    """Acceptance: the trained LoRA's own provenance (weights hash + training
    config + curation set) must be resolvable from the generation provenance,
    not just asserted by name."""
    data = json.loads(PROVENANCE_PATH.read_text())
    identity_provenance = data.get("identity_lora_provenance")
    assert identity_provenance, "identity_lora_provenance field missing"
    resolved = (REPO_ROOT / identity_provenance).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), (
        f"identity_lora_provenance '{identity_provenance}' does not resolve to a committed file"
    )


def test_generator_field_is_bare_repo_path() -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative path,
    no free-text annotation suffix."""
    data = json.loads(PROVENANCE_PATH.read_text())
    generator = data.get("generator")
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
    ARM_B_ATTEMPT_LOG_T0229.md) is the other, required half.
    """
    result = asset_gate_art.check_frame_consistency(
        frame_images[cell_a],
        frame_images[cell_b],
        background_index=BACKGROUND_INDEX,
        max_delta_ratio=MAX_FRAME_DELTA_RATIO,
    )
    assert result.passed, f"cells {cell_a}->{cell_b}: {result.reason}"
