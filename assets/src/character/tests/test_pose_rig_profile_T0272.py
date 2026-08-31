"""Side-profile base-pose keyframe pose-rig -- T-0272 unit tests.

Pure logic, no ComfyUI/network dependency. T-0259's own single-frame
feasibility probe (ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md's sibling report)
proved that reframing the FRONT-facing skeleton (`_POSE_KEYPOINTS_NORM`) with
a profile-camera prompt cannot work: ControlNet's structural conditioning
dominates the text prompt, so the model renders the front-facing topology
regardless of what the prompt asks for. This module
(`pose_rig_profile_T0272.py`) is a genuinely different keypoint layout, not a
mirrored/sheared copy of the front rig: legs collapsed onto a single fore-aft
line instead of spread side-by-side, shoulders collapsed in line with the
view axis instead of spread bilaterally, one arm reaching forward and the
other tucked back near the torso (occluded) instead of symmetric arms-at-
sides, and the head turned toward the facing direction with the far eye/ear
collapsed toward the near one instead of both visible at a fixed bilateral
spread.

This card delivers ONE still keyframe, not a cycle -- there is no
frame_index/frame_count parameterisation the way `pose_rig_walk_T0259.py`
has; `profile_keypoints()` returns a fixed pose every call.

RED state: pose_rig_profile_T0272.py does not exist -> import fails, every
test ERRORs.
GREEN state: `profile_keypoints` returns 18 COCO keypoints whose topology is
measurably different from the front rig's in exactly the ways the card's
acceptance criteria name, and rendering reuses Arm A's drawing primitive
unchanged.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_arm_a_idle_T0228  # noqa: E402
import pose_rig_profile_T0272  # noqa: E402

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

_FRONT = gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM


def _spread(points: dict[int, tuple[float, float]], a: int, b: int) -> float:
    return abs(points[a][0] - points[b][0])


def test_frame_emits_18_coco_keypoints() -> None:
    points = pose_rig_profile_T0272.profile_keypoints()
    assert set(points.keys()) == set(range(18)), "must emit all 18 OpenPose/COCO joints"


def test_keypoints_deterministic() -> None:
    a = pose_rig_profile_T0272.profile_keypoints()
    b = pose_rig_profile_T0272.profile_keypoints()
    assert a == b, "profile_keypoints() must return byte-identical keypoints every call"


def test_keypoints_returns_a_copy_not_the_shared_constant() -> None:
    """Callers must not be able to corrupt the module's own committed rig by
    mutating what they were handed."""
    points = pose_rig_profile_T0272.profile_keypoints()
    points[_NOSE] = (0.0, 0.0)
    assert pose_rig_profile_T0272.profile_keypoints()[_NOSE] != (0.0, 0.0)


def test_facing_direction_is_recorded() -> None:
    """Acceptance: 'record it in the sidecar, so downstream animation mirrors
    deliberately rather than guessing' -- the module itself names the one
    canonical facing it authored."""
    assert pose_rig_profile_T0272.FACING in ("left", "right")


def test_legs_collapse_onto_a_single_fore_aft_line() -> None:
    """Acceptance: 'legs on a single fore-aft line rather than side-by-side'.
    The front rig spreads both legs bilaterally across the frame (hip/knee/
    ankle all separated by a wide, roughly constant x-gap); a genuine profile
    topology instead keeps both legs close to one shared vertical line, since
    the left/right split of the front view is not visible from the side."""
    points = pose_rig_profile_T0272.profile_keypoints()
    for hip, knee, ankle in ((_R_HIP, _R_KNEE, _R_ANKLE), (_L_HIP, _L_KNEE, _L_ANKLE)):
        assert hip in points and knee in points and ankle in points

    front_hip_spread = _spread(_FRONT, _R_HIP, _L_HIP)
    front_knee_spread = _spread(_FRONT, _R_KNEE, _L_KNEE)
    profile_hip_spread = _spread(points, _R_HIP, _L_HIP)
    profile_knee_spread = _spread(points, _R_KNEE, _L_KNEE)

    assert profile_hip_spread < front_hip_spread / 2, (
        f"profile hip spread {profile_hip_spread} is not meaningfully collapsed vs "
        f"front rig's {front_hip_spread} -- looks side-by-side, not fore-aft"
    )
    assert profile_knee_spread < front_knee_spread / 2, (
        f"profile knee spread {profile_knee_spread} is not meaningfully collapsed vs "
        f"front rig's {front_knee_spread} -- looks side-by-side, not fore-aft"
    )


def test_shoulders_in_line_with_the_view_axis() -> None:
    """Acceptance: 'shoulders in line with the view axis'. The front rig
    spreads shoulders bilaterally (this is most of its total silhouette
    width); a profile view sees shoulder WIDTH as depth, not as an x-gap."""
    points = pose_rig_profile_T0272.profile_keypoints()
    front_shoulder_spread = _spread(_FRONT, _R_SHOULDER, _L_SHOULDER)
    profile_shoulder_spread = _spread(points, _R_SHOULDER, _L_SHOULDER)
    assert profile_shoulder_spread < front_shoulder_spread / 2, (
        f"profile shoulder spread {profile_shoulder_spread} is not meaningfully collapsed "
        f"vs front rig's {front_shoulder_spread}"
    )


def test_one_arm_forward_one_arm_back_not_symmetric() -> None:
    """Acceptance: 'one arm forward, one back (the far arm partially
    occluded), not symmetric about the spine' -- unlike the front rig's
    arms-at-sides pose (both wrists roughly under their own shoulder), one
    profile arm must reach clearly forward of its shoulder and the other must
    stay close to the torso (a much smaller offset), and the two offsets must
    not be a mirrored +/-x pair."""
    points = pose_rig_profile_T0272.profile_keypoints()
    near_reach = points[_R_WRIST][0] - points[_R_SHOULDER][0]
    far_reach = points[_L_WRIST][0] - points[_L_SHOULDER][0]

    assert near_reach > 0.05, f"near (forward) arm must reach clearly forward, got {near_reach}"
    assert abs(far_reach) < abs(near_reach) / 2, (
        f"far (back) arm must stay close to the torso (occluded), got offset {far_reach} vs "
        f"near arm's {near_reach}"
    )
    assert near_reach != -far_reach, "arms must not be a mirrored +/-x pair (that is the front rig)"


def test_head_turned_sideways() -> None:
    """Acceptance: 'head turned sideways' -- the nose must sit clearly off
    the neck's own x position (turned toward the facing direction), and the
    far eye/ear must collapse toward the near eye/ear (both visible at a
    fixed bilateral spread is the front rig's own topology, not a profile
    one)."""
    points = pose_rig_profile_T0272.profile_keypoints()
    nose_offset = points[_NOSE][0] - points[_NECK][0]
    assert abs(nose_offset) > 0.03, f"nose must be turned off the neck's x position, got {nose_offset}"

    front_eye_spread = _spread(_FRONT, _R_EYE, _L_EYE)
    front_ear_spread = _spread(_FRONT, _R_EAR, _L_EAR)
    profile_eye_spread = _spread(points, _R_EYE, _L_EYE)
    profile_ear_spread = _spread(points, _R_EAR, _L_EAR)

    assert profile_eye_spread < front_eye_spread, "far eye must collapse toward the near eye"
    assert profile_ear_spread < front_ear_spread, "far ear must collapse toward the near ear"


def test_render_pose_frame_reuses_arm_a_renderer() -> None:
    """Acceptance: the skeleton renderer is reused from Arm A's
    draw_pose_skeleton_cell, not re-authored."""
    src = inspect.getsource(pose_rig_profile_T0272.render_pose_frame)
    assert "draw_pose_skeleton_cell" in src, (
        "render_pose_frame must delegate to gen_arm_a_idle_T0228.draw_pose_skeleton_cell"
    )


def test_render_pose_frame_is_deterministic_png_bytes() -> None:
    from io import BytesIO

    points = pose_rig_profile_T0272.profile_keypoints()
    img_a = pose_rig_profile_T0272.render_pose_frame(points, 384)
    img_b = pose_rig_profile_T0272.render_pose_frame(points, 384)
    buf_a, buf_b = BytesIO(), BytesIO()
    img_a.save(buf_a, format="PNG")
    img_b.save(buf_b, format="PNG")
    assert buf_a.getvalue() == buf_b.getvalue()


def test_keypoints_to_coco_list_is_sorted_by_joint() -> None:
    points = pose_rig_profile_T0272.profile_keypoints()
    coco = pose_rig_profile_T0272.keypoints_to_coco_list(points)
    assert [entry["joint"] for entry in coco] == list(range(18))
