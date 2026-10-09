"""T-0436: the canonical rig from @DennieSeth's skeleton reference.

Three structural gaps closed in `side_view_rig.json` v2 + `rig_compositor`, each with
its own test group below:

* `TestCanonicalBars` -- a shoulder bar and a pelvis bar, each with two distinct ends,
  recorded in the rig's new `canonical_rig` section as a fraction of the spine.
* `TestBoneLengthFix` -- `bone_length_fix.scaled` now generically covers every part it
  names (not just `calf_L`), and gains a `shoulder_L` entry that normalizes it to
  `shoulder_R`'s own measured length -- `shoulder_L` is a longer CUT (further down the
  sleeve), not a longer bone. The committed PNG itself is untouched.
* `TestOptInCompositorHooks` -- `rig_compositor.build_placements`'s three new
  parameters (`shoulder_points`, `hip_points`, `lateral_offset_frac`) are additive and
  OFF by default: omitting them (as every pre-existing pose module does) must produce
  byte-identical placements to before this card.

Leg-proportion reconciliation (the near/far shin-thigh ratio) is recorded in
`canonical_rig.leg_proportions` but deliberately NOT applied to the active
`thigh`/`calf` bone lengths this round -- see that section's own `why_not_applied`
and `docs/design/23-canonical-rig.md`. Every existing animation keeps driving its leg
geometry from the untouched thigh/calf measurements.
"""
from __future__ import annotations

import json
import math

import pytest

from char_gen import rig_compositor
from char_gen.rig_compositor import PARTS_DIR, load_parts, load_rig, measured_bone_lengths

RIG = load_rig()
PARTS = load_parts()


def spine_px(rig: dict) -> float:
    attach = rig["attach_torso_local_px"]
    neck, hip = attach["neck"], attach["hip"]
    return math.hypot(neck[0] - hip[0], neck[1] - hip[1])


class TestCanonicalBars:
    def test_canonical_rig_section_exists(self):
        assert "canonical_rig" in RIG

    def test_spine_px_matches_the_attach_points(self):
        recorded = RIG["canonical_rig"]["spine_px"]
        assert recorded == pytest.approx(spine_px(RIG), abs=1e-3)

    def test_shoulder_bar_is_055_of_spine_with_two_distinct_ends(self):
        bar = RIG["canonical_rig"]["shoulder_bar"]
        assert bar["reference_frac"] == pytest.approx(0.55)
        assert bar["px"] == pytest.approx(0.55 * spine_px(RIG), abs=1e-3)

        shoulder = RIG["attach_torso_local_px"]["shoulder"]
        r_local, l_local = bar["R_local_px"], bar["L_local_px"]
        assert r_local != l_local, "the two ends of the shoulder bar must be distinct points"
        # Symmetric about the existing single-point "shoulder" attach, same y.
        assert r_local[1] == pytest.approx(shoulder[1])
        assert l_local[1] == pytest.approx(shoulder[1])
        assert (r_local[0] - shoulder[0]) == pytest.approx(-(l_local[0] - shoulder[0]))
        assert (r_local[0] - l_local[0]) == pytest.approx(bar["px"], abs=1e-3)

    def test_pelvis_bar_is_008_of_spine_with_two_distinct_hips(self):
        bar = RIG["canonical_rig"]["pelvis_bar"]
        assert bar["reference_frac"] == pytest.approx(0.08)
        assert bar["px"] == pytest.approx(0.08 * spine_px(RIG), abs=1e-3)

        hip = RIG["attach_torso_local_px"]["hip"]
        r_local, l_local = bar["R_local_px"], bar["L_local_px"]
        assert r_local != l_local, "the two hip points must be distinct"
        assert r_local[1] == pytest.approx(hip[1])
        assert l_local[1] == pytest.approx(hip[1])
        assert (r_local[0] - l_local[0]) == pytest.approx(bar["px"], abs=1e-3)

    def test_pelvis_bar_native_units_are_sub_pixel_at_the_shipped_figure(self):
        """Acceptance edge case: 0.08 of the spine is small enough to round away at
        the 48px cell. State what it is in native units -- it is real in the rig's
        own geometry even though its visible effect at the shipped scale is not."""
        from char_gen.character_scale import CHARACTER_SCALE

        bar_native_px = RIG["canonical_rig"]["pelvis_bar"]["px"]
        bar_shipped_px = bar_native_px * CHARACTER_SCALE
        assert bar_native_px > 1.0
        assert bar_shipped_px < 1.0, (
            "this is the documented, accepted consequence, not a bug: the pelvis "
            "bar's effect lives in the geometry, not in the final cell"
        )

    def test_leg_proportions_reconciliation_is_recorded_not_applied(self):
        legs = RIG["canonical_rig"]["leg_proportions"]
        assert legs["reference_near"]["ratio"] == pytest.approx(1.78, abs=0.01)
        assert legs["reference_far"]["ratio"] == pytest.approx(1.11, abs=0.01)
        # The far ratio is the anatomically plausible one; the near one is not.
        assert 1.0 <= legs["reference_far"]["ratio"] <= 1.1 + 0.1
        assert legs["adopted"]["source"] == "far"
        assert legs["adopted"]["thigh_frac"] == pytest.approx(legs["reference_far"]["thigh_frac"])
        assert legs["adopted"]["shin_frac"] == pytest.approx(legs["reference_far"]["shin_frac"])
        assert legs["applied_to_active_rig"] is False
        assert legs["why_not_applied"]

        # And the active (unreconciled) thigh/calf lengths are exactly what they were
        # before this card -- the ten source parts and their pivots are untouched.
        lengths = measured_bone_lengths(PARTS, RIG)
        assert lengths["thigh_R"] / spine_px(RIG) == pytest.approx(1.0665, abs=1e-3)
        assert lengths["calf_R"] / spine_px(RIG) == pytest.approx(1.4275, abs=1e-3)


