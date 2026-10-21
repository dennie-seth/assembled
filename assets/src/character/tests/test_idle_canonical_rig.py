"""T-0437: `idle_cycle` re-derived on the canonical rig (T-0436) -- the standing idle,
and nothing else.

Four groups:

* `TestFarLegOffsetFracIsGone` -- the old single-hip fore-aft fudge is removed, not
  merely zeroed; the two hips (the pelvis bar) do its job instead.
* `TestCanonicalTwoPointAttach` -- `idle_cycle`'s own render path resolves
  `shoulder_points`/`hip_points` from `side_view_rig.json`'s `canonical_rig` section
  (via `reference_pose_T0436.canonical_world_points`, the same geometry T-0436's own
  reference-pose render uses), not the old single shared attach point.
* `TestLateralOffsetAppliedPerChain` -- the 3/4 lateral-offset axis is applied, one
  value per limb chain, at each chain's root, and the far limb renders a real (not
  sliver) visible-pixel count because of it.
* `TestPerSideArmRestAngles` -- each arm gets its own rest-angle fields rather than
  falling back to one shared pair, and the arms still hang (no reach).
* `TestDrawOrderIsRealizedFromPixels` -- the rendered frame's draw order is derived by
  replaying the paint loop (`char_gen.draw_order_audit_T0436`), not by re-printing the
  rig's own z values.
* `TestBreathingMotionUnchanged` / `TestFeetDoNotDrift` / `TestFigureHeight` -- the
  approved breathing motion, ground contact and shared character scale all survive
  the re-derivation unchanged.

None of this touches `walk_cycle`, `sitting_idle_cycle` or a future
`sit_down_transition` -- see `tests/test_walk_cycle.py`/`tests/test_sitting_idle_cycle.py`
for the regression pins that this card must leave green.
"""
from __future__ import annotations

import numpy as np
import pytest

from char_gen import idle_cycle, rig_compositor
from char_gen import reference_pose_T0436 as refpose
from char_gen.character_scale import CHARACTER_SCALE, FIGURE_PX
from char_gen.draw_order_audit_T0436 import (
    canvas_geometry,
    contested_pairs,
    part_alpha_masks,
    realized_draw_rank,
    realized_owner,
)

RIG = rig_compositor.load_rig()
PARTS = rig_compositor.load_parts()


class TestFarLegOffsetFracIsGone:
    def test_the_constant_no_longer_exists(self):
        assert not hasattr(idle_cycle, "FAR_LEG_OFFSET_FRAC")

    def test_leg_stance_carries_an_unused_zero_not_the_old_fudge(self):
        """`LegStance.far_leg_offset_frac` is still a required field of the shared
        compositor's dataclass (out of scope to change), but idle no longer feeds it
        a real value -- `hip_points` does the separating now."""
        stance = idle_cycle.leg_stance(246.72, 330.24)
        assert stance.far_leg_offset_frac == 0.0


