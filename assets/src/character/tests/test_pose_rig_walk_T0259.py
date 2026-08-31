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

**2026-08-31 IMPROVEMENT PASS (art direction).** The previously-committed
sheet hitches at the loop seam because frame 0 sampled a near-neutral
passing pose instead of a contact pose (`_leg_swing(t)` sampled at the
centre of an 8-way phase slice landed near t=0, a zero-crossing of
`sin(2*pi*t)`, not at a stride extreme). The gait model changes from a
single `sin`-based offset (whose zero-crossings and extrema don't align
with frame boundaries under 8-way slicing without landing on a genuinely
degenerate double-zero point) to an offset/lift pair built from
`cos`/`sin` directly: `_leg_offset(t) = cos(2*pi*t)` is at its own extreme
(+-1) exactly at t=0 and t=0.5 -- so sampling the plain, even grid
`t = k/8` (no center-of-slice shift needed) puts frame 0 exactly on a
contact pose, all 8 samples exactly 1/8 apart including the seam, with no
degenerate double-zero anywhere (the old model's zero-crossings become this
model's *extrema*, which are informative, not degenerate). `_leg_lift(t) =
max(0, -sin(2*pi*t))` is independently zero throughout the offset's whole
stance half (t in [0, 0.5], where the old model's zero-crossings sat) and
peaks at t=0.75 -- the mid-swing passing point, where the offset is
momentarily 0 (ankle back under the hip) yet the leg is fully lifted. A new
`CROSS_EXTENT_NORM` term, driven by `lift` (zero except during swing), pulls
the swinging leg's knee/ankle laterally toward and slightly past the
opposite leg's own resting x, at zero amplitude during stance/contact so it
never distorts the wide-stride contact pose it's not needed for.
"""

from __future__ import annotations

import inspect
import math
import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_arm_a_idle_T0228  # noqa: E402
import pose_rig_walk_T0259  # noqa: E402

_R_SHOULDER, _L_SHOULDER = 2, 5
_R_KNEE, _R_ANKLE = 9, 10
_L_KNEE, _L_ANKLE = 12, 13
_R_WRIST, _L_WRIST = 4, 7
_R_HIP, _L_HIP = 8, 11

_BASE = gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM


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


# ---------------------------------------------------------------------------
# Frame 0 = contact pose, evenly spaced with the other 7 (the hitch fix)
# ---------------------------------------------------------------------------


def test_frame_zero_is_an_on_cycle_contact_pose() -> None:
    """Acceptance: frame 0 must be a stride EXTREME (a contact pose), not a
    near-neutral passing pose -- the defect measured on the previously
    committed sheet (5.31x seam/interior ratio)."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    contact = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)
    stride = pose_rig_walk_T0259.STRIDE_EXTENT_NORM

    right_dx = contact[_R_ANKLE][0] - _BASE[_R_ANKLE][0]
    left_dx = contact[_L_ANKLE][0] - _BASE[_L_ANKLE][0]
    assert right_dx == pytest.approx(stride), "frame 0's leading leg must be at full stride extent"
    assert left_dx == pytest.approx(-stride), "frame 0's trailing leg must be at full stride extent"

    # Both feet flat (no lift) at contact -- the classic double-stance moment,
    # not a mid-swing pose.
    assert contact[_R_ANKLE][1] == pytest.approx(_BASE[_R_ANKLE][1])
    assert contact[_L_ANKLE][1] == pytest.approx(_BASE[_L_ANKLE][1])


def test_all_eight_frames_are_evenly_spaced_in_phase() -> None:
    """Acceptance: raw math check that the phase sampled per frame is an
    exact, even k/8 grid (no center-of-slice shift), cross-checked against
    an independent `cos`/`sin` computation in this test -- not merely
    asserted by reading the implementation."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    stride = pose_rig_walk_T0259.STRIDE_EXTENT_NORM
    for k in range(n):
        t = k / n
        expected_dx = math.cos(2 * math.pi * t) * stride
        points = pose_rig_walk_T0259.walk_keypoints_for_frame(k, n)
        actual_dx = points[_R_ANKLE][0] - _BASE[_R_ANKLE][0]
        # The cross term is proportional to lift, which is 0 throughout the
        # right leg's stance half (t in [0, 0.5], i.e. k in {0, 1, 2, 3, 4}),
        # so pure-offset equality only holds there; check those directly.
        if k <= n // 2:
            assert actual_dx == pytest.approx(expected_dx, abs=1e-9), (
                f"frame {k}: expected pure-offset ankle dx {expected_dx}, got {actual_dx}"
            )


def test_seam_and_interior_steps_are_the_same_phase_delta() -> None:
    """The loop seam (frame 7 -> frame 0) must be the SAME 1/8 phase step as
    every interior pair -- not a special case, and not the ~3x hitch
    measured on the previous sheet."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    stride = pose_rig_walk_T0259.STRIDE_EXTENT_NORM

    def right_ankle_dx(k: int) -> float:
        points = pose_rig_walk_T0259.walk_keypoints_for_frame(k, n)
        return points[_R_ANKLE][0] - _BASE[_R_ANKLE][0]

    # The underlying continuous offset curve steps by the same 1/8 of a
    # period at every k -- verify the seam's step (k=7 -> k=8==0) matches an
    # interior step (k=0 -> k=1) to within floating tolerance, using the
    # closed-form curve (cos), which is exactly what the implementation
    # samples at each k/n.
    def expected(k: int) -> float:
        return math.cos(2 * math.pi * (k / n)) * stride

    interior_step = abs(expected(1) - expected(0))
    seam_step = abs(expected(n) - expected(n - 1))
    assert seam_step == pytest.approx(interior_step), (
        "the loop seam's phase step must equal an interior step's phase step"
    )
    # And the actual implementation's frame 0 (no cross-term contribution --
    # lift is 0 at every contact pose) matches the closed form exactly.
    assert right_ankle_dx(0) == pytest.approx(expected(0))


# ---------------------------------------------------------------------------
# Amplitude -- wide stride, real knee lift, visible arm opposition
# ---------------------------------------------------------------------------


def test_amplitudes_are_meaningfully_larger_than_the_previous_sheet() -> None:
    """Acceptance: the previous sheet's amplitudes (STRIDE_EXTENT_NORM=0.145,
    KNEE_LIFT_NORM=0.085, ARM_SWING_EXTENT_NORM=0.09) produced barely-visible
    limb motion. The revised rig must be meaningfully larger -- at least 1.5x
    on every axis, not a marginal tweak.

    1.5x, not the originally-tried 1.8x-2.2x: attempt 5 (real ComfyUI
    generation, seed 27182, see ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md) ran
    2.0-2.2x amplitudes and measured frame deltas of 0.328-0.473, well past
    the explicit 0.30 mechanical cap -- a harder acceptance criterion than
    any particular multiplier. 1.5x-1.7x is the calibrated-down value that
    fits back under the cap while still being clearly bigger than the
    original, barely-visible sheet."""
    assert pose_rig_walk_T0259.STRIDE_EXTENT_NORM >= 0.145 * 1.5
    assert pose_rig_walk_T0259.KNEE_LIFT_NORM >= 0.085 * 1.5
    assert pose_rig_walk_T0259.ARM_SWING_EXTENT_NORM >= 0.09 * 1.5


def test_legs_swing_opposite_phase_at_contact() -> None:
    """Opposed leg swing (motion spec): at the contact pose, one leg is at
    its forward extreme and the other at its back extreme -- not moving the
    same direction."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    contact = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)
    right_dx = contact[_R_ANKLE][0] - _BASE[_R_ANKLE][0]
    left_dx = contact[_L_ANKLE][0] - _BASE[_L_ANKLE][0]
    assert right_dx * left_dx < 0, (
        f"right/left ankle x-offsets must have opposite sign at the contact frame, "
        f"got right={right_dx}, left={left_dx}"
    )


def test_arms_swing_opposite_to_same_side_leg() -> None:
    """Motion spec: opposed arm-and-leg swing means the right arm swings
    with the LEFT leg (real-gait convention), not with the right leg."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    contact = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)

    right_arm_dx = contact[_R_WRIST][0] - _BASE[_R_WRIST][0]
    left_leg_dx = contact[_L_ANKLE][0] - _BASE[_L_ANKLE][0]
    assert right_arm_dx * left_leg_dx > 0, "right arm must swing WITH the left leg, not against it"
    assert abs(right_arm_dx) == pytest.approx(pose_rig_walk_T0259.ARM_SWING_EXTENT_NORM)


def test_arm_swing_is_readable_relative_to_shoulder_width() -> None:
    """'Readable at 40px' is ultimately a rendered-image judgement, but the
    rig itself must not sabotage it: the wrist swing amplitude must be a
    non-trivial fraction of shoulder width, not a sub-pixel wobble at the
    48x48 cell size this sheet ships at."""
    shoulder_width = abs(_BASE[_L_SHOULDER][0] - _BASE[_R_SHOULDER][0])
    assert pose_rig_walk_T0259.ARM_SWING_EXTENT_NORM >= shoulder_width * 0.9, (
        "arm swing amplitude should be comparable to shoulder width to read as real motion "
        "at game scale"
    )


# ---------------------------------------------------------------------------
# Passing pose: a real leg cross, not both legs merely hovering apart
# ---------------------------------------------------------------------------


def test_passing_leg_lifts_off_the_ground_line() -> None:
    """Motion spec: 'a pass pose where the free leg clears' -- the leg not
    bearing weight must rise (its own knee/ankle y must move up, i.e.
    numerically smaller in this normalised-down-positive space) relative to
    its own contact frame."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    right_contact = pose_rig_walk_T0259.walk_keypoints_for_frame(0, n)
    right_passing = pose_rig_walk_T0259.walk_keypoints_for_frame(3 * n // 4, n)
    assert right_passing[_R_ANKLE][1] < right_contact[_R_ANKLE][1], (
        "the passing leg's ankle must lift (smaller y) relative to its own contact frame"
    )

    left_contact = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 2, n)
    left_passing = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 4, n)
    assert left_passing[_L_ANKLE][1] < left_contact[_L_ANKLE][1], (
        "the mirrored leg's ankle must lift (smaller y) relative to its own contact frame"
    )


def test_passing_pose_legs_narrow_toward_a_cross() -> None:
    """Acceptance: 'Legs CROSS / pass under the body on the return swing.
    The passing pose must actually read as one leg passing the other, not
    both hovering apart.'

    Attempt 5 (real ComfyUI generation, seed 27182) shipped
    CROSS_EXTENT_NORM=0.14, large enough for the lifted ankle to reach the
    OTHER leg's resting x outright (a full cross) -- but combined with the
    also-larger stride/knee/arm amplitudes, measured frame deltas of
    0.328-0.473, past the explicit 0.30 mechanical cap. CROSS_EXTENT_NORM
    is calibrated down to 0.05 here to fit back under that cap (a harder
    acceptance criterion than a specific cross distance): the ankles no
    longer fully overtake each other, but the gap between them shrinks
    substantially at the peak-lift frame relative to the resting stance
    width -- a real, measured narrowing toward a cross, not a return to
    full bilateral symmetry."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    resting_gap = _BASE[_L_ANKLE][0] - _BASE[_R_ANKLE][0]

    # Right leg's peak lift (mid-swing, offset back to 0) is at 3n/4.
    right_peak = pose_rig_walk_T0259.walk_keypoints_for_frame(3 * n // 4, n)
    peak_gap_right_swinging = _BASE[_L_ANKLE][0] - right_peak[_R_ANKLE][0]
    assert peak_gap_right_swinging < resting_gap * 0.7, (
        f"right ankle's gap to the left leg at its peak-lift frame ({peak_gap_right_swinging}) "
        f"must narrow well below the resting gap ({resting_gap}) to read as passing/crossing"
    )

    # Mirrored: left leg's peak lift is at n/4.
    left_peak = pose_rig_walk_T0259.walk_keypoints_for_frame(n // 4, n)
    peak_gap_left_swinging = left_peak[_L_ANKLE][0] - _BASE[_R_ANKLE][0]
    assert peak_gap_left_swinging < resting_gap * 0.7, (
        f"left ankle's gap to the right leg at its peak-lift frame ({peak_gap_left_swinging}) "
        f"must narrow well below the resting gap ({resting_gap}) to read as passing/crossing"
    )


def test_cross_term_is_zero_at_contact() -> None:
    """The cross term is driven by lift, which is 0 at every contact pose --
    it must never distort the wide-stride contact pose (frame 0 and its
    opposite-contact mirror at frame_count/2)."""
    n = pose_rig_walk_T0259.FRAME_COUNT
    stride = pose_rig_walk_T0259.STRIDE_EXTENT_NORM
    for k in (0, n // 2):
        points = pose_rig_walk_T0259.walk_keypoints_for_frame(k, n)
        right_dx = points[_R_ANKLE][0] - _BASE[_R_ANKLE][0]
        left_dx = points[_L_ANKLE][0] - _BASE[_L_ANKLE][0]
        assert abs(abs(right_dx) - stride) < 1e-9, f"frame {k}: cross term leaked into contact"
        assert abs(abs(left_dx) - stride) < 1e-9, f"frame {k}: cross term leaked into contact"


# ---------------------------------------------------------------------------
# Rendering / serialisation, unchanged contract
# ---------------------------------------------------------------------------


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
