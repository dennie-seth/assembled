"""T-0317 -- committed green-costume side-profile reference artifact gate.

Validates `player_profile_costume_reference_T0317.png` the same way
`test_player_concept_sheet.py` (T-0209) and
`test_derive_profile_style_reference_T0272.py` (T-0272) validate their own
committed concept-art artifacts: existence, provenance completeness,
`concept_hash` matching the actual bytes, and (this card's own acceptance
criterion) green content quantitatively comparable to T-0272 round 5's own
recorded 6,000-6,900 green-pixel benchmark, not its 1.0-1.7% noise floor.

RED state: the artifact does not exist yet (no promoted attempt).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(CONCEPT_DIR))

from green_content import count_green_pixels  # noqa: E402

REFERENCE_PNG = CONCEPT_DIR / "player_profile_costume_reference_T0317.png"
REFERENCE_PROVENANCE = CONCEPT_DIR / "player_profile_costume_reference_T0317.provenance.json"

# T-0272 round 5's own recorded benchmark band for confirmed green-coat panels.
GREEN_BENCHMARK_LOWER = 6000
GREEN_NOISE_FLOOR_FRACTION = 0.017


def test_reference_png_exists():
    assert REFERENCE_PNG.exists(), f"Missing costume side reference: {REFERENCE_PNG}"


def test_provenance_exists():
    assert REFERENCE_PROVENANCE.exists(), f"Missing provenance sidecar: {REFERENCE_PROVENANCE}"


@pytest.fixture()
def reference_bytes() -> bytes:
    return REFERENCE_PNG.read_bytes()


@pytest.fixture()
def provenance() -> dict:
    return json.loads(REFERENCE_PROVENANCE.read_text())


def test_provenance_required_fields(provenance):
    required = {
        "model",
        "model_license",
        "model_hash",
        "prompt",
        "seed",
        "concept_hash",
        "route",
        "generator",
    }
    missing = required - provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_provenance_concept_hash_matches(reference_bytes, provenance):
    expected = hashlib.sha256(reference_bytes).hexdigest()
    assert provenance.get("concept_hash") == expected


def test_provenance_route_is_generated_not_faked():
    provenance = json.loads(REFERENCE_PROVENANCE.read_text())
    assert provenance["route"] == "generated"
    assert "model_hash" in provenance and provenance["model_hash"]


def test_provenance_generator_is_resolvable():
    provenance = json.loads(REFERENCE_PROVENANCE.read_text())
    generator_path = Path(__file__).resolve().parents[4] / provenance["generator"]
    assert generator_path.exists(), f"generator path does not resolve: {generator_path}"


def test_green_content_clears_the_noise_floor_and_approaches_the_benchmark(reference_bytes):
    """T-0272 round 5's own finding: a genuine costume match measures in the
    thousands of green pixels; a non-match (grey/tan tactical tier) measures
    1.0-1.7% of panel area, effectively anti-aliasing noise. This reference
    must clear that noise floor by a wide margin, not just nominally."""
    from io import BytesIO

    img = Image.open(BytesIO(reference_bytes)).convert("RGB")
    green_px = count_green_pixels(img)
    total_px = img.size[0] * img.size[1]
    noise_floor_px = GREEN_NOISE_FLOOR_FRACTION * total_px
    assert green_px > noise_floor_px * 5, (
        f"{green_px} green px is too close to the {noise_floor_px:.0f}px noise floor "
        f"for a {img.size} panel -- this does not read as a genuine green-coat match"
    )
    assert green_px >= GREEN_BENCHMARK_LOWER, (
        f"{green_px} green px is below T-0272 round 5's own recorded lower bound "
        f"({GREEN_BENCHMARK_LOWER}) for a confirmed green-coat panel"
    )
