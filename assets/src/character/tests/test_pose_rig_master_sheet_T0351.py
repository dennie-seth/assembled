"""Five-pose ControlNet skeleton rig for the Tier-1 master sheet -- T-0351.

Prompt-only pose control failed across 7 attempts (see
ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md, docs/assets/evidence/T-0351/README.md);
@DennieSeth's 2026-09-10 amendment permits ControlNet/OpenPose for pose
conditioning only, direction: "author an OpenPose skeleton per pose ...
reuse the existing pose rigs' joint output ... if practical." This module is
that authored rig -- five distinct 18-keypoint COCO/OpenPose layouts, one per
`gen_master_sheet_T0336.POSE_SPECS` entry, built the same way
`pose_rig_profile_T0272.py` was (a genuinely different topology per pose, not
a distorted copy of the front-facing idle rig).

RED state: pose_rig_master_sheet_T0351.py does not exist -> import fails,
every test ERRORs.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_arm_a_idle_T0228  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402

_NOSE, _NECK = 0, 1
_R_SHOULDER, _R_ELBOW, _R_WRIST = 2, 3, 4
_L_SHOULDER, _L_ELBOW, _L_WRIST = 5, 6, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13
_R_EYE, _L_EYE = 14, 15
_R_EAR, _L_EAR = 16, 17

_FRONT_IDLE = gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM

# Must match gen_master_sheet_T0336.POSE_SPECS keys exactly, in order.
POSE_KEYS = (
    "front_tpose",
    "back_tpose",
    "side_left_forward",
    "side_right_forward",
    "side_neutral",
)


def _spread(points: dict[int, tuple[float, float]], a: int, b: int) -> float:
    return abs(points[a][0] - points[b][0])


def test_pose_keys_match_the_cards_five_pose_specs() -> None:
    import gen_master_sheet_T0336 as gms

    assert [p.key for p in gms.POSE_SPECS] == list(POSE_KEYS)
    assert set(rig.POSE_KEYPOINTS_BY_KEY) == set(POSE_KEYS)


def test_every_pose_emits_18_coco_keypoints() -> None:
    for key in POSE_KEYS:
        points = rig.keypoints_for(key)
        assert set(points.keys()) == set(range(18)), f"{key} must emit all 18 joints"


def test_keypoints_deterministic() -> None:
    for key in POSE_KEYS:
        assert rig.keypoints_for(key) == rig.keypoints_for(key)


def test_keypoints_for_returns_a_copy_not_the_shared_constant() -> None:
    points = rig.keypoints_for("front_tpose")
    points[_NOSE] = (0.0, 0.0)
    assert rig.keypoints_for("front_tpose")[_NOSE] != (0.0, 0.0)


def test_all_coordinates_stay_within_the_unit_square() -> None:
    for key in POSE_KEYS:
        for x, y in rig.keypoints_for(key).values():
            assert 0.0 <= x <= 1.0, f"{key} joint x {x} out of [0,1]"
            assert 0.0 <= y <= 1.0, f"{key} joint y {y} out of [0,1]"


def test_front_tpose_arms_are_horizontal_and_clear_of_torso() -> None:
    """T-pose: both wrists at roughly shoulder height, extended far out in x."""
    points = rig.keypoints_for("front_tpose")
    r_shoulder_y = points[_R_SHOULDER][1]
    l_shoulder_y = points[_L_SHOULDER][1]
    assert abs(points[_R_WRIST][1] - r_shoulder_y) < 0.03
    assert abs(points[_L_WRIST][1] - l_shoulder_y) < 0.03

    idle_r_reach = _FRONT_IDLE[_R_SHOULDER][0] - _FRONT_IDLE[_R_WRIST][0]
    idle_l_reach = _FRONT_IDLE[_L_WRIST][0] - _FRONT_IDLE[_L_SHOULDER][0]
    tpose_r_reach = points[_R_SHOULDER][0] - points[_R_WRIST][0]
    tpose_l_reach = points[_L_WRIST][0] - points[_L_SHOULDER][0]
    assert tpose_r_reach > idle_r_reach * 1.5, "right arm must extend well past the idle pose"
    assert tpose_l_reach > idle_l_reach * 1.5, "left arm must extend well past the idle pose"


def test_front_tpose_legs_are_spread_wider_than_idle() -> None:
    points = rig.keypoints_for("front_tpose")
    idle_ankle_spread = _spread(_FRONT_IDLE, _R_ANKLE, _L_ANKLE)
    tpose_ankle_spread = _spread(points, _R_ANKLE, _L_ANKLE)
    assert tpose_ankle_spread > idle_ankle_spread * 1.3, (
        f"T-pose ankle spread {tpose_ankle_spread} is not meaningfully wider than idle's "
        f"{idle_ankle_spread}"
    )


def test_back_tpose_is_the_mirror_of_front_tpose() -> None:
    """Front and back T-pose are bilaterally symmetric, so the anatomically
    correct back-view rig (mirroring L/R labels for a figure turned around)
    lands on the same pixel positions as the front rig -- see
    `mirror_keypoints_lr`'s own docstring. This pins that the two were
    derived from the same transform, not independently typo'd numbers."""
    front = rig.keypoints_for("front_tpose")
    back = rig.keypoints_for("back_tpose")
    mirrored_front = rig.mirror_keypoints_lr(front)
    for j in range(18):
        assert abs(mirrored_front[j][0] - back[j][0]) < 1e-9
        assert abs(mirrored_front[j][1] - back[j][1]) < 1e-9


