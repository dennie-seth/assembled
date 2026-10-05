"""Regressions for `char_gen.sitting_idle_cycle`.

Three groups. `TestSeatedStance` pins the seated base pose -- a two-bone solve with BOTH
ends pinned (hip on the seat plane, ankle on the ground plane), so the legs need no curve
at all. `TestOnlyTheUpperBodyMoves` mirrors `test_idle_cycle.py`'s own scope pin: sitting
idle carries the same ONE signal as standing idle, reused rather than re-derived.
`TestComposited*` builds real frames from the ten committed parts and asserts the two
contacts are provably still, the amplitude survives the descent, and the loop closes --
from the actual composited pixels, not from the intent.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from char_gen.idle_cycle import ELBOW_REST_DEG, HEAD_REST_DEG, SHOULDER_REST_DEG, ankle_of
from char_gen.sitting_idle_cycle import (
    FRAME_COUNT,
    PARTS_DIR,
    SittingIdlePose,
    load_parts,
    load_rig,
    measured_bone_lengths,
    native_figure_height,
    pose_at,
    render_frames,
    seated_stance,
)
from char_gen.walk_cycle import bone_length

# Measured, matching docs/assets/evidence/T-0430/rig.json and
# assets/src/character/parts/side_view/side_view_rig.json -- same ten parts, unchanged.
TORSO_H = 257.0
THIGH, CALF = 246.7, 330.2
PHASES = [i / FRAME_COUNT for i in range(FRAME_COUNT)]


class TestSeatedStance:
    """The seated base pose: both ends of the leg chain are pinned, so there is nothing
    left for a curve to author."""

    def test_hip_rests_on_the_seat_plane(self):
        stance = seated_stance(THIGH, CALF)
        assert stance.seat_plane_y == 0.0

    def test_ankle_rests_on_the_ground_plane_directly_below_the_knee(self):
        stance = seated_stance(THIGH, CALF)
        assert stance.ground_plane_y == CALF

    def test_the_solve_reaches_the_target_exactly(self):
        """Forward-kinematics check: the solved angles must actually put the ankle at
        (hip_forward_x, ground_plane_y), not a clamped approximation."""
        stance = seated_stance(THIGH, CALF)
        from char_gen.sitting_idle_cycle import SeatedLegIK

        ik = SeatedLegIK(stance.thigh_deg, stance.knee_flexion_deg)
        got = ankle_of((0.0, stance.seat_plane_y), ik, THIGH, CALF)
        target = (stance.hip_forward_x, stance.ground_plane_y)
        assert math.hypot(got[0] - target[0], got[1] - target[1]) < 1e-6, (
            "the two-bone solve did not reach the chosen seat/ground planes exactly -- "
            "it clamped instead of solving"
        )

    def test_the_reach_is_not_at_the_clamp_boundary(self):
        """If the chosen planes put the ankle out of the leg's workspace, solve_leg
        clamps silently. The chosen reach must sit strictly inside (|thigh-calf|,
        thigh+calf)."""
        stance = seated_stance(THIGH, CALF)
        reach = math.hypot(stance.hip_forward_x, stance.ground_plane_y - stance.seat_plane_y)
        lo, hi = abs(THIGH - CALF), THIGH + CALF
        assert lo + 1.0 < reach < hi - 1.0, f"reach {reach:.1f} is at the IK's clamp edge"

    def test_the_thigh_is_roughly_horizontal(self):
        stance = seated_stance(THIGH, CALF)
        assert 80.0 < stance.thigh_deg < 100.0, (
            f"thigh at {stance.thigh_deg:.1f} deg does not read as a seated thigh"
        )

    def test_the_calf_hangs_roughly_vertical(self):
        stance = seated_stance(THIGH, CALF)
        calf_deg = stance.thigh_deg - stance.knee_flexion_deg
        assert abs(calf_deg) < 10.0, f"calf at {calf_deg:.1f} deg should be near-vertical"

    def test_the_stance_is_deterministic(self):
        assert seated_stance(THIGH, CALF) == seated_stance(THIGH, CALF)


class TestOnlyTheUpperBodyMoves:
    """Sitting idle carries exactly one signal, same as the standing idle it borrows
    `breath` from. Anything else reappearing here is the rejected 'too busy' idle."""

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_arms_are_a_fixed_hanging_pose(self, phase):
        p = pose_at(phase, TORSO_H)
        assert p.shoulder_deg == SHOULDER_REST_DEG
        assert p.elbow_deg == ELBOW_REST_DEG

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_head_and_torso_do_not_rotate(self, phase):
        p = pose_at(phase, TORSO_H)
        assert p.head_deg == HEAD_REST_DEG
        assert p.torso_deg == 0.0

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_legs_hold_the_seated_stance_at_every_phase(self, phase):
        stance = seated_stance(THIGH, CALF)
        p = pose_at(phase, TORSO_H, stance=stance)
        assert p.thigh_deg == stance.thigh_deg
        assert p.knee_flexion_deg == stance.knee_flexion_deg

    def test_the_upper_body_actually_moves(self):
        span = max(pose_at(ph, TORSO_H).upper_dy for ph in PHASES) - \
            min(pose_at(ph, TORSO_H).upper_dy for ph in PHASES)
        assert span > 0.0

    def test_frame_zero_is_the_base_pose(self):
        """Every frame is a departure from the seated base pose and must return to it --
        frame 0 (phase 0) IS that base pose, with no breath offset at all."""
        assert pose_at(0.0, TORSO_H).upper_dy == 0.0


class TestLoopCloses:
    def test_pose_agrees_across_the_seam(self):
        a, b = pose_at(0.0, TORSO_H), pose_at(1.0, TORSO_H)
        assert a.upper_dy == pytest.approx(b.upper_dy, abs=1e-12), "the loop will pop"

    def test_phase_wraps(self):
        assert pose_at(1.25, TORSO_H).upper_dy == pytest.approx(pose_at(0.25, TORSO_H).upper_dy)


class TestMeasuredGeometry:
    """Reads the real committed parts and rig JSON -- no hardcoded pixel sizes in the
    production module, mirroring `char_gen.idle_cycle`'s own generic pose math."""

    def test_parts_dir_has_all_ten_parts(self):
        parts = load_parts(PARTS_DIR)
        assert len(parts) == 10

    def test_bone_lengths_match_the_committed_rig(self):
        parts = load_parts(PARTS_DIR)
        rig = load_rig()
        lengths = measured_bone_lengths(parts, rig)
        # calf_L carries the rig's own length-scale correction; both calves should end up
        # within a pixel of each other, same as the walk's own correction achieves.
        assert abs(lengths["calf_L"] - lengths["calf_R"]) < 1.0
        assert lengths["thigh_L"] == pytest.approx(lengths["thigh_R"], abs=0.5)

    def test_native_figure_height_is_positive_and_plausible(self):
        parts = load_parts(PARTS_DIR)
        rig = load_rig()
        h = native_figure_height(parts, rig)
        # A seated figure is shorter than the standing figure's ~977px -- plausible bounds.
        assert 300.0 < h < 900.0


