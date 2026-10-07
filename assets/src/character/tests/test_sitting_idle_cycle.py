"""Regressions for `char_gen.sitting_idle_cycle` (T-0269 round 3).

Round 3 is pose refinement only, on top of round 2's settled crouch (no seat plane, one
shared `character_scale.CHARACTER_SCALE`, which this file's `TestNoSeatPlaneAnywhere`
and `TestSharedScale` still cover unchanged). Three refinements, three new test groups:

* `TestTorsoLeanIsApplied` -- round 2's `TORSO_LEAN_DEG` was recorded but never
  consumed (`rig_compositor.UpperPose` had no rotation field at all). This group
  proves the opposite from rendered pixels: the HEAD part's own rotated bitmap, not
  just its placement coordinate, differs with and without the lean.
* `TestArmRestPose` -- the crouch's own solved shoulder/elbow angles, proven (not
  asserted) to land the near wrist on the near knee, with the wrist-to-knee distance
  stated in both native and final pixels.
* `TestStagger` -- two independent per-leg IK solves to two different ankle x-targets
  on the shared ground plane, proven exact (not clamped) and clearly separated in
  final pixels (round 2's bug landed 0.48px apart; this round's own test pins a much
  larger floor).

`TestCompositedFrames` extends round 2's per-point contact-pixel proof from
`{hip, ankle_r, ankle_l}` to also cover both knees, closing the round-3 human-comment
gap ("a band that actually includes the hip and the knees").
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from char_gen import idle_cycle, rig_compositor
from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, FIGURE_PX, GROUND_ANCHOR_CELL_Y
from char_gen.rig_compositor import load_parts, load_rig, measured_bone_lengths
from char_gen.sitting_idle_cycle import (
    ANKLE_X_BACK,
    ANKLE_X_FRONT,
    ARM_STANCE,
    CROUCH_BREATH_RISE_FRAC,
    CROUCH_STANCE,
    ELBOW_DEG_CROUCH,
    EVIDENCE_DIR,
    FRAME_COUNT,
    HIP_HEIGHT_ABOVE_GROUND,
    SHOULDER_DEG_CROUCH,
    TORSO_LEAN_DEG,
    arm_stance,
    crouch_stance,
    leg_stance,
    pose_at,
    render_frames,
)
from char_gen.walk_cycle import bone_length

# Measured, matching docs/assets/evidence/T-0430/rig.json and
# assets/src/character/parts/side_view/side_view_rig.json -- same ten parts, unchanged.
THIGH, CALF = 246.72, 330.24
SHOULDER_LEN, FOREARM_LEN = 103.04, 198.34
PHASES = [i / FRAME_COUNT for i in range(FRAME_COUNT)]
#: Radius wide enough that every contact point's own window is opaque, yet narrow
#: enough it never catches a phase-varying edge -- swept empirically (see the T-0269
#: round 3 dev log): radius 9 is the widest that is still pixel-identical for every one
#: of the five contact points at once; radius 10 already breaks hip_px/knee_r_px.
CONTACT_WINDOW_RADIUS = 9


class TestNoSeatPlaneAnywhere:
    """Round 1's seat-plane abstraction is retired outright -- not renamed, removed."""

    def test_module_has_no_seat_plane_symbol(self):
        import char_gen.sitting_idle_cycle as mod

        names = dir(mod)
        offenders = [n for n in names if "seat" in n.lower()]
        assert not offenders, f"seat-plane symbols survived the rewrite: {offenders}"

    def test_crouch_stance_fields_have_no_seat_or_chair_framing(self):
        """The dataclass shape itself: a ground plane and a free hip, never a seat,
        chair, bench or stool plane."""
        import char_gen.sitting_idle_cycle as mod

        fields = {f for f in mod.CrouchStance.__dataclass_fields__}
        forbidden = {"seat_plane_y", "chair", "bench", "stool"}
        assert not (fields & forbidden), fields


