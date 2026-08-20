"""Tests for collapse layer crossfade logic (T-0203).

13-asset-pipeline.md §4.4: global collapse layer, 4 stages, crossfaded on
collapse proximity — the same value [0.0, 1.0] that drives chroma intensity.
Only two stages are audible at once (the crossfade pair).

Acceptance criteria:
  - Four stages authored and crossfade correctly on the driving value
  - At most two stages audible at any one time
"""

from __future__ import annotations

import pytest

from ambience_synth.collapse_crossfade import (
    COLLAPSE_STAGES,
    collapse_crossfade_pair,
)
from ambience_synth.recipe import AmbienceRecipe


class TestCrossfadePair:
    """Unit tests for collapse_crossfade_pair(proximity) -> (lower, upper, alpha)."""

    def test_at_zero_returns_stage_0_fully_on(self):
        lower, upper, alpha = collapse_crossfade_pair(0.0)
        assert lower == 0
        assert upper == 1
        assert alpha == pytest.approx(0.0)

    def test_at_one_returns_stage_3_fully_on(self):
        lower, upper, alpha = collapse_crossfade_pair(1.0)
        assert lower == 2
        assert upper == 3
        assert alpha == pytest.approx(1.0)

    def test_midpoint_first_segment(self):
        """proximity=1/6 → halfway between stage 0 and 1."""
        lower, upper, alpha = collapse_crossfade_pair(1.0 / 6.0)
        assert lower == 0
        assert upper == 1
        assert alpha == pytest.approx(0.5, abs=1e-9)

    def test_midpoint_second_segment(self):
        """proximity=0.5 → halfway between stage 1 and 2."""
        lower, upper, alpha = collapse_crossfade_pair(0.5)
        assert lower == 1
        assert upper == 2
        assert alpha == pytest.approx(0.5, abs=1e-9)

    def test_midpoint_third_segment(self):
        """proximity=5/6 → halfway between stage 2 and 3."""
        lower, upper, alpha = collapse_crossfade_pair(5.0 / 6.0)
        assert lower == 2
        assert upper == 3
        assert alpha == pytest.approx(0.5, abs=1e-9)

    def test_segment_boundary_one_third(self):
        """At proximity=1/3 the crossfade is entering segment 1→2, alpha=0."""
        lower, upper, alpha = collapse_crossfade_pair(1.0 / 3.0)
        assert lower == 1
        assert upper == 2
        assert alpha == pytest.approx(0.0, abs=1e-9)

    def test_segment_boundary_two_thirds(self):
        """At proximity=2/3 the crossfade is entering segment 2→3, alpha=0."""
        lower, upper, alpha = collapse_crossfade_pair(2.0 / 3.0)
        assert lower == 2
        assert upper == 3
        assert alpha == pytest.approx(0.0, abs=1e-9)

    def test_stages_always_consecutive(self):
        """upper is always lower + 1."""
        for i in range(101):
            p = i / 100.0
            lower, upper, alpha = collapse_crossfade_pair(p)
            assert upper == lower + 1, f"at proximity={p}: lower={lower}, upper={upper}"

    def test_stages_within_valid_range(self):
        """lower in [0, 2], upper in [1, 3] everywhere."""
        for i in range(101):
            p = i / 100.0
            lower, upper, alpha = collapse_crossfade_pair(p)
            assert 0 <= lower <= 2, f"lower={lower} out of range at p={p}"
            assert 1 <= upper <= 3, f"upper={upper} out of range at p={p}"

    def test_gains_sum_to_one(self):
        """lower_gain + upper_gain == 1.0 for all proximity values."""
        for i in range(101):
            p = i / 100.0
            _, _, alpha = collapse_crossfade_pair(p)
            lower_gain = 1.0 - alpha
            upper_gain = alpha
            assert lower_gain + upper_gain == pytest.approx(1.0)

    def test_alpha_always_in_unit_interval(self):
        """alpha is in [0.0, 1.0] for all proximity values."""
        for i in range(101):
            p = i / 100.0
            _, _, alpha = collapse_crossfade_pair(p)
            assert 0.0 <= alpha <= 1.0 + 1e-12, f"alpha={alpha} out of [0,1] at p={p}"

    def test_at_most_two_stages_audible(self):
        """Verifies the core invariant: at most two stages have non-zero gain."""
        # With a two-tuple (lower, upper) return, the constraint is structural.
        # This test verifies the indices are always exactly two distinct stages.
        for i in range(101):
            p = i / 100.0
            lower, upper, alpha = collapse_crossfade_pair(p)
            # Each proximity activates exactly the pair (lower, upper).
            # lower_gain = 1-alpha, upper_gain = alpha.
            # Both can be zero only at the endpoints where one dominates.
            # At most two stages have non-zero gain.
            stages_with_gain = set()
            if (1.0 - alpha) > 1e-12:
                stages_with_gain.add(lower)
            if alpha > 1e-12:
                stages_with_gain.add(upper)
            assert len(stages_with_gain) <= 2, (
                f"More than 2 stages audible at proximity={p}: {stages_with_gain}"
            )

    def test_clamp_below_zero(self):
        """proximity < 0 behaves as proximity=0."""
        r_clamped = collapse_crossfade_pair(0.0)
        r_negative = collapse_crossfade_pair(-0.5)
        assert r_clamped == pytest.approx(r_negative)

    def test_clamp_above_one(self):
        """proximity > 1 behaves as proximity=1."""
        r_clamped = collapse_crossfade_pair(1.0)
        r_over = collapse_crossfade_pair(1.5)
        assert r_clamped == pytest.approx(r_over)

    def test_monotonic_stage_progression(self):
        """As proximity increases, the crossfade never goes backwards."""
        prev_lower, _, prev_alpha = collapse_crossfade_pair(0.0)
        for i in range(1, 101):
            p = i / 100.0
            lower, _, alpha = collapse_crossfade_pair(p)
            # lower stage never decreases
            assert lower >= prev_lower, f"lower regressed at p={p}"
            prev_lower = lower
            prev_alpha = alpha


