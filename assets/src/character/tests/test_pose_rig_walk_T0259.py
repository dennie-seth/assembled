"""Walk-cycle pose-rig keypoint generator -- T-0259 unit tests.

Pure logic, no ComfyUI/network dependency. `pose_rig_T0249.py`'s own 'move'
state generalisation evidence documented its own limit: it only offsets Arm
A's static standing-idle base pose with a symmetric stride, so it can drive
an idle-with-stride variant, never a true mid-stride gait (no knee lift, no
opposed arm swing, no weight-bearing/passing leg distinction). This module
(`pose_rig_walk_T0259.py`) is that missing base-pose-level walk authoring:
opposed leg swing, a knee lift on the passing (non-weight-bearing) leg,
opposite-phase arm swing, and a hip bob -- and, distinct from every prior
round-2 pose rig, is designed so the loop seam (last frame -> frame 0) falls
out of the same periodic parameterisation as every other adjacent pair,
never a special case patched in afterwards.

RED state: pose_rig_walk_T0259.py does not exist -> import fails, every
test ERRORs.
GREEN state: `walk_keypoints_for_frame` derives 18-keypoint COCO frames
deterministically, legs/arms swing in the documented phase relationships,
the gait loops exactly, and rendering reuses Arm A's drawing primitive
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
import pose_rig_walk_T0259  # noqa: E402

_R_KNEE, _R_ANKLE = 9, 10
_L_KNEE, _L_ANKLE = 12, 13
_R_WRIST, _L_WRIST = 4, 7


def test_frame_emits_18_coco_keypoints() -> None:
    points = pose_rig_walk_T0259.walk_keypoints_for_frame(0, pose_rig_walk_T0259.FRAME_COUNT)
    assert set(points.keys()) == set(range(18)), "must emit all 18 OpenPose/COCO joints"


def test_keypoints_deterministic() -> None:
    a = pose_rig_walk_T0259.walk_keypoints_for_frame(3, pose_rig_walk_T0259.FRAME_COUNT)
    b = pose_rig_walk_T0259.walk_keypoints_for_frame(3, pose_rig_walk_T0259.FRAME_COUNT)
    assert a == b, "same (frame_index, frame_count) must yield byte-identical keypoints every call"


def test_frames_vary_across_the_cycle() -> None:
    """The whole point of scripting the pose: distinct frame indices are not
    all identical -- that is the authored gait the model has no say in."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    all_points = [pose_rig_walk_T0259.walk_keypoints_for_frame(i, n) for i in range(n)]
    distinct = {tuple(sorted(p.items())) for p in all_points}
    assert len(distinct) == n, "every frame of a walk cycle must have a distinct pose"


def test_loop_seam_matches_frame_zero() -> None:
    """Acceptance: frame 8 -> frame 1 (i.e. frame_count -> 0) must read
    continuously. Because the gait model is a periodic function of
    frame_index/frame_count with period 1, frame `frame_count` is
    mathematically identical to frame 0 -- proven directly, not just
    asserted in prose."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    frame_0 = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)
    frame_n = pose_rig_walk_T0259.walk_keypoints_for_frame(n, n)
    assert frame_0 == frame_n, "the loop seam must be identical to frame 0, not merely close"


def test_legs_swing_opposite_phase() -> None:
    """Opposed arm-and-leg swing (motion spec): at a frame where one leg
    reaches its forward extreme, the other must be at (or near) its back
    extreme -- not moving the same direction."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    base = gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM

    quarter = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 4, n)
    right_dx = quarter[_R_ANKLE][0] - base[_R_ANKLE][0]
    left_dx = quarter[_L_ANKLE][0] - base[_L_ANKLE][0]
    assert right_dx * left_dx < 0, (
        f"right/left ankle x-offsets must have opposite sign at a quarter-cycle frame, "
        f"got right={right_dx}, left={left_dx}"
    )


def test_arms_swing_opposite_to_same_side_leg() -> None:
    """Motion spec: opposed arm-and-leg swing means the right arm swings
    with the LEFT leg (real-gait convention), not with the right leg."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    base = gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM
    quarter = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 4, n)

    right_arm_dx = quarter[_R_WRIST][0] - base[_R_WRIST][0]
    left_leg_dx = quarter[_L_ANKLE][0] - base[_L_ANKLE][0]
    assert right_arm_dx * left_leg_dx > 0, "right arm must swing WITH the left leg, not against it"


def test_passing_leg_lifts_off_the_ground_line() -> None:
    """Motion spec: 'a pass pose where the free leg clears' -- the leg not
    bearing weight must rise (its own knee/ankle y must move up, i.e.
    numerically smaller in this normalised-down-positive space) relative to
    a contact frame."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    contact = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)
    passing = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 4, n)
    assert passing[_R_ANKLE][1] < contact[_R_ANKLE][1], (
        "the passing leg's ankle must lift (smaller y) relative to a contact frame"
    )


def test_render_pose_frame_reuses_arm_a_renderer() -> None:
    """Acceptance: the skeleton renderer is reused from Arm A's
    draw_pose_skeleton_cell, not re-authored."""
    src = inspect.getsource(pose_rig_walk_T0259.render_pose_frame)
    assert "draw_pose_skeleton_cell" in src, (
        "render_pose_frame must delegate to gen_arm_a_idle_T0228.draw_pose_skeleton_cell"
    )


def test_render_pose_frame_is_deterministic_png_bytes() -> None:
    from io import BytesIO

    n = pose_rig_walk_T0259.FRAME_COUNT
    points = pose_rig_walk_T0259.walk_keypoints_for_frame(2, n)
    img_a = pose_rig_walk_T0259.render_pose_frame(points, 384)
    img_b = pose_rig_walk_T0259.render_pose_frame(points, 384)
    buf_a, buf_b = BytesIO(), BytesIO()
    img_a.save(buf_a, format="PNG")
    img_b.save(buf_b, format="PNG")
    assert buf_a.getvalue() == buf_b.getvalue()


def test_keypoints_to_coco_list_is_sorted_by_joint() -> None:
    n = pose_rig_walk_T0259.FRAME_COUNT
    points = pose_rig_walk_T0259.walk_keypoints_for_frame(1, n)
    coco = pose_rig_walk_T0259.keypoints_to_coco_list(points)
    assert [entry["joint"] for entry in coco] == list(range(18))