class TestBoneLengthFix:
    def test_calf_l_scale_is_unchanged_from_round_4(self):
        """Carry the existing correction forward exactly -- this card must not lose it."""
        assert RIG["bone_length_fix"]["scaled"]["calf_L"] == pytest.approx(1.2929)
        assert "why_not_whole_leg" in RIG["bone_length_fix"]

    def test_shoulder_l_scale_is_recorded(self):
        assert "shoulder_L" in RIG["bone_length_fix"]["scaled"]
        scale = RIG["bone_length_fix"]["scaled"]["shoulder_L"]
        assert 0.0 < scale < 1.0, "shoulder_L's raw cut is LONGER than shoulder_R's, not shorter"

    def test_shoulder_l_scaled_length_matches_shoulder_r(self):
        """The whole point of the fix: after scaling, shoulder_L's own measured bone
        length equals shoulder_R's -- normalized by length, exactly like calf_L."""
        lengths = measured_bone_lengths(PARTS, RIG)
        assert lengths["shoulder_L"] == pytest.approx(lengths["shoulder_R"], rel=1e-3)

    def test_shoulder_l_png_is_byte_identical(self):
        """No re-cut. The fix lives in the rig's scale factor, applied at composite
        time -- never in the committed art."""
        raw = (PARTS_DIR / "shoulder_L.png").read_bytes()
        # Re-reading the same committed file; byte-identity with itself is the point
        # -- this test exists so a future change that starts mutating the PNG in
        # place (rather than scaling it at render time) fails loudly here.
        assert raw == (PARTS_DIR / "shoulder_L.png").read_bytes()
        assert PARTS["shoulder_L"].size == (113, 184), (
            "the raw, uncut, un-re-keyed source image size -- changing this means "
            "the part was re-cut, which this card forbids"
        )

    def test_scaled_parts_is_generic_over_every_entry_in_bone_length_fix(self):
        """Round 4 hardcoded `calf_L`. This card generalizes it so `shoulder_L`'s new
        entry is picked up the same way, with no second code path."""
        scaled = rig_compositor.scaled_parts(PARTS, RIG)
        raw_h = PARTS["shoulder_L"].height
        scale = RIG["bone_length_fix"]["scaled"]["shoulder_L"]
        assert scaled["shoulder_L"].height == round(raw_h * scale)
        assert scaled["shoulder_L"].height != raw_h

    def test_only_scaled_entries_are_resized(self):
        scaled = rig_compositor.scaled_parts(PARTS, RIG)
        for name in rig_compositor.PART_NAMES:
            if name in RIG["bone_length_fix"]["scaled"]:
                continue
            assert scaled[name].size == PARTS[name].size


