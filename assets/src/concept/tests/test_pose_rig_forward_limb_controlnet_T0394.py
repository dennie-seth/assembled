"""T-0394 -- forward-limb ControlNet/OpenPose skeleton, resting near leg.
No ComfyUI/network dependency (mirrors
test_pose_rig_forward_limb_controlnet_T0387.py's own pattern).

@DennieSeth, after T-0387's stop-and-report: the raised near leg is out of
scope. "We already have a clean single leg in profile from earlier work, so
the leg counts as solved." This module keeps T-0380/T-0382's far-arm
collapse (the fix that actually worked) verbatim and replaces only the near
knee/ankle -- previously a raised-leg excursion inherited from
`pose_rig_master_sheet_T0351.SIDE_RIGHT_FORWARD_KEYPOINTS_NORM` -- with the
same rig's own committed `SIDE_NEUTRAL_KEYPOINTS_NORM` near-leg joints: a
true profile, arms-down, legs-together resting stance, the same stance
family the T-0317 base image itself already shows. No knee/ankle numbers are
hand-typed here; both the base rig and the resting-leg override are reused
verbatim from already-committed modules.

RED state: pose_rig_forward_limb_controlnet_T0394 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

_CHARACTER_DIR = Path(__file__).resolve().parents[2] / "character"
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_forward_limb_controlnet_T0380 as _t0380_rig  # noqa: E402
import pose_rig_forward_limb_controlnet_T0394 as rig  # noqa: E402
import pose_rig_master_sheet_T0351 as _t0351  # noqa: E402

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

_OVERRIDDEN = {_R_KNEE, _R_ANKLE}


def test_only_the_near_knee_and_ankle_are_overridden_from_T0380():
    """Every joint this card does not touch -- including the far-arm
    collapse, both eyes, both ears, the near hip pivot -- stays reused
    verbatim from T-0380/T-0382's rig; only the near knee/ankle move."""
    upstream = _t0380_rig.FORWARD_LIMB_KEYPOINTS_NORM
    ours = rig.FORWARD_LIMB_KEYPOINTS_NORM
    for joint in set(upstream) - _OVERRIDDEN:
        assert ours[joint] == upstream[joint], f"joint {joint} drifted from T-0380's rig"
    for joint in _OVERRIDDEN:
        assert ours[joint] != upstream[joint], f"joint {joint} was expected to be overridden"


def test_near_knee_and_ankle_match_side_neutrals_own_committed_resting_stance():
    """No hand-typed numbers: the resting-leg override is T-0351's own
    committed `SIDE_NEUTRAL_KEYPOINTS_NORM` near knee/ankle, reused
    verbatim."""
    neutral = _t0351.SIDE_NEUTRAL_KEYPOINTS_NORM
    ours = rig.FORWARD_LIMB_KEYPOINTS_NORM
    assert ours[_R_KNEE] == neutral[_R_KNEE]
    assert ours[_R_ANKLE] == neutral[_R_ANKLE]


def test_keypoints_emit_all_18_coco_joints():
    assert set(rig.keypoints().keys()) == set(range(18))


def test_keypoints_returns_a_copy_not_the_shared_constant():
    points = rig.keypoints()
    points[_NOSE] = (0.0, 0.0)
    assert rig.keypoints()[_NOSE] != (0.0, 0.0)


def test_far_arm_is_still_collapsed_hidden_behind_the_far_shoulder():
    """T-0382's own fix must survive untouched -- this card does not
    reopen the second-hand defect; it only changes the leg."""
    points = rig.keypoints()
    assert points[_L_ELBOW] == points[_L_SHOULDER]
    assert points[_L_WRIST] == points[_L_SHOULDER]


def test_near_arm_is_still_extended_forward_unchanged():
    """The single-arm fix's own qualifying pose (near arm forward) must
    survive untouched -- only the leg moves."""
    points = rig.keypoints()
    upstream = _t0380_rig.FORWARD_LIMB_KEYPOINTS_NORM
    assert points[_R_ELBOW] == upstream[_R_ELBOW]
    assert points[_R_WRIST] == upstream[_R_WRIST]