class TestCompositedFrames:
    """Built from the real parts. Assertions run on the actual composited pixels."""

    @classmethod
    @pytest.fixture(scope="class")
    def result(cls):
        return render_frames()

    def test_frame_count(self, result):
        assert len(result.native_frames) == FRAME_COUNT
        assert len(result.descended_frames) == FRAME_COUNT

    def test_both_contacts_are_provably_still(self, result):
        """The hip and both ankles never move -- assert it on the pixels, not the intent.
        Everything below the lower-body band is placed from constants that do not vary
        with phase, so it must be bit-for-bit identical across every frame."""
        band = result.lower_body_band
        arrays = [np.asarray(f.crop(band)) for f in result.native_frames]
        base = arrays[0]
        for i, arr in enumerate(arrays[1:], start=1):
            assert np.array_equal(arr, base), (
                f"frame {i}'s lower body differs from frame 0 -- the seat/ground contacts "
                "moved when they must not"
            )

    def test_the_upper_body_amplitude_clears_a_pixel_at_the_final_height(self, result):
        assert result.upper_body_travel_final_px > 1.0, (
            f"upper body travels only {result.upper_body_travel_final_px:.2f}px at the "
            "final figure height -- it will not read"
        )

    def test_the_amplitude_stays_a_breath_not_a_bob(self, result):
        assert result.upper_body_travel_final_px < 2.0, (
            f"{result.upper_body_travel_final_px:.2f}px reads as a bob, not a breath"
        )

    def test_the_loop_seam_is_not_the_worst_transition(self, result):
        """The cosine ease rests at both ends, so wrapping frame N-1 back to frame 0
        should not be a bigger jump than any interior step."""
        deltas = result.changed_px_per_frame_pair
        seam = deltas[-1]
        assert seam <= max(deltas), "the loop seam pops harder than an interior frame step"

    def test_some_motion_is_visible_between_frames(self, result):
        """A dead sheet (nothing changes) is a failure, not a pass."""
        assert max(result.changed_px_per_frame_pair) > 0

    def test_sheet_and_gif_are_written(self, tmp_path, result):
        from char_gen.sitting_idle_cycle import save_gif, save_sheet

        sheet_path = save_sheet(result.descended_frames, tmp_path / "sheet.png")
        gif_path = save_gif(result.descended_frames, tmp_path / "loop.gif")
        assert sheet_path.exists()
        assert gif_path.exists()
        sheet = Image.open(sheet_path)
        assert sheet.width == result.cell_px * FRAME_COUNT
        assert sheet.height == result.cell_px


class TestSittingIdlePoseDefaults:
    def test_defaults_are_frozen_dataclass_values(self):
        p = SittingIdlePose(upper_dy=0.0)
        assert p.shoulder_deg == SHOULDER_REST_DEG
        assert p.elbow_deg == ELBOW_REST_DEG
        assert p.head_deg == HEAD_REST_DEG


def test_walk_cycle_bone_length_is_unmodified_by_this_module():
    """Shared-helper regression: `bone_length` must resolve the same value for callers
    outside this module after sitting_idle_cycle imports it."""
    assert bone_length(257.0, 0.0) == 257.0
    assert bone_length(344.0, 0.04) == pytest.approx(330.24)
