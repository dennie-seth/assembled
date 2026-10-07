"""Deterministic side-view crouch-sit idle loop, composited from the committed parts.

Round 2 (T-0269). Round 1 built a CHAIR SIT: both ends of the leg chain pinned (hip on
an abstract "seat plane", ankle a thigh-length forward on the ground), which resolved to
thigh 90.0 degrees (horizontal) and 90.00 degrees of knee flexion -- a character perched
on an invisible seat. Two corrections, both from @DennieSeth / the reviewer:

1. The base pose is a CROUCH, not a chair sit. There is no seat plane anywhere in this
   module -- no `seat_plane_y`, no hip-on-seat pin. The only ground constraint is both
   ankles on the ground plane. The hip is a free point, chosen directly: low, and
   roughly above the ankle, not projected a thigh-length forward. `crouch_stance()`
   solves the two leg angles that reach that chosen hip-to-ankle target with
   `char_gen.idle_cycle.solve_leg` -- a strictly deeper two-bone bend than round 1's.

2. ONE character world-to-pixel scale, shared with the standing idle, defined once in
   `char_gen.character_scale` -- never re-derived from this (or any other) pose's own
   height. Round 1 measured the SEATED figure's own 730.82px native height and derived
   a 0.05473 descent scale to force it to fill the same 40px figure cell as the
   standing idle, which rendered the crouched character ~37.5% LARGER than standing. At
   the shared scale the crouch simply occupies less vertical space than standing -- the
   correct result, not something to correct for.

The compositing machinery itself (part loading, pivot math, the calf_L length
correction, rotation padding, z-ordering, descent to the 48px cell) is NOT duplicated
here -- it lives once in `char_gen.rig_compositor`, generic over any pose. This module
supplies only the crouch's own `LegStance` and its own `phase -> UpperPose`.

The legs stay static across the loop -- hip and both ankles are fixed for every frame,
exactly as round 1 built it -- only the upper body breathes, reusing
`char_gen.idle_cycle.breath` unmodified (same signal, same `torso.png`, as the standing
idle). The amplitude is NOT reused unmodified: `BREATH_RISE_FRAC` at the corrected
0.0398 scale lands near 1.1px, well short of round 1's 1.52px margin, so this module
raises its own `CROUCH_BREATH_RISE_FRAC` to restore a comfortably visible breath -- see
the module docstring note near its definition.
"""
from __future__ import annotations

import json
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

FRAME_COUNT = 6

#: The crouch target, chosen directly rather than inherited from the leg's own segment
#: lengths (round 1's bug): the hip sits 300px above the ground plane -- lower than
#: round 1's chair-sit hip height (330.2px, the calf's own length) -- and directly
#: above the ankle (0px forward), i.e. "roughly over the heels" taken literally. Reach
#: from hip to ankle is 300px, well inside the leg's (83.5, 576.9)px workspace and a
#: full 27% shorter than round 1's 412.1px chair-sit reach -- the leg folds up visibly
#: more compactly, which is what "deep knee flexion" actually requires.
HIP_HEIGHT_ABOVE_GROUND = 300.0
HIP_FORWARD_OF_ANKLE = 0.0

#: Torso stays upright. A small forward lean was explicitly allowed by the card; this
#: module chooses not to use one -- a crouch reads clearly from the leg geometry alone,
#: and an upright torso keeps the already-approved torso/head/arm attachment math
#: (shared with the standing idle via `rig_compositor.build_placements`) untouched.
TORSO_LEAN_DEG = 0.0

#: Feet are planted FLAT. This module does not re-cut or re-pose the foot independently
#: of the calf -- the calf part's own baked-in foot shape (round 1's choice, unchanged)
#: is a fixed cutout at the end of the shin, not a separately articulated part, so
#: "flat" is the art's own existing silhouette rather than a newly decided pose.
FEET_PLANTED = "flat"

#: BREATH_RISE_FRAC (0.108) at the corrected 0.0398 scale lands at ~1.10px of travel
#: (0.108 * 257 * 0.0398) -- clears the 1px floor, but with far less margin than round
#: 1's 1.52px. Raised here, for this pose only, to restore a comfortably visible
#: breath: 0.15 * 257 * 0.0398 = ~1.53px, within a rounding error of round 1's own
#: number and still well under the 2px "bob, not breath" ceiling. `idle_cycle`'s own
#: BREATH_RISE_FRAC is untouched -- the standing idle keeps its own calibration.
CROUCH_BREATH_RISE_FRAC = 0.15


@dataclass(frozen=True)
class CrouchStance:
    """The crouch base pose: a rig configuration, not a generated image. The only
    ground constraint is `ground_plane_y`, which both ankles rest on. The hip is a free
    point -- `hip_height_above_ground` above the ground, `hip_forward_of_ankle_x` ahead
    of the ankle -- chosen directly, never pinned to a seat or any other plane."""
    ground_plane_y: float
    hip_y: float
    hip_forward_of_ankle_x: float
    thigh_deg: float
    knee_flexion_deg: float


