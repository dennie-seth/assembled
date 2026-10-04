"""Regressions for `char_gen.idle_cycle`.

`TestFeetStayPlanted` is the one that matters: idle is defined by the feet not moving, and
the IK is what makes that true by construction rather than by inspection.
"""
import math

import pytest

from char_gen.idle_cycle import (
    BREATH_CYCLES_PER_LOOP,
    BREATH_RISE_FRAC,
    SHIFT_CYCLES_PER_LOOP,
    SHIFT_SWAY_FRAC,
    ankle_of,
    pose_at,
    solve_leg,
)

TORSO_H = 257.0
THIGH, CALF = 246.7, 330.2
PHASES = [i / 12 for i in range(12)]


class TestFeetStayPlanted:
    """The IK must land the ankle exactly where it was asked to, for every pose in the
    loop. If this fails the feet slide and it is no longer an idle."""

    @pytest.mark.parametrize("phase", PHASES)
    def test_solved_chain_reaches_the_requested_ankle(self, phase):
        p = pose_at(phase, TORSO_H)
        hip = (400.0 + p.hip_dx, 300.0 + p.hip_dy)
        ankle = (400.0, 300.0 + 0.90 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        got = ankle_of(hip, ik, THIGH, CALF)
        err = math.hypot(got[0] - ankle[0], got[1] - ankle[1])
        assert err < 1e-6, f"foot slid {err:.4f}px at phase {phase:.2f}"

    def test_a_rest_pose_that_is_too_extended_would_be_caught(self):
        """At near-full extension a raised hip puts the ankle out of reach and the solver
        clamps -- which is exactly how the foot slid during development."""
        hip = (400.0, 300.0 - 40.0)
        ankle = (400.0, 300.0 + 0.995 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        got = ankle_of(hip, ik, THIGH, CALF)
        assert math.hypot(got[0] - ankle[0], got[1] - ankle[1]) > 1.0

    def test_knee_bends_forward(self):
        hip = (400.0, 300.0)
        ankle = (400.0, 300.0 + 0.85 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        assert ik.knee_flexion_deg > 0
        assert ik.thigh_deg > 0, "thigh should sit forward of the hip-ankle line"
        assert ik.calf_deg < ik.thigh_deg, "calf must swing back relative to the thigh"


class TestTwoSignalsAtDifferentRates:
    def test_breath_is_faster_than_the_weight_shift(self):
        assert BREATH_CYCLES_PER_LOOP > SHIFT_CYCLES_PER_LOOP

    def test_the_ratio_is_harmonically_clean(self):
        ratio = BREATH_CYCLES_PER_LOOP / SHIFT_CYCLES_PER_LOOP
        assert ratio == pytest.approx(round(ratio)), (
            "a non-integer ratio makes the two signals beat against each other"
        )

    def test_breath_is_the_primary_signal(self):
        """Breath travel must exceed sway travel -- it is the one that should read."""
        breath_p2p = BREATH_RISE_FRAC * TORSO_H
        sway_p2p = 2 * SHIFT_SWAY_FRAC * TORSO_H
        assert breath_p2p > sway_p2p


class TestAmplitudesSurviveTheDescent:
    """A first pass used 'subtle' fractions and produced 0.15px of travel at a 40px
    figure -- arithmetically present, visually absent. These pin the calibration."""

    DESCENT = 0.0413          # measured source->cell scale for this part set

    def test_breath_clears_one_pixel_at_the_final_height(self):
        px = BREATH_RISE_FRAC * TORSO_H * self.DESCENT
        assert px > 1.0, f"breath is only {px:.2f}px at 40px -- it will not read"

    def test_sway_is_close_to_a_pixel(self):
        px = 2 * SHIFT_SWAY_FRAC * TORSO_H * self.DESCENT
        assert px > 0.8, f"sway is only {px:.2f}px at 40px"


class TestLoopCloses:
    def test_pose_at_zero_and_one_agree(self):
        a, b = pose_at(0.0, TORSO_H), pose_at(1.0, TORSO_H)
        for f in ("hip_dx", "hip_dy", "torso_deg", "shoulder_deg", "elbow_deg"):
            assert getattr(a, f) == pytest.approx(getattr(b, f), abs=1e-9), (
                f"{f} differs across the loop seam -- the loop will pop"
            )

    def test_phase_wraps(self):
        assert pose_at(1.25, TORSO_H).hip_dx == pytest.approx(pose_at(0.25, TORSO_H).hip_dx)


class TestArmsTrailRatherThanSwing:
    def test_shoulder_motion_is_small_compared_with_a_walk_swing(self):
        span = max(pose_at(p, TORSO_H).shoulder_deg for p in PHASES) - \
            min(pose_at(p, TORSO_H).shoulder_deg for p in PHASES)
        assert span < 8.0, f"shoulder swings {span:.1f}deg -- that reads as walking"

    def test_the_elbow_never_straightens(self):
        assert all(pose_at(p, TORSO_H).elbow_deg > 5.0 for p in PHASES)

    def test_the_far_arm_lags_the_near_arm(self):
        near = [pose_at(p, TORSO_H).shoulder_deg for p in PHASES]
        far = [pose_at(p, TORSO_H, far_side=True).shoulder_deg for p in PHASES]
        assert near != far, "both arms moving identically reads as one rigid pair"
