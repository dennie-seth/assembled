"""T-0419: recover genuine per-frame rig keypoints for the three v1 synthetic
state sheets (crouch-hide, die, move) from `char_gen.synth_states`'s own
deterministic drawing formulas -- never invented, never copied from another
sheet's rig. Every expected coordinate below is transcribed directly from
`_draw_crouch_frame`/`_draw_die_frame`/`_draw_walk_frame`'s own pixel-range
arithmetic in `char_gen.synth_states` (docs/design/13-asset-pipeline.md
§3.5), so a test failure here means the recovery module's geometry has
drifted from the generator it is supposed to describe.

COCO-18 joint layout (matches `asset_gate.character`'s own
`RIG_LIMB_JOINT_PAIRS`/`HEAD_JOINT_INDICES`/etc.):
  0 nose, 1 neck, 2 Rshoulder, 3 Relbow, 4 Rwrist, 5 Lshoulder, 6 Lelbow,
  7 Lwrist, 8 Rhip, 9 Rknee, 10 Rankle, 11 Lhip, 12 Lknee, 13 Lankle,
  14 Reye, 15 Leye, 16 Rear, 17 Lear.

Because these three synthetic sheets are flat rectangular colour blocks
(no distinct facial features or arm segments were ever drawn for
crouch-hide/die), several joints are honestly COLLAPSED to the same point
-- documented per-function below -- rather than assigned invented distinct
positions. That is a genuine transcription of "this feature does not exist
in the source pixels", not a fabricated pose.
"""

from __future__ import annotations

from char_gen.rig_recovery_T0419 import (
    CELL_SIZE,
    crouch_hide_frame_keypoints,
    die_frame_keypoints,
    move_frame_keypoints,
)


def _joint(keypoints: list[dict], joint_index: int) -> tuple[float, float]:
    for kp in keypoints:
        if kp["joint"] == joint_index:
            return (kp["x"], kp["y"])
    raise AssertionError(f"joint {joint_index} missing from {keypoints!r}")


def _norm(col: float, row: float) -> tuple[float, float]:
    return (col / CELL_SIZE, row / CELL_SIZE)


class TestCrouchHideRecovery:
    """`_draw_crouch_frame`: body core rows 20:42 cols 10:38 (constant);
    head rows (4+2*step):(+10) cols 16:28; legs rows (40-step):(+5, cap 46)
    cols 14:20 (R) / 30:36 (L)."""

    def test_returns_all_18_coco_joints(self):
        kps = crouch_hide_frame_keypoints(step=0)
        assert sorted(kp["joint"] for kp in kps) == list(range(18))

    def test_step_0_head_center(self):
        # head_top=4, head_bot=14 -> row center 9; cols 16:28 -> col center 22
        kps = crouch_hide_frame_keypoints(step=0)
        assert _joint(kps, 0) == _norm(22, 9)

    def test_step_8_head_center(self):
        # head_top=4+16=20, head_bot=30 -> row center 25
        kps = crouch_hide_frame_keypoints(step=8)
        assert _joint(kps, 0) == _norm(22, 25)

    def test_head_joints_collapse_to_nose(self):
        # no distinct facial features were ever drawn -- eyes/ears are an
        # honest collapse onto the same point as nose, not invented offsets.
        kps = crouch_hide_frame_keypoints(step=3)
        nose = _joint(kps, 0)
        for joint_index in (14, 15, 16, 17):
            assert _joint(kps, joint_index) == nose

    def test_neck_is_body_core_top_center(self):
        # body core cols 10:38 -> center col 24; body top row 20 (constant).
        kps = crouch_hide_frame_keypoints(step=5)
        assert _joint(kps, 1) == _norm(24, 20)

    def test_arm_joints_collapse_to_shoulder_no_drawn_arm(self):
        # crouch-hide draws no separate arm rectangle -- shoulder/elbow/
        # wrist collapse to the body-core edge on each side.
        kps = crouch_hide_frame_keypoints(step=2)
        r_shoulder = _joint(kps, 2)
        assert r_shoulder == _norm(38, 20)
        assert _joint(kps, 3) == r_shoulder
        assert _joint(kps, 4) == r_shoulder
        l_shoulder = _joint(kps, 5)
        assert l_shoulder == _norm(10, 20)
        assert _joint(kps, 6) == l_shoulder
        assert _joint(kps, 7) == l_shoulder

    def test_hips_are_body_core_bottom_corners(self):
        kps = crouch_hide_frame_keypoints(step=0)
        assert _joint(kps, 8) == _norm(38, 42)
        assert _joint(kps, 11) == _norm(10, 42)

    def test_step_0_leg_positions(self):
        # leg_top=40, leg_bot=min(45,46)=45 -> row center 42.5
        kps = crouch_hide_frame_keypoints(step=0)
        assert _joint(kps, 9) == _norm(33, 42.5)
        assert _joint(kps, 10) == _norm(33, 45)
        assert _joint(kps, 12) == _norm(17, 42.5)
        assert _joint(kps, 13) == _norm(17, 45)

    def test_step_8_leg_positions(self):
        # leg_top=32, leg_bot=min(37,46)=37 -> row center 34.5
        kps = crouch_hide_frame_keypoints(step=8)
        assert _joint(kps, 9) == _norm(33, 34.5)
        assert _joint(kps, 10) == _norm(33, 37)


