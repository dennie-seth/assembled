"""Regressions for `char_gen.idle_cycle`.

Two groups matter. `TestOnlyTheUpperBodyMoves` pins the scope decision -- idle carries ONE
signal, and an earlier version that layered breathing, sway, pitch, roll and arm trail was
rejected as too busy to watch. `TestAmplitudeSurvivesTheDescent` pins the calibration, after
a pass that measured 0.15px of travel at the target height.
"""
import math

import pytest

from char_gen.idle_cycle import (
    BREATH_CYCLES_PER_LOOP,
    ELBOW_REST_DEG,
    LEG_FOLLOW,
    SHOULDER_REST_DEG,
    ankle_of,
    breath,
    pose_at,
    solve_leg,
    travel_at_final_height,
)

TORSO_H = 257.0
THIGH, CALF = 246.7, 330.2
DESCENT = 0.0409          # measured source->cell scale for this part set
PHASES = [i / 12 for i in range(12)]


class TestOnlyTheUpperBodyMoves:
    """Idle carries exactly one signal. Anything else reappearing here is the 'too busy'
    regression @DennieSeth rejected."""

    @pytest.mark.parametrize("phase", PHASES)
    def test_nothing_but_upper_dy_varies(self, phase):
        p = pose_at(phase, TORSO_H)
        assert p.hip_dx == 0.0, "no lateral sway in idle"
        assert p.hip_dy == 0.0, "the hips do not move -- only the upper body does"
        assert p.torso_deg == 0.0, "no torso pitch or roll"
        assert p.head_deg == 0.0, "the head rides the torso, it does not nod"

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_arms_are_a_fixed_hanging_pose(self, phase):
        p = pose_at(phase, TORSO_H)
        assert p.shoulder_deg == SHOULDER_REST_DEG
        assert p.elbow_deg == ELBOW_REST_DEG

    def test_the_legs_absorb_nothing(self):
        assert LEG_FOLLOW == 0.0, (
            "a non-zero leg follow would move the hips, and the feet with them"
        )

    def test_the_upper_body_actually_moves(self):
        span = max(pose_at(p, TORSO_H).upper_dy for p in PHASES) - \
            min(pose_at(p, TORSO_H).upper_dy for p in PHASES)
        assert span > 0.0


class TestAmplitudeSurvivesTheDescent:
    def test_travel_clears_one_pixel_at_the_final_height(self):
        px = travel_at_final_height(TORSO_H, DESCENT)
        assert px > 1.0, f"upper body travels only {px:.2f}px at 40px -- it will not read"

    def test_travel_stays_minimal(self):
        px = travel_at_final_height(TORSO_H, DESCENT)
        assert px < 2.0, f"{px:.2f}px is a bob, not a breath -- idle should sit still"

    def test_one_breath_per_loop(self):
        assert BREATH_CYCLES_PER_LOOP == 1.0, "two cycles reads as panting at this length"


class TestLoopCloses:
    def test_breath_rests_at_both_ends(self):
        assert breath(0.0) == pytest.approx(0.0, abs=1e-12)
        assert breath(1.0) == pytest.approx(0.0, abs=1e-12)

    def test_the_ease_peaks_mid_loop(self):
        assert breath(0.5) == pytest.approx(1.0, abs=1e-12)

    def test_pose_agrees_across_the_seam(self):
        a, b = pose_at(0.0, TORSO_H), pose_at(1.0, TORSO_H)
        assert a.upper_dy == pytest.approx(b.upper_dy, abs=1e-12), "the loop will pop"

    def test_phase_wraps(self):
        assert pose_at(1.25, TORSO_H).upper_dy == pytest.approx(
            pose_at(0.25, TORSO_H).upper_dy)

    def test_motion_is_symmetric_about_the_midpoint(self):
        """A cosine ease rises and falls identically, so the loop reverses cleanly."""
        for t in (0.1, 0.2, 0.3):
            assert breath(t) == pytest.approx(breath(1.0 - t), abs=1e-12)


class TestLegIK:
    """Still used for the one-off rest pose, and the right tool for any future animation
    whose hips move while a foot stays put."""

    def test_solved_chain_reaches_the_requested_ankle(self):
        hip = (400.0, 300.0)
        ankle = (420.0, 300.0 + 0.93 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        got = ankle_of(hip, ik, THIGH, CALF)
        assert math.hypot(got[0] - ankle[0], got[1] - ankle[1]) < 1e-6

    def test_knee_bends_forward(self):
        hip = (400.0, 300.0)
        ankle = (400.0, 300.0 + 0.85 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        assert ik.knee_flexion_deg > 0
        assert ik.calf_deg < ik.thigh_deg, "the calf must swing back relative to the thigh"

    def test_an_out_of_reach_target_is_clamped_not_crashed(self):
        hip = (400.0, 300.0)
        ankle = (400.0, 300.0 + 2.0 * (THIGH + CALF))
        ik = solve_leg(hip, ankle, THIGH, CALF)
        assert math.isfinite(ik.thigh_deg) and math.isfinite(ik.knee_flexion_deg)
