"""T-0380 -- forward-limb ControlNet/OpenPose skeleton, pure construction
tests. No ComfyUI/network dependency.

T-0355's stop-and-report falsified the prompt-only route for this exact pose
(near arm + near leg extended ~90 degrees, strict profile): even the one
attempt that got costume/identity right twisted to three-quarter once the
pose clause competed with the identity clause for the same attention budget.
@DennieSeth's follow-up: pose must come from a skeleton, not the prompt. This
module authors that skeleton from `pose_rig_master_sheet_T0351`'s already-
committed `side_right_forward` joints -- these tests pin that it is reused
verbatim (not re-typed), that it already satisfies "front leg raised ~90
degrees at the hip, not a lunge," and that it faces the same direction (right)
as the T-0317 base image this card conditions img2img on.

RED state: pose_rig_forward_limb_controlnet_T0380 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import pose_rig_forward_limb_controlnet_T0380 as rig  # noqa: E402

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13


def test_keypoints_are_reused_verbatim_from_the_committed_T0351_rig():
    import pose_rig_master_sheet_T0351 as t0351

    assert rig.FORWARD_LIMB_KEYPOINTS_NORM == t0351.keypoints_for("side_right_forward")


def test_keypoints_emit_all_18_coco_joints():
    assert set(rig.keypoints().keys()) == set(range(18))


def test_keypoints_returns_a_copy_not_the_shared_constant():
    points = rig.keypoints()
    points[_NOSE] = (0.0, 0.0)
    assert rig.keypoints()[_NOSE] != (0.0, 0.0)


def test_near_thigh_is_within_20_degrees_of_horizontal():
    """Acceptance: 'the near thigh within ~20 degrees of horizontal (front
    leg raised ~90 degrees at the hip, not a lunge)'."""
    angle = rig.thigh_angle_degrees_from_horizontal()
    assert angle < 20, f"near thigh is {angle:.1f} degrees from horizontal, not raised"


def test_near_arm_extends_forward_and_far_arm_stays_back():
    points = rig.keypoints()
    r_arm_reach = points[_R_WRIST][0] - points[_R_SHOULDER][0]
    l_arm_reach = points[_L_WRIST][0] - points[_L_SHOULDER][0]
    assert r_arm_reach > 0.08, f"near arm must reach clearly forward, got {r_arm_reach}"
    assert abs(l_arm_reach) < abs(r_arm_reach) / 2, "far arm must stay back, near the torso"


def test_near_leg_extends_forward_and_far_leg_stays_back():
    points = rig.keypoints()
    r_leg_reach = points[_R_ANKLE][0] - points[_R_HIP][0]
    l_leg_reach = points[_L_ANKLE][0] - points[_L_HIP][0]
    assert r_leg_reach > 0.08, f"near leg must reach clearly forward, got {r_leg_reach}"
    assert l_leg_reach < r_leg_reach, "far leg must stay back, not forward"


def test_shoulders_and_hips_collapse_like_a_true_profile():
    """A genuine profile, not the three-quarter defect T-0355 hit: both
    shoulders/both hips sit on (almost) the same x, not spread bilaterally."""
    points = rig.keypoints()
    assert abs(points[_R_SHOULDER][0] - points[_L_SHOULDER][0]) < 0.03
    assert abs(points[_R_HIP][0] - points[_L_HIP][0]) < 0.03


def test_faces_right_same_direction_as_the_T0317_base():
    """The T-0317 base image this card conditions img2img on faces right; the
    skeleton must face the same way so img2img and ControlNet agree, not
    fight each other."""
    points = rig.keypoints()
    assert points[_NOSE][0] > points[_NECK][0]
    assert points[_R_SHOULDER][0] > points[_L_SHOULDER][0]


def test_render_skeleton_reuses_the_T0351_renderer():
    import inspect

    src = inspect.getsource(rig.render_skeleton)
    assert "render_pose_skeleton" in src


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