class TestCanonicalTwoPointAttach:
    """idle's own render path resolves two distinct world points per bar, from the
    rig's `canonical_rig` section -- not the old single shared `attach["shoulder"]`/
    one-hip-plus-fudge pair."""

    def test_canonical_points_resolves_four_distinct_world_points(self):
        shoulder_points, hip_points = idle_cycle.canonical_points(RIG)
        assert shoulder_points["R"] != shoulder_points["L"]
        assert hip_points["R"] != hip_points["L"]
        # Same y per bar -- the two ends of a bar are a pure horizontal split.
        assert shoulder_points["R"][1] == pytest.approx(shoulder_points["L"][1])
        assert hip_points["R"][1] == pytest.approx(hip_points["L"][1])

    def test_canonical_points_matches_the_rig_level_geometry_T0436_already_established(self):
        """idle must not re-derive this geometry its own way -- it resolves the
        SAME four points `reference_pose_T0436`'s reference-pose render does for a
        hip at the origin."""
        shoulder_points, hip_points = idle_cycle.canonical_points(RIG)
        expected = refpose.canonical_world_points(RIG, hip_world=(0.0, 0.0))
        assert shoulder_points["R"] == expected["shoulder_R"]
        assert shoulder_points["L"] == expected["shoulder_L"]
        assert hip_points["R"] == expected["hip_R"]
        assert hip_points["L"] == expected["hip_L"]

    def test_shoulder_points_are_the_canonical_shoulder_bar_apart(self):
        shoulder_points, _ = idle_cycle.canonical_points(RIG)
        dx = abs(shoulder_points["R"][0] - shoulder_points["L"][0])
        assert dx == pytest.approx(RIG["canonical_rig"]["shoulder_bar"]["px"], abs=1e-3)

    def test_hip_points_are_the_canonical_pelvis_bar_apart(self):
        """Acceptance: state the measured horizontal separation between the two hip
        points in native px."""
        _, hip_points = idle_cycle.canonical_points(RIG)
        dx = abs(hip_points["R"][0] - hip_points["L"][0])
        assert dx == pytest.approx(RIG["canonical_rig"]["pelvis_bar"]["px"], abs=1e-3)
        assert dx == pytest.approx(18.5074, abs=1e-3)

    def test_render_path_actually_passes_these_points_into_the_compositor(self):
        """Not just available -- CONSUMED. The torso placement for phase 0 (where
        `upper_dy` is exactly 0.0, breath(0) == 0) must land each shoulder/hip exactly
        on the canonical world points, proving `render_frames`'s own call into
        `rig_compositor` actually used them rather than falling back to the old
        single shared attach."""
        placements = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        shoulder_points, hip_points = idle_cycle.canonical_points(RIG)
        assert placements["shoulder_R"].target_xy == shoulder_points["R"]
        assert placements["thigh_R"].target_xy == hip_points["R"]
        # L sides carry the chain's own lateral offset ON TOP of the bar-end point --
        # see TestLateralOffsetAppliedPerChain below for that mechanism in isolation.

    def test_legacy_single_shared_attach_point_is_no_longer_what_drives_this_pose(self):
        """Baseline (pre-T-0436) behaviour put both shoulders/both un-offset hips at
        ONE shared point. idle's two canonical points must actually differ from each
        other -- the regression this whole card exists to fix."""
        placements = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        assert placements["shoulder_R"].target_xy != placements["shoulder_L"].target_xy
        assert placements["thigh_R"].target_xy != placements["thigh_L"].target_xy


