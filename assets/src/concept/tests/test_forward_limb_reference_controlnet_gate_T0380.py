"""T-0380 -- committed forward-limb ControlNet reference artifact gate.

Validates `player_profile_forward_limb_reference_controlnet.png` the same way
`test_costume_reference_gate_T0317.py` (T-0317) validates its own committed
artifact: existence, provenance completeness, `concept_hash` matching the
actual bytes, and green content against T-0272 round 5's own recorded
6,000-6,900 benchmark band (used here as a floor per this card's own
acceptance text).

Per this card's own pre-registered alternative outcome, a stop-and-report
after 4 spent attempts with no compliant image is a valid PASS for the card
-- in that case this file is expected to stay RED by design (same as
T-0355's own `test_forward_limb_reference_gate_T0355.py`), with the
per-attempt evidence and reasoning committed under
`docs/assets/evidence/T-0380/` instead of a promoted artifact.

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

REFERENCE_PNG = CONCEPT_DIR / "player_profile_forward_limb_reference_controlnet.png"
REFERENCE_PROVENANCE = (
    CONCEPT_DIR / "player_profile_forward_limb_reference_controlnet.provenance.json"
)

# T-0272 round 5's own recorded benchmark band, used as a floor per this
# card's own acceptance text ("at or above its 6,000 floor").
GREEN_BENCHMARK_LOWER = 6000
GREEN_MEASURE_CROP_SIZE = (187, 200)
BORDER_PX = 16
BORDER_MAX_CHANNEL = 16


def test_reference_png_exists():
    assert REFERENCE_PNG.exists(), (
        f"Missing forward-limb ControlNet reference: {REFERENCE_PNG} -- if the card's own "
        "4-attempt hard cap was spent with no compliant image, this is a valid PASS via the "
        "pre-registered stop-and-report outcome and this test is expected to stay RED; see "
        "docs/assets/evidence/T-0380/README.md"
    )


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
        "denoise",
        "controlnet_strength",
        "concept_hash",
        "route",
        "generator",
        "base_image_path",
        "base_image_sha256",
        "skeleton_path",
        "skeleton_sha256",
        "gpu_seconds",
    }
    missing = required - provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_provenance_model_hash_is_non_null(provenance):
    assert provenance.get("model_hash")


def test_provenance_concept_hash_matches(reference_bytes, provenance):
    expected = hashlib.sha256(reference_bytes).hexdigest()
    assert provenance.get("concept_hash") == expected


def test_provenance_route_is_generated_not_faked(provenance):
    assert provenance["route"] == "generated"


def test_provenance_generator_is_resolvable(provenance):
    generator_path = Path(__file__).resolve().parents[4] / provenance["generator"]
    assert generator_path.exists(), f"generator path does not resolve: {generator_path}"


def test_background_border_band_is_solid_black(reference_bytes):
    import numpy as np

    img = Image.open(__import__("io").BytesIO(reference_bytes)).convert("RGB")
    arr = np.array(img)
    band = np.concatenate(
        [
            arr[:BORDER_PX, :, :].reshape(-1, 3),
            arr[-BORDER_PX:, :, :].reshape(-1, 3),
            arr[:, :BORDER_PX, :].reshape(-1, 3),
            arr[:, -BORDER_PX:, :].reshape(-1, 3),
        ]
    )
    measured_max = int(band.max())
    assert measured_max <= BORDER_MAX_CHANNEL, (
        f"border band max channel {measured_max} exceeds {BORDER_MAX_CHANNEL} -- background "
        "is not solid black"
    )


def test_green_content_clears_the_6000_floor(reference_bytes):
    img = Image.open(__import__("io").BytesIO(reference_bytes)).convert("RGB")
    w, h = img.size
    cw, ch = GREEN_MEASURE_CROP_SIZE
    left, upper = (w - cw) // 2, (h - ch) // 2
    crop_box = (left, upper, left + cw, upper + ch)
    green_px = count_green_pixels(img, crop=crop_box)
    assert green_px >= GREEN_BENCHMARK_LOWER, (
        f"{green_px} green px in the centred {cw}x{ch} crop is below the "
        f"{GREEN_BENCHMARK_LOWER}px floor"
    )
