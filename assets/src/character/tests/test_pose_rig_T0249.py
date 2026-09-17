"""Pose-rig keypoint generator -- T-0249 (HANDOFF §24-b / §24.4) unit tests.

Pure logic, no ComfyUI/network dependency: covers keypoint math (breathing,
weight-shift, stride), determinism, directability (animation parameters are
editable numbers, not baked constants), and reuse of Arm A's OpenPose-format
18-keypoint COCO renderer (gen_arm_a_idle_T0228.draw_pose_skeleton_cell) --
see pose_rig_T0249.py's module docstring for the design this implements
(HANDOFF §24.4 "the script becomes the pose authority": the script owns
keypoints, frame count, timing and the animation curve; the model owns
silhouette/costume/shading/texture).

RED state: pose_rig_T0249.py does not exist -> both importorskip calls fail
to import (the module import raises, not "module missing"), every test
ERRORs.
GREEN state: rig loads assets/src/character/pose_rig_T0249.json, derives
18-keypoint COCO frames deterministically from committed numeric
parameters, and renders them via the reused Arm A drawing primitives.
"""

from __future__ import annotations

import inspect
import sys
from io import BytesIO
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_arm_a_idle_T0228  # noqa: E402
import pose_rig_T0249  # noqa: E402

RIG_PATH = _CHARACTER_DIR / "pose_rig_T0249.json"


@pytest.fixture(scope="module")
def rig() -> dict:
    assert RIG_PATH.exists(), f"committed rig parameters not found: {RIG_PATH}"
    return pose_rig_T0249.load_rig(RIG_PATH)


def test_rig_has_idle_and_move_states(rig: dict) -> None:
    """Acceptance: 'the rig generalises' -- at minimum idle and one other
    state (move) share the same generator, driven by different committed
    numbers."""
    assert "idle" in rig["states"]
    assert "move" in rig["states"]


@pytest.mark.parametrize("state_name", ["idle", "move"])
def test_frame_emits_18_coco_keypoints(rig: dict, state_name: str) -> None:
    state = rig["states"][state_name]
    points = pose_rig_T0249.keypoints_for_frame(
        state, frame_index=0, frame_count=state["frame_count"]
    )
    assert set(points.keys()) == set(range(18)), "must emit all 18 OpenPose/COCO joints"


def test_keypoints_deterministic(rig: dict) -> None:
    state = rig["states"]["idle"]
    a = pose_rig_T0249.keypoints_for_frame(state, frame_index=3, frame_count=9)
    b = pose_rig_T0249.keypoints_for_frame(state, frame_index=3, frame_count=9)
    assert a == b, "same (state, frame_index) must yield byte-identical keypoints every call"


def test_frames_vary_across_the_idle_cycle(rig: dict) -> None:
    """The whole point of scripting the pose: distinct frame indices are not
    all identical (that's the authored motion the model has no say in)."""
    state = rig["states"]["idle"]
    frame_count = state["frame_count"]
    all_points = [
        pose_rig_T0249.keypoints_for_frame(state, i, frame_count) for i in range(frame_count)
    ]
    distinct = {tuple(sorted(p.items())) for p in all_points}
    assert len(distinct) > 1, (
        "every frame produced identical keypoints -- breathing/weight-shift parameters "
        "are not actually doing anything"
    )


def test_breathing_amplitude_is_directable(rig: dict) -> None:
    """Acceptance: breathing amplitude etc. must be editable numbers in the
    committed file, not constants buried in code -- prove it by doubling the
    amplitude and checking the resulting displacement exactly doubles."""
    state = rig["states"]["idle"]
    frame_count = state["frame_count"]
    frame_index = 2  # non-zero phase within the cycle

    base_points = pose_rig_T0249.keypoints_for_frame(state, frame_index, frame_count)
    doubled_state = {**state, "breathing_amplitude_norm": state["breathing_amplitude_norm"] * 2}
    doubled_points = pose_rig_T0249.keypoints_for_frame(doubled_state, frame_index, frame_count)

    rest_y = pose_rig_T0249._POSE_KEYPOINTS_NORM[0][1]  # nose
    base_dy = base_points[0][1] - rest_y
    doubled_dy = doubled_points[0][1] - rest_y
    assert base_dy != 0, "breathing must move the nose keypoint away from rest at frame 2"
    assert doubled_dy == pytest.approx(base_dy * 2)


def test_weight_shift_extent_is_directable(rig: dict) -> None:
    state = rig["states"]["idle"]
    frame_count = state["frame_count"]
    frame_index = 2

    base_points = pose_rig_T0249.keypoints_for_frame(state, frame_index, frame_count)
    doubled_state = {**state, "weight_shift_extent_norm": state["weight_shift_extent_norm"] * 2}
    doubled_points = pose_rig_T0249.keypoints_for_frame(doubled_state, frame_index, frame_count)

    rest_x = pose_rig_T0249._POSE_KEYPOINTS_NORM[8][0]  # right hip
    base_dx = base_points[8][0] - rest_x
    doubled_dx = doubled_points[8][0] - rest_x
    assert base_dx != 0, "weight-shift must move the right-hip keypoint away from rest at frame 2"
    assert doubled_dx == pytest.approx(base_dx * 2)


def test_move_state_adds_stride_not_present_in_idle(rig: dict) -> None:
    """Generalisation evidence: move's rig config drives leg keypoints idle's
    does not (stride), proving the same generator produces a materially
    different motion for a different state, not a relabelled idle cycle."""
    idle = rig["states"]["idle"]
    move = rig["states"]["move"]
    assert move.get("stride_extent_norm", 0.0) > 0.0
    assert idle.get("stride_extent_norm", 0.0) == 0.0

    idle_points = pose_rig_T0249.keypoints_for_frame(idle, 2, idle["frame_count"])
    move_points = pose_rig_T0249.keypoints_for_frame(move, 2, move["frame_count"])
    assert idle_points[9] != move_points[9], "move must actually move the right knee (stride)"


def test_render_pose_frame_reuses_arm_a_renderer() -> None:
    """Acceptance: reused from Arm A's draw_pose_skeleton_cell, not
    re-authored -- assert the T-0249 renderer delegates to that exact
    function (parametrised on points) instead of a parallel reimplementation."""
    src = inspect.getsource(pose_rig_T0249.render_pose_frame)
    assert "draw_pose_skeleton_cell" in src, (
        "render_pose_frame must delegate to gen_arm_a_idle_T0228.draw_pose_skeleton_cell, "
        "per HANDOFF §24.4 ('reuse it rather than authoring another one')"
    )


def test_draw_pose_skeleton_cell_default_unchanged() -> None:
    """The backward-compatible edit to Arm A's renderer (optional
    points_norm) must not change any existing caller's output."""
    size = 64
    default_image = gen_arm_a_idle_T0228.draw_pose_skeleton_cell(size)
    explicit_image = gen_arm_a_idle_T0228.draw_pose_skeleton_cell(
        size, points_norm=gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM
    )
    assert list(default_image.getdata()) == list(explicit_image.getdata())


def test_render_pose_frame_is_deterministic_png_bytes(rig: dict) -> None:
    state = rig["states"]["idle"]
    points = pose_rig_T0249.keypoints_for_frame(state, 4, state["frame_count"])
    img_a = pose_rig_T0249.render_pose_frame(points, 384)
    img_b = pose_rig_T0249.render_pose_frame(points, 384)
    buf_a, buf_b = BytesIO(), BytesIO()
    img_a.save(buf_a, format="PNG")
    img_b.save(buf_b, format="PNG")
    assert buf_a.getvalue() == buf_b.getvalue()