class TestLateralOffsetAppliedPerChain:
    """`lateral_offset_frac` is passed into the render path, one value per limb
    chain, applied at each chain's root -- `far_limb_lateral_offset_frac` returns the
    dict idle's render path actually uses."""

    def test_one_value_per_chain_both_parts_equal(self):
        offsets = idle_cycle.far_limb_lateral_offset_frac(RIG)
        assert offsets["shoulder_L"] == offsets["forearm_L"]
        assert offsets["thigh_L"] == offsets["calf_L"]

    def test_the_render_path_actually_applies_it_not_just_computes_it(self):
        """Compare the chain-root target with vs without the offset -- proves
        POSITION moved, not merely that the dict exists."""
        with_offset = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        rig = RIG
        parts = PARTS
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = rig_compositor.measured_bone_lengths(parts, rig)
        stance = idle_cycle.leg_stance(lengths["thigh_R"], lengths["calf_R"])
        shoulder_points, hip_points = idle_cycle.canonical_points(rig)
        upper = idle_cycle._upper_pose_at(0.0, scaled["torso"].height)
        without_offset = {
            p.name: p
            for p in rig_compositor.build_placements(
                upper, stance, scaled, rig["rig"], rig["attach_torso_local_px"], lengths,
                shoulder_points=shoulder_points, hip_points=hip_points,
                lateral_offset_frac={},
            )
        }
        assert with_offset["shoulder_L"].target_xy != without_offset["shoulder_L"].target_xy
        assert with_offset["thigh_L"].target_xy != without_offset["thigh_L"].target_xy

    def test_the_chains_two_parts_shift_by_the_same_amount(self):
        """The distal part inherits the root's shift through forward kinematics --
        it must not be named a second time at the same fraction and double the
        effective shift (T-0436's own FAIL-verdict regression)."""
        placements = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        rig = RIG
        parts = PARTS
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = rig_compositor.measured_bone_lengths(parts, rig)
        stance = idle_cycle.leg_stance(lengths["thigh_R"], lengths["calf_R"])
        shoulder_points, hip_points = idle_cycle.canonical_points(rig)
        upper = idle_cycle._upper_pose_at(0.0, scaled["torso"].height)
        baseline = {
            p.name: p
            for p in rig_compositor.build_placements(
                upper, stance, scaled, rig["rig"], rig["attach_torso_local_px"], lengths,
                shoulder_points=shoulder_points, hip_points=hip_points,
                lateral_offset_frac={},
            )
        }
        shoulder_dx = placements["shoulder_L"].target_xy[0] - baseline["shoulder_L"].target_xy[0]
        forearm_dx = placements["forearm_L"].target_xy[0] - baseline["forearm_L"].target_xy[0]
        assert forearm_dx == pytest.approx(shoulder_dx)
        thigh_dx = placements["thigh_L"].target_xy[0] - baseline["thigh_L"].target_xy[0]
        calf_dx = placements["calf_L"].target_xy[0] - baseline["calf_L"].target_xy[0]
        assert calf_dx == pytest.approx(thigh_dx)

    def test_far_arm_renders_a_real_not_sliver_visible_pixel_count(self):
        placements = idle_cycle.build_placements_at(phase=0.0)
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        owner = realized_owner(placements, masks)
        shoulder_l_px = int(np.count_nonzero(owner == "shoulder_L"))
        forearm_l_px = int(np.count_nonzero(owner == "forearm_L"))
        assert shoulder_l_px > 100, f"only {shoulder_l_px}px -- a sliver, not a visible limb"
        assert forearm_l_px > 100, f"only {forearm_l_px}px -- a sliver, not a visible limb"

    def test_far_leg_renders_a_real_not_sliver_visible_pixel_count_without_the_old_fudge(self):
        """Acceptance: confirm the far leg renders a non-zero (and non-sliver)
        pixel count now that `FAR_LEG_OFFSET_FRAC` is gone."""
        placements = idle_cycle.build_placements_at(phase=0.0)
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        owner = realized_owner(placements, masks)
        thigh_l_px = int(np.count_nonzero(owner == "thigh_L"))
        calf_l_px = int(np.count_nonzero(owner == "calf_L"))
        assert thigh_l_px > 100, f"only {thigh_l_px}px -- a sliver, not a visible limb"
        assert calf_l_px > 100, f"only {calf_l_px}px -- a sliver, not a visible limb"


