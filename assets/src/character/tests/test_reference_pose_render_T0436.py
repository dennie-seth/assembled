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


class TestHipPxMatchesWorldOrigin:
    """Regression for the reviewer's FAIL verdict (2026-10-08T22:18:16Z): passing
    `hip_points` into `render_frames` must not change what `RenderResult.hip_px`
    means. `gen_reference_pose_evidence_T0436.py` relies on `hip_px` being the
    canvas pixel for world `(0, 0)` to place every other overlay point via its own
    `to_canvas`; `rig_compositor.render_frames` silently redefined it to the canvas
    pixel of `hip_R` whenever `hip_points` was supplied, a +9.06px error measured
    directly on the committed overlay."""

    def test_hip_px_is_the_canvas_pixel_for_world_origin(self):
        placements = refpose.build_reference_placements()
        origin, _size = _canvas_geometry(placements)
        expected = (round(-origin[0]), round(-origin[1]))
        result = refpose.render()
        assert result.hip_px == expected


class TestLegDebugPixelsTrackTheLateralOffset:
    """Regression for the same FAIL verdict's secondary defect: `render_frames`'s
    debug `knee_l_px`/`ankle_l_px` were computed from `resolved_hip_points["L"]`
    WITHOUT the chain's own lateral offset, while the actually-placed `calf_L`
    (via `build_placements`) DOES carry it -- the two disagreed by exactly the
    offset whenever `lateral_offset_frac` is active."""

    def test_ankle_l_px_matches_the_leg_chain_solved_from_the_actually_placed_thigh_l(self):
        placements = {p.name: p for p in refpose.build_reference_placements()}
        rig = rig_compositor.load_rig()
        lengths = rig_compositor.measured_bone_lengths(rig_compositor.load_parts(), rig)
        # ground_plane_y only feeds leg_stance's dataclass, not leg_chain's own
        # math (hip_side/thigh_len/calf_len/leg.thigh_deg_l/knee_flexion_deg_l do) --
        # any finite value reproduces the same thigh_deg_l/knee_flexion_deg_l this
        # module's leg_stance always uses.
        stance = refpose.leg_stance((0.0, 0.0), ground_plane_y=0.0)
        # thigh_L.target_xy is the ground truth -- build_placements already applied
        # this chain's lateral offset to it before using it as the leg_chain root.
        _knee_l_expected, ankle_l_expected = rig_compositor.leg_chain(
            placements["thigh_L"].target_xy, lengths["thigh_L"], lengths["calf_L"], stance, "L",
        )
        origin, _size = _canvas_geometry(list(placements.values()))
        expected_ankle_l_px = (
            round(ankle_l_expected[0] - origin[0]), round(ankle_l_expected[1] - origin[1]),
        )

        result = refpose.render()
        assert result.ankle_l_px == expected_ankle_l_px


class TestPerSideArmAnglesFromTheReference:
    """Fix round 4: the near (R) and far (L) arms are posed from DIFFERENT angles
    measured off the red bone lines in the attached
    `dennie_canonical_skeleton_ref.png` (mirrored and converted into this rig's own
    sign convention) -- replacing the previous SHOULDER_REST_DEG/ELBOW_REST_DEG
    pair that gave both arms the same droop."""

    def test_arm_angle_constants_match_the_measured_reference(self):
        assert refpose.SHOULDER_DEG_R == pytest.approx(44.3)
        assert refpose.ELBOW_DEG_R == pytest.approx(40.7)
        assert refpose.SHOULDER_DEG_L == pytest.approx(-56.4)
        assert refpose.ELBOW_DEG_L == pytest.approx(33.2)

    def test_upper_pose_gives_each_arm_its_own_angle(self):
        pose = refpose.upper_pose(0.0, 100.0)
        assert pose.shoulder_deg_for("R") == pytest.approx(refpose.SHOULDER_DEG_R)
        assert pose.shoulder_deg_for("L") == pytest.approx(refpose.SHOULDER_DEG_L)
        assert pose.elbow_deg_for("R") == pytest.approx(refpose.ELBOW_DEG_R)
        assert pose.elbow_deg_for("L") == pytest.approx(refpose.ELBOW_DEG_L)
        assert pose.shoulder_deg_for("R") != pose.shoulder_deg_for("L")

    def test_reference_placements_put_each_elbow_at_a_different_angle_derived_target(self):
        """Both shoulders share one world point in this pose (set from the
        canonical shoulder-bar ends, not from `shoulder_deg`), so the elbow
        target is the one place a difference in ANGLE (not just root position)
        is directly observable."""
        placements = {p.name: p for p in refpose.build_reference_placements(lateral_offset_frac={})}
        rig = rig_compositor.load_rig()
        lengths = rig_compositor.measured_bone_lengths(rig_compositor.load_parts(), rig)

        from char_gen.walk_cycle import distal_joint

        elbow_r = distal_joint(
            placements["shoulder_R"].target_xy, lengths["shoulder_R"], refpose.SHOULDER_DEG_R,
        )
        elbow_l = distal_joint(
            placements["shoulder_L"].target_xy, lengths["shoulder_L"], refpose.SHOULDER_DEG_L,
        )
        assert placements["forearm_R"].target_xy == pytest.approx(elbow_r)
        assert placements["forearm_L"].target_xy == pytest.approx(elbow_l)
        assert elbow_r != elbow_l


class TestDeterminism:
    def test_render_is_deterministic(self):
        r1 = refpose.render()
        r2 = refpose.render()
        assert list(r1.native_frames[0].getdata()) == list(r2.native_frames[0].getdata())

    def test_render_produces_exactly_one_frame(self):
        result = refpose.render()
        assert len(result.native_frames) == 1
        assert len(result.descended_frames) == 1