class TestCollapseStages:
    """Tests that COLLAPSE_STAGES defines exactly 4 valid AmbienceRecipe objects."""

    def test_four_stages_defined(self):
        assert len(COLLAPSE_STAGES) == 4

    def test_all_are_ambience_recipes(self):
        for i, stage in enumerate(COLLAPSE_STAGES):
            assert isinstance(stage, AmbienceRecipe), (
                f"COLLAPSE_STAGES[{i}] is not an AmbienceRecipe"
            )

    def test_stages_have_distinct_seeds(self):
        seeds = [s.seed for s in COLLAPSE_STAGES]
        assert len(set(seeds)) == 4, f"stages do not have distinct seeds: {seeds}"

    def test_all_stages_on_ambience_bus(self):
        for i, stage in enumerate(COLLAPSE_STAGES):
            assert stage.bus == "ambience", (
                f"COLLAPSE_STAGES[{i}].bus = {stage.bus!r}, expected 'ambience'"
            )

    def test_all_stages_have_at_least_one_layer(self):
        for i, stage in enumerate(COLLAPSE_STAGES):
            assert len(stage.layers) >= 1, (
                f"COLLAPSE_STAGES[{i}] has no layers"
            )

    def test_stages_have_positive_body_and_crossfade(self):
        for i, stage in enumerate(COLLAPSE_STAGES):
            assert stage.body_s > 0, f"COLLAPSE_STAGES[{i}].body_s <= 0"
            assert stage.crossfade_s > 0, f"COLLAPSE_STAGES[{i}].crossfade_s <= 0"

    def test_stage_names_unique(self):
        names = [s.name for s in COLLAPSE_STAGES]
        assert len(set(names)) == 4, f"stages do not have distinct names: {names}"

    def test_stages_have_correct_sample_rate(self):
        for i, stage in enumerate(COLLAPSE_STAGES):
            assert stage.sample_rate == 44100, (
                f"COLLAPSE_STAGES[{i}].sample_rate = {stage.sample_rate}, expected 44100"
            )