class TestPerSideArmRestAngles:
    """Each arm gets its OWN rest-angle fields -- required once the two arms are
    rooted at different ends of the shoulder bar -- and both still hang (0deg from
    vertical at the shoulder): a standing idle has no reach, so this is NOT the
    reference lunge's reaching/trailing pair."""

    def test_per_side_constants_exist_and_both_arms_still_hang(self):
        assert idle_cycle.SHOULDER_REST_DEG_R == 0.0
        assert idle_cycle.SHOULDER_REST_DEG_L == 0.0
        assert idle_cycle.ELBOW_REST_DEG_R == 14.0
        assert idle_cycle.ELBOW_REST_DEG_L == 14.0

    def test_not_the_reference_lunges_reach_and_trail_angles(self):
        assert idle_cycle.SHOULDER_REST_DEG_R != pytest.approx(refpose.SHOULDER_DEG_R)
        assert idle_cycle.SHOULDER_REST_DEG_L != pytest.approx(refpose.SHOULDER_DEG_L)

    def test_idle_pose_sets_the_per_side_fields_rather_than_falling_back(self):
        p = idle_cycle.pose_at(0.3, 257.0)
        assert p.shoulder_deg_r == idle_cycle.SHOULDER_REST_DEG_R
        assert p.shoulder_deg_l == idle_cycle.SHOULDER_REST_DEG_L
        assert p.elbow_deg_r == idle_cycle.ELBOW_REST_DEG_R
        assert p.elbow_deg_l == idle_cycle.ELBOW_REST_DEG_L

    def test_upper_pose_carries_explicit_per_side_overrides_not_none(self):
        upper = idle_cycle._upper_pose_at(0.3, 257.0)
        assert upper.shoulder_deg_r is not None
        assert upper.shoulder_deg_l is not None
        assert upper.elbow_deg_r is not None
        assert upper.elbow_deg_l is not None
        assert upper.shoulder_deg_for("R") == idle_cycle.SHOULDER_REST_DEG_R
        assert upper.shoulder_deg_for("L") == idle_cycle.SHOULDER_REST_DEG_L
        assert upper.elbow_deg_for("R") == idle_cycle.ELBOW_REST_DEG_R
        assert upper.elbow_deg_for("L") == idle_cycle.ELBOW_REST_DEG_L

    def test_measured_upper_arm_angle_from_vertical_is_zero_both_sides(self):
        """0deg in this rig's sign convention IS straight down -- vertical. State the
        measured angle directly from the placements rather than just the constant."""
        placements = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        rig = RIG
        lengths = rig_compositor.measured_bone_lengths(PARTS, rig)

        from char_gen.walk_cycle import distal_joint

        # Reconstruct each upper arm's own absolute angle from where its elbow
        # (forearm's own target) actually landed, independent of re-reading the
        # constant back.
        for side, shoulder_deg in (("R", idle_cycle.SHOULDER_REST_DEG_R),
                                    ("L", idle_cycle.SHOULDER_REST_DEG_L)):
            sh_name = f"shoulder_{side}"
            expected_elbow = distal_joint(
                placements[sh_name].target_xy, lengths[sh_name], shoulder_deg,
            )
            fa_name = f"forearm_{side}"
            assert placements[fa_name].target_xy == pytest.approx(expected_elbow)
            assert shoulder_deg == pytest.approx(0.0), (
                f"upper arm {side} sits at {shoulder_deg}deg from vertical, not 0"
            )


class TestDrawOrderIsRealizedFromPixels:
    """Derived by replaying the actual paint loop (`char_gen.draw_order_audit_T0436`),
    never by re-printing `rig.*.z`."""

    def test_realized_rank_is_a_strictly_decreasing_function_of_z_for_all_ten_parts(self):
        placements = idle_cycle.build_placements_at(phase=0.0)
        ranks = realized_draw_rank(placements)
        z_of = {p.name: p.z for p in placements}
        assert len(ranks) == 10
        for name, rank in ranks.items():
            assert rank == 10 - z_of[name]

    def test_no_contested_pair_resolves_against_the_published_z_order(self):
        placements = idle_cycle.build_placements_at(phase=0.0)
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        pairs = contested_pairs(placements, masks)
        assert len(pairs) > 0, "expected real overlap between limbs and the torso"
        violations = [p for p in pairs if p["resolves_against_z_order"]]
        assert violations == [], f"{len(violations)} of {len(pairs)} pairs disagree: {violations}"


class TestBreathingMotionUnchanged:
    """The approved motion (@DennieSeth, T-0430) is not up for re-tuning here."""

    def test_approved_constants_hold(self):
        assert idle_cycle.BREATH_CYCLES_PER_LOOP == 1.0
        assert idle_cycle.BREATH_RISE_FRAC == 0.108
        assert idle_cycle.LEG_FOLLOW == 0.0
        assert idle_cycle.IDLE_THIGH_DEG == 0.0
        assert idle_cycle.IDLE_KNEE_FLEXION_DEG == 0.0
        assert idle_cycle.HEAD_REST_DEG == 0.0

    def test_measured_upper_body_travel_native_and_final_px(self):
        result = idle_cycle.render_frames(frame_count=12)
        torso_h = result.torso_px_size[1]
        native_travel = idle_cycle.travel_at_final_height(torso_h, 1.0)
        final_travel = idle_cycle.travel_at_final_height(torso_h, result.character_scale)
        assert native_travel > 1.0
        assert 0.5 < final_travel < 2.0, f"{final_travel:.3f}px final-size travel"