def test_near_thigh_is_close_to_vertical_not_raised():
    """This is the card's own point: the near leg must read as *resting*,
    not raised. A resting thigh hangs close to vertical (~90 degrees from
    horizontal); T-0380/T-0382's raised-leg thigh sat within 20 degrees of
    horizontal. This asserts the opposite regime, not just "different"."""
    angle = rig.thigh_angle_degrees_from_horizontal()
    assert angle > 70, f"near thigh is {angle:.1f} degrees from horizontal, still reads raised"


def test_near_thigh_is_no_longer_within_20_degrees_of_horizontal():
    """Direct regression guard against T-0380/T-0382's own raised-leg
    acceptance ceiling -- that ceiling must NOT be met here, since a raised
    leg is explicitly out of scope for this card."""
    angle = rig.thigh_angle_degrees_from_horizontal()
    assert angle >= 20


def test_near_and_far_leg_sit_close_together_like_a_resting_profile_stance():
    """side_neutral's own design: legs together, not spread by a stride --
    the near and far ankle should sit close on x, not far apart the way a
    raised/striding leg would spread them."""
    points = rig.keypoints()
    assert abs(points[_R_ANKLE][0] - points[_L_ANKLE][0]) < 0.10


def test_faces_right_same_direction_as_the_T0317_base():
    points = rig.keypoints()
    assert points[_NOSE][0] > points[_NECK][0]
    assert points[_R_SHOULDER][0] > points[_L_SHOULDER][0]


def test_shoulders_and_hips_collapse_like_a_true_profile():
    points = rig.keypoints()
    assert abs(points[_R_SHOULDER][0] - points[_L_SHOULDER][0]) < 0.03
    assert abs(points[_R_HIP][0] - points[_L_HIP][0]) < 0.03


def test_render_skeleton_reuses_the_shared_openpose_renderer():
    import inspect

    src = inspect.getsource(rig.render_skeleton)
    assert "draw_pose_skeleton_cell" in src


def test_render_skeleton_does_not_call_T0351s_render_pose_skeleton():
    import inspect

    src = inspect.getsource(rig.render_skeleton)
    assert "render_pose_skeleton" not in src


def test_render_skeleton_actually_reflects_this_cards_overrides():
    from io import BytesIO

    from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell

    expected = draw_pose_skeleton_cell(256, points_norm=rig.keypoints())
    actual = rig.render_skeleton(256)
    buf_expected, buf_actual = BytesIO(), BytesIO()
    expected.save(buf_expected, format="PNG")
    actual.save(buf_actual, format="PNG")
    assert buf_expected.getvalue() == buf_actual.getvalue()


def test_render_skeleton_differs_from_T0380s_rendered_skeleton():
    from io import BytesIO

    ours = rig.render_skeleton(256)
    theirs = _t0380_rig.render_skeleton(256)
    buf_ours, buf_theirs = BytesIO(), BytesIO()
    ours.save(buf_ours, format="PNG")
    theirs.save(buf_theirs, format="PNG")
    assert buf_ours.getvalue() != buf_theirs.getvalue()


def test_render_skeleton_size_matches_request():
    img = rig.render_skeleton(1024)
    assert img.size == (1024, 1024)


def test_render_skeleton_is_deterministic_png_bytes():
    from io import BytesIO

    img_a = rig.render_skeleton(512)
    img_b = rig.render_skeleton(512)
    buf_a, buf_b = BytesIO(), BytesIO()
    img_a.save(buf_a, format="PNG")
    img_b.save(buf_b, format="PNG")
    assert buf_a.getvalue() == buf_b.getvalue()


def test_keypoints_to_coco_list_is_sorted_by_joint():
    coco = rig.keypoints_to_coco_list()
    assert [entry["joint"] for entry in coco] == list(range(18))
