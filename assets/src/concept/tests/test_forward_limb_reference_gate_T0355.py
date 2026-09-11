"""T-0355 -- committed forward-limb green-costume side-profile reference
artifact gate.

Validates `player_profile_forward_limb_reference_T0355.png` the same way
`test_costume_reference_gate_T0317.py` validates T-0317's own committed
reference: existence, provenance completeness, `concept_hash` matching the
actual bytes, and green content quantitatively comparable to T-0272 round
5's own recorded 6,000-6,900 green-pixel benchmark -- this card's own
acceptance criterion is that the green costume is "measurably present,
quantified the way T-0317's was", not asserted by eye.

Pre-registered alternative outcome (this card's own acceptance criteria):
if the forward-limb profile cannot be generated within the 4-attempt hard
cap, this test file is expected to stay RED and the stop-and-report evidence
under docs/assets/evidence/T-0355/ is the actual deliverable instead -- see
that directory's README for the outcome actually reached.

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

REFERENCE_PNG = CONCEPT_DIR / "player_profile_forward_limb_reference_T0355.png"
REFERENCE_PROVENANCE = CONCEPT_DIR / "player_profile_forward_limb_reference_T0355.provenance.json"

# T-0272 round 5's own recorded benchmark band for confirmed green-coat panels
# -- the same predicate and noise floor T-0317's own gate uses.
GREEN_BENCHMARK_LOWER = 6000
GREEN_NOISE_FLOOR_FRACTION = 0.017


def test_reference_png_exists():
    assert REFERENCE_PNG.exists(), f"Missing forward-limb side reference: {REFERENCE_PNG}"


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
        "model_hash",
        "prompt",
        "seed",
        "concept_hash",
        "route",
        "generator",
        "gpu_seconds",
    }
    missing = required - provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_provenance_concept_hash_matches(reference_bytes, provenance):
    expected = hashlib.sha256(reference_bytes).hexdigest()
    assert provenance.get("concept_hash") == expected


def test_provenance_route_is_generated_not_faked(provenance):
    assert provenance["route"] == "generated"
    assert "model_hash" in provenance and provenance["model_hash"]


def test_provenance_generator_is_resolvable(provenance):
    generator_path = Path(__file__).resolve().parents[4] / provenance["generator"]
    assert generator_path.exists(), f"generator path does not resolve: {generator_path}"


def test_provenance_states_canonical_coat_length(provenance):
    assert "past the knee" in provenance["prompt"].lower()


def test_green_content_clears_the_noise_floor_and_approaches_the_benchmark(reference_bytes):
    img = Image.open(__import__("io").BytesIO(reference_bytes)).convert("RGB")
    green_px = count_green_pixels(img)
    total_px = img.size[0] * img.size[1]
    noise_floor_px = GREEN_NOISE_FLOOR_FRACTION * total_px
    assert green_px > noise_floor_px * 5, (
        f"{green_px} green px is too close to the {noise_floor_px:.0f}px noise floor "
        f"for a {img.size} reference -- this does not read as a genuine green-coat match"
    )
    assert green_px >= GREEN_BENCHMARK_LOWER, (
        f"{green_px} green px is below T-0272 round 5's own recorded lower bound "
        f"({GREEN_BENCHMARK_LOWER}) for a confirmed green-coat panel"
    )
