"""Regressions for `char_gen.sitting_idle_cycle` (T-0269 round 2).

Round 2 replaces round 1's chair-sit (`seat_plane_y`, thigh 90deg, knee flexion 90deg)
with a crouch, and replaces its per-pose descent scale (0.05473, derived from the
seated figure's own height) with the ONE shared `char_gen.character_scale` constant,
also consumed by `char_gen.idle_cycle`. `TestCrouchStance` pins the new pose.
`TestSharedScale` is the cross-state check this round adds: it renders BOTH the crouch
and the standing idle through the same `char_gen.rig_compositor` and asserts they agree
on the one thing a shared scale promises (shared parts, same pixel size; a shared
ground row) while differing on the one thing a crouch is SUPPOSED to differ on (overall
figure height). `TestComposited*` builds real frames from the ten committed parts and
asserts the two contacts are provably still, the amplitude survives the descent, and
the loop closes -- from the actual composited pixels, not from the intent.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from char_gen import idle_cycle
from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, FIGURE_PX, GROUND_ANCHOR_CELL_Y
from char_gen.idle_cycle import ELBOW_REST_DEG, HEAD_REST_DEG, SHOULDER_REST_DEG
from char_gen.rig_compositor import load_parts, load_rig, measured_bone_lengths
from char_gen.sitting_idle_cycle import (
    CROUCH_BREATH_RISE_FRAC,
    FRAME_COUNT,
    HIP_FORWARD_OF_ANKLE,
    HIP_HEIGHT_ABOVE_GROUND,
    TORSO_LEAN_DEG,
    crouch_stance,
    pose_at,
    render_frames,
)
from char_gen.walk_cycle import bone_length

# Measured, matching docs/assets/evidence/T-0430/rig.json and
# assets/src/character/parts/side_view/side_view_rig.json -- same ten parts, unchanged.
THIGH, CALF = 246.72, 330.24
PHASES = [i / FRAME_COUNT for i in range(FRAME_COUNT)]


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
    """The crouch base pose: a free hip, solved to reach a chosen (not inherited)
    ankle target. Both ankles on the ground plane are the only contact constraint."""

    def test_the_only_ground_constraint_is_the_ankle(self):
        stance = crouch_stance(THIGH, CALF)
        assert stance.ground_plane_y == HIP_HEIGHT_ABOVE_GROUND

    def test_the_hip_is_a_free_point_not_pinned_to_a_plane(self):
        stance = crouch_stance(THIGH, CALF)
        assert stance.hip_y == 0.0
        assert stance.hip_forward_of_ankle_x == HIP_FORWARD_OF_ANKLE

    def test_the_solve_reaches_the_target_exactly(self):
        """Forward-kinematics check: the solved angles must actually put the ankle at
        the chosen (hip_forward_of_ankle_x, ground_plane_y) target, not a clamped
        approximation."""
        stance = crouch_stance(THIGH, CALF)
        ik = idle_cycle.LegIK(stance.thigh_deg, stance.knee_flexion_deg)
        got = idle_cycle.ankle_of((0.0, stance.hip_y), ik, THIGH, CALF)
        target = (stance.hip_forward_of_ankle_x, stance.ground_plane_y)
        assert math.hypot(got[0] - target[0], got[1] - target[1]) < 1e-6, (
            "the two-bone solve did not reach the chosen hip/ground target exactly -- "
            "it clamped instead of solving"
        )

    def test_the_reach_is_not_at_the_clamp_boundary(self):
        stance = crouch_stance(THIGH, CALF)
        reach = math.hypot(
            stance.hip_forward_of_ankle_x, stance.ground_plane_y - stance.hip_y
        )
        lo, hi = abs(THIGH - CALF), THIGH + CALF
        assert lo + 1.0 < reach < hi - 1.0, f"reach {reach:.1f} is at the IK's clamp edge"

    def test_the_reach_is_shorter_than_round_1s_chair_sit(self):
        """The fold must be visibly more compact than the retired chair-sit's 412.1px
        reach -- that is what "deep knee flexion" costs in hip-to-ankle distance."""
        stance = crouch_stance(THIGH, CALF)
        reach = math.hypot(
            stance.hip_forward_of_ankle_x, stance.ground_plane_y - stance.hip_y
        )
        round_1_reach = math.hypot(THIGH, CALF)  # the retired chair-sit's own reach
        assert reach < round_1_reach * 0.9, (
            f"reach {reach:.1f}px is not meaningfully shorter than the retired "
            f"chair-sit's {round_1_reach:.1f}px -- the fold is not deep enough"
        )

    def test_the_thigh_is_not_horizontal(self):
        """Round 1's bug, pinned so it cannot silently return: a horizontal thigh
        (~90deg) is the chair-sit this round replaces."""
        stance = crouch_stance(THIGH, CALF)
        assert stance.thigh_deg < 85.0, (
            f"thigh at {stance.thigh_deg:.1f} deg reads as horizontal -- that is the "
            "retired chair-sit, not a crouch"
        )

    def test_the_knee_flexion_is_deeper_than_round_1s_90_degrees(self):
        stance = crouch_stance(THIGH, CALF)
        assert stance.knee_flexion_deg > 100.0, (
            f"knee flexion {stance.knee_flexion_deg:.2f} deg is not substantially "
            "deeper than round 1's 90.00 deg"
        )

    def test_the_hip_sits_lower_than_round_1s_chair_sit_hip(self):
        """Round 1's hip sat CALF_LEN above the ground (330.24px, the thigh being
        horizontal). This round's hip must sit lower."""
        stance = crouch_stance(THIGH, CALF)
        hip_height_above_ground = stance.ground_plane_y - stance.hip_y
        assert hip_height_above_ground < CALF, (
            f"hip height {hip_height_above_ground:.1f}px is not lower than round 1's "
            f"chair-sit hip height ({CALF:.1f}px)"
        )

    def test_the_stance_is_deterministic(self):
        assert crouch_stance(THIGH, CALF) == crouch_stance(THIGH, CALF)

    def test_torso_is_upright(self):
        """A small forward lean was allowed by the card; this module chooses none --
        state the angle rather than leaving it implicit."""
        assert TORSO_LEAN_DEG == 0.0


