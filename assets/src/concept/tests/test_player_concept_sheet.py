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
assets/src/character/MANUAL_GENERATION.md). `synth_player_concept.py`
produces a programmatic full-colour PIL image that carries the silhouette,
pose direction, and palette family needed to seed T-0198-iter-2 via
IP-Adapter/img2img conditioning (T-0106 path). SDXL replacement follows
the same swap path as the sprite sheets once ComfyUI is accessible.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"

CONCEPT_PNG = CONCEPT_DIR / "player_character_concept_sheet_v1.png"
CONCEPT_PROVENANCE = CONCEPT_DIR / "player_character_concept_sheet_v1.provenance.json"
CONCEPT_RECIPE = CONCEPT_DIR / "player_character_concept_sheet_v1.recipe.json"


@pytest.fixture(scope="session")
def concept_bytes() -> bytes:
    if not CONCEPT_PNG.exists():
        pytest.fail(
            f"Concept sheet not found: {CONCEPT_PNG}\n"
            "Run assets/src/concept/synth_player_concept.py to generate it."
        )
    return CONCEPT_PNG.read_bytes()


@pytest.fixture(scope="session")
def provenance(concept_bytes) -> dict:  # noqa: ARG001
    if not CONCEPT_PROVENANCE.exists():
        pytest.fail(f"Provenance sidecar not found: {CONCEPT_PROVENANCE}")
    return json.loads(CONCEPT_PROVENANCE.read_text())


def test_concept_png_exists():
    """Concept sheet must exist as an artifact (deliverable_type: artifact)."""
    assert CONCEPT_PNG.exists(), f"Missing concept sheet: {CONCEPT_PNG}"


def test_concept_full_colour(concept_bytes):
    """§6 table: concept sheets are full-colour, never indexed/quantized."""
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(concept_bytes))
    assert img.mode in ("RGB", "RGBA"), (
        f"Expected full-colour mode (RGB/RGBA), got {img.mode!r}. "
        "Concept sheets must NOT be indexed (mode P) — they are pipeline sources, not descended sprites."
    )


def test_concept_resolution(concept_bytes):
    """§6.9 / §3.5: 1024×1024 base SDXL resolution."""
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(concept_bytes))
    assert img.size == (1024, 1024), (
        f"Expected 1024×1024, got {img.size}. "
        "Concept sheets are generated at base SDXL native resolution."
    )


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
        f"  file sha256 is:  {expected}\n"
        "Re-run synth_player_concept.py to regenerate provenance."
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
