#!/usr/bin/env python3
"""Deterministic pose-rig keypoint generator (T-0249, HANDOFF §24-b / §24.4).

§24.4 reframes §24-b: "the script becomes the pose authority" -- the script
emits a deterministic OpenPose-format 18-keypoint COCO skeleton per frame and
owns keypoints, frame count, timing and the animation curve; the model is
given no say in the pose (it owns silhouette, costume, shading, texture
only). This module is the "script" half of that division of labour:

  - `load_rig` reads the committed, editable numeric parameters
    (`pose_rig_T0249.json`) -- breathing amplitude, weight-shift extent,
    stride extent, cycle counts, easing -- so redirecting the animation is
    an edit to that file, not a re-roll of a seed.
  - `keypoints_for_frame` derives a full 18-keypoint frame from those
    parameters plus a frame index, starting from Arm A's static standing-idle
    base pose (`gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`) and offsetting
    the joints breathing/weight-shift/stride actually move.
  - `render_pose_frame` draws that frame. It does NOT re-implement drawing:
    it reuses `gen_arm_a_idle_T0228.draw_pose_skeleton_cell` (widened with an
    optional `points_norm` parameter, backward compatible with every existing
    caller) directly, per the acceptance criterion "the skeleton renderer is
    reused from Arm A's attempt-2 draw_pose_skeleton_cell PIL path, not
    re-authored."

There is no DWPose/OpenPose *preprocessor* installed on the ComfyUI host
(T-0218's finding, still true) -- that is exactly why this module renders
the skeleton directly as a PIL image handed straight to ControlNet, rather
than assuming a preprocessor will derive a pose from some other input.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

from gen_arm_a_idle_T0228 import (  # noqa: E402
    _POSE_KEYPOINTS_NORM,
    draw_pose_skeleton_cell,
)

RIG_PATH = _CHARACTER_DIR / "pose_rig_T0249.json"

Point = tuple[float, float]

# Joint groups the rig moves, in Arm A's 18-keypoint COCO numbering
# (module docstring / pose_rig_T0249.json for the full layout).
_BREATHING_JOINTS: tuple[int, ...] = (0, 1, 2, 5, 14, 15, 16, 17)  # head/neck/shoulders/eyes/ears
_WEIGHT_SHIFT_HIP_TO_LEG: dict[int, tuple[int, int]] = {
    8: (9, 10),  # right hip -> right knee, right ankle
    11: (12, 13),  # left hip -> left knee, left ankle
}
_STRIDE_LEG_JOINTS: dict[str, tuple[int, int]] = {
    "right": (9, 10),  # right knee, right ankle
    "left": (12, 13),  # left knee, left ankle
}


def load_rig(path: Path = RIG_PATH) -> dict:
    return json.loads(path.read_text())


def ease(name: str, t: float) -> float:
    """t -> a displacement curve in [-1, 1]. Breathing and weight-shift are
    periodic motions (not one-shot eased transitions), so 'sine' is a full
    period sinusoid over t, not an easeInOut clamp."""
    if name == "sine":
        return math.sin(2 * math.pi * t)
    raise ValueError(f"unknown easing {name!r}")


def keypoints_for_frame(
    state: dict,
    frame_index: int,
    frame_count: int,
    *,
    base_points: dict[int, Point] = _POSE_KEYPOINTS_NORM,
) -> dict[int, Point]:
    """Derive one frame's 18 keypoints from the rig's committed parameters.

    Deterministic: the same (state, frame_index, frame_count) always yields
    the same points -- no randomness, no seed, nothing SDXL-adjacent. This
    is the "script is the pose authority" half of the pipeline; nothing here
    ever touches a generated pixel.
    """
    t = frame_index / frame_count
    phase = (t + state.get("phase_offset", 0.0)) % 1.0

    breathe = ease(state["easing"], phase * state.get("breathing_cycles", 1)) * state[
        "breathing_amplitude_norm"
    ]
    shift = ease(state["easing"], phase * state.get("weight_shift_cycles", 1)) * state[
        "weight_shift_extent_norm"
    ]
    stride_extent = state.get("stride_extent_norm", 0.0)
    stride_phase = ease(state["easing"], phase)

    points = dict(base_points)

    for joint in _BREATHING_JOINTS:
        x, y = points[joint]
        points[joint] = (x, y - breathe)  # negative y = up: rises on inhale

    for hip, leg_chain in _WEIGHT_SHIFT_HIP_TO_LEG.items():
        x, y = points[hip]
        points[hip] = (x + shift, y)
        for joint in leg_chain:
            lx, ly = points[joint]
            points[joint] = (lx + shift, ly)

    if stride_extent:
        right_knee, right_ankle = _STRIDE_LEG_JOINTS["right"]
        left_knee, left_ankle = _STRIDE_LEG_JOINTS["left"]
        for joint in (right_knee, right_ankle):
            x, y = points[joint]
            points[joint] = (x + stride_phase * stride_extent, y)
        for joint in (left_knee, left_ankle):
            x, y = points[joint]
            points[joint] = (x - stride_phase * stride_extent, y)

    return points


def render_pose_frame(points: dict[int, Point], size: int):
    """Reuses gen_arm_a_idle_T0228.draw_pose_skeleton_cell directly -- same
    limb topology/colours, same joint-radius/line-width scaling, same pure
    black background -- parametrised on this frame's keypoints instead of
    the static base pose."""
    return draw_pose_skeleton_cell(size, points_norm=points)


def keypoints_to_coco_list(points: dict[int, Point]) -> list[dict]:
    """Serialise a frame's keypoints in ascending joint order -- what gets
    written to the per-frame keypoints JSON committed alongside each
    rendered skeleton, so the recipe is checkable, not merely asserted."""
    return [{"joint": i, "x": points[i][0], "y": points[i][1]} for i in sorted(points)]
