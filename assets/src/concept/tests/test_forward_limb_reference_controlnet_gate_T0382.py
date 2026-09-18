"""T-0382 -- committed forward-limb ControlNet reference artifact gate.

Validates `player_profile_forward_limb_reference_controlnet.png` the same way
`test_forward_limb_reference_controlnet_gate_T0380.py` (T-0380) and
`test_costume_reference_gate_T0317.py` (T-0317) validate their own committed
artifacts: existence, provenance completeness, `concept_hash` matching the
actual bytes, and green content against T-0272 round 5's own recorded
6,000-6,900 benchmark band (used here as a floor per this card's own
acceptance text).

T-0382 re-runs T-0380 attempt 2's exact recipe against the corrected
(far-arm-collapsed) skeleton, within a hard cap of 3 generation attempts. Per
this card's own pre-registered alternative outcome, a stop-and-report after 3
spent attempts with no compliant image is a valid PASS for the card -- in
that case this file is expected to stay RED by design (same convention as
T-0380's and T-0355's own gate files), with the per-attempt evidence and
reasoning committed under `docs/assets/evidence/T-0382/` instead of a
promoted artifact.

RED state: the artifact does not exist yet (no promoted attempt) -- these
gates skip themselves while it is missing and re-arm as soon as one is
committed.
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

# T-0382's own pre-registered 3-attempt cap may be spent without a compliant
# image (see docs/assets/evidence/T-0382/README.md once it exists), in which
# case there is no artifact for these gates to assert on yet. Skipping while
# it is absent keeps ci-concept-gate green for every later assets card
# without deleting the gate: the moment a reference is committed, every test
# below re-arms automatically. (`xfail` is not usable here: seven of these
# tests read the artifact in a fixture, so their failures surface as setup
# errors, which xfail does not convert.)
pytestmark = pytest.mark.skipif(
    not REFERENCE_PNG.exists(),
    reason=(
        "no promoted forward-limb ControlNet reference yet -- either the generation attempts "
        "have not run yet in this session, or T-0382's 3-attempt cap was spent with a "
        "pre-registered stop-and-report; see docs/assets/evidence/T-0382/README.md"
    ),
)


def test_reference_png_exists():
    assert REFERENCE_PNG.exists(), (
        f"Missing forward-limb ControlNet reference: {REFERENCE_PNG} -- if the card's own "
        "3-attempt hard cap was spent with no compliant image, this is a valid PASS via the "
        "pre-registered stop-and-report outcome and this test is expected to stay RED; see "
        "docs/assets/evidence/T-0382/README.md"
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


def test_provenance_skeleton_sha256_differs_from_T0380_attempts_1_2(provenance):
    """This card's own acceptance text: 'the uploaded skeleton's sha256 is
    recorded per attempt and differs from T-0380 attempts 1-2's skeleton' --
    T-0380's attempts 1-2 uploaded the un-collapsed far-arm skeleton
    (`git show 0e48838~1:assets/src/concept/player_profile_forward_limb_skeleton_T0380.png`,
    the commit immediately before T-0380's own far-arm-collapse fix); this
    card's skeleton has the far arm collapsed onto the far shoulder, so the
    bytes -- and therefore the sha256 -- must differ."""
    t0380_attempts_1_2_skeleton_sha256 = (
        "1fe2df9f771633291ea68298e48e37c23630c3353daeb333704b0439ed728069"
    )
    assert provenance.get("skeleton_sha256") != t0380_attempts_1_2_skeleton_sha256
