"""Regressions for `char_gen.idle_render`, the deterministic side-view idle compositor.

These assert against actually-composited pixels, not the curve math `test_idle_cycle.py`
already pins -- per T-0430's own acceptance criteria, "both feet stay planted" and "the
loop is seamless" must be shown from the composited frames, not just from intent.
"""
import numpy as np
import pytest
from PIL import Image

from char_gen.idle_cycle import DESCEND_SCALE, FRAME_COUNT
from char_gen.idle_render import (
    PART_NAMES,
    PARTS_DIR,
    compose_frame,
    descend,
    foot_bottom_rows,
    load_parts,
)

PHASES = [i / FRAME_COUNT for i in range(FRAME_COUNT)]


@pytest.fixture(scope="module")
def parts():
    return load_parts()


class TestNoGpuNoNetwork:
    """T-0430 acceptance: 'zero GPU calls -- assert that, do not merely claim it.'"""

    FORBIDDEN = ("comfy", "ComfyUI", "requests", "http://", "https://", "torch", "cuda")

    def test_idle_render_source_has_no_gpu_or_network_tokens(self):
        src = (PARTS_DIR.parent.parent / "src" / "char_gen" / "idle_render.py").read_text()
        for token in self.FORBIDDEN:
            assert token not in src, f"found forbidden token {token!r} in idle_render.py"

    def test_idle_cycle_source_has_no_gpu_or_network_tokens(self):
        src = (PARTS_DIR.parent.parent / "src" / "char_gen" / "idle_cycle.py").read_text()
        for token in self.FORBIDDEN:
            assert token not in src, f"found forbidden token {token!r} in idle_cycle.py"


class TestPartsReusedUnmodified:
    def test_all_ten_parts_load(self, parts):
        assert set(parts) == set(PART_NAMES)
        assert len(parts) == 10

    def test_parts_are_loaded_from_the_committed_side_view_directory(self):
        assert PARTS_DIR.name == "side_view"
        assert (PARTS_DIR / "side_view_rig.json").exists()


class TestLoopIsSeamless:
    def test_phase_zero_and_phase_one_render_identical_pixels(self, parts):
        a = np.asarray(compose_frame(parts, 0.0))
        b = np.asarray(compose_frame(parts, 1.0))
        assert a.shape == b.shape
        assert np.array_equal(a, b), "frame at phase 1.0 must match phase 0.0 exactly"


class TestFeetStayPlanted:
    """No ankle may rise off the ground line in any frame -- the clearest line between
    idle and walk."""

    def test_foot_bottom_rows_are_identical_across_every_frame(self, parts):
        frames = [compose_frame(parts, p) for p in PHASES]
        rows = [foot_bottom_rows(f) for f in frames]
        first = rows[0]
        for i, r in enumerate(rows[1:], start=1):
            assert r == first, (
                f"frame {i}'s foot contact row {r} differs from frame 0's {first} -- a foot "
                "moved"
            )

    def test_foot_bottom_rows_are_identical_after_descent(self, parts):
        frames = [descend(compose_frame(parts, p)) for p in PHASES]
        rows = [foot_bottom_rows(f) for f in frames]
        assert all(r == rows[0] for r in rows), (
            "descent must not introduce any per-frame foot movement"
        )


class TestMotionSurvivesDescent:
    def test_descended_frame_height_matches_target_figure_scale(self, parts):
        native = compose_frame(parts, 0.0)
        small = descend(native)
        expected_h = round(native.height * DESCEND_SCALE)
        assert small.height == expected_h

    def test_torso_centroid_moves_visibly_across_the_breath_cycle(self, parts):
        # Sample the quarter-cycle point where breath peaks (frames are 0-indexed phases of
        # i / FRAME_COUNT; with 2 breath cycles per loop the first peak lands near phase
        # 0.25 / BREATH_CYCLES_PER_LOOP of a full cycle -- i.e. phase 0.125).
        low = descend(compose_frame(parts, 0.0))
        peak = descend(compose_frame(parts, 0.125))
        y_low = _opaque_centroid_y(low)
        y_peak = _opaque_centroid_y(peak)
        assert abs(y_low - y_peak) > 0.5, (
            f"torso centroid barely moved ({y_low:.2f} -> {y_peak:.2f}) at final figure "
            "height -- breathing does not read"
        )


def _opaque_centroid_y(img: Image.Image) -> float:
    alpha = np.asarray(img)[:, :, 3]
    ys, _ = np.nonzero(alpha > 0)
    return float(ys.mean())
