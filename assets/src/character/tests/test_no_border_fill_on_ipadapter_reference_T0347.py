"""RED: T-0347 reverses T-0319's own fix. Forcing `crop_identity_reference`'s
IP-Adapter identity crop background to a dark fill (T-0319, PR #350) was
meant to stop the crop's own mid-grey panel background bleeding into every
generated frame -- but recolouring the *reference* image itself, rather
than a generated render, corrupts IP-Adapter's conditioning signal: probed
against a live ComfyUI run, it destroyed generation coherence 100% of the
time (`asset-pipeline-review-2026-09-09.md`, approved by @DennieSeth). This
supersedes and deletes `test_reference_background_fix_T0319.py`, whose
assertions enforced exactly the behaviour removed here -- the two files
cannot both pass at once.

`char_gen.cutout.force_border_background_to_fill` itself is untouched and
stays correct for its other, legitimate use: cleaning a generated RENDER's
own background before segmentation
(`gen_hybrid_walk_T0259.reprocess_attempt_background_fix`,
`gen_hybrid_profile_T0272.build_indexed_cell` -- both covered by their own
existing tests, unaffected by this card).

No ComfyUI/GPU needed: `crop_identity_reference` is a pure pixel transform
of the already-committed concept sheet, no network call.

RED: `crop_identity_reference` still calls `force_border_background_to_fill`
-- the produced crop's border is still forced to `DARK_BACKGROUND_FILL`
instead of being left as a plain, uncorrected crop of the concept sheet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_hybrid_walk_T0259 as walk  # noqa: E402

from char_gen.cutout import DARK_BACKGROUND_FILL  # noqa: E402


@pytest.fixture
def uncorrected_crop() -> Image.Image:
    return (
        Image.open(walk.CONCEPT_SHEET_PATH)
        .convert("RGB")
        .crop(walk.IDENTITY_REFERENCE_CROP_BOX)
    )


@pytest.fixture
def crop_output(tmp_path: Path) -> Image.Image:
    dest = tmp_path / "identity_reference_crop.png"
    walk.crop_identity_reference(walk.CONCEPT_SHEET_PATH, dest)
    return Image.open(dest).convert("RGB")


def test_crop_identity_reference_is_byte_identical_to_a_plain_crop(
    crop_output: Image.Image, uncorrected_crop: Image.Image
) -> None:
    """The produced IP-Adapter reference must match a plain
    `Image.crop(IDENTITY_REFERENCE_CROP_BOX)` exactly -- no border-fill
    recolouring, no pixel touched beyond the crop itself. Direct inverse of
    T-0319's own `test_crop_background_is_forced_to_dark_background_fill`."""
    assert np.array_equal(np.array(crop_output), np.array(uncorrected_crop))


def test_crop_identity_reference_border_keeps_the_concept_sheet_panel_colour(
    crop_output: Image.Image,
) -> None:
    corner_pixels = [
        crop_output.getpixel((0, 0)),
        crop_output.getpixel((crop_output.size[0] - 1, 0)),
        crop_output.getpixel((0, crop_output.size[1] - 1)),
    ]
    assert all(px != DARK_BACKGROUND_FILL for px in corner_pixels), corner_pixels


def test_crop_identity_reference_never_calls_force_border_background_to_fill(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Guard: fails if a future caller reintroduces border-fill on this
    reference path -- e.g. someone re-adding the T-0319 call because the
    mid-grey-background symptom recurs, without re-reading why it was
    removed. Spying on the module's own imported name catches any call made
    while preparing the IP-Adapter reference, however
    `crop_identity_reference`'s body is refactored."""
    calls: list[tuple[Image.Image, float]] = []

    def spy(img: Image.Image, tolerance: float, **kwargs: object) -> Image.Image:
        calls.append((img, tolerance))
        return img

    monkeypatch.setattr(walk, "force_border_background_to_fill", spy)

    dest = tmp_path / "identity_reference_crop.png"
    walk.crop_identity_reference(walk.CONCEPT_SHEET_PATH, dest)

    assert calls == [], (
        "crop_identity_reference must never call force_border_background_to_fill -- "
        "applying it to an IP-Adapter reference image destroys generation coherence "
        "(T-0347); that correction belongs only on a generated render before cutout"
    )