class TestDieRecovery:
    """`_draw_die_frame`: body core rows 13:42 cols 8:40 (constant); head
    rows (4+2*step):(+10) cols (16+2*step):(+12); legs rows (41-step):(+5,
    cap 46) cols 14:20 (R) / 30:36 (L)."""

    def test_step_0_head_center(self):
        # head_r0=4, rows 4:14 -> center row 9; head_c0=16, cols 16:28 -> center col 22
        kps = die_frame_keypoints(step=0)
        assert _joint(kps, 0) == _norm(22, 9)

    def test_step_8_head_center(self):
        # head_r0=20, rows 20:30 -> center row 25; head_c0=32, cols 32:44 -> center col 38
        kps = die_frame_keypoints(step=8)
        assert _joint(kps, 0) == _norm(38, 25)

    def test_neck_is_body_core_top_center(self):
        # body cols 8:40 -> center col 24; body top row 13 (constant).
        kps = die_frame_keypoints(step=4)
        assert _joint(kps, 1) == _norm(24, 13)

    def test_hips_are_body_core_bottom_corners(self):
        kps = die_frame_keypoints(step=0)
        assert _joint(kps, 8) == _norm(40, 42)
        assert _joint(kps, 11) == _norm(8, 42)

    def test_step_0_leg_positions(self):
        # leg_r0=41, leg_r1=min(46,46)=46 -> row center 43.5
        kps = die_frame_keypoints(step=0)
        assert _joint(kps, 9) == _norm(33, 43.5)
        assert _joint(kps, 10) == _norm(33, 46)


class TestMoveRecovery:
    """`_draw_walk_frame` + `_WALK_OFFSETS`: constant body/head/arms, legs
    shift by (l_off, r_off) per `_WALK_OFFSETS[frame_index]` for the 10 real
    walk frames; frame indices 10-11 are the sheet's own documented spare/
    blank cells ((3,1), (3,2)) with no figure drawn at all."""

    def test_frame_0_walk_offsets_neutral(self):
        # _WALK_OFFSETS[0] = (0, 0); left leg cols 14:20 -> center 17,
        # right leg cols 30:36 -> center 33; both rows 29:35 -> center 32.
        kps = move_frame_keypoints(frame_index=0)
        assert _joint(kps, 12) == _norm(17, 32)  # Lknee
        assert _joint(kps, 9) == _norm(33, 32)  # Rknee

    def test_frame_2_full_left_stride(self):
        # _WALK_OFFSETS[2] = (-4, 4)
        kps = move_frame_keypoints(frame_index=2)
        assert _joint(kps, 12) == _norm(17 - 4, 32)
        assert _joint(kps, 9) == _norm(33 + 4, 32)

    def test_head_is_constant_across_frames(self):
        # move never shifts the head -- rows 4:14 cols 16:28 every frame.
        assert _joint(move_frame_keypoints(0), 0) == _norm(22, 9)
        assert _joint(move_frame_keypoints(6), 0) == _norm(22, 9)

    def test_arms_are_drawn_rectangles_not_collapsed(self):
        # unlike crouch/die, move draws real (constant) arm rectangles, so
        # shoulder/elbow/wrist are genuinely distinct points, not collapsed.
        kps = move_frame_keypoints(frame_index=0)
        r_shoulder, r_elbow, r_wrist = _joint(kps, 2), _joint(kps, 3), _joint(kps, 4)
        assert r_shoulder != r_elbow
        assert r_elbow != r_wrist

    def test_spare_cell_10_and_11_are_documented_blank(self):
        # (3,1) and (3,2): no figure pixels exist at all -- every joint
        # collapses to the cell centre, the module's documented convention
        # for "no pose to report", never an invented walking pose.
        for frame_index in (10, 11):
            kps = move_frame_keypoints(frame_index=frame_index)
            for kp in kps:
                assert (kp["x"], kp["y"]) == (0.5, 0.5)

    def test_returns_12_frames_worth_when_asked_for_full_sheet(self):
        from char_gen.rig_recovery_T0419 import move_sheet_frame_count

        assert move_sheet_frame_count() == 12