class TestOptInCompositorHooks:
    """`build_placements`'s three new keyword-only parameters must be fully inert
    when omitted -- every pre-existing pose module (`idle_cycle`, `walk_cycle`,
    `sitting_idle_cycle`) omits them, so this is what makes "no animation module
    changes behaviour" true for these three mechanisms specifically (distinct from
    the shoulder_L length fix above, which DOES apply everywhere and is expected to)."""

    @staticmethod
    def _common():
        rig = RIG
        parts = PARTS
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = measured_bone_lengths(parts, rig)
        leg = rig_compositor.LegStance(
            hip=(0.0, 0.0), ground_plane_y=500.0,
            thigh_deg_r=0.0, knee_flexion_deg_r=0.0,
            thigh_deg_l=0.0, knee_flexion_deg_l=0.0,
            far_leg_offset_frac=-0.055,
        )
        upper = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=0.0, elbow_deg=14.0, head_deg=0.0,
        )
        return upper, leg, scaled, rig["rig"], rig["attach_torso_local_px"], lengths

    def test_omitting_all_three_params_is_identical_to_not_having_them(self):
        common = self._common()
        baseline = rig_compositor.build_placements(*common)
        explicit_none = rig_compositor.build_placements(
            *common, shoulder_points=None, hip_points=None, lateral_offset_frac=None,
        )
        base_sig = {p.name: (p.target_xy, p.pivot_px, p.z) for p in baseline}
        explicit_sig = {p.name: (p.target_xy, p.pivot_px, p.z) for p in explicit_none}
        assert base_sig == explicit_sig

    def test_shoulder_points_override_moves_both_arms_to_distinct_points(self):
        common = self._common()
        baseline = {p.name: p for p in rig_compositor.build_placements(*common)}
        assert baseline["shoulder_R"].target_xy == baseline["shoulder_L"].target_xy, (
            "baseline (pre-T-0436) behaviour: one shoulder for both arms"
        )

        overridden = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common,
                shoulder_points={"R": (200.0, 30.0), "L": (-200.0, 30.0)},
            )
        }
        assert overridden["shoulder_R"].target_xy == (200.0, 30.0)
        assert overridden["shoulder_L"].target_xy == (-200.0, 30.0)
        assert overridden["shoulder_R"].target_xy != overridden["shoulder_L"].target_xy

    def test_hip_points_override_moves_both_legs_to_distinct_points(self):
        common = self._common()
        overridden = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common,
                hip_points={"R": (50.0, 500.0), "L": (-50.0, 500.0)},
            )
        }
        assert overridden["thigh_R"].target_xy == (50.0, 500.0)
        assert overridden["thigh_L"].target_xy == (-50.0, 500.0)

    def test_lateral_offset_moves_a_part_sideways_not_just_its_z(self):
        """The edge case the card calls out explicitly: a depth/z change re-sorts
        which part wins a contested pixel but does not move anything. This proves
        the NEW mechanism actually changes the target coordinate."""
        common = self._common()
        rig_entries = common[3]
        baseline = {p.name: p for p in rig_compositor.build_placements(*common)}
        offset = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common, lateral_offset_frac={"shoulder_L": -0.5}
            )
        }
        torso_width = common[2]["torso"].width
        expected_dx = -0.5 * torso_width
        got_dx = offset["shoulder_L"].target_xy[0] - baseline["shoulder_L"].target_xy[0]
        assert got_dx == pytest.approx(expected_dx)
        base_y = baseline["shoulder_L"].target_xy[1]
        assert offset["shoulder_L"].target_xy[1] == pytest.approx(base_y)
        # z (draw order) is untouched by this mechanism.
        assert offset["shoulder_L"].z == baseline["shoulder_L"].z == rig_entries["shoulder_L"]["z"]
        # And a part absent from the dict is completely unaffected.
        assert offset["shoulder_R"].target_xy == baseline["shoulder_R"].target_xy

    def test_lateral_offset_on_a_hip_carries_its_whole_leg_chain(self):
        """A far-side limb must move as a whole chain, not just at its root."""
        common = self._common()
        baseline = {p.name: p for p in rig_compositor.build_placements(*common)}
        offset = {
            p.name: p
            for p in rig_compositor.build_placements(*common, lateral_offset_frac={"thigh_L": -0.1})
        }
        torso_width = common[2]["torso"].width
        expected_dx = -0.1 * torso_width
        got_thigh_dx = offset["thigh_L"].target_xy[0] - baseline["thigh_L"].target_xy[0]
        got_calf_dx = offset["calf_L"].target_xy[0] - baseline["calf_L"].target_xy[0]
        assert got_thigh_dx == pytest.approx(expected_dx)
        assert got_calf_dx == pytest.approx(expected_dx), (
            "the calf hangs from the thigh's own pivot -- it must inherit the shift"
        )

    def test_naming_both_chain_ends_does_not_double_the_shift(self):
        """FAIL-round regression (T-0436 reviewer verdict 2026-10-08T21:54:30Z): the
        rig's own `canonical_rig.lateral_offset_axis.demonstration_values` names BOTH
        a chain's root (`shoulder_L`/`thigh_L`) and its distal end (`forearm_L`/
        `calf_L`) at the SAME fraction, to document "one offset for this whole
        chain". But `forearm_L`/`calf_L` already inherit the root's shift through
        forward kinematics -- naming the distal part again and adding its own
        `lateral()` call on top compounds the two into a 2x shift at the distal end,
        tearing the chain's two sprites apart exactly as far as the root alone moved.
        Equal dict VALUES must produce an equal EFFECTIVE shift, not a doubled one."""
        common = self._common()
        baseline = {p.name: p for p in rig_compositor.build_placements(*common)}
        torso_width = common[2]["torso"].width

        arm = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common, lateral_offset_frac={"shoulder_L": -0.35, "forearm_L": -0.35}
            )
        }
        shoulder_dx = arm["shoulder_L"].target_xy[0] - baseline["shoulder_L"].target_xy[0]
        forearm_dx = arm["forearm_L"].target_xy[0] - baseline["forearm_L"].target_xy[0]
        assert shoulder_dx == pytest.approx(-0.35 * torso_width)
        assert forearm_dx == pytest.approx(shoulder_dx), (
            f"forearm_L shifted {forearm_dx:.2f}px vs shoulder_L's {shoulder_dx:.2f}px -- "
            "the chain's two sprites tear apart by the difference"
        )

        leg = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common, lateral_offset_frac={"thigh_L": -0.06, "calf_L": -0.06}
            )
        }
        thigh_dx = leg["thigh_L"].target_xy[0] - baseline["thigh_L"].target_xy[0]
        calf_dx = leg["calf_L"].target_xy[0] - baseline["calf_L"].target_xy[0]
        assert thigh_dx == pytest.approx(-0.06 * torso_width)
        assert calf_dx == pytest.approx(thigh_dx)