class TestCrouchStance:
    """The crouch base pose: a shared, free hip; each leg solved independently to its
    own ankle target. Both ankles on the ground plane, at different x, are the only
    contact constraint."""

    def test_the_only_ground_constraint_is_the_ankle(self):
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        assert stance.ground_plane_y == HIP_HEIGHT_ABOVE_GROUND

    def test_the_hip_is_a_free_point_shared_by_both_legs(self):
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        assert stance.hip_y == 0.0

    @pytest.mark.parametrize("side", ["r", "l"])
    def test_each_sides_solve_reaches_its_own_target_exactly(self, side):
        """Forward-kinematics check per leg: the solved angles must actually put that
        side's ankle at its OWN chosen x-target, not a clamped approximation."""
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        ankle_x = getattr(stance, f"ankle_x_{side}")
        thigh_deg = getattr(stance, f"thigh_deg_{side}")
        knee_flexion_deg = getattr(stance, f"knee_flexion_deg_{side}")
        ik = idle_cycle.LegIK(thigh_deg, knee_flexion_deg)
        got = idle_cycle.ankle_of((0.0, stance.hip_y), ik, THIGH, CALF)
        target = (ankle_x, stance.ground_plane_y)
        assert math.hypot(got[0] - target[0], got[1] - target[1]) < 1e-6, (
            f"the {side} leg's two-bone solve did not reach its own target exactly -- "
            "it clamped instead of solving"
        )

    @pytest.mark.parametrize("side", ["r", "l"])
    def test_each_sides_reach_is_not_at_the_clamp_boundary(self, side):
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        ankle_x = getattr(stance, f"ankle_x_{side}")
        reach = math.hypot(ankle_x, stance.ground_plane_y - stance.hip_y)
        lo, hi = abs(THIGH - CALF), THIGH + CALF
        assert lo + 1.0 < reach < hi - 1.0, f"{side} reach {reach:.1f} is at the IK's clamp edge"

    @pytest.mark.parametrize("side", ["r", "l"])
    def test_each_leg_is_shorter_reach_than_round_1s_chair_sit(self, side):
        """The fold must be visibly more compact than the retired chair-sit's 412.1px
        reach -- that is what "deep knee flexion" costs in hip-to-ankle distance."""
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        ankle_x = getattr(stance, f"ankle_x_{side}")
        reach = math.hypot(ankle_x, stance.ground_plane_y - stance.hip_y)
        round_1_reach = math.hypot(THIGH, CALF)  # the retired chair-sit's own reach
        assert reach < round_1_reach * 0.9, (
            f"{side} reach {reach:.1f}px is not meaningfully shorter than the retired "
            f"chair-sit's {round_1_reach:.1f}px -- the fold is not deep enough"
        )

    def test_no_legs_thigh_is_pinned_to_round_1s_exact_90_degrees(self):
        """Round 1's bug was an EXACT 90.0deg thigh from a seat-plane pin. Round 3's
        front leg is legitimately close to horizontal (an IK consequence of staggering
        the ankle forward at a fixed hip height, not a seat pin) -- the regression
        guard is therefore "not the exact chair-sit value", not an arbitrary angle
        threshold that no longer fits a genuinely staggered stance."""
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        for side in ("r", "l"):
            thigh_deg = getattr(stance, f"thigh_deg_{side}")
            assert thigh_deg != pytest.approx(90.0, abs=0.05), (
                f"{side} thigh at {thigh_deg:.2f} deg is round 1's exact chair-sit "
                "horizontal, not a genuine IK solve"
            )

    def test_both_knee_flexions_are_deeper_than_round_1s_90_degrees(self):
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        for side in ("r", "l"):
            flex = getattr(stance, f"knee_flexion_deg_{side}")
            assert flex > 100.0, (
                f"{side} knee flexion {flex:.2f} deg is not substantially deeper than "
                "round 1's 90.00 deg"
            )

    def test_the_hip_sits_lower_than_round_1s_chair_sit_hip(self):
        """Round 1's hip sat CALF_LEN above the ground (330.24px, the thigh being
        horizontal). This round's hip must sit lower."""
        stance = crouch_stance(THIGH, CALF, THIGH, CALF)
        hip_height_above_ground = stance.ground_plane_y - stance.hip_y
        assert hip_height_above_ground < CALF, (
            f"hip height {hip_height_above_ground:.1f}px is not lower than round 1's "
            f"chair-sit hip height ({CALF:.1f}px)"
        )

    def test_the_stance_is_deterministic(self):
        assert crouch_stance(THIGH, CALF, THIGH, CALF) == crouch_stance(THIGH, CALF, THIGH, CALF)


