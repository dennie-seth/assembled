"""Regressions for `char_gen.background_key`.

The one that matters is `TestInteriorBackdropColouredRegionSurvives`: it pins the reason
this keys by flooding from the border instead of thresholding globally.
"""
import numpy as np
import pytest
from PIL import Image

from char_gen.background_key import DEFAULT_TOLERANCE, key_background

GREY = (151, 149, 151)
GREEN = (40, 120, 60)


def _render(width=80, height=80, backdrop=GREY, figure=GREEN, figure_box=(20, 10, 60, 70)):
    a = np.zeros((height, width, 3), dtype=np.uint8)
    a[:, :] = backdrop
    x0, y0, x1, y1 = figure_box
    a[y0:y1, x0:x1] = figure
    return Image.fromarray(a, "RGB")


class TestBackdropIsDetectedWithoutBeingNamed:
    def test_backdrop_colour_comes_from_the_border(self):
        _, stats = key_background(_render())
        assert stats["backdrop_rgb"] == list(GREY)

    def test_the_figure_is_opaque_and_the_backdrop_is_not(self):
        rgba, _ = key_background(_render())
        a = np.asarray(rgba)
        assert a[40, 40, 3] == 255, "figure centre should be fully opaque"
        assert a[2, 2, 3] == 0, "frame corner should be fully transparent"


class TestInteriorBackdropColouredRegionSurvives:
    """The whole reason this floods from the border.

    A costume highlight the same colour as the backdrop is NOT reachable from the frame
    edge, so it must stay opaque. A global threshold would punch a hole through it.
    """

    def test_enclosed_backdrop_coloured_patch_stays_opaque(self):
        img = _render()
        a = np.asarray(img).copy()
        a[30:50, 30:50] = GREY          # a grey highlight fully inside the green figure
        rgba, stats = key_background(Image.fromarray(a, "RGB"))

        assert np.asarray(rgba)[40, 40, 3] == 255, (
            "an enclosed backdrop-coloured region must survive -- if this fails the keyer "
            "has regressed to a global threshold"
        )
        assert stats["figure_pixels_colliding_with_backdrop"] >= 400, (
            "the collision metric should report the patch a global threshold would eat"
        )


class TestStatsDescribeTheResult:
    def test_touching_the_frame_is_reported(self):
        # figure runs off the left edge; the other three sides keep a backdrop margin
        _, stats = key_background(_render(figure_box=(0, 10, 60, 70)))
        assert stats["figure_touches_frame"] == ["left"]

    def test_a_figure_clear_of_the_frame_reports_no_contact(self):
        _, stats = key_background(_render())
        assert stats["figure_touches_frame"] == []

    def test_fractions_are_complementary(self):
        _, stats = key_background(_render())
        total = stats["keyed_out_fraction"] + stats["figure_fraction"]
        assert 0.97 <= total <= 1.03


class TestTolerance:
    @pytest.mark.parametrize("tol", [DEFAULT_TOLERANCE, 10, 90])
    def test_a_clean_synthetic_render_keys_at_any_sane_tolerance(self, tol):
        rgba, _ = key_background(_render(), tolerance=tol)
        a = np.asarray(rgba)
        assert a[40, 40, 3] == 255
        assert a[2, 2, 3] == 0
