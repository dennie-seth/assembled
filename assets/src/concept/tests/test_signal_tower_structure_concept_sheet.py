"""T-0226 — Signal Tower structure/traversal concept sheet artifact gate.

`docs/design/13-asset-pipeline.md` §6 requires one concept sheet per asset
set. T-0226 audits the Signal Tower set against the seven rooms declared in
`docs/design/14-vertical-slice.md` §10 and finds three dressing elements with
no existing coverage from the material sheet (T-0167), player sheet
(T-0209), entity sheet (T-0210), or cover/hiding props sheet (T-0211):

- **Records Room shelving** — dense records-office shelving rows (`14` §10
  "Records Room" row)
- **Ladder** — the free, always-usable vertical connector used between every
  room on the climb (`14` §10 room graph; `11` §2 "Ladder ... same status as
  a normal door")
- **Power Substation catwalk/grating** — the short elevated catwalk the
  Watcher is fixed on (`14` §10 "Power Substation" row)

This is a single new concept sheet covering all three (matching T-0211's
precedent of one sheet covering multiple related prop classes), validated
the same way as the other Signal Tower concept-sheet gates:

- Full-colour (RGB mode — not indexed/quantized, §6 table)
- Full-res 1024×1024 (base SDXL native, §6.9 framing requirements)
- Provenance sidecar present with required fields including `concept_hash`
  (sha256 of the image bytes, archetype-first coherence guard §6)
- Recipe sidecar present (T-0104 committed concept workflow input)

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

STRUCTURE_PNG = CONCEPT_DIR / "signal_tower_structure_concept_sheet_v1.png"
STRUCTURE_PROVENANCE = CONCEPT_DIR / "signal_tower_structure_concept_sheet_v1.provenance.json"
STRUCTURE_RECIPE = CONCEPT_DIR / "signal_tower_structure_concept_sheet_v1.recipe.json"

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
def structure_bytes(ensure_signal_tower_structure_concept_sheet) -> bytes:  # noqa: ARG001
    """Return the raw bytes of the signal tower structure concept sheet PNG."""
    return STRUCTURE_PNG.read_bytes()


@pytest.fixture(scope="session")
def structure_provenance(structure_bytes) -> dict:  # noqa: ARG001
    return json.loads(STRUCTURE_PROVENANCE.read_text())


def test_structure_concept_png_exists(ensure_signal_tower_structure_concept_sheet):  # noqa: ARG001
    """Concept sheet must exist as an artifact (deliverable_type: artifact)."""
    assert STRUCTURE_PNG.exists(), f"Missing signal tower structure concept sheet: {STRUCTURE_PNG}"


def test_structure_concept_full_colour(structure_bytes):
    """§6 table: concept sheets are full-colour (RGB colour_type=2), never indexed."""
    meta = _parse_png_ihdr(structure_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) — concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8, f"Expected 8-bit depth, got {meta['bit_depth']}."


def test_structure_concept_resolution(structure_bytes):
    """§6.9 / §3.5: 1024×1024 base SDXL resolution."""
    meta = _parse_png_ihdr(structure_bytes)
    assert meta["width"] == 1024, f"Expected width 1024, got {meta['width']}"
    assert meta["height"] == 1024, f"Expected height 1024, got {meta['height']}"


def test_structure_provenance_exists(structure_provenance):
    """Provenance sidecar must be present alongside the concept sheet."""
    assert isinstance(structure_provenance, dict)


def test_structure_provenance_required_fields(structure_provenance):
    """§6 coherence guard: concept_hash (sha256 of approved sheet) must be in provenance."""
    required = {"model", "model_license", "prompt", "seed", "concept_hash", "generator"}
    missing = required - structure_provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_structure_provenance_concept_hash_matches(structure_bytes, structure_provenance):
    """concept_hash must match sha256 of the actual concept sheet bytes (§6 seam)."""
    expected = hashlib.sha256(structure_bytes).hexdigest()
    actual = structure_provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}"
    )


def test_structure_provenance_generator_resolves_to_committed_code(structure_provenance):
    """P-7: the generator field must resolve to a file committed in the repo."""
    generator = structure_provenance.get("generator", "")
    assert generator, "Provenance must declare a generator (P-7)"
    # The generator field is a path (optionally with a trailing description);
    # the leading whitespace-delimited token must be a real, committed path.
    candidate = generator.split()[0]
    resolved = WORKTREE / candidate
    assert resolved.exists(), (
        f"generator field {generator!r} does not resolve to a committed file "
        f"(looked for {resolved})"
    )


def test_structure_recipe_exists():
    """Recipe JSON must be present (T-0104 workflow source for future SDXL replacement)."""
    assert STRUCTURE_RECIPE.exists(), f"Missing recipe: {STRUCTURE_RECIPE}"


def test_structure_recipe_required_fields():
    """Recipe must have prompt, seed, checkpoint, dimensions, name."""
    recipe = json.loads(STRUCTURE_RECIPE.read_text())
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"


def test_structure_concept_covers_records_shelving(structure_provenance):
    """Provenance prompt must reference Records Room shelving/dressing (`14` §10)."""
    prompt = structure_provenance.get("prompt", "")
    terms = ["shelving", "shelves", "records"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, (
        f"Provenance prompt must reference Records Room shelving. Looked for any of {terms!r}."
    )


def test_structure_concept_covers_ladder(structure_provenance):
    """Provenance prompt must reference the ladder (vertical connector, `14` §10 room graph)."""
    prompt = structure_provenance.get("prompt", "")
    terms = ["ladder"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference the ladder. Looked for any of {terms!r}."


def test_structure_concept_covers_catwalk(structure_provenance):
    """Provenance prompt must reference the Power Substation catwalk/grating (`14` §10)."""
    prompt = structure_provenance.get("prompt", "")
    terms = ["catwalk", "grating"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference the catwalk/grating. Looked for any of {terms!r}."