class TestFeetDoNotDrift:
    """Across every frame, both ankles stay within 1px of their first-frame position
    and the lowest body pixel stays on the ground plane."""

    def test_ankles_and_ground_contact_are_stable_across_every_frame(self):
        result = idle_cycle.render_frames(frame_count=12)
        bottoms = []
        for frame in result.native_frames:
            alpha = np.asarray(frame)[:, :, 3]
            ys, _xs = np.nonzero(alpha > 0)
            bottoms.append(int(ys.max()))
        max_dev = max(bottoms) - min(bottoms)
        assert max_dev <= 1, (
            f"lowest body pixel moves {max_dev}px across the loop -- not planted"
        )

        # Per-frame leg geometry is phase-independent by construction (the hips do
        # not move in idle) -- confirm that directly from re-solved placements for
        # several phases rather than only trusting the single RenderResult field.
        ankle_positions = {"R": set(), "L": set()}
        for phase in (0.0, 0.25, 0.5, 0.75):
            placements = {p.name: p for p in idle_cycle.build_placements_at(phase=phase)}
            for side in ("R", "L"):
                knee, ankle = rig_compositor.leg_chain(
                    placements[f"thigh_{side}"].target_xy,
                    rig_compositor.measured_bone_lengths(PARTS, RIG)[f"thigh_{side}"],
                    rig_compositor.measured_bone_lengths(PARTS, RIG)[f"calf_{side}"],
                    result.leg, side,
                )
                ankle_positions[side].add((round(ankle[0], 3), round(ankle[1], 3)))
        assert len(ankle_positions["R"]) == 1, "ankle_R moved across phases"
        assert len(ankle_positions["L"]) == 1, "ankle_L moved across phases"


class TestFigureHeightMatchesSharedScale:
    """`figure_height()` (char_gen.character_scale) is computed purely from the hip
    y, the ground plane and the head/attach geometry -- none of which this card's
    shoulder/hip-point or lateral-offset additions touch, so the already-approved
    standing idle's own measured height must come out EXACTLY as it did before this
    card (38.906...px), still within the project's own established tolerance for
    this check (`test_sitting_idle_cycle.py`'s `test_standing_still_reads_at_roughly_
    its_own_approved_height`: 0.9x-1.1x of FIGURE_PX, not a tighter absolute bound
    this card has no mechanism to move closer to)."""

    def test_figure_height_matches_the_shared_scale_target(self):
        result = idle_cycle.render_frames(frame_count=12)
        measured = result.native_figure_height * result.character_scale
        assert measured == pytest.approx(38.90609200000001, abs=1e-6)
        assert FIGURE_PX * 0.9 < measured < FIGURE_PX * 1.1
        assert result.character_scale == CHARACTER_SCALE