class TestOnlyTheUpperBodyMoves:
    """Sitting idle carries exactly one signal, same as the standing idle it borrows
    `breath` from. Anything else reappearing here is the rejected 'too busy' idle."""

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_arms_are_a_fixed_hanging_pose(self, phase):
        p = pose_at(phase, 257.0)
        assert p.shoulder_deg == SHOULDER_REST_DEG
        assert p.elbow_deg == ELBOW_REST_DEG

    @pytest.mark.parametrize("phase", PHASES)
    def test_the_head_does_not_rotate(self, phase):
        p = pose_at(phase, 257.0)
        assert p.head_deg == HEAD_REST_DEG

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

    def test_both_contacts_are_provably_still(self, result):
        """The hip and both ankles never move -- assert it on the pixels, not the
        intent. Everything below the lower-body band is placed from constants that do
        not vary with phase, so it must be bit-for-bit identical across every frame.

        This band alone proves the ANKLES: it starts below the upper body's own
        lowest reach across every phase, so it cannot contain anything the breath
        touches. It does NOT reach up as far as the hip -- the hanging forearms pass
        close by the hip on their way down, so a band wide enough to clear them starts
        below it. The hip itself is proven separately, below."""
        band = result.lower_body_band
        arrays = [np.asarray(f.crop(band)) for f in result.native_frames]
        base = arrays[0]
        for i, arr in enumerate(arrays[1:], start=1):
            assert np.array_equal(arr, base), (
                f"frame {i}'s lower body differs from frame 0 -- the hip/ankle "
                "contacts moved when they must not"
            )

    @pytest.mark.parametrize(
        "point_name", ["hip_px", "ankle_r_px", "ankle_l_px"]
    )
    def test_each_contact_pixel_is_identical_across_every_frame(self, result, point_name):
        """The hip proof the band above cannot give: the near leg (thigh_R/calf_R) is
        the topmost z-order layer in every frame (`rig_compositor.build_placements`
        draws it last), so wherever it is opaque the composited pixel is its own
        phase-invariant content, full stop, regardless of what the breathing torso or
        hanging arms are doing underneath. Sampling an 11x11 neighbourhood at the
        contact's own canvas coordinate -- the same `leg_chain` two-bone solve that
        placed the calf there, not a separately re-derived point -- and requiring it
        both opaque and pixel-identical across every frame is the direct proof this
        band-only test could not give for the hip."""
        px = getattr(result, point_name)
        windows = [
            np.asarray(f.crop((px[0] - 5, px[1] - 5, px[0] + 6, px[1] + 6)))
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
        """BREATH_RISE_FRAC unmodified lands near 1.1px at the corrected scale --
        clears the floor but with far less margin than round 1's 1.52px. This pose
        must use a raised amplitude, not the bare idle constant."""
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


def test_walk_cycle_bone_length_is_unmodified_by_this_module():
    """Shared-helper regression: `bone_length` must resolve the same value for callers
    outside this module after sitting_idle_cycle (via rig_compositor) imports it."""
    assert bone_length(257.0, 0.0) == 257.0
    assert bone_length(344.0, 0.04) == pytest.approx(330.24)
