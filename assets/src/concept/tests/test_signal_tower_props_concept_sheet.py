"""T-0211 — Signal Tower props concept sheet artifact gate.

Validates that the signal tower props concept sheet exists in
`assets/src/concept/` and meets the §6.9 requirements from
`docs/design/13-asset-pipeline.md`:

- Full-colour (RGB mode — not indexed/quantized, §6 table)
- Full-res 1024×1024 (base SDXL native, §6.9 framing requirements)
- Provenance sidecar present with required fields including `concept_hash`
  (sha256 of the image bytes, archetype-first coherence guard §6)

Covers both prop classes distinctly per `docs/design/11-moment-to-moment.md` §2:
- Cover props: block sight-cone only, partial protection
- Dedicated hiding-spot props: block all sensors once inside, single-occupant,
  exposed entry

T-0102 validation gate (palette-membership, index-semantics, etc.) does
**not** apply to concept sheets — those checks are for descended sprites.
The concept sheet is a pipeline *source*, not a shipped asset.

Unblocks T-0201 (Signal Tower prop pack) to condition off this sheet via
T-0106's IP-Adapter/img2img path.

PNG inspection uses stdlib (struct) only — no Pillow/numpy dependency.
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"

PROPS_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.png"
PROPS_PROVENANCE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.provenance.json"
PROPS_RECIPE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.recipe.json"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _parse_png_ihdr(data: bytes) -> dict:
    """Parse PNG signature + IHDR chunk, return image metadata dict.

    Returns keys: width, height, bit_depth, colour_type.
    colour_type 2 = RGB truecolour (not indexed).
    """
    assert data[:8] == _PNG_SIG, "Not a valid PNG (bad signature)"
    chunk_len = struct.unpack(">I", data[8:12])[0]
    chunk_type = data[12:16]
    assert chunk_type == b"IHDR", f"First chunk is {chunk_type!r}, expected IHDR"
    assert chunk_len == 13, f"IHDR length {chunk_len}, expected 13"
    ihdr = data[16:29]
    width, height = struct.unpack(">II", ihdr[0:8])
    bit_depth = ihdr[8]
    colour_type = ihdr[9]
    return {
        "width": width,
        "height": height,
        "bit_depth": bit_depth,
        "colour_type": colour_type,
    }


@pytest.fixture(scope="session")
def props_bytes(ensure_signal_tower_props_concept_sheet) -> bytes:  # noqa: ARG001
    """Return the raw bytes of the signal tower props concept sheet PNG."""
    return PROPS_PNG.read_bytes()


@pytest.fixture(scope="session")
def props_provenance(props_bytes) -> dict:  # noqa: ARG001
    return json.loads(PROPS_PROVENANCE.read_text())


def test_props_concept_png_exists(ensure_signal_tower_props_concept_sheet):  # noqa: ARG001
    """Concept sheet must exist as an artifact (deliverable_type: artifact)."""
    assert PROPS_PNG.exists(), f"Missing signal tower props concept sheet: {PROPS_PNG}"


def test_props_concept_full_colour(props_bytes):
    """§6 table: concept sheets are full-colour (RGB colour_type=2), never indexed."""
    meta = _parse_png_ihdr(props_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) — concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8, (
        f"Expected 8-bit depth, got {meta['bit_depth']}."
    )


def test_props_concept_resolution(props_bytes):
    """§6.9 / §3.5: 1024×1024 base SDXL resolution."""
    meta = _parse_png_ihdr(props_bytes)
    assert meta["width"] == 1024, f"Expected width 1024, got {meta['width']}"
    assert meta["height"] == 1024, f"Expected height 1024, got {meta['height']}"


def test_props_provenance_exists(props_provenance):
    """Provenance sidecar must be present alongside the concept sheet."""
    assert isinstance(props_provenance, dict)


def test_props_provenance_required_fields(props_provenance):
    """§6 coherence guard: concept_hash (sha256 of approved sheet) must be in provenance."""
    required = {"model", "model_license", "prompt", "seed", "concept_hash"}
    missing = required - props_provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_props_provenance_concept_hash_matches(props_bytes, props_provenance):
    """concept_hash must match sha256 of the actual concept sheet bytes (§6 seam)."""
    expected = hashlib.sha256(props_bytes).hexdigest()
    actual = props_provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}"
    )


def test_props_recipe_exists():
    """Recipe JSON must be present (workflow source for future SDXL replacement)."""
    assert PROPS_RECIPE.exists(), f"Missing recipe: {PROPS_RECIPE}"


def test_props_recipe_required_fields():
    """Recipe must have prompt, seed, checkpoint, dimensions, name."""
    recipe = json.loads(PROPS_RECIPE.read_text())
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"


def test_props_concept_covers_cover_props(props_provenance):
    """Provenance prompt must reference cover props (partial protection, sight-cone only)."""
    prompt = props_provenance.get("prompt", "")
    # Must mention the cover prop class concept
    cover_terms = ["cover", "sight"]
    matched = [t for t in cover_terms if t.lower() in prompt.lower()]
    assert matched, (
        "Provenance prompt must reference cover props (partial protection, sight-cone block). "
        f"Looked for any of {cover_terms!r} in prompt. "
        "Concept sheet must cover both prop classes (T-0211 acceptance)."
    )


def test_props_concept_covers_hiding_spot_props(props_provenance):
    """Provenance prompt must reference hiding-spot props (all-sensor block, single-occupant)."""
    prompt = props_provenance.get("prompt", "")
    # Must mention the hiding-spot prop class concept
    hide_terms = ["hiding", "locker", "hide", "enclosed", "single-occupant"]
    matched = [t for t in hide_terms if t.lower() in prompt.lower()]
    assert matched, (
        "Provenance prompt must reference hiding-spot props (all-sensor block, single-occupant). "
        f"Looked for any of {hide_terms!r} in prompt. "
        "Concept sheet must cover both prop classes (T-0211 acceptance)."
    )