class TestStagger:
    """T-0269 round 3's second refinement: two different ankle x-targets on the SAME
    ground plane, each solved independently from the ONE shared hip -- not
    `far_leg_offset_frac` shifting one leg's pose sideways (round 2's bug, which left
    the two ankles 0.48 final px apart)."""

    def test_the_two_ankle_targets_are_different(self):
        assert ANKLE_X_FRONT != ANKLE_X_BACK
        assert CROUCH_STANCE.ankle_x_r != CROUCH_STANCE.ankle_x_l

    def test_the_two_legs_resolve_different_knee_flexion(self):
        assert CROUCH_STANCE.knee_flexion_deg_r != pytest.approx(
            CROUCH_STANCE.knee_flexion_deg_l, abs=0.5
        ), "both legs resolved the same flexion -- that is one pose shifted, not a stagger"

    def test_both_legs_reaches_are_inside_the_workspace_not_clamped(self):
        lo, hi = abs(THIGH - CALF), THIGH + CALF
        for ankle_x in (CROUCH_STANCE.ankle_x_r, CROUCH_STANCE.ankle_x_l):
            reach = math.hypot(ankle_x, HIP_HEIGHT_ABOVE_GROUND)
            assert lo + 1.0 < reach < hi - 1.0, (
                f"ankle_x={ankle_x} reach {reach:.1f}px is at or past the leg's own "
                f"({lo:.1f}, {hi:.1f}) workspace -- the solve would have to clamp"
            )

    def test_both_legs_stay_deep_past_90_degrees(self):
        """The stagger must change the stance, not the depth."""
        assert CROUCH_STANCE.knee_flexion_deg_r > 100.0
        assert CROUCH_STANCE.knee_flexion_deg_l > 100.0

    def test_the_separation_is_clearly_visible_at_the_final_figure(self):
        """Round 2's two ankles were 0.48 final px apart -- sub-pixel, invisible. This
        round's must be unambiguous at the 40px figure convention."""
        separation = abs(CROUCH_STANCE.ankle_x_r - CROUCH_STANCE.ankle_x_l) * CHARACTER_SCALE
        assert separation > 3.0, (
            f"{separation:.2f} final px of separation is not clearly visible -- round "
            "2's bug was 0.48px"
        )

    def test_the_hip_is_genuinely_shared_not_offset_per_leg(self):
        """`far_leg_offset_frac` must be 0.0 for this pose -- the card is explicit that
        each leg solves from the SHARED hip, and widening this offset is a different
        (and rejected) way of faking a stagger."""
        leg = leg_stance(THIGH, CALF, THIGH, CALF)
        assert leg.far_leg_offset_frac == 0.0
        hip_points = rig_compositor.leg_hip_points(leg, torso_width=221.0)
        assert hip_points["R"] == hip_points["L"] == leg.hip