def test_side_panels_collapse_shoulder_and_hip_spread_like_a_true_profile() -> None:
    """The exact #365 defect this card exists to fix: a three-quarter view
    still shows both shoulders/hips spread bilaterally. A true profile
    collapses that spread onto a single line, same check T-0272's rig uses."""
    front_shoulder_spread = _spread(_FRONT_IDLE, _R_SHOULDER, _L_SHOULDER)
    front_hip_spread = _spread(_FRONT_IDLE, _R_HIP, _L_HIP)
    for key in ("side_left_forward", "side_right_forward", "side_neutral"):
        points = rig.keypoints_for(key)
        assert _spread(points, _R_SHOULDER, _L_SHOULDER) < front_shoulder_spread / 2, key
        assert _spread(points, _R_HIP, _L_HIP) < front_hip_spread / 2, key


def test_side_right_forward_only_the_right_arm_and_leg_extend_forward() -> None:
    points = rig.keypoints_for("side_right_forward")
    r_arm_reach = points[_R_WRIST][0] - points[_R_SHOULDER][0]
    l_arm_reach = points[_L_WRIST][0] - points[_L_SHOULDER][0]
    r_leg_reach = points[_R_ANKLE][0] - points[_R_HIP][0]
    l_leg_reach = points[_L_ANKLE][0] - points[_L_HIP][0]

    assert abs(r_arm_reach) > 0.08, f"right arm must reach clearly forward, got {r_arm_reach}"
    assert abs(l_arm_reach) < abs(r_arm_reach) / 2, "left arm must stay back, near the torso"
    assert abs(r_leg_reach) > 0.08, f"right leg must reach clearly forward, got {r_leg_reach}"
    assert abs(l_leg_reach) < abs(r_leg_reach), "left leg must stay back, not forward"


def test_side_left_forward_only_the_left_arm_and_leg_extend_forward() -> None:
    points = rig.keypoints_for("side_left_forward")
    r_arm_reach = points[_R_WRIST][0] - points[_R_SHOULDER][0]
    l_arm_reach = points[_L_WRIST][0] - points[_L_SHOULDER][0]
    r_leg_reach = points[_R_ANKLE][0] - points[_R_HIP][0]
    l_leg_reach = points[_L_ANKLE][0] - points[_L_HIP][0]

    assert abs(l_arm_reach) > 0.08, f"left arm must reach clearly forward, got {l_arm_reach}"
    assert abs(r_arm_reach) < abs(l_arm_reach) / 2, "right arm must stay back, near the torso"
    assert abs(l_leg_reach) > 0.08, f"left leg must reach clearly forward, got {l_leg_reach}"
    assert abs(r_leg_reach) < abs(l_leg_reach), "right leg must stay back, not forward"


