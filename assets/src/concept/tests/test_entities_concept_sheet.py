"""T-0210 — Three-entity concept sheet artifact gate.

Validates that the entities concept sheet exists in
`assets/src/concept/` and meets the §6.9 requirements from
`docs/design/13-asset-pipeline.md`:

- Full-colour (RGB mode — not indexed/quantized, §6 table)
- Full-res 1024×1024 (base SDXL native, §6.9 framing requirements)
- Provenance sidecar present with required fields including `concept_hash`
  (sha256 of the image bytes, archetype-first coherence guard §6)

Covers all three entities: Watcher, Sound, Still Air.

T-0102 validation gate (palette-membership, index-semantics, etc.) does
**not** apply to concept sheets — those checks are for descended sprites.
The concept sheet is a pipeline *source*, not a shipped asset.

This card (T-0210) uses the same synthetic-generation fallback as T-0209:
ComfyUI is not reachable from WSL (Windows Firewall; see
assets/src/character/MANUAL_GENERATION.md). The conftest `ensure_entities_concept_sheet`
fixture produces a programmatic full-colour PNG (stdlib-only: struct, zlib,
binascii) that carries the silhouette, pose direction, and palette family
for Watcher, Sound, and Still Air, needed to seed T-0200-iter-2 via
IP-Adapter/img2img conditioning (T-0106 path). SDXL replacement follows
the same swap path once ComfyUI is accessible.

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

ENTITIES_PNG = CONCEPT_DIR / "entities_concept_sheet_v1.png"
ENTITIES_PROVENANCE = CONCEPT_DIR / "entities_concept_sheet_v1.provenance.json"
ENTITIES_RECIPE = CONCEPT_DIR / "entities_concept_sheet_v1.recipe.json"

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
def entities_bytes(ensure_entities_concept_sheet) -> bytes:  # noqa: ARG001
    """Return the raw bytes of the entities concept sheet PNG."""
    return ENTITIES_PNG.read_bytes()


@pytest.fixture(scope="session")
def entities_provenance(entities_bytes) -> dict:  # noqa: ARG001
    return json.loads(ENTITIES_PROVENANCE.read_text())


def test_entities_concept_png_exists(ensure_entities_concept_sheet):  # noqa: ARG001
    """Concept sheet must exist as an artifact (deliverable_type: artifact)."""
    assert ENTITIES_PNG.exists(), f"Missing entity concept sheet: {ENTITIES_PNG}"


def test_entities_concept_full_colour(entities_bytes):
    """§6 table: concept sheets are full-colour (RGB colour_type=2), never indexed."""
    meta = _parse_png_ihdr(entities_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) — concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8, (
        f"Expected 8-bit depth, got {meta['bit_depth']}."
    )


def test_entities_concept_resolution(entities_bytes):
    """§6.9 / §3.5: 1024×1024 base SDXL resolution."""
    meta = _parse_png_ihdr(entities_bytes)
    assert meta["width"] == 1024, f"Expected width 1024, got {meta['width']}"
    assert meta["height"] == 1024, f"Expected height 1024, got {meta['height']}"


def test_entities_provenance_exists(entities_provenance):
    """Provenance sidecar must be present alongside the concept sheet."""
    assert isinstance(entities_provenance, dict)


def test_entities_provenance_required_fields(entities_provenance):
    """§6 coherence guard: concept_hash (sha256 of approved sheet) must be in provenance."""
    required = {"model", "model_license", "prompt", "seed", "concept_hash"}
    missing = required - entities_provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_entities_provenance_concept_hash_matches(entities_bytes, entities_provenance):
    """concept_hash must match sha256 of the actual concept sheet bytes (§6 seam)."""
    expected = hashlib.sha256(entities_bytes).hexdigest()
    actual = entities_provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}"
    )


def test_entities_recipe_exists():
    """Recipe JSON must be present (workflow source for future SDXL replacement)."""
    assert ENTITIES_RECIPE.exists(), f"Missing recipe: {ENTITIES_RECIPE}"


def test_entities_recipe_required_fields():
    """Recipe must have prompt, seed, checkpoint, dimensions, name."""
    recipe = json.loads(ENTITIES_RECIPE.read_text())
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"


def test_entities_recipe_covers_all_three(entities_provenance):
    """Provenance prompt must reference all three entity names."""
    prompt = entities_provenance.get("prompt", "")
    for entity in ("Watcher", "Sound", "Still Air"):
        assert entity in prompt, (
            f"Entity '{entity}' not mentioned in provenance prompt. "
            "Concept sheet must cover all three entities (T-0210 acceptance)."
        )