def crouch_stance(
    thigh_len: float = THIGH_LEN, calf_len: float = CALF_LEN,
    hip_height_above_ground: float = HIP_HEIGHT_ABOVE_GROUND,
    hip_forward_of_ankle: float = HIP_FORWARD_OF_ANKLE,
) -> CrouchStance:
    """Solve the crouch base pose once. The hip sits at `(0, 0)`; the ankle target is
    `hip_forward_of_ankle` forward and `hip_height_above_ground` below it --
    `char_gen.idle_cycle.solve_leg` resolves the two-bone chain that reaches it. Reused
    unchanged for every frame, which is what makes the legs static by construction."""
    ik = idle_cycle.solve_leg(
        (0.0, 0.0), (hip_forward_of_ankle, hip_height_above_ground), thigh_len, calf_len
    )
    return CrouchStance(
        ground_plane_y=hip_height_above_ground,
        hip_y=0.0,
        hip_forward_of_ankle_x=hip_forward_of_ankle,
        thigh_deg=ik.thigh_deg,
        knee_flexion_deg=ik.knee_flexion_deg,
    )


#: The canonical crouch pose this module ships -- committed numbers, not re-derived per
#: call, using the default (non-measured) bone lengths above. `render_frames()` always
#: solves again from the real, measured parts; this is only a convenience default.
CROUCH_STANCE = crouch_stance()


def leg_stance(thigh_len: float = THIGH_LEN, calf_len: float = CALF_LEN,
               stance: CrouchStance | None = None) -> rig_compositor.LegStance:
    st = stance if stance is not None else crouch_stance(thigh_len, calf_len)
    return rig_compositor.LegStance(
        hip=(0.0, st.hip_y),
        ground_plane_y=st.ground_plane_y,
        thigh_deg=st.thigh_deg,
        knee_flexion_deg=st.knee_flexion_deg,
        far_leg_offset_frac=idle_cycle.FAR_LEG_OFFSET_FRAC,
    )


def pose_at(phase: float, torso_height: float) -> rig_compositor.UpperPose:
    """Resolve the upper-body pose. Reuses `char_gen.idle_cycle.breath` unchanged --
    same signal, same part (`torso.png`), as the standing idle -- but this pose's own
    `CROUCH_BREATH_RISE_FRAC`, raised to stay visible at the corrected shared scale."""
    return rig_compositor.UpperPose(
        upper_dy=-CROUCH_BREATH_RISE_FRAC * torso_height * idle_cycle.breath(phase),
        shoulder_deg=idle_cycle.SHOULDER_REST_DEG,
        elbow_deg=idle_cycle.ELBOW_REST_DEG,
        head_deg=idle_cycle.HEAD_REST_DEG,
    )


def render_frames(frame_count: int = FRAME_COUNT, **kwargs) -> rig_compositor.RenderResult:
    """Composite the crouch-sit idle through the shared compositor, at the one shared
    `char_gen.character_scale.CHARACTER_SCALE` and `GROUND_ANCHOR_CELL_Y` -- never a
    scale derived from this pose's own height."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    stance = leg_stance(lengths["thigh_R"], lengths["calf_R"])
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

    stance = crouch_stance()
    crouch_final_h = result.native_figure_height * CHARACTER_SCALE
    standing_final_h = standing.native_figure_height * CHARACTER_SCALE

    torso_width = rig_compositor.load_parts()["torso"].width
    far_leg_dx = idle_cycle.FAR_LEG_OFFSET_FRAC * torso_width
    ankle_r = (stance.hip_forward_of_ankle_x, stance.ground_plane_y)
    ankle_l = (stance.hip_forward_of_ankle_x + far_leg_dx, stance.ground_plane_y)

    report = {
        "frames": FRAME_COUNT,
        "cell_px": CELL_PX,
        "character_scale": CHARACTER_SCALE,
        "ground_anchor_cell_y": GROUND_ANCHOR_CELL_Y,
        "crouch_stance": {
            "ground_plane_y": stance.ground_plane_y,
            "hip_y": stance.hip_y,
            "hip_forward_of_ankle_x": stance.hip_forward_of_ankle_x,
            "thigh_deg": stance.thigh_deg,
            "knee_flexion_deg": stance.knee_flexion_deg,
            "torso_lean_deg": TORSO_LEAN_DEG,
            "feet_planted": FEET_PLANTED,
        },
        "contacts": {
            "hip_xy": [0.0, stance.hip_y],
            "ankle_r_xy": list(ankle_r),
            "ankle_l_xy": list(ankle_l),
            "hip_canvas_px": list(result.hip_px),
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
        "sheet": str(sheet_path),
        "gif": str(gif_path),
        "comparison": str(comparison_path),
    }

    rig_json_path = EVIDENCE_DIR / "rig.json"
    rig_json_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