class TestArmsRideTheBreath:
    """Fix round (2026-10-21): the arms stayed put while the torso rose and fell --
    `rig_compositor.build_placements` was adding `upper.upper_dy` to
    `attach_world("shoulder")` but not to a caller-supplied `shoulder_points`, and
    idle's two-point attach (T-0436/T-0437) always supplies one. The breath-extreme
    phases are located from `idle_cycle.breath` itself, not hardcoded frame indices
    -- `breath` rests at both ends of the cycle, so its min/max over the loop's own
    sampled phases are the two frames that most clearly show (or fail to show) the
    coupling."""

    @staticmethod
    def _breath_extreme_phases(frame_count: int = 12) -> tuple[float, float]:
        phases = [i / frame_count for i in range(frame_count)]
        breaths = [idle_cycle.breath(p) for p in phases]
        return phases[breaths.index(min(breaths))], phases[breaths.index(max(breaths))]

    def test_shoulder_and_forearm_move_with_torso_between_breath_extremes(self):
        low_phase, high_phase = self._breath_extreme_phases()
        low = {p.name: p for p in idle_cycle.build_placements_at(phase=low_phase)}
        high = {p.name: p for p in idle_cycle.build_placements_at(phase=high_phase)}

        torso_dy = high["torso"].target_xy[1] - low["torso"].target_xy[1]
        assert abs(torso_dy) > 0.5, (
            f"breath extremes should move the torso measurably, got {torso_dy}px"
        )

        for side in ("R", "L"):
            sh_name, fa_name = f"shoulder_{side}", f"forearm_{side}"
            shoulder_dy = high[sh_name].target_xy[1] - low[sh_name].target_xy[1]
            forearm_dy = high[fa_name].target_xy[1] - low[fa_name].target_xy[1]
            assert shoulder_dy == pytest.approx(torso_dy, abs=1e-6), (
                f"{sh_name} moved {shoulder_dy}px between breath extremes, "
                f"torso moved {torso_dy}px -- arm is not riding the torso"
            )
            assert forearm_dy == pytest.approx(torso_dy, abs=1e-6), (
                f"{fa_name} moved {forearm_dy}px between breath extremes, "
                f"torso moved {torso_dy}px -- arm is not riding the torso"
            )

    def test_shoulder_x_and_lateral_offset_are_undisturbed_by_the_breath_term(self):
        """The breath term is added to y only -- it must not touch the x the lateral
        offset already resolved, or disturb the one-offset-per-chain rule."""
        low_phase, high_phase = self._breath_extreme_phases()
        low = {p.name: p for p in idle_cycle.build_placements_at(phase=low_phase)}
        high = {p.name: p for p in idle_cycle.build_placements_at(phase=high_phase)}
        for side in ("R", "L"):
            sh_name, fa_name = f"shoulder_{side}", f"forearm_{side}"
            assert low[sh_name].target_xy[0] == pytest.approx(high[sh_name].target_xy[0])
            assert low[fa_name].target_xy[0] == pytest.approx(high[fa_name].target_xy[0])

    def test_hip_points_not_given_the_breath_term(self):
        """The hips/feet must stay planted regardless of the shoulder fix -- only
        `shoulder_points` gets `upper_dy` added, never `hip_points`."""
        low_phase, high_phase = self._breath_extreme_phases()
        low = {p.name: p for p in idle_cycle.build_placements_at(phase=low_phase)}
        high = {p.name: p for p in idle_cycle.build_placements_at(phase=high_phase)}
        for side in ("R", "L"):
            th_name = f"thigh_{side}"
            assert low[th_name].target_xy == high[th_name].target_xy, (
                f"{th_name} moved between breath extremes -- hips must stay planted"
            )

    def test_a_zero_breath_frame_does_not_shift_the_arms(self):
        """Rounding must not let a sub-pixel breath term shift the arms on a frame
        where the torso itself has not moved -- phase 0.0 has `breath(0.0) == 0.0`
        exactly, so `upper_dy` is exactly 0.0 and the arms must land exactly where
        the bare canonical points (no breath term at all) put them."""
        placements = {p.name: p for p in idle_cycle.build_placements_at(phase=0.0)}
        shoulder_points, _ = idle_cycle.canonical_points(RIG)
        assert idle_cycle.breath(0.0) == 0.0
        # shoulder_R carries no lateral offset (only the far/_L side does), so its
        # placed target is the raw canonical point, untouched by the breath term.
        assert placements["shoulder_R"].target_xy == shoulder_points["R"]


class TestReferencePoseUnmovedByTheArmBreathFix:
    """`reference_pose_T0436.upper_pose` always sets `upper_dy=0.0` -- adding a zero
    term to a caller-supplied `shoulder_points` is a provable no-op, verified here
    rather than merely assumed."""

    def test_reference_pose_shoulder_targets_equal_the_raw_canonical_points(self):
        placements = {p.name: p for p in refpose.build_reference_placements()}
        points = refpose.canonical_world_points(RIG, hip_world=(0.0, 0.0))
        # shoulder_R carries no lateral offset (the near side) so comparing it
        # directly against the raw canonical point isolates the breath term alone.
        assert placements["shoulder_R"].target_xy == points["shoulder_R"]

    def test_reference_render_still_resolves_the_same_shoulder_points(self):
        upper = refpose.upper_pose(0.0, 257.0)
        assert upper.upper_dy == 0.0
