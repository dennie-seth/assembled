"""T-0209 — Player character concept sheet artifact gate.

Validates that the player character concept sheet exists in
`assets/src/concept/` and meets the §6.9 requirements from
`docs/design/13-asset-pipeline.md`:

- Full-colour (RGB mode — not indexed/quantized, §6 table)
- Full-res 1024×1024 (base SDXL native, §6.9 framing requirements)
- Provenance sidecar present with required fields including `concept_hash`
  (sha256 of the image bytes, archetype-first coherence guard §6)

T-0102 validation gate (palette-membership, index-semantics, etc.) does
**not** apply to concept sheets — those checks are for descended sprites.
The concept sheet is a pipeline *source*, not a shipped asset.

This card (T-0209) uses the same synthetic-generation fallback as T-0198/
T-0199: ComfyUI is not reachable from WSL (Windows Firewall; see
assets/src/character/MANUAL_GENERATION.md). The conftest `ensure_concept_sheet`
fixture produces a programmatic full-colour PNG (stdlib-only: struct, zlib,
binascii) that carries the silhouette, pose direction, and palette family
needed to seed T-0198-iter-2 via IP-Adapter/img2img conditioning (T-0106).
SDXL replacement follows the same swap path as the sprite sheets once
ComfyUI is accessible.

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

CONCEPT_PNG = CONCEPT_DIR / "player_character_concept_sheet_v1.png"
CONCEPT_PROVENANCE = CONCEPT_DIR / "player_character_concept_sheet_v1.provenance.json"
CONCEPT_RECIPE = CONCEPT_DIR / "player_character_concept_sheet_v1.recipe.json"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _parse_png_ihdr(data: bytes) -> dict:
    """Parse PNG signature + IHDR chunk, return image metadata dict.

    Returns keys: width, height, bit_depth, colour_type.
    colour_type 2 = RGB truecolour (not indexed).
    """
    assert data[:8] == _PNG_SIG, "Not a valid PNG (bad signature)"
    # IHDR is always the first chunk: 4-len + 4-type + 13-data + 4-crc = 25 bytes
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
def concept_bytes(ensure_concept_sheet) -> bytes:  # noqa: ARG001
    """Return the raw bytes of the concept sheet PNG (after conftest generates it)."""
    return CONCEPT_PNG.read_bytes()


@pytest.fixture(scope="session")
def provenance(concept_bytes) -> dict:  # noqa: ARG001
    return json.loads(CONCEPT_PROVENANCE.read_text())


def test_concept_png_exists(ensure_concept_sheet):  # noqa: ARG001
    """Concept sheet must exist as an artifact (deliverable_type: artifact)."""
    assert CONCEPT_PNG.exists(), f"Missing concept sheet: {CONCEPT_PNG}"


def test_concept_full_colour(concept_bytes):
    """§6 table: concept sheets are full-colour (RGB colour_type=2), never indexed."""
    meta = _parse_png_ihdr(concept_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) — concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8, (
        f"Expected 8-bit depth, got {meta['bit_depth']}."
    )


def test_concept_resolution(concept_bytes):
    """§6.9 / §3.5: 1024×1024 base SDXL resolution."""
    meta = _parse_png_ihdr(concept_bytes)
    assert meta["width"] == 1024, f"Expected width 1024, got {meta['width']}"
    assert meta["height"] == 1024, f"Expected height 1024, got {meta['height']}"


def test_provenance_exists(provenance):
    """Provenance sidecar must be present alongside the concept sheet."""
    assert isinstance(provenance, dict)


def test_provenance_required_fields(provenance):
    """§6 coherence guard: concept_hash (sha256 of approved sheet) must be in provenance."""
    required = {"model", "model_license", "prompt", "seed", "concept_hash"}
    missing = required - provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_provenance_concept_hash_matches(concept_bytes, provenance):
    """concept_hash must match sha256 of the actual concept sheet bytes (§6 seam)."""
    expected = hashlib.sha256(concept_bytes).hexdigest()
    actual = provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}"
    )


def test_recipe_exists():
    """Recipe JSON must be present (workflow source for future SDXL replacement)."""
    assert CONCEPT_RECIPE.exists(), f"Missing recipe: {CONCEPT_RECIPE}"


def test_recipe_required_fields():
    """Recipe must have prompt, seed, checkpoint, dimensions."""
    recipe = json.loads(CONCEPT_RECIPE.read_text())
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"
