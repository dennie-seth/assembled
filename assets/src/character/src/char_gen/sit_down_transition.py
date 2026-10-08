"""Deterministic side-view sit-down transition: idle -> crouch, composited from the
committed parts and the two already-merged, already-approved anchor poses.

Scope (T-0268)
--------------
Both endpoints of this animation are given, not invented: the standing idle
(`char_gen.idle_cycle.idle_stance()`) and the crouch-sit
(`char_gen.sitting_idle_cycle.crouch_stance()`), both merged and approved on this branch.
This module's only job is the interpolation between them -- zero GPU, zero sampling, the
same inputs always produce the same frames, exactly like every other animation in this
package.

The one real problem: the feet
-------------------------------
Standing has both ankles essentially under the hip (`idle_stance()`: thigh/knee both at
0 degrees). The crouch has them staggered -- the near/R leg forward at `ANKLE_X_FRONT`
(+198 native px), the far/L leg back at `ANKLE_X_BACK` (-85 native px). A transition
between those two configurations cannot keep both feet planted the whole way; something
has to move, 283 native px of it.

**Contact decision, stated:** ONE FOOT STEPS AT A TIME. The far (L) leg repositions
first -- it lifts, swings back from its standing position to `ANKLE_X_BACK`, and plants
-- while the near (R) leg holds exactly at its standing position. Only once L has
planted does R lift, swing forward to `ANKLE_X_FRONT`, and plant. At every single frame
pair, at least one leg's ankle target is unchanged (that is "planted" -- see the module
docstring's worked-out invariant below); never both at once.

**What this costs:** nothing at frame 0 -- the transition's first frame reproduces
`idle_stance()` exactly (thigh/knee both 0 degrees, both sides), because neither leg has
started moving yet. The alternative (the stagger already present at frame 0, both feet
planted throughout) was considered and rejected specifically because it fails this card's
own acceptance bullet: frame 0 must reproduce the standing anchor, not a modified version
of it with the stagger pre-applied.

Why "planted" does not mean "pixel-identical crop"
---------------------------------------------------
A naive reading of "planted" (the sitting idle's own `test_each_contact_pixel_is_...`
tests: a raw pixel-crop comparison) does not apply here, and deliberately so. In this
transition the HIP sinks toward a fixed ground every single frame -- including frames
where a given foot is not stepping. The planted leg's own knee flexion still changes
frame to frame, exactly as a real standing leg's knee bends more as the hip drops toward
it. That is correct, not a slide: the ANKLE's own `(x, y)` target is unchanged (in both
native-canvas and, after the per-frame ground-anchor correction, cell coordinates), only
the thigh/calf art rotates differently to reach that same fixed point from a
closer-above hip. "Planted" is therefore checked against the solved ankle TARGET
coordinate (proven exact, never clamped, for every interior frame -- see `clamped_r`/
`clamped_l` on the result), not against a raw pixel crop.

Per-frame ground anchor, not a single shared one
--------------------------------------------------
`rig_compositor.render_frames` takes one phase-INDEPENDENT `LegStance`, because every
pose it has composited so far (idle, sitting-idle) holds its hip at a fixed height for
the whole loop. This transition's hip height is the entire point of the motion, so this
module keeps its own compositing loop: it calls `rig_compositor.build_placements`
per frame (as that function already is generic over pose), then re-implements the
canvas-sizing / descent / ground-anchor step so EACH frame's own `ground_plane_y` --
not a single shared scalar -- drives where that frame's ground row lands. The anchor row
within the 48px cell (`GROUND_ANCHOR_CELL_Y`) is still the one shared constant, so a
planted foot's cell pixel position is provably identical frame to frame regardless of how
much the hip has sunk that frame (worked out in `render_frames`'s own comments). Nothing
in `rig_compositor` itself is modified -- every existing pose module's render path, and
its own tests, are completely untouched.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen import idle_cycle, rig_compositor, sitting_idle_cycle
from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, GROUND_ANCHOR_CELL_Y

_REPO_ROOT = Path(__file__).resolve().parents[5]
EVIDENCE_DIR = _REPO_ROOT / "docs" / "assets" / "evidence" / "T-0268"

#: One-way, 6-8 frames per the motion spec. 8 chosen so the two foot-step windows below
#: land on exact frame boundaries (3/7 of the way through) rather than needing
#: additional rounding.
FRAME_COUNT = 8

#: The contact decision, in one line, surfaced on the result and in rig.json rather than
#: left to be inferred from the schedule below.
CONTACT_DECISION = "one_foot_steps"
CONTACT_DECISION_NOTE = (
    "the far (L) leg steps first, from its standing position back to ANKLE_X_BACK, "
    "while the near (R) leg holds; only once L has planted does R step forward to "
    "ANKLE_X_FRONT, while L holds. At least one leg is planted at every frame pair; "
    "frame 0 is the untouched standing idle, since neither leg has moved yet."
)

#: Fraction-of-transition windows for each foot's own step. L goes first; R second.
#: 3/7 lands exactly on frame index 3 of an 8-frame (7-interval) schedule.
L_WINDOW: tuple[float, float] = (0.0, 3.0 / 7.0)
R_WINDOW: tuple[float, float] = (3.0 / 7.0, 1.0)

#: How far (native px) the stepping foot clears the ground at its own step's midpoint.
#: Verified in render_frames/tests to stay well inside the leg's IK workspace for the
#: whole schedule -- see the module's own dev notes; at CHARACTER_SCALE this is ~2px at
#: the final figure, clearly a lift rather than a slide.
LIFT_PX = 50.0

#: Cubic ease-out for the hip descent: velocity strictly decreases over the transition,
#: so it settles rather than dropping at a constant rate.
EASE_POWER = 3


def ease_out(t: float) -> float:
    """0..1, decelerating -- the derivative shrinks as t -> 1."""
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** EASE_POWER


def window_frac(t: float, window: tuple[float, float]) -> float:
    """0 before `window` starts, 1 after it ends, eased (via `ease_out`) in between."""
    t0, t1 = window
    if t <= t0:
        return 0.0
    if t >= t1:
        return 1.0
    return ease_out((t - t0) / (t1 - t0))


def lift_at(frac: float) -> float:
    """A single hump in native px: EXACTLY 0 at both ends of a step's own
    window-fraction (grounded at touch-down and lift-off), peak at the middle. Not a
    loop -- `frac` never wraps, it is one leg's own progress through its own step.

    Clamped to literal 0.0 at the boundaries rather than trusting
    `sin(pi * 0.0 or 1.0)` to land there -- it doesn't: floating-point `math.pi` is
    only an approximation, so `sin(math.pi)` is ~1.2e-16, not 0.0, and that noise
    would otherwise read as "still lifted" to an exact-equality contact check.
    """
    frac = max(0.0, min(1.0, frac))
    if frac <= 0.0 or frac >= 1.0:
        return 0.0
    return LIFT_PX * math.sin(math.pi * frac)


@dataclass(frozen=True)
class FrameLegTargets:
    """What both legs are asked to reach at one frame: a shared ground height (the hip's
    own distance from the real, fixed ground -- shrinks every frame, including a
    planted foot's, because the HIP is what is sinking) and each leg's own ankle x and
    ground clearance."""
    ground_plane_y: float
    ankle_x_r: float
    ankle_x_l: float
    lift_r: float
    lift_l: float
    r_frac: float
    l_frac: float


@dataclass(frozen=True)
class Anchors:
    """The two endpoints, read from the merged modules -- never hardcoded."""
    thigh_r: float
    calf_r: float
    thigh_l: float
    calf_l: float
    torso_width: float
    torso_height: float
    start_leg: rig_compositor.LegStance
    end_leg: rig_compositor.LegStance
    ankle_r_start: tuple[float, float]
    ankle_l_start: tuple[float, float]
    ankle_r_end: tuple[float, float]
    ankle_l_end: tuple[float, float]


def compute_anchors() -> Anchors:
    """Re-measures everything from the committed parts and the two merged pose
    modules -- `idle_cycle.leg_stance()` for the start, `sitting_idle_cycle.leg_stance()`
    for the end. Neither module's own resolved pose is altered."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    scaled = rig_compositor.scaled_parts(parts, rig)
    torso_width = scaled["torso"].width
    torso_height = scaled["torso"].height

    start_leg = idle_cycle.leg_stance(lengths["thigh_R"], lengths["calf_R"])
    end_leg = sitting_idle_cycle.leg_stance(
        lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"]
    )

    start_hips = rig_compositor.leg_hip_points(start_leg, torso_width)
    end_hips = rig_compositor.leg_hip_points(end_leg, torso_width)

    _, ankle_r_start = rig_compositor.leg_chain(
        start_hips["R"], lengths["thigh_R"], lengths["calf_R"], start_leg, "R"
    )
    _, ankle_l_start = rig_compositor.leg_chain(
        start_hips["L"], lengths["thigh_L"], lengths["calf_L"], start_leg, "L"
    )
    _, ankle_r_end = rig_compositor.leg_chain(
        end_hips["R"], lengths["thigh_R"], lengths["calf_R"], end_leg, "R"
    )
    _, ankle_l_end = rig_compositor.leg_chain(
        end_hips["L"], lengths["thigh_L"], lengths["calf_L"], end_leg, "L"
    )

    return Anchors(
        thigh_r=lengths["thigh_R"], calf_r=lengths["calf_R"],
        thigh_l=lengths["thigh_L"], calf_l=lengths["calf_L"],
        torso_width=torso_width, torso_height=torso_height,
        start_leg=start_leg, end_leg=end_leg,
        ankle_r_start=ankle_r_start, ankle_l_start=ankle_l_start,
        ankle_r_end=ankle_r_end, ankle_l_end=ankle_l_end,
    )


def leg_targets_at(t: float, anchors: Anchors) -> FrameLegTargets:
    ease = ease_out(t)
    ground = anchors.start_leg.ground_plane_y + (
        anchors.end_leg.ground_plane_y - anchors.start_leg.ground_plane_y
    ) * ease
    l_frac = window_frac(t, L_WINDOW)
    r_frac = window_frac(t, R_WINDOW)
    ankle_x_l = anchors.ankle_l_start[0] + (
        anchors.ankle_l_end[0] - anchors.ankle_l_start[0]
    ) * l_frac
    ankle_x_r = anchors.ankle_r_start[0] + (
        anchors.ankle_r_end[0] - anchors.ankle_r_start[0]
    ) * r_frac
    return FrameLegTargets(
        ground_plane_y=ground,
        ankle_x_r=ankle_x_r, ankle_x_l=ankle_x_l,
        lift_r=lift_at(r_frac), lift_l=lift_at(l_frac),
        r_frac=r_frac, l_frac=l_frac,
    )


@dataclass(frozen=True)
class SolvedLeg:
    leg: rig_compositor.LegStance
    ankle_r: tuple[float, float]
    ankle_l: tuple[float, float]
    clamped_r: bool
    clamped_l: bool


def _reach_clamped(dx: float, dy: float, thigh_len: float, calf_len: float) -> bool:
    lo, hi = abs(thigh_len - calf_len), thigh_len + calf_len
    reach = math.hypot(dx, dy)
    return not (lo + 1e-6 < reach < hi - 1e-6)


def leg_stance_at(targets: FrameLegTargets, anchors: Anchors) -> SolvedLeg:
    """Contact-driven, same two-bone solve `sitting_idle_cycle.crouch_stance()` already
    uses (`idle_cycle.solve_leg`) -- the ankle TARGETS are interpolated (held while
    planted, swept through the lift while stepping), and the joint angles are
    WHATEVER THAT SOLVE PRODUCES, never themselves interpolated. Interpolating the
    angles directly (the rejected approach -- see the card's own edge case) would drag
    both feet through the ground along a straight blend between two very different
    stances; solving fresh against each frame's own ankle target is what keeps whichever
    foot is grounded actually on the ground plane."""
    target_r = (targets.ankle_x_r, targets.ground_plane_y - targets.lift_r)
    target_l = (targets.ankle_x_l, targets.ground_plane_y - targets.lift_l)
    ik_r = idle_cycle.solve_leg((0.0, 0.0), target_r, anchors.thigh_r, anchors.calf_r)
    ik_l = idle_cycle.solve_leg((0.0, 0.0), target_l, anchors.thigh_l, anchors.calf_l)
    leg = rig_compositor.LegStance(
        hip=(0.0, 0.0),
        ground_plane_y=targets.ground_plane_y,
        thigh_deg_r=ik_r.thigh_deg, knee_flexion_deg_r=ik_r.knee_flexion_deg,
        thigh_deg_l=ik_l.thigh_deg, knee_flexion_deg_l=ik_l.knee_flexion_deg,
        far_leg_offset_frac=0.0,
    )
    return SolvedLeg(
        leg=leg, ankle_r=target_r, ankle_l=target_l,
        clamped_r=_reach_clamped(target_r[0], target_r[1], anchors.thigh_r, anchors.calf_r),
        clamped_l=_reach_clamped(target_l[0], target_l[1], anchors.thigh_l, anchors.calf_l),
    )


def upper_pose_at(t: float, anchors: Anchors) -> rig_compositor.UpperPose:
    """The torso lean and the crouch's own arm drape are carried across the WHOLE
    transition on the same ease as the hip descent, landing exactly on the crouch's
    values at the last frame and exactly on the idle's (all zero, bar the resting elbow
    bend) at frame 0 -- never snapped on only at the end. No breath: this is a one-way
    transition, not a loop, so there is nothing for a breath cycle to rest against."""
    ease = ease_out(t)
    shoulder = idle_cycle.SHOULDER_REST_DEG + (
        sitting_idle_cycle.SHOULDER_DEG_CROUCH - idle_cycle.SHOULDER_REST_DEG
    ) * ease
    elbow = idle_cycle.ELBOW_REST_DEG + (
        sitting_idle_cycle.ELBOW_DEG_CROUCH - idle_cycle.ELBOW_REST_DEG
    ) * ease
    torso = 0.0 + (sitting_idle_cycle.TORSO_LEAN_DEG - 0.0) * ease
    return rig_compositor.UpperPose(
        upper_dy=0.0, shoulder_deg=shoulder, elbow_deg=elbow,
        head_deg=idle_cycle.HEAD_REST_DEG, torso_deg=torso,
    )


@dataclass
class FrameSpec:
    """Everything one frame needs to be placed and solved -- kept around on the result
    so tests can inspect the resolved per-frame numbers directly, not just the pixels."""
    t: float
    leg: rig_compositor.LegStance
    upper: rig_compositor.UpperPose
    ankle_r: tuple[float, float]
    ankle_l: tuple[float, float]
    lift_r: float
    lift_l: float
    clamped_r: bool
    clamped_l: bool
    z_override: dict[str, float] | None
    foot_flatten: dict[str, float] | None


def _frame_spec(i: int, frame_count: int, anchors: Anchors) -> FrameSpec:
    t = i / (frame_count - 1)
    if i == 0:
        # Frame 0 reproduces the standing anchor EXACTLY -- idle_cycle's own leg_stance,
        # not a value this module's own solve happens to agree with. idle_stance() sits
        # at exact full leg extension, a singularity solve_leg is not meant to resolve
        # (see idle_cycle's own docstring) -- this bypasses the solve entirely for this
        # one frame, same as idle_cycle itself does.
        return FrameSpec(
            t=t, leg=anchors.start_leg, upper=upper_pose_at(t, anchors),
            ankle_r=anchors.ankle_r_start, ankle_l=anchors.ankle_l_start,
            lift_r=0.0, lift_l=0.0, clamped_r=False, clamped_l=False,
            z_override=None, foot_flatten=None,
        )
    if i == frame_count - 1:
        # The last frame reproduces the crouch anchor EXACTLY -- sitting_idle_cycle's
        # own leg_stance/crouch_stance, asserted for equality (not proximity) in tests.
        return FrameSpec(
            t=t, leg=anchors.end_leg, upper=upper_pose_at(t, anchors),
            ankle_r=anchors.ankle_r_end, ankle_l=anchors.ankle_l_end,
            lift_r=0.0, lift_l=0.0, clamped_r=False, clamped_l=False,
            z_override=sitting_idle_cycle.CROUCH_Z_OVERRIDE,
            foot_flatten={"calf_R": sitting_idle_cycle.FRONT_FOOT_FLATTEN_DEG},
        )
    targets = leg_targets_at(t, anchors)
    solved = leg_stance_at(targets, anchors)
    # The crouch's own z fix (thigh_R/thigh_L's near-rectangular crops crossing the
    # torso) and front-foot flatten only matter once the pose is actually crouch-like --
    # gated on R's own step window so neither engages before R starts moving, and the
    # flatten itself ramps across that same window rather than snapping in at the end.
    if t >= R_WINDOW[0]:
        z_override = sitting_idle_cycle.CROUCH_Z_OVERRIDE
        foot_flatten = {
            "calf_R": sitting_idle_cycle.FRONT_FOOT_FLATTEN_DEG * targets.r_frac
        }
    else:
        z_override = None
        foot_flatten = None
    return FrameSpec(
        t=t, leg=solved.leg, upper=upper_pose_at(t, anchors),
        ankle_r=solved.ankle_r, ankle_l=solved.ankle_l,
        lift_r=targets.lift_r, lift_l=targets.lift_l,
        clamped_r=solved.clamped_r, clamped_l=solved.clamped_l,
        z_override=z_override, foot_flatten=foot_flatten,
    )


def frame_specs(frame_count: int = FRAME_COUNT, anchors: Anchors | None = None) -> list[FrameSpec]:
    anchors = anchors if anchors is not None else compute_anchors()
    return [_frame_spec(i, frame_count, anchors) for i in range(frame_count)]


def frame_placements(i: int, frame_count: int = FRAME_COUNT) -> list[rig_compositor.Placement]:
    """One frame's placements, built the same way `render_frames` does internally --
    exposed so a test can inspect a single frame's part images/z-order without
    re-rendering the whole transition."""
    anchors = compute_anchors()
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    scaled = rig_compositor.scaled_parts(parts, rig)
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    spec = _frame_spec(i, frame_count, anchors)
    return rig_compositor.build_placements(
        spec.upper, spec.leg, scaled, rig["rig"], rig["attach_torso_local_px"], lengths,
        z_override=spec.z_override, foot_flatten=spec.foot_flatten,
    )


@dataclass
class TransitionResult:
    native_frames: list[Image.Image]
    descended_frames: list[Image.Image]
    cell_px: int
    character_scale: float
    ground_anchor_cell_y: float
    specs: list[FrameSpec]
    hip_height_final_px: list[float]
    changed_px_per_frame_pair: list[int]
    torso_px_size: tuple[int, int]
    contact_decision: str = CONTACT_DECISION


def render_frames(frame_count: int = FRAME_COUNT) -> TransitionResult:
    anchors = compute_anchors()
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    scaled = rig_compositor.scaled_parts(parts, rig)
    rig_entries = rig["rig"]
    attach = rig["attach_torso_local_px"]
    lengths = rig_compositor.measured_bone_lengths(parts, rig)

    specs = frame_specs(frame_count, anchors)
    all_placements = [
        rig_compositor.build_placements(
            spec.upper, spec.leg, scaled, rig_entries, attach, lengths,
            z_override=spec.z_override, foot_flatten=spec.foot_flatten,
        )
        for spec in specs
    ]

    margin = 4.0
    boxes = [rig_compositor.placement_bbox(pl) for pl in all_placements]
    x0 = min(b[0] for b in boxes) - margin
    y0 = min(b[1] for b in boxes) - margin
    x1 = max(b[2] for b in boxes) + margin
    y1 = max(b[3] for b in boxes) + margin
    canvas_w, canvas_h = math.ceil(x1 - x0), math.ceil(y1 - y0)
    offset = (-x0, -y0)

    native_frames = []
    for pl in all_placements:
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        for placement in sorted(pl, key=lambda p: -p.z):
            dest = (
                round(placement.target_xy[0] - placement.pivot_px[0] + offset[0]),
                round(placement.target_xy[1] - placement.pivot_px[1] + offset[1]),
            )
            canvas.alpha_composite(placement.image, dest=dest)
        native_frames.append(canvas)

    descended = [
        f.resize(
            (max(1, round(f.width * CHARACTER_SCALE)), max(1, round(f.height * CHARACTER_SCALE))),
            Image.Resampling.LANCZOS,
        )
        for f in native_frames
    ]

    # Per-frame ground anchor -- the generalization this module needs beyond
    # rig_compositor.render_frames. Each frame's OWN ground_plane_y (the hip's
    # shrinking distance from the real, fixed ground) decides where that frame's
    # native-space ground row lands once descended; GROUND_ANCHOR_CELL_Y is still the
    # one shared row every frame is placed against, so a foot with an unchanged ankle
    # target renders at an unchanged cell pixel regardless of how far the hip has sunk
    # that frame: ankle_cell_y = GROUND_ANCHOR_CELL_Y - ground_descended_y + (same
    # ground_descended_y, since an ungrounded foot's native y IS ground_plane_y+offset)
    # = GROUND_ANCHOR_CELL_Y, a constant, for every frame where that foot is not lifted.
    cell_frames = []
    for spec, d in zip(specs, descended):
        ground_canvas_y = spec.leg.ground_plane_y + offset[1]
        ground_descended_y = ground_canvas_y * CHARACTER_SCALE
        cell = Image.new("RGBA", (CELL_PX, CELL_PX), (0, 0, 0, 0))
        dest_x = round((CELL_PX - d.width) / 2.0)
        dest_y = round(GROUND_ANCHOR_CELL_Y - ground_descended_y)
        cell.alpha_composite(d, dest=(dest_x, dest_y))
        cell_frames.append(cell)

    arrays = [np.asarray(f) for f in native_frames]
    changed_px = [
        int(np.count_nonzero(np.any(arrays[i] != arrays[i + 1], axis=-1)))
        for i in range(frame_count - 1)
    ]

    hip_height_final_px = [spec.leg.ground_plane_y * CHARACTER_SCALE for spec in specs]

    return TransitionResult(
        native_frames=native_frames,
        descended_frames=cell_frames,
        cell_px=CELL_PX,
        character_scale=CHARACTER_SCALE,
        ground_anchor_cell_y=GROUND_ANCHOR_CELL_Y,
        specs=specs,
        hip_height_final_px=hip_height_final_px,
        changed_px_per_frame_pair=changed_px,
        torso_px_size=scaled["torso"].size,
    )


def main() -> None:
    import json

    result = render_frames()

    sheet_path = rig_compositor.save_sheet(
        result.descended_frames, EVIDENCE_DIR / "sit_down_sheet_48.png"
    )
    gif_path = rig_compositor.save_gif(
        result.descended_frames, EVIDENCE_DIR / "sit_down_loop_x8.gif",
        duration_ms=90,
    )

    anchors = compute_anchors()
    report = {
        "frames": FRAME_COUNT,
        "cell_px": CELL_PX,
        "character_scale": CHARACTER_SCALE,
        "ground_anchor_cell_y": GROUND_ANCHOR_CELL_Y,
        "contact_decision": CONTACT_DECISION,
        "contact_decision_note": CONTACT_DECISION_NOTE,
        "ease_power": EASE_POWER,
        "lift_px": LIFT_PX,
        "l_window": list(L_WINDOW),
        "r_window": list(R_WINDOW),
        "anchors": {
            "standing": {
                "ground_plane_y": anchors.start_leg.ground_plane_y,
                "thigh_deg_r": anchors.start_leg.thigh_deg_r,
                "knee_flexion_deg_r": anchors.start_leg.knee_flexion_deg_r,
                "thigh_deg_l": anchors.start_leg.thigh_deg_l,
                "knee_flexion_deg_l": anchors.start_leg.knee_flexion_deg_l,
                "ankle_r": list(anchors.ankle_r_start),
                "ankle_l": list(anchors.ankle_l_start),
            },
            "crouch": {
                "ground_plane_y": anchors.end_leg.ground_plane_y,
                "thigh_deg_r": anchors.end_leg.thigh_deg_r,
                "knee_flexion_deg_r": anchors.end_leg.knee_flexion_deg_r,
                "thigh_deg_l": anchors.end_leg.thigh_deg_l,
                "knee_flexion_deg_l": anchors.end_leg.knee_flexion_deg_l,
                "ankle_r": list(anchors.ankle_r_end),
                "ankle_l": list(anchors.ankle_l_end),
            },
        },
        "hip_descent_final_px": {
            "per_frame": result.hip_height_final_px,
            "total": result.hip_height_final_px[0] - result.hip_height_final_px[-1],
        },
        "per_frame": [
            {
                "frame": i,
                "t": spec.t,
                "thigh_deg_r": spec.leg.thigh_deg_r,
                "knee_flexion_deg_r": spec.leg.knee_flexion_deg_r,
                "thigh_deg_l": spec.leg.thigh_deg_l,
                "knee_flexion_deg_l": spec.leg.knee_flexion_deg_l,
                "ankle_r": list(spec.ankle_r),
                "ankle_l": list(spec.ankle_l),
                "lift_r_native_px": spec.lift_r,
                "lift_l_native_px": spec.lift_l,
                "clamped_r": spec.clamped_r,
                "clamped_l": spec.clamped_l,
                "torso_deg": spec.upper.torso_deg,
                "shoulder_deg": spec.upper.shoulder_deg,
                "elbow_deg": spec.upper.elbow_deg,
            }
            for i, spec in enumerate(result.specs)
        ],
        "changed_px_per_frame_pair": result.changed_px_per_frame_pair,
        "sheet": sheet_path.name,
        "gif": gif_path.name,
    }

    rig_json_path = EVIDENCE_DIR / "rig.json"
    rig_json_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
