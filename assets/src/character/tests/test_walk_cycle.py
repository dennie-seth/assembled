"""Regressions for `char_gen.walk_cycle`.

The ones that matter are `TestFlexionIsBigEnoughToSee` and
`TestLowerSegmentIsAChildNotASibling`: together they pin the defect that made an earlier
revision read as rigid limbs -- flexion too small to resolve at 40px, and clamped to zero
for half the cycle.
"""
import math

import pytest

from char_gen.walk_cycle import (
    ELBOW,
    HIP,
    KNEE,
    SHOULDER,
    JointAngles,
    angles_at,
    bone_length,
    distal_joint,
    length_scale_to_match,
    root_bob,
    sample,
)

FIGURE_PX = 40          # docs/design/13-asset-pipeline.md
PHASES = [i / 8 for i in range(8)]


class TestSample:
    def test_interpolates_between_keyframes(self):
        assert sample([(0.0, 0.0), (1.0, 10.0)], 0.5) == pytest.approx(5.0)

    def test_phase_wraps(self):
        c = [(0.0, 3.0), (1.0, 7.0)]
        assert sample(c, 1.25) == pytest.approx(sample(c, 0.25))

    def test_endpoints_match_so_the_loop_is_seamless(self):
        for curve in (HIP, KNEE, SHOULDER, ELBOW):
            assert curve[0][1] == pytest.approx(curve[-1][1]), (
                "a cycle whose first and last keyframe differ will pop at the loop seam"
            )


class TestFlexionIsBigEnoughToSee:
    """An earlier revision used a 20-degree knee, half-wave rectified. On a ~9px calf at a
    40px figure that is sub-pixel for most of its range and exactly ZERO half the time, so
    the leg read as one rigid bone. These assertions stop that regressing."""

    def test_knee_reaches_a_real_swing_phase_bend(self):
        peak = max(v for _, v in KNEE)
        assert peak >= 50, f"swing-phase knee bend must be unmistakable, got {peak:.1f}"

    def test_knee_is_never_clamped_flat_for_long(self):
        flat = [p for p in PHASES if sample(KNEE, p) < 3.0]
        assert len(flat) <= 1, (
            f"the knee was straight for {len(flat)} of 8 frames -- that is what made it "
            "look rigid"
        )

    def test_elbow_never_fully_straightens(self):
        assert min(v for _, v in ELBOW) > 10

    def test_knee_bend_is_visible_at_the_target_figure_height(self):
        # calf ~ 22% of figure height; a 50deg bend must move the ankle > 1px at 40px
        calf_px = 0.22 * FIGURE_PX
        peak = max(v for _, v in KNEE)
        deflection = calf_px * math.sin(math.radians(peak))
        assert deflection > 1.5, f"ankle only moves {deflection:.2f}px -- sub-pixel"


class TestLowerSegmentIsAChildNotASibling:
    """The lower segment must carry parent + own flexion, not its own angle alone."""

    def test_calf_is_parent_minus_knee_flexion(self):
        a = JointAngles(hip=10.0, knee_flexion=30.0, shoulder=0.0, elbow_flexion=0.0)
        assert a.calf == pytest.approx(-20.0)

    def test_forearm_is_parent_plus_elbow_flexion(self):
        a = JointAngles(hip=0.0, knee_flexion=0.0, shoulder=-5.0, elbow_flexion=25.0)
        assert a.forearm == pytest.approx(20.0)

    def test_calf_tracks_the_thigh_when_flexion_is_zero(self):
        a = JointAngles(hip=17.0, knee_flexion=0.0, shoulder=0.0, elbow_flexion=0.0)
        assert a.calf == pytest.approx(17.0), "a straight knee means calf follows thigh"


class TestOpposition:
    def test_far_side_is_half_a_cycle_out_of_phase(self):
        near, far = angles_at(0.0), angles_at(0.0, far_side=True)
        assert near.hip != pytest.approx(far.hip)
        assert far.hip == pytest.approx(angles_at(0.5).hip)

    def test_arms_oppose_legs_on_the_same_side(self):
        # at heel strike the thigh is forward and the same-side arm is back
        a = angles_at(0.0)
        assert a.hip > 0 and a.shoulder < 0


class TestGeometry:
    def test_bone_length_is_the_part_below_its_pivot(self):
        assert bone_length(200, 0.04) == pytest.approx(192.0)

    def test_distal_joint_hangs_straight_down_at_zero(self):
        x, y = distal_joint((100.0, 50.0), 80.0, 0.0)
        assert (x, y) == pytest.approx((100.0, 130.0))

    def test_positive_angle_swings_the_tip_forward(self):
        x, _ = distal_joint((0.0, 0.0), 100.0, 30.0)
        assert x > 0, "positive must move the tip toward +x (the facing direction)"

    def test_root_bob_dips_twice_per_cycle(self):
        dips = [root_bob(p, 10.0) for p in [i / 64 for i in range(64)]]
        assert min(dips) == pytest.approx(-10.0, abs=0.2)
        assert root_bob(0.0, 10.0) == pytest.approx(0.0, abs=1e-6)
        assert root_bob(0.5, 10.0) == pytest.approx(0.0, abs=1e-6)


class TestLengthMatching:
    def test_scale_makes_a_short_bone_match_its_opposite(self):
        # the measured case: far calf 255.4 against a near calf of 330.2
        f = length_scale_to_match(255.4, 330.2)
        assert 255.4 * f == pytest.approx(330.2)
        assert f == pytest.approx(1.2929, abs=1e-4)

    def test_rejects_a_nonsense_length(self):
        with pytest.raises(ValueError):
            length_scale_to_match(0.0, 100.0)
