"""T-0436: the static render that proves the canonical rig can reproduce the
structural features of @DennieSeth's skeleton reference -- a shoulder bar and a
pelvis bar with two distinct ends, and a lateral offset that makes the far arm
visible instead of hiding it inside the torso silhouette.

Scope, deliberately narrow: `char_gen.reference_pose_T0436` is a NEW module that
calls the shared `rig_compositor.render_frames` for exactly one static frame, using
the new opt-in parameters `test_canonical_rig_T0436.py` proves are inert by default.
It does not touch, and its own tests do not re-test, `walk_cycle`/`idle_cycle`/
`sitting_idle_cycle`.
"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from char_gen import reference_pose_T0436 as refpose
from char_gen import rig_compositor


def _composite(placements: list[rig_compositor.Placement], origin: tuple[float, float],
                size: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    for p in sorted(placements, key=lambda pl: -pl.z):
        dest = (round(p.target_xy[0] - p.pivot_px[0] - origin[0]),
                round(p.target_xy[1] - p.pivot_px[1] - origin[1]))
        canvas.alpha_composite(p.image, dest=dest)
    return canvas


def _canvas_geometry(
    placements: list[rig_compositor.Placement],
) -> tuple[tuple[float, float], tuple[int, int]]:
    xs = [p.target_xy[0] - p.pivot_px[0] for p in placements]
    ys = [p.target_xy[1] - p.pivot_px[1] for p in placements]
    x0, y0 = min(xs) - 4, min(ys) - 4
    x1 = max(x + p.image.width for x, p in zip(xs, placements)) + 4
    y1 = max(y + p.image.height for y, p in zip(ys, placements)) + 4
    return (x0, y0), (int(x1 - x0), int(y1 - y0))


def visible_pixel_count(all_placements: list[rig_compositor.Placement], part_name: str) -> int:
    """How many composited pixels are THIS part's own, non-transparent contribution
    -- i.e. pixels where removing the part changes the final (alpha-composited)
    result and the "with" result is itself non-transparent there. A part that is
    fully occluded by something drawn on top of it contributes zero, regardless of
    how much of its own bitmap is opaque. Both composites share the same canvas
    origin/size (taken from the WITH-part placement list) so they compare pixel for
    pixel."""
    without_part = [p for p in all_placements if p.name != part_name]
    assert len(without_part) == len(all_placements) - 1, "part_name must be in all_placements"

    origin, size = _canvas_geometry(all_placements)
    arr_with = np.asarray(_composite(all_placements, origin, size))
    arr_without = np.asarray(_composite(without_part, origin, size))
    differs = np.any(arr_with != arr_without, axis=-1)
    is_opaque = arr_with[:, :, 3] > 0
    return int(np.count_nonzero(differs & is_opaque))


class TestFarArmVisibility:
    def test_far_arm_is_visible_in_the_reference_pose_render(self):
        placements = refpose.build_reference_placements()
        shoulder_l_px = visible_pixel_count(placements, "shoulder_L")
        forearm_l_px = visible_pixel_count(placements, "forearm_L")
        assert shoulder_l_px > 0, "shoulder_L must render a non-zero number of visible pixels"
        assert forearm_l_px > 0, "forearm_L must render a non-zero number of visible pixels"

    def test_far_arm_is_more_visible_with_the_lateral_offset_than_without(self):
        """The contrast the card requires: the two-point shoulder attach alone
        (bar ends, no extra push) is not what clears the torso -- the lateral
        offset is. Re-sorting (z) never did this; this proves POSITION changed."""
        with_offset = refpose.build_reference_placements()
        without_offset = refpose.build_reference_placements(lateral_offset_frac={})
        with_px = visible_pixel_count(with_offset, "shoulder_L")
        without_px = visible_pixel_count(without_offset, "shoulder_L")
        assert with_px > without_px


class TestTwoPointAttachInTheReferencePose:
    def test_shoulder_ends_are_the_canonical_bar_apart(self):
        placements = {p.name: p for p in refpose.build_reference_placements(lateral_offset_frac={})}
        rig = rig_compositor.load_rig()
        expected = rig["canonical_rig"]["shoulder_bar"]["px"]
        dx = placements["shoulder_R"].target_xy[0] - placements["shoulder_L"].target_xy[0]
        assert dx == pytest.approx(expected, abs=1.0)

    def test_hip_ends_are_the_canonical_bar_apart(self):
        placements = {p.name: p for p in refpose.build_reference_placements(lateral_offset_frac={})}
        rig = rig_compositor.load_rig()
        expected = rig["canonical_rig"]["pelvis_bar"]["px"]
        dx = placements["thigh_R"].target_xy[0] - placements["thigh_L"].target_xy[0]
        assert dx == pytest.approx(expected, abs=1.0)


class TestDeterminism:
    def test_render_is_deterministic(self):
        r1 = refpose.render()
        r2 = refpose.render()
        assert list(r1.native_frames[0].getdata()) == list(r2.native_frames[0].getdata())

    def test_render_produces_exactly_one_frame(self):
        result = refpose.render()
        assert len(result.native_frames) == 1
        assert len(result.descended_frames) == 1
