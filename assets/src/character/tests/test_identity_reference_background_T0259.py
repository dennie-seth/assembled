"""RED: `crop_identity_reference`'s background correction is hard-coded to
T-0319's `force_border_background_to_fill` hard-replace, with no way for a
caller to select a different correction.

The 2026-09-08 attempt log (`probe_reference_bypass_T0259.py`, "bypass" and
"blend" variants) established a decisive, independently-verified finding:
applying that hard flat replace to the IDENTITY REFERENCE crop -- as opposed
to a per-frame cutout, which is a different call site entirely -- produces a
perfectly flat region with a sharp geometric edge that destabilises
IP-Adapter conditioning into structurally incoherent output (attempts 3-4),
while the SAME crop with no correction ("bypass", attempts 5-9's own
regime) or a partial alpha-blend toward the same fill ("blend_0.5")
generates a coherent, recognisable figure. `crop_identity_reference` has no
parameter to select any variant but the hard-replace default, so this
already-proven fix cannot be wired into `run_attempt` without either a
hard-coded behaviour change (which would also silently change
`gen_hybrid_profile_T0272.py`'s own identity conditioning, since that
module imports and calls this exact function unchanged) or a new,
independently-selectable parameter.

GREEN state: `crop_identity_reference` gains a keyword-only
`background_correction` parameter. Its default, `"hard_fill"`, reproduces
today's exact behaviour byte-for-byte, so `gen_hybrid_profile_T0272.py`'s
call site (which does not pass the new keyword) is provably unaffected.
`"none"` reproduces the probe's "bypass" variant exactly (no correction at
all). `"blend_<alpha>"` reproduces the probe's "blend" variant: an
alpha-blend toward `DARK_BACKGROUND_FILL` over the same border-flood mask,
rather than a hard replace. The blend helper itself (`blend_border_background`)
moves from the diagnostic-only probe script into this module as a shared,
tested primitive -- generalizing it rather than leaving two copies, per this
card's own "do not fork the hybrid logic into a divergent copy" instruction.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gen_hybrid_walk_T0259 import (  # noqa: E402
    CUTOUT_OKLAB_TOLERANCE,
    blend_border_background,
    crop_identity_reference,
)

from char_gen.cutout import DARK_BACKGROUND_FILL  # noqa: E402


def _make_synthetic_concept_sheet(tmp_path: Path) -> Path:
    """A tiny synthetic stand-in for the real concept sheet, large enough
    to cover `IDENTITY_REFERENCE_CROP_BOX` -- a flat light-grey panel (the
    mid-grey background regime T-0319 was written against) with a small
    darker rectangle standing in for the figure, so the border-flood mask
    has a genuine foreground/background split to work with."""
    from gen_hybrid_walk_T0259 import IDENTITY_REFERENCE_CROP_BOX

    x0, y0, x1, y1 = IDENTITY_REFERENCE_CROP_BOX
    w, h = x1, y1
    arr = np.full((h, w, 3), 150, dtype=np.uint8)
    cx0, cy0 = x0 + (x1 - x0) // 3, y0 + (y1 - y0) // 3
    cx1, cy1 = x0 + 2 * (x1 - x0) // 3, y0 + 2 * (y1 - y0) // 3
    arr[cy0:cy1, cx0:cx1] = (40, 90, 40)
    path = tmp_path / "synthetic_concept_sheet.png"
    Image.fromarray(arr, mode="RGB").save(path)
    return path


def test_default_background_correction_is_unchanged_hard_fill(tmp_path):
    """No `background_correction` kwarg at all -- exactly how
    `gen_hybrid_profile_T0272.py` calls this function -- must reproduce
    today's committed behaviour byte-for-byte, so this parameter is
    provably additive and does not alter T-0272's own identity
    conditioning."""
    from char_gen.cutout import force_border_background_to_fill

    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    dest_default = tmp_path / "default.png"
    dest_explicit = tmp_path / "explicit_hard_fill.png"

    crop_identity_reference(sheet_path, dest_default)
    crop_identity_reference(sheet_path, dest_explicit, background_correction="hard_fill")

    from gen_hybrid_walk_T0259 import IDENTITY_REFERENCE_CROP_BOX

    expected = force_border_background_to_fill(
        Image.open(sheet_path).convert("RGB").crop(IDENTITY_REFERENCE_CROP_BOX),
        CUTOUT_OKLAB_TOLERANCE,
    )
    assert np.array_equal(np.array(Image.open(dest_default)), np.array(expected))
    assert np.array_equal(np.array(Image.open(dest_default)), np.array(Image.open(dest_explicit)))


def test_background_correction_none_applies_no_correction(tmp_path):
    """`"none"` reproduces the probe's "bypass" variant: the raw crop,
    unmodified -- proven coherent (matches attempts 5-9's figure quality)
    but not dark enough to reliably clear the background-fraction floor on
    its own."""
    from gen_hybrid_walk_T0259 import IDENTITY_REFERENCE_CROP_BOX

    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    dest = tmp_path / "none.png"
    crop_identity_reference(sheet_path, dest, background_correction="none")

    raw_crop = Image.open(sheet_path).convert("RGB").crop(IDENTITY_REFERENCE_CROP_BOX)
    assert np.array_equal(np.array(Image.open(dest)), np.array(raw_crop))


def test_background_correction_blend_is_strictly_between_raw_and_hard_fill(tmp_path):
    """A `"blend_<alpha>"` correction must land strictly between the raw
    crop and the hard-fill result on every background pixel -- darker than
    doing nothing, but not a flat geometric replace -- which is the
    property the probe's coherence finding depends on."""
    from gen_hybrid_walk_T0259 import IDENTITY_REFERENCE_CROP_BOX

    from char_gen.cutout import border_flood_background_mask, force_border_background_to_fill

    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    dest = tmp_path / "blend.png"
    crop_identity_reference(sheet_path, dest, background_correction="blend_0.5")

    raw_crop = Image.open(sheet_path).convert("RGB").crop(IDENTITY_REFERENCE_CROP_BOX)
    hard_fill = force_border_background_to_fill(raw_crop, CUTOUT_OKLAB_TOLERANCE)
    blended = Image.open(dest)

    mask = border_flood_background_mask(raw_crop, CUTOUT_OKLAB_TOLERANCE)
    raw_arr = np.array(raw_crop, dtype=np.int16)
    hard_arr = np.array(hard_fill, dtype=np.int16)
    blend_arr = np.array(blended, dtype=np.int16)

    assert mask.any(), "synthetic fixture must contain a real background region"
    bg_raw = raw_arr[mask]
    bg_hard = hard_arr[mask]
    bg_blend = blend_arr[mask]
    # Every background pixel moves toward the fill but does not reach it --
    # strictly between raw and hard-fill on every channel that actually
    # differs between the two.
    differs = bg_raw != bg_hard
    assert differs.any()
    lo = np.minimum(bg_raw, bg_hard)
    hi = np.maximum(bg_raw, bg_hard)
    assert np.all(bg_blend[differs] >= lo[differs])
    assert np.all(bg_blend[differs] <= hi[differs])
    assert not np.array_equal(bg_blend, bg_raw)
    assert not np.array_equal(bg_blend, bg_hard)


def test_background_correction_blend_alpha_zero_equals_none(tmp_path):
    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    dest_zero = tmp_path / "blend_zero.png"
    dest_none = tmp_path / "none.png"
    crop_identity_reference(sheet_path, dest_zero, background_correction="blend_0.0")
    crop_identity_reference(sheet_path, dest_none, background_correction="none")
    assert np.array_equal(np.array(Image.open(dest_zero)), np.array(Image.open(dest_none)))


def test_background_correction_blend_alpha_one_equals_hard_fill(tmp_path):
    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    dest_one = tmp_path / "blend_one.png"
    dest_hard = tmp_path / "hard.png"
    crop_identity_reference(sheet_path, dest_one, background_correction="blend_1.0")
    crop_identity_reference(sheet_path, dest_hard, background_correction="hard_fill")
    assert np.array_equal(np.array(Image.open(dest_one)), np.array(Image.open(dest_hard)))


def test_unknown_background_correction_raises(tmp_path):
    sheet_path = _make_synthetic_concept_sheet(tmp_path)
    with pytest.raises(ValueError, match="background_correction"):
        crop_identity_reference(sheet_path, tmp_path / "x.png", background_correction="bogus")


def test_blend_border_background_matches_dark_fill_direction():
    """Direct unit test of the moved-and-shared `blend_border_background`
    helper (previously duplicated in the diagnostic-only probe script) --
    every background pixel it touches must move toward
    `DARK_BACKGROUND_FILL`, never away from it."""
    arr = np.full((32, 32, 3), 150, dtype=np.uint8)
    img = Image.fromarray(arr, mode="RGB")
    blended = blend_border_background(img, CUTOUT_OKLAB_TOLERANCE, alpha=0.5)
    blended_arr = np.array(blended, dtype=np.int16)
    fill = np.array(DARK_BACKGROUND_FILL, dtype=np.int16)
    # A uniform flat image is entirely background under the border-flood
    # mask, so every pixel must have moved exactly halfway to the fill.
    expected = (arr.astype(np.int16) * 0.5 + fill * 0.5).round()
    assert np.allclose(blended_arr, expected, atol=1)
