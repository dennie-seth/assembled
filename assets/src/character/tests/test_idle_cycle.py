"""Regressions for `char_gen.idle_cycle`.

Mirrors `test_walk_cycle.py`'s shape: `TestAmplitudeSurvivesDescent` pins the exact defect
the walk's own first attempt paid for (a signal too small to resolve at the 40px figure
height), and `TestBreathAndSwayDoNotBeat` pins the edge case the walk never had to worry
about -- two periodic signals close enough in frequency to read as a single wobble instead
of two layered motions.
"""
import pytest

from char_gen.idle_cycle import (
    ARM_LAG_DAMPING,
    ARM_LAG_PHASE,
    BREATH,
    BREATH_CYCLES_PER_LOOP,
    DESCEND_SCALE,
    FIGURE_PX,
    LEG_REST_ANGLE_DEG,
    SWAY,
    SWAY_AMPLITUDE_NATIVE_PX,
    SWAY_CYCLES_PER_LOOP,
    offsets_at,
)
from char_gen.walk_cycle import sample

PHASES = [i / 12 for i in range(12)]


class TestLoopIsSeamless:
    def test_breath_endpoints_match(self):
        assert BREATH[0][1] == pytest.approx(BREATH[-1][1], abs=1e-9), (
            "a breath curve whose first and last keyframe differ will pop at the loop seam"
        )

    def test_sway_endpoints_match(self):
        assert SWAY[0][1] == pytest.approx(SWAY[-1][1], abs=1e-9), (
            "a sway curve whose first and last keyframe differ will pop at the loop seam"
        )

    def test_offsets_at_phase_zero_and_one_agree(self):
        a, b = offsets_at(0.0), offsets_at(1.0)
        assert a.breath_dy == pytest.approx(b.breath_dy)
        assert a.sway_dx == pytest.approx(b.sway_dx)
        assert a.arm_lag_dx == pytest.approx(b.arm_lag_dx)


class TestBreathAndSwayDoNotBeat:
    """Close periods read as a wobble instead of two layered signals (T-0430 edge case).
    Breath completing exactly twice per sway cycle keeps the two harmonically locked and
    far enough apart in frequency that they never beat against each other."""

    def test_breath_is_twice_the_frequency_of_sway(self):
        assert BREATH_CYCLES_PER_LOOP == 2 * SWAY_CYCLES_PER_LOOP

    def test_periods_are_not_close(self):
        breath_period = 1.0 / BREATH_CYCLES_PER_LOOP
        sway_period = 1.0 / SWAY_CYCLES_PER_LOOP
        ratio = sway_period / breath_period
        assert ratio >= 2.0, f"periods only {ratio:.2f}x apart -- close enough to beat"


class TestAmplitudeSurvivesDescent:
    """The walk's first attempt used a 20-degree knee that was sub-pixel at 40px and read
    as rigid. These assertions measure the same thing for idle's breath and sway signals
    before a single pixel is composited."""

    def test_breath_displacement_is_above_a_pixel_at_final_figure_height(self):
        peak = max(v for _, v in BREATH)
        descended = peak * DESCEND_SCALE
        assert descended > 1.0, (
            f"breath only moves {descended:.2f}px at a {FIGURE_PX}px figure height -- sub-pixel"
        )

    def test_sway_amplitude_was_halved_per_human_review_comment(self):
        """@DennieSeth, 2026-10-05: "Make the skeleton wiggle sideways 50% less, it
        should look like breathing." Pins the literal halving (35.0px -> 17.5px) so a
        future change to this value is a deliberate decision, not a silent drift."""
        assert SWAY_AMPLITUDE_NATIVE_PX == pytest.approx(17.5)

    def test_sway_displacement_is_now_below_a_pixel_at_final_figure_height(self):
        """Halving sway's amplitude for the above reason puts its own descended
        displacement under this module's 1px "does it read" floor (0.716px, where the
        prior 35.0px amplitude gave 1.432px -- see TestAmplitudeSurvivesDescent's other
        tests, which still require breath to clear that floor). This is a reported,
        accepted tradeoff per T-0430's own acceptance criterion ("If a chosen amplitude
        turns out to be sub-pixel, report that ... rather than shipping motion nobody
        can see") -- not an oversight. Pinning the actual value, rather than deleting
        the assertion, still catches an unintended future drift in either direction.
        """
        peak = max(v for _, v in SWAY)
        descended = peak * DESCEND_SCALE
        assert descended == pytest.approx(0.716, abs=0.01), (
            f"sway displacement is {descended:.3f}px at a {FIGURE_PX}px figure height -- "
            "update this pinned value and docs/assets/evidence/side-view-idle-reference/"
            "README.md together if the amplitude changes again"
        )

    def test_breath_is_the_larger_signal(self):
        breath_peak = max(v for _, v in BREATH)
        sway_peak = max(v for _, v in SWAY)
        assert breath_peak > sway_peak, (
            "breathing must read as the primary signal and weight shift as the secondary one"
        )


class TestArmsTrailRatherThanSwing:
    """Arms must lag the torso's own motion, not rotate through a driven arc (T-0430 edge
    case: 'the arms read as swinging')."""

    def test_arm_lag_is_a_damped_delayed_copy_of_sway(self):
        phase = 0.37
        o = offsets_at(phase)
        expected = sample(SWAY, phase - ARM_LAG_PHASE) * ARM_LAG_DAMPING
        assert o.arm_lag_dx == pytest.approx(expected)

    def test_damping_is_less_than_one(self):
        assert 0 < ARM_LAG_DAMPING < 1, (
            "undamped lag is just the torso's own motion copied, not a trail"
        )

    def test_lag_phase_is_nonzero(self):
        assert ARM_LAG_PHASE > 0, (
            "zero lag means the arm moves exactly with the torso -- rigid, not trailing"
        )

    def test_arm_never_matches_sway_exactly(self):
        for p in PHASES:
            o = offsets_at(p)
            assert o.arm_lag_dx != pytest.approx(o.sway_dx), (
                "an arm offset identical to the torso's own sway is a rigid attachment, "
                "not a trailing lag"
            )


class TestLegsStayPlanted:
    """Feet must never move -- the clearest line between idle and walk. Holding the rest
    angle constant at every phase is what makes the composited ankle position provably
    identical frame to frame (see test_idle_render.py for the pixel-level assertion)."""

    def test_rest_angle_is_constant_every_phase(self):
        for _ in PHASES:
            assert LEG_REST_ANGLE_DEG == 0.0

    def test_offsets_never_touch_leg_angle(self):
        # offsets_at only ever returns torso/arm translation, never a leg angle -- there is
        # no field here to drive a hip or knee swing.
        o = offsets_at(0.5)
        assert not hasattr(o, "hip")
        assert not hasattr(o, "knee_flexion")