class TestTorsoLeanIsApplied:
    """T-0269 round 3's headline fix. Round 2 recorded `TORSO_LEAN_DEG` into rig.json
    without ever consuming it -- `rig_compositor.UpperPose` had no rotation field, so
    the recorded 0.0 was correct only by coincidence. Every test below proves the
    CURRENT, non-zero lean reaches the render, from the actual composited/placed
    pixels, not from reading the constant back."""

    @staticmethod
    def _placements_for(torso_deg):
        parts = load_parts()
        rig = load_rig()
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = measured_bone_lengths(parts, rig)
        leg = leg_stance(THIGH, CALF, THIGH, CALF)
        pose = rig_compositor.UpperPose(
            upper_dy=0.0, shoulder_deg=SHOULDER_DEG_CROUCH, elbow_deg=ELBOW_DEG_CROUCH,
            head_deg=idle_cycle.HEAD_REST_DEG, torso_deg=torso_deg,
        )
        return rig_compositor.build_placements(
            pose, leg, scaled, rig["rig"], rig["attach_torso_local_px"], lengths
        )

    def test_torso_lean_deg_is_non_zero(self):
        assert TORSO_LEAN_DEG != 0.0, (
            "a zero lean is indistinguishable from round 2's unconsumed constant -- "
            "this round must actually lean the torso"
        )

    def test_rotate_offset_agrees_with_distal_joint_for_a_downward_vector(self):
        """`rotate_offset` generalizes `distal_joint`'s own sign convention --
        `distal_joint(origin, L, deg)` must be the special case `offset=(0, L)`."""
        from char_gen.walk_cycle import distal_joint

        length = 123.4
        for deg in (-30.0, 0.0, 17.0, 90.0):
            got = rig_compositor.rotate_offset((0.0, length), deg)
            want = distal_joint((0.0, 0.0), length, deg)
            assert got == pytest.approx(want, abs=1e-9)

    def test_the_heads_own_rendered_pixels_change_with_the_lean(self):
        """The strongest proof: the HEAD part's own rotated bitmap -- not just its
        placement coordinate -- must differ between two DIFFERENT non-zero torso
        angles. (Comparing against `torso_deg=0.0` would compare a rotated-and-padded
        image against an untouched one of a different size -- `place()` only pads for
        rotation when `angle_deg` is truthy -- so this compares two angles that both
        trigger the same padding, isolating the rotation itself.) This is only
        possible if `torso_deg` reaches `Image.rotate`, which is exactly what round 2
        never did."""
        leaned = self._placements_for(TORSO_LEAN_DEG)
        half_leaned = self._placements_for(TORSO_LEAN_DEG / 2.0)
        leaned_head = next(p for p in leaned if p.name == "head")
        half_leaned_head = next(p for p in half_leaned if p.name == "head")
        assert leaned_head.image.size == half_leaned_head.image.size
        leaned_arr = np.asarray(leaned_head.image)
        half_arr = np.asarray(half_leaned_head.image)
        assert not np.array_equal(leaned_arr, half_arr), (
            "the head's own rendered pixels are identical at two different "
            "TORSO_LEAN_DEG values -- the lean is not reaching Image.rotate, round "
            "2's bug"
        )

    def test_the_shoulders_own_rendered_pixels_change_with_the_lean(self):
        """Whatever rides on the torso must follow -- proven the same way for the arms."""
        leaned = self._placements_for(TORSO_LEAN_DEG)
        half_leaned = self._placements_for(TORSO_LEAN_DEG / 2.0)
        leaned_sh = next(p for p in leaned if p.name == "shoulder_R")
        half_leaned_sh = next(p for p in half_leaned if p.name == "shoulder_R")
        assert not np.array_equal(np.asarray(leaned_sh.image), np.asarray(half_leaned_sh.image)), (
            "the shoulder's own rendered pixels are identical at two different "
            "TORSO_LEAN_DEG values -- the arms are not following the torso"
        )

    def test_the_lean_moves_the_head_toward_the_knees_not_away(self):
        """TORSO_LEAN_DEG is NEGATIVE in this rig's convention (see the module
        docstring's sign note: the torso's own hip->neck vector points mostly straight
        up, and the same spin that swings a downward vector toward +x swings an upward
        one toward -x). A forward lean must move the head toward +x (over the knees),
        checked on the real placement this round's lean actually produces."""
        leaned = self._placements_for(TORSO_LEAN_DEG)
        upright = self._placements_for(0.0)
        leaned_x = next(p for p in leaned if p.name == "head").target_xy[0]
        upright_x = next(p for p in upright if p.name == "head").target_xy[0]
        assert leaned_x > upright_x, (
            f"leaning the torso moved the head's x from {upright_x:.1f} to "
            f"{leaned_x:.1f} -- that is backward (-x), not forward over the knees"
        )

    def test_the_lean_does_not_move_any_contact(self):
        """Rotating the torso must not shift the hip or either ankle -- those are leg
        geometry, untouched by the upper body's own rotation."""
        leg = leg_stance(THIGH, CALF, THIGH, CALF)

        def is_leg_part(name):
            return "thigh" in name or "calf" in name

        leaned_by_name = {
            p.name: p.target_xy for p in self._placements_for(TORSO_LEAN_DEG) if is_leg_part(p.name)
        }
        upright_by_name = {
            p.name: p.target_xy for p in self._placements_for(0.0) if is_leg_part(p.name)
        }
        assert leaned_by_name == upright_by_name, (
            "a leg part's placement target changed when only the torso's lean "
            "changed -- the lean is leaking into leg geometry"
        )
        assert leg.hip == (0.0, 0.0)


class TestArmRestPose:
    """T-0269 round 3's second refinement: the crouch's OWN solved shoulder/elbow
    angles, not `idle_cycle`'s standing-rest constants, landing the near wrist at the
    near knee."""

    def test_shoulder_and_elbow_are_this_poses_own_not_idles(self):
        assert SHOULDER_DEG_CROUCH != idle_cycle.SHOULDER_REST_DEG
        assert ELBOW_DEG_CROUCH != idle_cycle.ELBOW_REST_DEG

    def test_the_arm_solve_reaches_the_near_knee(self):
        assert ARM_STANCE.wrist_to_knee_distance_native_px < 1e-6, (
            f"wrist landed {ARM_STANCE.wrist_to_knee_distance_native_px:.3f} native px "
            "from the near knee -- the solve did not reach the target"
        )

    def test_wrist_to_knee_distance_in_final_pixels_is_small(self):
        final_px = ARM_STANCE.wrist_to_knee_distance_native_px * CHARACTER_SCALE
        assert final_px < 0.5, f"{final_px:.3f} final px -- not 'at or near' the knee"

    def test_the_arm_solve_is_not_clamped(self):
        lo, hi = ARM_STANCE.reach_workspace
        assert not ARM_STANCE.clamped, (
            f"reach {ARM_STANCE.reach:.1f} is outside the arm's own ({lo:.1f}, "
            f"{hi:.1f}) workspace -- the solve clamped instead of reaching exactly"
        )
        assert lo + 1.0 < ARM_STANCE.reach < hi - 1.0

    def test_the_elbow_is_bent_not_locked_straight(self):
        """A believable resting bend, not a fully extended (0deg) or fully folded
        (180deg) singularity."""
        assert 5.0 < abs(ELBOW_DEG_CROUCH) < 175.0

    def test_arm_stance_is_deterministic(self):
        rig = load_rig()
        attach = rig["attach_torso_local_px"]
        leg = leg_stance(THIGH, CALF, THIGH, CALF)
        knee_r, _ = rig_compositor.leg_chain(leg.hip, THIGH, CALF, leg, "R")
        a = arm_stance(SHOULDER_LEN, FOREARM_LEN, attach, leg.hip, knee_r)
        b = arm_stance(SHOULDER_LEN, FOREARM_LEN, attach, leg.hip, knee_r)
        assert a == b