def test_side_left_forward_is_the_mirror_of_side_right_forward() -> None:
    right_fwd = rig.keypoints_for("side_right_forward")
    left_fwd = rig.keypoints_for("side_left_forward")
    mirrored = rig.mirror_keypoints_lr(right_fwd)
    for j in range(18):
        assert abs(mirrored[j][0] - left_fwd[j][0]) < 1e-9
        assert abs(mirrored[j][1] - left_fwd[j][1]) < 1e-9


def test_side_neutral_arms_hang_down_not_forward() -> None:
    points = rig.keypoints_for("side_neutral")
    arm_triples = ((_R_SHOULDER, _R_ELBOW, _R_WRIST), (_L_SHOULDER, _L_ELBOW, _L_WRIST))
    for shoulder, elbow, wrist in arm_triples:
        assert points[wrist][1] > points[elbow][1] > points[shoulder][1], (
            "each arm must hang downward: wrist below elbow below shoulder"
        )
        assert abs(points[wrist][0] - points[shoulder][0]) < 0.06, (
            "a hanging arm must stay close to the shoulder's x position, not reach forward"
        )


def test_side_neutral_legs_are_together_not_staggered() -> None:
    """Acceptance: 'both legs together standing upright' -- unlike panels
    3/4's walking stagger, the near/far ankle must sit close together, not
    one forward and one back."""
    points = rig.keypoints_for("side_neutral")
    walking_points = rig.keypoints_for("side_right_forward")
    neutral_ankle_gap = _spread(points, _R_ANKLE, _L_ANKLE)
    walking_ankle_gap = _spread(walking_points, _R_ANKLE, _L_ANKLE)
    assert neutral_ankle_gap < walking_ankle_gap / 2, (
        f"side-neutral ankle gap {neutral_ankle_gap} is not meaningfully together vs "
        f"the walking pose's {walking_ankle_gap}"
    )


def test_side_panels_head_turned_toward_the_facing_direction() -> None:
    for key in ("side_left_forward", "side_right_forward", "side_neutral"):
        points = rig.keypoints_for(key)
        assert abs(points[_NOSE][0] - points[_NECK][0]) > 0.03, key


def test_render_pose_skeleton_reuses_arm_a_renderer() -> None:
    src = inspect.getsource(rig.render_pose_skeleton)
    assert "draw_pose_skeleton_cell" in src


def test_render_pose_skeleton_is_deterministic_png_bytes() -> None:
    from io import BytesIO

    img_a = rig.render_pose_skeleton("side_neutral", 512)
    img_b = rig.render_pose_skeleton("side_neutral", 512)
    buf_a, buf_b = BytesIO(), BytesIO()
    img_a.save(buf_a, format="PNG")
    img_b.save(buf_b, format="PNG")
    assert buf_a.getvalue() == buf_b.getvalue()


def test_render_pose_skeleton_size_matches_request() -> None:
    img = rig.render_pose_skeleton("front_tpose", 1024)
    assert img.size == (1024, 1024)


def test_keypoints_to_coco_list_is_sorted_by_joint() -> None:
    points = rig.keypoints_for("front_tpose")
    coco = rig.keypoints_to_coco_list(points)
    assert [entry["joint"] for entry in coco] == list(range(18))


def test_mirror_keypoints_lr_swaps_left_and_right_labels() -> None:
    points = {i: (0.1 * i, 0.2 * i) for i in range(18)}
    mirrored = rig.mirror_keypoints_lr(points)
    assert mirrored[_L_SHOULDER] == (1.0 - points[_R_SHOULDER][0], points[_R_SHOULDER][1])
    assert mirrored[_R_SHOULDER] == (1.0 - points[_L_SHOULDER][0], points[_L_SHOULDER][1])
    assert mirrored[_NOSE] == (1.0 - points[_NOSE][0], points[_NOSE][1])