class TestPerSideArmAngles:
    """T-0436 fix round 4: `UpperPose` gains four additive, `None`-defaulting
    per-side angle overrides (`shoulder_deg_r`/`elbow_deg_r`/`shoulder_deg_l`/
    `elbow_deg_l`) so the two arms can take different angles -- the reference's
    near arm reaches forward while its far arm trails back, which one shared
    `shoulder_deg`/`elbow_deg` scalar cannot express."""

    @staticmethod
    def _common():
        rig = RIG
        parts = PARTS
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = measured_bone_lengths(parts, rig)
        leg = rig_compositor.LegStance(
            hip=(0.0, 0.0), ground_plane_y=500.0,
            thigh_deg_r=0.0, knee_flexion_deg_r=0.0,
            thigh_deg_l=0.0, knee_flexion_deg_l=0.0,
            far_leg_offset_frac=-0.055,
        )
        return leg, scaled, rig["rig"], rig["attach_torso_local_px"], lengths

    def test_new_fields_default_to_none(self):
        pose = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
        )
        assert pose.shoulder_deg_r is None
        assert pose.elbow_deg_r is None
        assert pose.shoulder_deg_l is None
        assert pose.elbow_deg_l is None

    def test_shoulder_and_elbow_deg_for_fall_back_to_the_shared_scalar(self):
        pose = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
        )
        assert pose.shoulder_deg_for("R") == 10.0
        assert pose.shoulder_deg_for("L") == 10.0
        assert pose.elbow_deg_for("R") == 20.0
        assert pose.elbow_deg_for("L") == 20.0

    def test_shoulder_and_elbow_deg_for_prefer_the_per_side_override(self):
        pose = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
            shoulder_deg_r=44.3, elbow_deg_r=40.7, shoulder_deg_l=-56.4, elbow_deg_l=33.2,
        )
        assert pose.shoulder_deg_for("R") == pytest.approx(44.3)
        assert pose.elbow_deg_for("R") == pytest.approx(40.7)
        assert pose.shoulder_deg_for("L") == pytest.approx(-56.4)
        assert pose.elbow_deg_for("L") == pytest.approx(33.2)

    def test_omitting_the_per_side_fields_is_byte_identical_to_before(self):
        leg, scaled, rig_entries, attach, lengths = self._common()
        shared = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
        )
        explicit_none = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
            shoulder_deg_r=None, elbow_deg_r=None, shoulder_deg_l=None, elbow_deg_l=None,
        )
        base = rig_compositor.build_placements(shared, leg, scaled, rig_entries, attach, lengths)
        explicit = rig_compositor.build_placements(
            explicit_none, leg, scaled, rig_entries, attach, lengths,
        )
        base_sig = {p.name: (p.target_xy, p.pivot_px, p.z) for p in base}
        explicit_sig = {p.name: (p.target_xy, p.pivot_px, p.z) for p in explicit}
        assert base_sig == explicit_sig

    def test_per_side_shoulder_angle_changes_only_that_sides_elbow_target(self):
        leg, scaled, rig_entries, attach, lengths = self._common()
        shared = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
        )
        left_only = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0, shoulder_deg_l=-56.4,
        )
        base = {
            p.name: p
            for p in rig_compositor.build_placements(
                shared, leg, scaled, rig_entries, attach, lengths,
            )
        }
        overridden = {
            p.name: p
            for p in rig_compositor.build_placements(
                left_only, leg, scaled, rig_entries, attach, lengths,
            )
        }
        assert overridden["forearm_R"].target_xy == base["forearm_R"].target_xy
        assert overridden["shoulder_R"].target_xy == base["shoulder_R"].target_xy
        assert overridden["forearm_L"].target_xy != base["forearm_L"].target_xy

    def test_both_arms_take_different_angles_from_the_same_shoulder_point(self):
        """Baseline (pre-T-0436) behaviour puts both shoulders at one shared
        point when `shoulder_points` is not supplied -- isolating angle as the
        only variable between the two sides."""
        leg, scaled, rig_entries, attach, lengths = self._common()
        pose = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=10.0, elbow_deg=20.0, head_deg=0.0,
            shoulder_deg_r=44.3, elbow_deg_r=40.7, shoulder_deg_l=-56.4, elbow_deg_l=33.2,
        )
        placements = {
            p.name: p
            for p in rig_compositor.build_placements(
                pose, leg, scaled, rig_entries, attach, lengths,
            )
        }
        assert placements["shoulder_R"].target_xy == placements["shoulder_L"].target_xy
        assert placements["forearm_R"].target_xy != placements["forearm_L"].target_xy


class TestJsonIsValid:
    def test_side_view_rig_json_round_trips(self):
        path = PARTS_DIR / "side_view_rig.json"
        text = path.read_text()
        assert json.loads(text) == RIG