class TestOnlyTheUpperBodyMoves:
    """Sitting idle carries exactly one signal, same as the standing idle it borrows
    `breath` from. The arms and the torso lean are each a fixed REST configuration
    (this pose's own, not idle_cycle's) -- constant across every phase; only
    `upper_dy` varies."""

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_arms_are_a_fixed_pose(self, phase):
        p = pose_at(phase, 257.0)
        assert p.shoulder_deg == SHOULDER_DEG_CROUCH
        assert p.elbow_deg == ELBOW_DEG_CROUCH

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_head_does_not_rotate_on_its_own(self, phase):
        assert pose_at(phase, 257.0).head_deg == idle_cycle.HEAD_REST_DEG

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_torso_lean_is_fixed(self, phase):
        p = pose_at(phase, 257.0)
        assert p.torso_deg == TORSO_LEAN_DEG

    def test_the_upper_body_actually_moves(self):
        span = max(pose_at(ph, 257.0).upper_dy for ph in PHASES) - \
            min(pose_at(ph, 257.0).upper_dy for ph in PHASES)
        assert span > 0.0

    def test_frame_zero_is_the_base_pose(self):
        assert pose_at(0.0, 257.0).upper_dy == 0.0


class TestLoopCloses:
    def test_pose_agrees_across_the_seam(self):
        a, b = pose_at(0.0, 257.0), pose_at(1.0, 257.0)
        assert a.upper_dy == pytest.approx(b.upper_dy, abs=1e-12), "the loop will pop"

    def test_phase_wraps(self):
        assert pose_at(1.25, 257.0).upper_dy == pytest.approx(pose_at(0.25, 257.0).upper_dy)


class TestMeasuredGeometry:
    def test_parts_dir_has_all_ten_parts(self):
        parts = load_parts()
        assert len(parts) == 10

    def test_bone_lengths_match_the_committed_rig(self):
        parts = load_parts()
        rig = load_rig()
        lengths = measured_bone_lengths(parts, rig)
        assert abs(lengths["calf_L"] - lengths["calf_R"]) < 1.0
        assert lengths["thigh_L"] == pytest.approx(lengths["thigh_R"], abs=0.5)


