"""RED: `crop_identity_reference`'s IP-Adapter identity crop must have its
own background forced dark before it is ever uploaded (T-0319).

See `WALK_BACKGROUND_FIX_T0319.md` and `test_force_border_background_T0319.py`
for the full root-cause evidence: `IDENTITY_REFERENCE_CROP_BOX`
(`gen_hybrid_walk_T0259.py:194`) crops a panel of the committed concept sheet
whose own background is mid-grey (modal RGB ~(144,143,145)), and that crop is
fed to IPAdapterAdvanced as the identity reference -- image-level
conditioning that bleeds the reference's own background tone into every
generated frame, a pathway independent of the text prompt/negative prompt
(the negative prompt already names "grey background" explicitly and it made
no difference).

No ComfyUI/GPU needed: `crop_identity_reference` is a pure pixel transform of
the already-committed concept sheet, no network call.

RED: `crop_identity_reference` crops but does not correct the background --
the destination file's own border pixels are still the concept sheet's
mid-grey panel colour, not a dark fill.
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

# T-0319: modal RGB measured on the concept sheet's own panel background at
# IDENTITY_REFERENCE_CROP_BOX, and on the raw sampled frames it bled into --
# both land in this range, well outside CUTOUT_OKLAB_TOLERANCE of black.
MEASURED_GREY_MODAL_RGB = (144, 143, 145)


@pytest.fixture
def corrected_crop(tmp_path: Path) -> Image.Image:
    dest = tmp_path / "identity_reference_crop.png"
    walk.crop_identity_reference(walk.CONCEPT_SHEET_PATH, dest)
    return Image.open(dest).convert("RGB")


def test_crop_background_is_no_longer_mid_grey(corrected_crop: Image.Image) -> None:
    arr = np.array(corrected_crop)
    w, h = corrected_crop.size
    border = np.concatenate(
        [arr[0, :], arr[h - 1, :], arr[:, 0], arr[:, w - 1]]
    )
    modal_grey_count = int(
        np.all(np.abs(border.astype(int) - np.array(MEASURED_GREY_MODAL_RGB)) <= 3, axis=-1).sum()
    )
    assert modal_grey_count == 0, (
        f"{modal_grey_count} border pixels still match the concept sheet panel's own mid-grey "
        f"({MEASURED_GREY_MODAL_RGB}) -- the reference's background bleed is not fixed"
    )


def test_crop_background_is_forced_to_dark_background_fill(corrected_crop: Image.Image) -> None:
    corner_pixels = [
        corrected_crop.getpixel((0, 0)),
        corrected_crop.getpixel((corrected_crop.size[0] - 1, 0)),
        corrected_crop.getpixel((0, corrected_crop.size[1] - 1)),
    ]
    assert all(px == DARK_BACKGROUND_FILL for px in corner_pixels), corner_pixels


def test_crop_still_preserves_the_figure_silhouette(corrected_crop: Image.Image) -> None:
    """The correction must not swallow the identity it exists to preserve --
    sample a known-figure interior point (the coat, per T-0319's own visual
    check) and confirm it survived byte-identical to the uncorrected crop."""
    uncorrected = (
        Image.open(walk.CONCEPT_SHEET_PATH)
        .convert("RGB")
        .crop(walk.IDENTITY_REFERENCE_CROP_BOX)
    )
    sample_point = (90, 130)  # inside the coat, per this card's own visual verification
    assert corrected_crop.getpixel(sample_point) == uncorrected.getpixel(sample_point)


def test_crop_output_size_unchanged(corrected_crop: Image.Image) -> None:
    assert corrected_crop.size == (
        walk.IDENTITY_REFERENCE_CROP_BOX[2] - walk.IDENTITY_REFERENCE_CROP_BOX[0],
        walk.IDENTITY_REFERENCE_CROP_BOX[3] - walk.IDENTITY_REFERENCE_CROP_BOX[1],
    )
