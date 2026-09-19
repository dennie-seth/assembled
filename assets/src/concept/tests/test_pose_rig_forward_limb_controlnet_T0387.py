"""T-0387 -- forward-limb ControlNet/OpenPose skeleton, pure construction
tests. No ComfyUI/network dependency (mirrors
test_pose_rig_forward_limb_controlnet_T0380.py's own pattern).

T-0382's stop-and-report (`docs/assets/evidence/T-0382/README.md`) measured
denoise 0.87 against the corrected (far-arm-collapsed) T-0380/T-0382 rig and
found the near-leg raise -- already satisfying "thigh <20 degrees from
horizontal" per T-0380's own test -- too small in on-canvas amplitude
(knee only ~0.11 of frame width forward of the hip, ~0.01 higher) to read
as a break in the coat's silhouette at either denoise tested (attempt 1
"legs flat" at 0.87; attempt 3 "both feet together at rest" at 0.80). It
also measured the head cluster's two eye joints sitting only ~0.02 apart on
x -- almost coincident -- which this card's own reasoning ties to attempt
1's back/three-quarter drift and no visible lens: too weak an asymmetric
signal for the sampler to commit to a strict one-eye-visible profile head.

This module keeps every joint from `pose_rig_forward_limb_controlnet_T0380`
(far arm already collapsed) verbatim except two overrides:

  - the near (right) knee/ankle pushed further forward and the knee lifted
    higher, while keeping the thigh angle under this card's inherited
    20-degree ceiling
  - the eye pair separated much further apart on x: the near (right) eye
    pulled toward the nose, the far (left) eye pulled back toward the far
    ear

RED state: pose_rig_forward_limb_controlnet_T0387 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import pose_rig_forward_limb_controlnet_T0380 as _t0382_rig  # noqa: E402
import pose_rig_forward_limb_controlnet_T0387 as rig  # noqa: E402

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

_OVERRIDDEN = {_R_KNEE, _R_ANKLE, _R_EYE, _L_EYE}


def test_only_the_knee_ankle_and_eye_joints_are_overridden_from_T0382():
    """Every joint this card does not touch -- including the far-arm
    collapse T-0382 already fixed -- stays reused verbatim; only the near
    knee/ankle (leg amplitude) and both eyes (head asymmetry) move."""
    upstream = _t0382_rig.FORWARD_LIMB_KEYPOINTS_NORM
    ours = rig.FORWARD_LIMB_KEYPOINTS_NORM
    for joint in set(upstream) - _OVERRIDDEN:
        assert ours[joint] == upstream[joint], f"joint {joint} drifted from T-0382's rig"
    for joint in _OVERRIDDEN:
        assert ours[joint] != upstream[joint], f"joint {joint} was expected to be overridden"


def test_keypoints_emit_all_18_coco_joints():
    assert set(rig.keypoints().keys()) == set(range(18))


def test_keypoints_returns_a_copy_not_the_shared_constant():
    points = rig.keypoints()
    points[_NOSE] = (0.0, 0.0)
    assert rig.keypoints()[_NOSE] != (0.0, 0.0)


def test_far_arm_is_still_collapsed_hidden_behind_the_far_shoulder():
    """T-0382's own fix must survive untouched -- this card does not
    reopen the second-hand defect."""
    points = rig.keypoints()
    assert points[_L_ELBOW] == points[_L_SHOULDER]
    assert points[_L_WRIST] == points[_L_SHOULDER]


def test_near_thigh_is_within_20_degrees_of_horizontal():
    """Acceptance ceiling inherited from T-0380/T-0382: 'the near thigh
    within ~20 degrees of horizontal (front leg raised ~90 degrees at the
    hip, not a lunge)'."""
    angle = rig.thigh_angle_degrees_from_horizontal()
    assert angle < 20, f"near thigh is {angle:.1f} degrees from horizontal, not raised"


def test_near_knee_reach_is_substantially_larger_than_T0382s_rig():
    """The measured defect: T-0382's own knee reach (~0.11 of frame width,
    ~0.01 of frame height) was too small an amplitude for the sampler to
    render as a visible break in the coat -- this pins the fix at a
    concrete, much larger on-canvas excursion, not just a same-magnitude
    number that happens to differ."""
    upstream = _t0382_rig.FORWARD_LIMB_KEYPOINTS_NORM
    hip_x, hip_y = rig.FORWARD_LIMB_KEYPOINTS_NORM[_R_HIP]
    old_knee_x, old_knee_y = upstream[_R_KNEE]
    new_knee_x, new_knee_y = rig.FORWARD_LIMB_KEYPOINTS_NORM[_R_KNEE]

    old_dx, old_dy = old_knee_x - hip_x, hip_y - old_knee_y
    new_dx, new_dy = new_knee_x - hip_x, hip_y - new_knee_y

    assert new_dx > old_dx * 1.3, "knee's forward reach must clearly grow, not just shift"
    assert new_dy > old_dy * 2.0, "knee's upward lift must clearly grow, not just shift"


def test_near_ankle_stays_forward_of_knee_and_off_the_ground():
    points = rig.keypoints()
    knee_x, _ = points[_R_KNEE]
    ankle_x, ankle_y = points[_R_ANKLE]
    far_ankle_y = points[_L_ANKLE][1]
    assert ankle_x > knee_x, "shin must continue forward from the raised knee, not fold back"
    assert ankle_y < far_ankle_y - 0.1, "raised foot must sit well clear of the standing foot's ground line"


def test_eye_pair_separation_is_much_wider_than_T0382s_rig():
    """The measured defect: T-0382's own eye pair sat only ~0.02 apart on
    x, almost coincident -- too weak an asymmetric signal to anchor a
    strict one-eye-visible profile head. This pins a clearly wider gap."""
    upstream = _t0382_rig.FORWARD_LIMB_KEYPOINTS_NORM
    old_gap = abs(upstream[_R_EYE][0] - upstream[_L_EYE][0])
    new_gap = abs(rig.FORWARD_LIMB_KEYPOINTS_NORM[_R_EYE][0] - rig.FORWARD_LIMB_KEYPOINTS_NORM[_L_EYE][0])
    assert new_gap > old_gap * 2.5, "eye separation must clearly widen, not just shift"


def test_near_eye_sits_close_to_the_nose_far_eye_sits_close_to_the_far_ear():
    """The near eye anchors the visible goggle lens near the forward-most
    facial point (the nose); the far eye tucks back near the far ear,
    reading as hidden behind the head in profile."""
    points = rig.keypoints()
    nose_x = points[_NOSE][0]
    far_ear_x = points[_L_EAR][0]
    r_eye_x = points[_R_EYE][0]
    l_eye_x = points[_L_EYE][0]
    assert abs(r_eye_x - nose_x) < 0.02
    assert abs(l_eye_x - far_ear_x) < 0.02


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


def test_render_skeleton_differs_from_T0382s_rendered_skeleton():
    from io import BytesIO

    ours = rig.render_skeleton(256)
    theirs = _t0382_rig.render_skeleton(256)
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