class TestCompositedFrames:
    """Built from the real parts. Assertions run on the actual composited pixels."""

    @classmethod
    @pytest.fixture(scope="class")
    def result(cls):
        return render_frames()

    def test_frame_count(self, result):
        assert len(result.native_frames) == FRAME_COUNT
        assert len(result.descended_frames) == FRAME_COUNT

    def test_the_lower_body_band_is_still_bit_identical(self, result):
        """Everything below the lower-body band is placed from constants that do not
        vary with phase, so it must be bit-for-bit identical across every frame. The
        band alone does not reach the hip or the knees (the breathing upper body, and
        now the arm resting on the near knee, overlap that region) -- those are proven
        separately below, per-point."""
        band = result.lower_body_band
        arrays = [np.asarray(f.crop(band)) for f in result.native_frames]
        base = arrays[0]
        for i, arr in enumerate(arrays[1:], start=1):
            assert np.array_equal(arr, base), (
                f"frame {i}'s lower body band differs from frame 0 -- static leg "
                "geometry moved when it must not"
            )

    @pytest.mark.parametrize("point_name", ["ankle_r_px", "ankle_l_px"])
    def test_each_contact_pixel_is_identical_across_every_frame(self, result, point_name):
        """Per-point proof for the two GROUND contacts, from composited pixels.

        Round 4 narrows this from five points to the two ankles, and the reason is a
        premise that stopped being true rather than a weakened standard. It used to
        read the hip and both knees too, resting on the near leg (thigh_R/calf_R)
        being the topmost z-order layer -- so whatever it covered was its own
        phase-invariant content. Round 4 draws `thigh_R` BEHIND the torso (its
        rectangular crop was painting over the body), so a composited pixel at the hip
        or the near knee can now legitimately be breathing torso, and asserting it is
        frozen would be asserting the breath does not happen.

        The ankles are unaffected -- the shins are still frontmost down there, and they
        are the only contacts the pose actually makes with the ground. Stillness of the
        legs as a whole is proven, more strongly and without any layering assumption, by
        `test_the_leg_placements_are_identical_across_every_phase` below."""
        px = getattr(result, point_name)
        r = CONTACT_WINDOW_RADIUS
        windows = [
            np.asarray(f.crop((px[0] - r, px[1] - r, px[0] + r + 1, px[1] + r + 1)))
            for f in result.native_frames
        ]
        base = windows[0]
        assert base[:, :, 3].max() > 0, (
            f"{point_name} at {px} is fully transparent -- this proves nothing"
        )
        for i, win in enumerate(windows[1:], start=1):
            assert np.array_equal(win, base), (
                f"frame {i}'s pixels around {point_name} ({px}) differ from frame 0 -- "
                f"the {point_name.replace('_px', '')} contact moved when it must not"
            )

    def test_the_leg_placements_are_identical_across_every_phase(self):
        """Every leg part is placed with the same bitmap, pivot, target and z in every
        frame. This is what "the legs are static" actually means, and unlike a pixel
        window it cannot be confounded by whatever is layered on top of them."""
        from char_gen import rig_compositor, sitting_idle_cycle

        parts = rig_compositor.load_parts()
        rig = rig_compositor.load_rig()
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = rig_compositor.measured_bone_lengths(parts, rig)
        stance = sitting_idle_cycle.leg_stance(
            lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"]
        )
        torso_h = scaled["torso"].height

        def leg_signature(phase):
            placements = rig_compositor.build_placements(
                sitting_idle_cycle.pose_at(phase, torso_h), stance, scaled, rig["rig"],
                rig["attach_torso_local_px"], lengths,
                z_override=sitting_idle_cycle.CROUCH_Z_OVERRIDE,
                foot_flatten={"calf_R": sitting_idle_cycle.FRONT_FOOT_FLATTEN_DEG},
            )
            return {
                p.name: (p.target_xy, p.pivot_px, p.z, p.image.tobytes())
                for p in placements
                if p.name in rig_compositor.LEG_PART_NAMES
            }

        base = leg_signature(0.0)
        assert set(base) == set(rig_compositor.LEG_PART_NAMES), (
            "the leg signature must cover every leg part, or it proves less than it claims"
        )
        for i in range(1, FRAME_COUNT):
            got = leg_signature(i / FRAME_COUNT)
            for name in base:
                assert got[name] == base[name], (
                    f"leg part {name} is placed differently at phase {i}/{FRAME_COUNT} "
                    "than at phase 0 -- the legs must be static across the whole loop"
                )

    def test_the_forward_foot_is_flattened_without_moving_its_ankle(self):
        """Round 4 (@DennieSeth): the leading foot plants flat. The rotation is applied
        about the shin's own ankle, so the solved ground contact must not move."""
        from char_gen import rig_compositor, sitting_idle_cycle

        parts = rig_compositor.load_parts()
        rig = rig_compositor.load_rig()
        scaled = rig_compositor.scaled_parts(parts, rig)
        lengths = rig_compositor.measured_bone_lengths(parts, rig)
        stance = sitting_idle_cycle.leg_stance(
            lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"]
        )
        torso_h = scaled["torso"].height
        upper = sitting_idle_cycle.pose_at(0.0, torso_h)
        common = (upper, stance, scaled, rig["rig"], rig["attach_torso_local_px"], lengths)

        plain = {p.name: p for p in rig_compositor.build_placements(*common)}
        flat = {
            p.name: p
            for p in rig_compositor.build_placements(
                *common, foot_flatten={"calf_R": sitting_idle_cycle.FRONT_FOOT_FLATTEN_DEG}
            )
        }

        hips = rig_compositor.leg_hip_points(stance, scaled["torso"].width)
        _knee, ankle = rig_compositor.leg_chain(
            hips["R"], lengths["thigh_R"], lengths["calf_R"], stance, "R"
        )
        thigh_deg, knee_flex = rig_compositor.leg_angles(stance, "R")
        flat_deg = thigh_deg - knee_flex + sitting_idle_cycle.FRONT_FOOT_FLATTEN_DEG
        landed = rig_compositor.distal_joint(
            flat["calf_R"].target_xy, lengths["calf_R"], flat_deg
        )
        assert landed == pytest.approx(ankle, abs=1e-6), (
            f"flattening the forward foot moved its ankle from {ankle} to {landed} -- "
            "it must rotate about the ankle, not the knee"
        )
        assert flat["calf_R"].target_xy != plain["calf_R"].target_xy, (
            "the flattened shin was not repositioned at all -- the rotation cannot have "
            "been applied about the ankle"
        )
        assert flat["calf_L"].target_xy == plain["calf_L"].target_xy, (
            "flattening the FORWARD foot must not disturb the trailing leg"
        )

    def test_the_upper_body_amplitude_clears_a_pixel_at_the_final_height(self, result):
        torso_h = load_parts()["torso"].height
        travel = CROUCH_BREATH_RISE_FRAC * torso_h * CHARACTER_SCALE
        assert travel > 1.0, (
            f"upper body travels only {travel:.2f}px at the final figure height -- "
            "it will not read"
        )

    def test_the_amplitude_stays_a_breath_not_a_bob(self, result):
        torso_h = load_parts()["torso"].height
        travel = CROUCH_BREATH_RISE_FRAC * torso_h * CHARACTER_SCALE
        assert travel < 2.0, f"{travel:.2f}px reads as a bob, not a breath"

    def test_the_breath_was_raised_above_the_unmodified_idle_amplitude(self, result):
        """BREATH_RISE_FRAC unmodified lands near 1.1px at the shared scale -- clears
        the floor but with far less margin than this pose's own re-measured amplitude.
        This pose must use its own raised amplitude, not the bare idle constant."""
        assert CROUCH_BREATH_RISE_FRAC > idle_cycle.BREATH_RISE_FRAC

    def test_the_loop_seam_is_not_the_worst_transition(self, result):
        """The cosine ease rests at both ends, so wrapping frame N-1 back to frame 0
        should not be a bigger jump than any interior step. `deltas[-1]` IS the seam
        (frame N-1 -> frame 0, the wrap-around pair) -- it must be compared against the
        OTHER pairs, never against a maximum that includes itself."""
        deltas = result.changed_px_per_frame_pair
        *interior, seam = deltas
        assert interior, "need at least one interior transition to compare the seam against"
        assert seam <= max(interior), (
            f"loop seam changed {seam}px, worse than the worst interior step "
            f"({max(interior)}px) -- the seam pops harder than an interior frame transition"
        )

    def test_some_motion_is_visible_between_frames(self, result):
        """A dead sheet (nothing changes) is a failure, not a pass."""
        assert max(result.changed_px_per_frame_pair) > 0

    def test_sheet_and_gif_are_written(self, tmp_path, result):
        from char_gen.rig_compositor import save_gif, save_sheet

        sheet_path = save_sheet(result.descended_frames, tmp_path / "sheet.png")
        gif_path = save_gif(result.descended_frames, tmp_path / "loop.gif")
        assert sheet_path.exists()
        assert gif_path.exists()
        sheet = Image.open(sheet_path)
        assert sheet.width == result.cell_px * FRAME_COUNT
        assert sheet.height == result.cell_px


