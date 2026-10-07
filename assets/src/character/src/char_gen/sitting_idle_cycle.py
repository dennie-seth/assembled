"""Deterministic side-view crouch-sit idle loop, composited from the committed parts.

Round 3 (T-0269). @DennieSeth confirmed the crouch itself reads correctly (round 2's
corrections -- no seat plane, one shared `character_scale.CHARACTER_SCALE` -- are kept
unchanged). This round is pose refinement only, three changes:

1. **Torso lean, actually applied.** Round 2 recorded `TORSO_LEAN_DEG = 0.0` into
   `rig.json` without ever consuming it -- `rig_compositor.UpperPose` had no
   torso-rotation field at all, so the constant was correct only because it was zero.
   `rig_compositor.UpperPose.torso_deg` (new) and `rig_compositor.build_placements`
   (rewritten) now actually rotate the torso about its hip attach point, and carry the
   head/shoulders/forearms along as a parent rotation -- see that module's own
   docstring for the mechanics. This module just sets `TORSO_LEAN_DEG` to a non-zero
   value and lets the shared compositor apply it.

   **Sign note:** in this rig's rotation convention (`distal_joint`/`Image.rotate`:
   positive swings a part that hangs straight DOWN toward +x), the torso's OWN vector
   from hip to neck points mostly straight UP. The same spin that swings a downward
   vector toward +x swings an upward vector toward -x -- so a FORWARD lean (head/chest
   toward +x, over the knees) needs a NEGATIVE `TORSO_LEAN_DEG`. This is verified from
   rendered pixels in the test suite, not just asserted from the sign.

2. **The crouch's own arm rest pose.** Round 2's arms reused `idle_cycle`'s STANDING
   rest angles verbatim (`SHOULDER_REST_DEG=0`, `ELBOW_REST_DEG=14`), which is why they
   hung straight down instead of resting on the knees. `arm_stance()` solves this
   pose's own `(shoulder_deg, elbow_deg)` with the same two-bone IK `crouch_stance()`
   already uses for the legs (`idle_cycle.solve_leg`), targeting the near knee. Note
   the ARM's forward-kinematics convention is additive (`forearm_deg = shoulder_deg +
   elbow_deg`, rig.json's own `sign_convention.forearm`) where the LEG's is subtractive
   (`calf_deg = thigh_deg - knee_flexion_deg`) -- `arm_stance()` converts between them;
   see its own docstring.

3. **A real stagger.** Round 2's two ankles were both pinned to the SAME
   `hip_forward_of_ankle_x`, separated only by `far_leg_offset_frac` shifting the far
   leg's HIP sideways -- an identical leg pose shifted 0.48 final pixels, not a
   stagger. `crouch_stance()` now solves EACH leg independently, from the one shared
   hip to its OWN ankle x-target -- different reach, therefore different knee flexion,
   therefore two visibly different legs. `far_leg_offset_frac` is 0.0 here: the hip is
   genuinely shared, exactly as the card asks ("each leg needs its own IK solve from
   the SHARED hip").

The compositing machinery itself (part loading, pivot math, the calf_L length
correction, rotation padding, torso-lean propagation, z-ordering, descent to the 48px
cell) is NOT duplicated here -- it lives once in `char_gen.rig_compositor`, generic over
any pose. This module supplies only the crouch's own `LegStance`, its own arm rest
angles, and its own `phase -> UpperPose`.

The legs stay static across the loop -- hip and both ankles are fixed for every frame --
only the upper body breathes, reusing `char_gen.idle_cycle.breath` unmodified (same
signal, same part (`torso.png`), as the standing idle). `CROUCH_BREATH_RISE_FRAC` is
re-measured this round at the refined pose (the lean and the arm change do not touch the
breath signal itself, only what the upper body looks like at rest).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from char_gen import idle_cycle, rig_compositor
from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, GROUND_ANCHOR_CELL_Y

_REPO_ROOT = Path(__file__).resolve().parents[5]
EVIDENCE_DIR = _REPO_ROOT / "docs" / "assets" / "evidence" / "T-0269"

#: Measured bone lengths, same parts as the walk/standing idle (side_view_rig.json /
#: docs/assets/evidence/T-0430/rig.json): thighs measure equal; both calves measure
#: equal once calf_L's own rig-recorded length-scale correction is applied. Defaults
#: only -- `render_frames()` always re-measures from the committed parts.
THIGH_LEN = 246.72
CALF_LEN = 330.24

#: The near (R) arm's own measured length, same convention as THIGH_LEN/CALF_LEN above
#: -- a documented default matching the committed parts, never a solve input inside
#: `render_frames()`, which always re-measures. Only one arm is solved against (both
#: shoulders share the resulting rest angle, same as round 1/2) -- the far arm's own
#: raw part proportions were never validated against the near arm's and are out of
#: this card's scope.
SHOULDER_LEN = 103.04
FOREARM_LEN = 198.34

FRAME_COUNT = 6

#: The crouch target. The hip sits 300px above the ground plane -- lower than round
#: 1's chair-sit hip height (330.24px, the calf's own length) -- directly above neither
#: ankle, since round 3 gives each leg its own ankle x-target below.
HIP_HEIGHT_ABOVE_GROUND = 300.0

#: The stagger (T-0269 round 3): two different ankle x-targets on the SAME ground
#: plane, solved independently from the ONE shared hip. R (the near leg, topmost
#: z-order -- `side_view_rig.json`'s `thigh_R`/`calf_R` z=0, drawn last/frontmost) leads
#: -- it is the forward foot. L (the far leg, drawn behind) trails. This is the card's
#: own worked feasibility check verbatim: both reaches (313.2, 305.9) are comfortably
#: inside the leg's (83.52, 576.96) workspace, both solves are exact (not clamped), and
#: the separation is ~6 final px -- clearly visible, not round 2's 0.48px.
#: Round 5: re-solved from @DennieSeth's marked-up frame
#: (`dennie_markup_arms_legs.png`). His red leg lines put the forward ankle ~198 native
#: px ahead of the hip and the trailing ankle ~85 behind it -- a 283px stance, nearly
#: double round 4's 150px, which is why the legs did not read as standing. At this
#: stance the forward shin resolves to 8 degrees off vertical (he drew it vertical) and
#: both solves stay exact inside the leg's (83.5, 577.0) workspace.
ANKLE_X_FRONT = 198.0
ANKLE_X_BACK = -85.0

#: Round 4 (@DennieSeth: "something weird in the very middle"). Diagnosed from the
#: composite: the offender is `thigh_R`. Its hand-cut crop is a near-rectangle
#: (bbox_fill 0.87, not a traced silhouette), and at this crouch's ~88deg thigh rotation
#: that opaque box swings across the belly. Because `side_view_rig.json` puts the near
#: leg frontmost (z=0), the box painted OVER the torso, reading as an unidentified slab.
#: Neither the part nor the shared rig is touched -- this pose alone draws `thigh_R`
#: behind the torso (z=3), which hides the surplus box where it crosses the body while
#: the real thigh still reads in front of the far leg.
CROUCH_Z_OVERRIDE = {"thigh_R": 3.5, "thigh_L": 3.6}
#: Round 5 adds `thigh_L`. Widening the stance to @DennieSeth's marked-up geometry
#: swings the trailing thigh's crop -- also a near-rectangle (bbox fill 0.94, the
#: least-traced part of the ten) -- across the front of the body, where it filled the
#: gap between the legs and read as one green mass rather than two legs. Behind the
#: torso it stops competing with the silhouette and the stance reads.

#: Round 4 (@DennieSeth: the forward foot should sit flat on the floor). The leading
#: foot is the near/R leg -- `ANKLE_X_FRONT` above. Applied as a rotation about the
#: shin's own ANKLE, so the solved contact stays exactly on the ground plane.
FRONT_FOOT_FLATTEN_DEG = 15.0

#: Forward torso lean (T-0269 round 3) -- NEGATIVE in this rig's convention; see the
#: module docstring's sign note. A small lean, not a bow: ~12 degrees, "hunched a
#: little over the knees, not bolt upright."
TORSO_LEAN_DEG = -12.0

#: Feet are planted FLAT. This module does not re-cut or re-pose the foot independently
#: of the calf -- the calf part's own baked-in foot shape (round 1's choice, unchanged)
#: is a fixed cutout at the end of the shin, not a separately articulated part, so
#: "flat" is the art's own existing silhouette rather than a newly decided pose.
FEET_PLANTED = "flat"

#: Re-measured at the round 3 pose (the lean and the arm change do not touch this
#: signal): 0.15 * 257 * 0.0398 = ~1.53px of travel at the final figure, clearing the
#: 1px floor with the same margin round 2 had, well under the 2px "bob, not breath"
#: ceiling. `idle_cycle`'s own BREATH_RISE_FRAC is untouched -- the standing idle keeps
#: its own calibration.
#: Round 4 (@DennieSeth: "breathing a little less tense"). 0.15 measured 1.534px of
#: travel at the final figure; 0.117 measures ~1.197px -- softer, still clearing the
#: ~1px floor that makes it read at all.
CROUCH_BREATH_RISE_FRAC = 0.117


@dataclass(frozen=True)
class CrouchStance:
    """The crouch base pose: a rig configuration, not a generated image. The only
    ground constraint is `ground_plane_y`, which BOTH ankles rest on -- at DIFFERENT x,
    the stagger this round adds. The hip is a single free point, SHARED by both legs
    (round 3 keeps it shared rather than adding a second per-leg hip offset): each leg
    is solved independently, from that one shared hip to its own ankle target, which is
    what makes the two legs carry different knee flexion -- a real stagger, not
    `far_leg_offset_frac` shifting one leg's pose sideways (round 2's bug)."""
    ground_plane_y: float
    hip_y: float
    ankle_x_r: float
    ankle_x_l: float
    thigh_deg_r: float
    knee_flexion_deg_r: float
    thigh_deg_l: float
    knee_flexion_deg_l: float


def crouch_stance(
    thigh_len_r: float = THIGH_LEN, calf_len_r: float = CALF_LEN,
    thigh_len_l: float = THIGH_LEN, calf_len_l: float = CALF_LEN,
    hip_height_above_ground: float = HIP_HEIGHT_ABOVE_GROUND,
    ankle_x_r: float = ANKLE_X_FRONT, ankle_x_l: float = ANKLE_X_BACK,
) -> CrouchStance:
    """Solve both legs, each independently, from the shared hip at `(0, 0)` to its OWN
    ankle target -- `(ankle_x_r, hip_height_above_ground)` for R, `(ankle_x_l,
    hip_height_above_ground)` for L -- via `char_gen.idle_cycle.solve_leg`. Reused
    unchanged for every frame, which is what makes the legs static by construction."""
    ik_r = idle_cycle.solve_leg(
        (0.0, 0.0), (ankle_x_r, hip_height_above_ground), thigh_len_r, calf_len_r
    )
    ik_l = idle_cycle.solve_leg(
        (0.0, 0.0), (ankle_x_l, hip_height_above_ground), thigh_len_l, calf_len_l
    )
    return CrouchStance(
        ground_plane_y=hip_height_above_ground,
        hip_y=0.0,
        ankle_x_r=ankle_x_r,
        ankle_x_l=ankle_x_l,
        thigh_deg_r=ik_r.thigh_deg,
        knee_flexion_deg_r=ik_r.knee_flexion_deg,
        thigh_deg_l=ik_l.thigh_deg,
        knee_flexion_deg_l=ik_l.knee_flexion_deg,
    )


#: The canonical crouch pose this module ships -- committed numbers, not re-derived per
#: call, using the default (non-measured) bone lengths above. `render_frames()` always
#: solves again from the real, measured parts; this is only a convenience default.
CROUCH_STANCE = crouch_stance()


def leg_stance(
    thigh_len_r: float = THIGH_LEN, calf_len_r: float = CALF_LEN,
    thigh_len_l: float = THIGH_LEN, calf_len_l: float = CALF_LEN,
    stance: CrouchStance | None = None,
) -> rig_compositor.LegStance:
    st = stance if stance is not None else crouch_stance(
        thigh_len_r, calf_len_r, thigh_len_l, calf_len_l
    )
    return rig_compositor.LegStance(
        hip=(0.0, st.hip_y),
        ground_plane_y=st.ground_plane_y,
        thigh_deg_r=st.thigh_deg_r,
        knee_flexion_deg_r=st.knee_flexion_deg_r,
        thigh_deg_l=st.thigh_deg_l,
        knee_flexion_deg_l=st.knee_flexion_deg_l,
        far_leg_offset_frac=0.0,
    )


@dataclass(frozen=True)
class ArmStance:
    """The crouch's own arm rest pose -- `shoulder_deg`/`elbow_deg` are this pose's own
    LOCAL rest angles (before the torso's lean is added as a parent rotation by
    `rig_compositor.build_placements`: `shoulder_abs = torso_deg + shoulder_deg`, same
    convention the legs' thigh/knee split already uses). Also carries the diagnostics
    the card asks this round to report: the resolved wrist position, the knee it
    targeted, the distance between them, and whether the solve was clamped."""
    shoulder_deg: float
    elbow_deg: float
    wrist_xy: tuple[float, float]
    knee_target_xy: tuple[float, float]
    wrist_to_knee_distance_native_px: float
    reach: float
    reach_workspace: tuple[float, float]
    clamped: bool


#: Round 5: the arm angles now come from @DennieSeth's own red arm line rather than
#: from a two-bone IK solve.
#:
#: WHY. Rounds 3-4 solved the arm so the wrist landed EXACTLY on the knee. The
#: shoulder-to-knee reach is 259-285 native px against an arm that is only 301px fully
#: extended, so "touch the knee" forced a nearly straight arm -- and the solver settled
#: on the branch with the upper arm swung 81 degrees forward (nearly horizontal, at
#: shoulder height) and the forearm folded back down. Geometrically exact, anatomically
#: broken: that is the "mangled/disjointed" arm. It was identical in round 3; round 4
#: only made it visible, by moving `thigh_R` off the top of the z-order where it had
#: been covering ~23% of the arm.
#:
#: His line instead drapes: upper arm hanging near-vertical (+13.7 degrees off straight
#: down), forearm swinging forward to the knee. Fixing the upper arm at his angle and
#: choosing the elbow that gets closest to the knee lands the wrist 14 native px away --
#: 0.56px at the final figure, i.e. resting on the knee to the eye, without pretending
#: the arm is long enough to stretch there.
SHOULDER_DRAPE_DEG = 10.67
ELBOW_DRAPE_DEG = 57.0


def arm_stance(
    shoulder_len: float, forearm_len: float, attach: dict,
    hip: tuple[float, float], knee_target: tuple[float, float],
    torso_deg: float = TORSO_LEAN_DEG,
    shoulder_deg: float = SHOULDER_DRAPE_DEG,
    elbow_deg: float = ELBOW_DRAPE_DEG,
) -> ArmStance:
    """Solve this pose's own `(shoulder_deg, elbow_deg)` so the (near) wrist lands at
    `knee_target` -- the same two-bone IK `crouch_stance()` uses for a leg, reused
    for the arm chain via `idle_cycle.solve_leg(shoulder_world, knee_target, ...)`.

    Shoulder world position: the torso's own `attach["shoulder"]` offset from its own
    `attach["hip"]`, carried by the torso's lean via `rig_compositor.rotate_offset` --
    the SAME transform `build_placements` applies at render time, not a second,
    independently-derived rotation.

    Sign conversion: `idle_cycle.solve_leg` always resolves a SUBTRACTIVE two-bone
    chain (`calf_deg = thigh_deg - knee_flexion_deg`, the leg's own convention). The
    rendered arm is ADDITIVE (`forearm_deg = shoulder_deg + elbow_deg`,
    `side_view_rig.json`'s own `sign_convention.forearm`). Reusing the solve's absolute
    angles directly through the additive formula would send the forearm to the WRONG
    place; `elbow_deg = -ik.knee_flexion_deg` is what makes the additive render
    reproduce the exact angle the subtractive solve found.
    """
    hip_local = tuple(attach["hip"])
    shoulder_local = tuple(attach["shoulder"])
    shoulder_offset = (shoulder_local[0] - hip_local[0], shoulder_local[1] - hip_local[1])
    world_offset = rig_compositor.rotate_offset(shoulder_offset, torso_deg)
    shoulder_world = (hip[0] + world_offset[0], hip[1] + world_offset[1])

    reach = math.hypot(knee_target[0] - shoulder_world[0], knee_target[1] - shoulder_world[1])
    lo, hi = abs(shoulder_len - forearm_len), shoulder_len + forearm_len

    # The pose is GIVEN (see SHOULDER_DRAPE_DEG above), not solved: place the elbow from
    # the shoulder at the drape angle, then the wrist from the elbow at the additive
    # forearm angle -- `side_view_rig.json`'s own `sign_convention.forearm`. The
    # wrist-to-knee distance below is therefore a MEASUREMENT of how close the drape
    # happens to rest, never a residual that was driven to zero.
    elbow_xy = rig_compositor.distal_joint(shoulder_world, shoulder_len, shoulder_deg)
    wrist = rig_compositor.distal_joint(elbow_xy, forearm_len, shoulder_deg + elbow_deg)
    distance = math.hypot(wrist[0] - knee_target[0], wrist[1] - knee_target[1])

    return ArmStance(
        shoulder_deg=shoulder_deg,
        elbow_deg=elbow_deg,
        wrist_xy=wrist,
        knee_target_xy=knee_target,
        wrist_to_knee_distance_native_px=distance,
        reach=reach,
        reach_workspace=(lo, hi),
        clamped=not (lo + 1e-6 < reach < hi - 1e-6),
    )


def _default_arm_stance() -> ArmStance:
    """Computed once at import time from the REAL committed rig + the default
    `CROUCH_STANCE` -- never a second, hand-copied set of attach numbers, so this
    can't silently drift from `side_view_rig.json`. `render_frames()` re-derives this
    fresh from the parts actually on disk every call (see below); this cached value is
    only the module-level rest-angle default `pose_at()` uses, the same role
    `CROUCH_STANCE` already plays for the legs."""
    rig = rig_compositor.load_rig()
    attach = rig["attach_torso_local_px"]
    leg = leg_stance()
    knee_r, _ = rig_compositor.leg_chain(leg.hip, THIGH_LEN, CALF_LEN, leg, "R")
    return arm_stance(SHOULDER_LEN, FOREARM_LEN, attach, leg.hip, knee_r)


ARM_STANCE = _default_arm_stance()
SHOULDER_DEG_CROUCH = ARM_STANCE.shoulder_deg
ELBOW_DEG_CROUCH = ARM_STANCE.elbow_deg


def pose_at(phase: float, torso_height: float) -> rig_compositor.UpperPose:
    """Resolve the upper-body pose. Reuses `char_gen.idle_cycle.breath` unchanged --
    same signal, same part (`torso.png`), as the standing idle -- but this pose's own
    `CROUCH_BREATH_RISE_FRAC`, `TORSO_LEAN_DEG`, and `SHOULDER_DEG_CROUCH`/
    `ELBOW_DEG_CROUCH` rather than `idle_cycle`'s standing-rest constants."""
    return rig_compositor.UpperPose(
        upper_dy=-CROUCH_BREATH_RISE_FRAC * torso_height * idle_cycle.breath(phase),
        shoulder_deg=SHOULDER_DEG_CROUCH,
        elbow_deg=ELBOW_DEG_CROUCH,
        head_deg=idle_cycle.HEAD_REST_DEG,
        torso_deg=TORSO_LEAN_DEG,
    )


def render_frames(frame_count: int = FRAME_COUNT, **kwargs) -> rig_compositor.RenderResult:
    """Composite the crouch-sit idle through the shared compositor, at the one shared
    `char_gen.character_scale.CHARACTER_SCALE` and `GROUND_ANCHOR_CELL_Y` -- never a
    scale derived from this pose's own height."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    stance = leg_stance(
        lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"]
    )
    kwargs.setdefault("z_override", CROUCH_Z_OVERRIDE)
    kwargs.setdefault("foot_flatten", {"calf_R": FRONT_FOOT_FLATTEN_DEG})
    return rig_compositor.render_frames(stance, pose_at, frame_count, **kwargs)


def render_comparison_image(
    crouch: rig_compositor.RenderResult,
    standing: rig_compositor.RenderResult,
    upscale: int = 6,
    gap_px: int = 16,
    background: tuple[int, int, int] = (32, 32, 36),
    line_color: tuple[int, int, int] = (220, 60, 60),
) -> Image.Image:
    """The corrected crouch beside the approved standing idle, at the SAME scale and on
    the SAME ground line -- the size match this card has to show, not just assert."""
    from PIL import ImageDraw

    crouch_cell = crouch.descended_frames[0]
    standing_cell = standing.descended_frames[0]
    cell_px = crouch.cell_px
    assert standing.cell_px == cell_px

    big_w = cell_px * upscale
    canvas = Image.new(
        "RGB", (big_w * 2 + gap_px * upscale, cell_px * upscale), background
    )
    for i, cell in enumerate((crouch_cell, standing_cell)):
        flat = Image.new("RGB", cell.size, background)
        flat.paste(cell, mask=cell.split()[3])
        big = flat.resize((big_w, cell_px * upscale), Image.Resampling.NEAREST)
        canvas.paste(big, (i * (big_w + gap_px * upscale), 0))

    draw = ImageDraw.Draw(canvas)
    ground_y = round(GROUND_ANCHOR_CELL_Y * upscale)
    draw.line([(0, ground_y), (canvas.width, ground_y)], fill=line_color, width=2)
    return canvas


def main() -> None:
    result = render_frames()
    standing = idle_cycle.render_frames()

    sheet_path = rig_compositor.save_sheet(
        result.descended_frames, EVIDENCE_DIR / "sitting_idle_sheet_48.png"
    )
    gif_path = rig_compositor.save_gif(
        result.descended_frames, EVIDENCE_DIR / "sitting_idle_loop_x8.gif"
    )
    comparison = render_comparison_image(result, standing)
    comparison_path = EVIDENCE_DIR / "scale_match_crouch_vs_standing.png"
    comparison_path.parent.mkdir(parents=True, exist_ok=True)
    comparison.save(comparison_path)

    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    attach = rig["attach_torso_local_px"]
    stance = crouch_stance(
        lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"]
    )
    leg = leg_stance(lengths["thigh_R"], lengths["calf_R"], lengths["thigh_L"], lengths["calf_L"],
                      stance=stance)
    knee_r, _ = rig_compositor.leg_chain(leg.hip, lengths["thigh_R"], lengths["calf_R"], leg, "R")
    knee_l, _ = rig_compositor.leg_chain(leg.hip, lengths["thigh_L"], lengths["calf_L"], leg, "L")
    arms = arm_stance(lengths["shoulder_R"], lengths["forearm_R"], attach, leg.hip, knee_r)

    crouch_final_h = result.native_figure_height * CHARACTER_SCALE
    standing_final_h = standing.native_figure_height * CHARACTER_SCALE

    stagger_separation_final_px = abs(stance.ankle_x_r - stance.ankle_x_l) * CHARACTER_SCALE

    report = {
        "frames": FRAME_COUNT,
        "cell_px": CELL_PX,
        "character_scale": CHARACTER_SCALE,
        "ground_anchor_cell_y": GROUND_ANCHOR_CELL_Y,
        "crouch_stance": {
            "ground_plane_y": stance.ground_plane_y,
            "hip_y": stance.hip_y,
            "torso_lean_deg": TORSO_LEAN_DEG,
            "feet_planted": FEET_PLANTED,
            "leg_r": {
                "ankle_x": stance.ankle_x_r,
                "thigh_deg": stance.thigh_deg_r,
                "knee_flexion_deg": stance.knee_flexion_deg_r,
                "role": "front (near, leads)",
            },
            "leg_l": {
                "ankle_x": stance.ankle_x_l,
                "thigh_deg": stance.thigh_deg_l,
                "knee_flexion_deg": stance.knee_flexion_deg_l,
                "role": "back (far, trails)",
            },
            "front_foot_flatten_deg": FRONT_FOOT_FLATTEN_DEG,
            "crouch_z_override": CROUCH_Z_OVERRIDE,
            "stagger_separation_final_px": stagger_separation_final_px,
        },
        "arm_stance": {
            "shoulder_deg": arms.shoulder_deg,
            "elbow_deg": arms.elbow_deg,
            "reach_native_px": arms.reach,
            "reach_workspace_native_px": list(arms.reach_workspace),
            "clamped": arms.clamped,
            "wrist_to_knee_distance_final_px": (
                arms.wrist_to_knee_distance_native_px * CHARACTER_SCALE
            ),
        },
        "contacts": {
            "hip_canvas_px": list(result.hip_px),
            "knee_r_canvas_px": list(result.knee_r_px),
            "knee_l_canvas_px": list(result.knee_l_px),
            "ankle_r_canvas_px": list(result.ankle_r_px),
            "ankle_l_canvas_px": list(result.ankle_l_px),
        },
        "native_figure_height_px": {
            "crouch": result.native_figure_height,
            "standing": standing.native_figure_height,
        },
        "final_figure_height_px_at_common_scale": {
            "crouch": crouch_final_h,
            "standing": standing_final_h,
        },
        "breath_rise_frac": {
            "crouch": CROUCH_BREATH_RISE_FRAC,
            "standing_idle_cycle": idle_cycle.BREATH_RISE_FRAC,
        },
        "upper_body_travel_final_px": {
            "crouch": CROUCH_BREATH_RISE_FRAC * rig_compositor.load_parts()["torso"].height
            * CHARACTER_SCALE,
        },
        "changed_px_per_frame_pair": result.changed_px_per_frame_pair,
        "loop_seam_changed_px": result.changed_px_per_frame_pair[-1],
        "lower_body_band": result.lower_body_band,
        "sheet": sheet_path.name,
        "gif": gif_path.name,
        "comparison": comparison_path.name,
    }

    rig_json_path = EVIDENCE_DIR / "rig.json"
    rig_json_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
