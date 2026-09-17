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


def test_near_limbs_and_torso_are_reused_verbatim_from_the_committed_T0351_rig():
    """Every joint this card's acceptance criteria actually depend on -- the
    near arm/leg raise, the profile-collapsed shoulders/hips, the head/face
    joints, the far leg -- is reused verbatim from T-0351, unmodified. Only
    the far arm's elbow/wrist are card-specific overrides (see the collapse
    test below) -- attempt 2's evidence showed reusing them verbatim too
    renders a second, visible far hand."""
    import pose_rig_master_sheet_T0351 as t0351

    upstream = t0351.keypoints_for("side_right_forward")
    ours = rig.FORWARD_LIMB_KEYPOINTS_NORM
    overridden = {_L_ELBOW, _L_WRIST}
    for joint in set(upstream) - overridden:
        assert ours[joint] == upstream[joint], f"joint {joint} drifted from the committed T0351 rig"
    assert ours[_L_ELBOW] != upstream[_L_ELBOW], "far elbow must be overridden to collapse it hidden"
    assert ours[_L_WRIST] != upstream[_L_WRIST], "far wrist must be overridden to collapse it hidden"


def test_far_arm_is_collapsed_hidden_behind_the_far_shoulder():
    """Attempt 2 (docs/assets/evidence/T-0380/attempt_2_main_1024.png) reused
    T-0351's far arm verbatim -- 'held back close to the body' for a
    multi-panel walk-cycle sheet, but still offset far enough from the torso
    (elbow/wrist projected out past the hip) that img2img rendered it as a
    second, unrequested visible hand/glove at the hip. That is exactly the
    'far fist visible' defect T-0355 already falsified the prompt-only route
    over. Fix: collapse the far elbow/wrist onto the far shoulder for this
    card's skeleton specifically -- a zero-length limb, the same 'collapsed
    onto the view axis' principle already applied to the shoulders/hips in a
    true profile -- so the ControlNet conditioning gives the sampler no
    joint to hang a second hand on."""
    points = rig.keypoints()
    assert points[_L_ELBOW] == points[_L_SHOULDER]
    assert points[_L_WRIST] == points[_L_SHOULDER]


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


def test_render_skeleton_reuses_the_shared_openpose_renderer():
    import inspect

    src = inspect.getsource(rig.render_skeleton)
    assert "draw_pose_skeleton_cell" in src


def test_render_skeleton_does_not_call_T0351s_render_pose_skeleton():
    """Regression for the attempt-3 bug: `_T0351.render_pose_skeleton`
    re-derives keypoints from T-0351's own module and would silently
    discard this module's far-arm collapse override (see module
    docstring) -- `render_skeleton` must draw this module's own
    `keypoints()` instead."""
    import inspect

    src = inspect.getsource(rig.render_skeleton)
    assert "render_pose_skeleton" not in src


def test_render_skeleton_actually_reflects_the_far_arm_collapse():
    """Pins the fix directly at the pixel level: rendering this module's
    keypoints must produce bit-identical output to drawing `keypoints()`
    directly -- i.e. `render_skeleton` cannot silently substitute some
    other (un-collapsed) point set, the exact way it did before this
    module imported `draw_pose_skeleton_cell` itself."""
    from io import BytesIO

    from gen_arm_a_idle_T0228 import draw_pose_skeleton_cell

    expected = draw_pose_skeleton_cell(256, points_norm=rig.keypoints())
    actual = rig.render_skeleton(256)
    buf_expected, buf_actual = BytesIO(), BytesIO()
    expected.save(buf_expected, format="PNG")
    actual.save(buf_actual, format="PNG")
    assert buf_expected.getvalue() == buf_actual.getvalue()


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