class TestSharedScale:
    """The cross-state check this round adds. Renders BOTH the crouch and the standing
    idle through the same `char_gen.rig_compositor`, at the same default
    `CHARACTER_SCALE`/`GROUND_ANCHOR_CELL_Y`, and compares them directly.

    This must NOT assert that either pose fills `FIGURE_PX` (40px) -- that is round
    1's bug. It asserts that a part shared between the two poses comes out at the same
    pixel size, that the ground anchors to the same row, and that the crouch -- and
    only the crouch -- comes out shorter.
    """

    @classmethod
    @pytest.fixture(scope="class")
    def crouch(cls):
        return render_frames()

    @classmethod
    @pytest.fixture(scope="class")
    def standing(cls):
        return idle_cycle.render_frames()

    def test_both_renders_use_the_one_shared_character_scale(self, crouch, standing):
        assert crouch.character_scale == CHARACTER_SCALE
        assert standing.character_scale == CHARACTER_SCALE
        assert crouch.character_scale == standing.character_scale

    def test_shared_parts_come_out_at_the_same_pixel_size(self, crouch, standing):
        """`torso.png` is identical art consumed unrotated by both poses. At a SHARED
        scale its rendered size must be identical; round 1's per-pose scale (0.05473
        for the seated figure vs whatever the standing idle used) would have made this
        fail -- that is exactly the regression this test exists to catch."""
        cw, ch = crouch.torso_px_size
        sw, sh = standing.torso_px_size
        scale = crouch.character_scale
        crouch_final = (round(cw * scale), round(ch * scale))
        standing_final = (round(sw * scale), round(sh * scale))
        assert crouch_final == standing_final, (
            f"torso renders at {crouch_final}px in the crouch vs {standing_final}px "
            "standing -- the two poses are not using the same world-to-pixel scale"
        )

    def test_the_crouch_is_shorter_than_standing_at_the_common_scale(self, crouch, standing):
        """The crouch occupying LESS vertical space than standing, at the shared
        scale, is the correct result this round restores -- not something to correct
        for by inflating the crouch's own scale (round 1's bug)."""
        crouch_final_h = crouch.native_figure_height * crouch.character_scale
        standing_final_h = standing.native_figure_height * standing.character_scale
        assert crouch_final_h < standing_final_h, (
            f"crouch final height {crouch_final_h:.1f}px is not shorter than "
            f"standing's {standing_final_h:.1f}px -- a crouch must not be taller than "
            "or equal to a stand"
        )

    def test_this_is_not_a_fill_40px_test(self, crouch):
        """The tempting, WRONG test: assert the crouch is 40px tall. That reintroduces
        round 1's bug (inflating a compact pose to a tall pose's own target height).
        Pin the opposite instead -- the crouch must NOT be close to FIGURE_PX."""
        crouch_final_h = crouch.native_figure_height * crouch.character_scale
        assert crouch_final_h < FIGURE_PX * 0.85, (
            f"crouch final height {crouch_final_h:.1f}px is suspiciously close to "
            f"FIGURE_PX ({FIGURE_PX}px) -- check nothing is re-deriving a per-pose "
            "scale to force this pose to fill the standing idle's own target height"
        )

    def test_standing_still_reads_at_roughly_its_own_approved_height(self, crouch, standing):
        """The shared-scale refactor must not silently move the APPROVED standing
        idle. Its own final figure height at the shared scale must still land close to
        FIGURE_PX (40px, docs/assets/evidence/T-0430/rig.json) -- not exactly, since
        this round measures it freshly from the committed parts/rig rather than
        trusting a hand-copied number, but within a few percent."""
        standing_final_h = standing.native_figure_height * standing.character_scale
        assert FIGURE_PX * 0.9 < standing_final_h < FIGURE_PX * 1.1, (
            f"standing final height {standing_final_h:.1f}px has drifted away from "
            f"the approved ~{FIGURE_PX}px figure -- the shared-scale refactor moved "
            "the standing idle"
        )

    def test_shared_ground_anchor(self, crouch, standing):
        """The ground plane must map to the SAME row within the 48px cell for both
        states, so a sprite swap cannot make the character hop."""
        assert crouch.cell_px == CELL_PX == standing.cell_px
        assert crouch.ground_anchor_cell_y == standing.ground_anchor_cell_y == GROUND_ANCHOR_CELL_Y

    def test_standing_idle_is_unaffected_by_the_torso_deg_field(self, standing):
        """`idle_cycle` never sets `torso_deg` -- `UpperPose`'s default (0.0) must
        leave its render identical to before this field existed. Pinned against the
        approved docs/assets/evidence/T-0430 figure height."""
        standing_final_h = standing.native_figure_height * standing.character_scale
        assert FIGURE_PX * 0.9 < standing_final_h < FIGURE_PX * 1.1


class TestEvidenceHasNoAbsolutePaths:
    """T-0269 round 3 human comment: `rig.json` must not record absolute worktree
    paths -- those are only valid on the machine/run that produced them."""

    def test_committed_rig_json_has_no_absolute_paths(self):
        import json

        rig_json_path = EVIDENCE_DIR / "rig.json"
        data = json.loads(rig_json_path.read_text())

        def walk(value):
            if isinstance(value, str):
                assert not value.startswith("/"), f"absolute path recorded: {value!r}"
                assert "worktrees" not in value, f"worktree-scoped path recorded: {value!r}"
            elif isinstance(value, dict):
                for v in value.values():
                    walk(v)
            elif isinstance(value, list):
                for v in value:
                    walk(v)

        walk(data)


def test_walk_cycle_bone_length_is_unmodified_by_this_module():
    """Shared-helper regression: `bone_length` must resolve the same value for callers
    outside this module after sitting_idle_cycle (via rig_compositor) imports it."""
    assert bone_length(257.0, 0.0) == 257.0
    assert bone_length(344.0, 0.04) == pytest.approx(330.24)
