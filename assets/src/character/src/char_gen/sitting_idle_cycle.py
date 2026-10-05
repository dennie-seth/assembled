"""Deterministic side-view sitting-idle loop, composited from the committed parts.

Third user of the walk's own reference path: hand-cut parts -> post-process key ->
deterministic rig and gait. No GPU, no sampling -- the same inputs always produce the same
frames. Unlike the walk and the standing idle, this card also has to DEFINE the pose it
builds from: there is no committed `seated`/`sit` symbol anywhere in `char_gen`.

The seated base pose
---------------------
Both ends of the leg chain are pinned: the hip rests on a **seat plane** and the ankle
rests on a **ground plane**. `char_gen.idle_cycle.solve_leg` already solves a two-bone
chain from a hip to a *fixed* ankle -- here both ends are fixed, so the solve has nothing
left to curve. The chosen planes put the ankle `(hip_forward_x, ground_plane_y)` below and
ahead of the hip, which resolves to a thigh ~90 degrees forward (horizontal) and a knee
flexion ~90 degrees (calf hanging near-vertical) -- a plain chair-sitting silhouette, not
tuned by eye. `seated_stance()` runs this solve once; every frame reuses the same angles,
so the legs are IDENTICAL in every frame and the two contacts cannot drift.

That leaves the upper body as the only thing in motion, which is exactly the shape of the
approved standing idle: `char_gen.idle_cycle.breath` and its `BREATH_RISE_FRAC` calibration
are reused unmodified, because the signal (the torso/head/arms rising and falling as one
piece) and the part (the same `torso.png`) are identical between the two poses. The legs
never see the breath signal at all -- they attach to the hip anchor directly, while the
torso (and everything that hangs from it) attaches to that SAME anchor offset by the
breath, so the two visibly decouple exactly the way idle's own first working version did.

Compositor
----------
Reads the ten committed parts and `side_view_rig.json` directly -- pivots, z-order, the
torso's neck/shoulder/hip attach points, and the calf_L length-scale correction all come
from that file, not from numbers re-typed here. `char_gen.walk_cycle.distal_joint`'s sign
convention (a positive angle swings a downward-hanging part's tip toward +x) is reused
as-is; `Image.rotate(angle_deg, center=pivot_px)` was checked empirically to agree with it.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen.idle_cycle import (
    BREATH_RISE_FRAC,
    ELBOW_REST_DEG,
    FAR_LEG_OFFSET_FRAC,
    HEAD_REST_DEG,
    SHOULDER_REST_DEG,
    ankle_of,  # noqa: F401  (re-exported for the forward-kinematics check in tests)
    breath,
    solve_leg,
)
from char_gen.idle_cycle import (
    LegIK as SeatedLegIK,  # noqa: F401  (re-exported: same two-bone IK, both ends pinned)
)
from char_gen.walk_cycle import bone_length, distal_joint

#: The ten parts this animation is built from. No re-cut, no re-key -- consumed as they
#: stand under assets/src/character/parts/side_view/.
PART_NAMES = [
    "head", "torso",
    "shoulder_R", "shoulder_L", "forearm_R", "forearm_L",
    "thigh_R", "thigh_L", "calf_R", "calf_L",
]

PARTS_DIR = Path(__file__).resolve().parents[2] / "parts" / "side_view"
RIG_PATH = PARTS_DIR / "side_view_rig.json"
_REPO_ROOT = Path(__file__).resolve().parents[5]
EVIDENCE_DIR = _REPO_ROOT / "docs" / "assets" / "evidence" / "T-0269"

#: Measured bone lengths, same parts as the walk/standing idle (side_view_rig.json /
#: docs/assets/evidence/T-0430/rig.json): thighs measure equal; both calves measure equal
#: once calf_L's own rig-recorded length-scale correction is applied.
THIGH_LEN = 246.7
CALF_LEN = 330.2

FRAME_COUNT = 6
CELL_PX = 48
FIGURE_PX = 40


@dataclass(frozen=True)
class SeatedStance:
    """The seated base pose: a rig configuration, not a generated image. Both contact
    planes plus the two leg angles they resolve to."""
    seat_plane_y: float
    ground_plane_y: float
    hip_forward_x: float
    thigh_deg: float
    knee_flexion_deg: float


def seated_stance(thigh_len: float = THIGH_LEN, calf_len: float = CALF_LEN) -> SeatedStance:
    """Solve the seated base pose once. The hip sits at the seat plane (y=0); the ankle
    sits on the ground plane directly below the knee, with the thigh projected forward by
    its own length -- a neutral chair-sitting target, not a clamped guess. Reused unchanged
    for every frame, which is what makes the legs static by construction."""
    ground_plane_y = calf_len
    hip_forward_x = thigh_len
    ik = solve_leg((0.0, 0.0), (hip_forward_x, ground_plane_y), thigh_len, calf_len)
    return SeatedStance(
        seat_plane_y=0.0,
        ground_plane_y=ground_plane_y,
        hip_forward_x=hip_forward_x,
        thigh_deg=ik.thigh_deg,
        knee_flexion_deg=ik.knee_flexion_deg,
    )


#: The canonical seated pose this module ships -- committed numbers, not re-derived per
#: call. State these in the run report: thigh/knee-flexion degrees, seat/ground plane y.
SEATED_STANCE = seated_stance()


@dataclass(frozen=True)
class SittingIdlePose:
    """Resolved pose at one phase. `upper_dy` is the only field that varies across the
    loop -- everything else is the seated base pose, held constant."""
    upper_dy: float
    shoulder_deg: float = SHOULDER_REST_DEG
    elbow_deg: float = ELBOW_REST_DEG
    head_deg: float = HEAD_REST_DEG
    torso_deg: float = 0.0
    thigh_deg: float = SEATED_STANCE.thigh_deg
    knee_flexion_deg: float = SEATED_STANCE.knee_flexion_deg


def pose_at(phase: float, torso_height: float, stance: SeatedStance | None = None
            ) -> SittingIdlePose:
    """Resolve the pose. Reuses `char_gen.idle_cycle.breath`/`BREATH_RISE_FRAC` unchanged --
    same signal, same part (`torso.png`), as the standing idle."""
    st = stance if stance is not None else SEATED_STANCE
    return SittingIdlePose(
        upper_dy=-BREATH_RISE_FRAC * torso_height * breath(phase),
        thigh_deg=st.thigh_deg,
        knee_flexion_deg=st.knee_flexion_deg,
    )


# --------------------------------------------------------------- measured geometry ----

def load_rig(rig_path: Path = RIG_PATH) -> dict:
    return json.loads(rig_path.read_text())


def load_parts(parts_dir: Path = PARTS_DIR) -> dict[str, Image.Image]:
    return {name: Image.open(parts_dir / f"{name}.png").convert("RGBA") for name in PART_NAMES}


def _calf_l_scale(rig: dict) -> float:
    return float(rig["bone_length_fix"]["scaled"]["calf_L"])


def _scaled_parts(parts: dict[str, Image.Image], rig: dict) -> dict[str, Image.Image]:
    """calf_L carries the rig's own length-scale correction -- its upper portion is
    occluded by the near leg in a side view, so the cut is short even though the bone is
    not. Scaling the part restores the bone; the normalized pivot keeps the chain intact."""
    scale = _calf_l_scale(rig)
    out = dict(parts)
    w, h = parts["calf_L"].size
    out["calf_L"] = parts["calf_L"].resize(
        (round(w * scale), round(h * scale)), Image.Resampling.LANCZOS
    )
    return out


def measured_bone_lengths(parts: dict[str, Image.Image], rig: dict) -> dict[str, float]:
    """`bone_length(height, pivot_y)` for every part, read from the rig JSON's own pivot
    fractions -- no pixel size is hardcoded in this module."""
    scaled = _scaled_parts(parts, rig)
    return {
        name: bone_length(scaled[name].height, rig["rig"][name]["pivot"][1])
        for name in PART_NAMES
    }


def native_figure_height(parts: dict[str, Image.Image], rig: dict) -> float:
    """Topmost head pixel to the ground plane, at rest (upper_dy=0) -- the reference
    height the descent scale is measured against, not eyeballed."""
    scaled = _scaled_parts(parts, rig)
    lengths = measured_bone_lengths(parts, rig)
    attach = rig["attach_torso_local_px"]
    head_h = scaled["head"].height
    head_pivot_y = rig["rig"]["head"]["pivot"][1]

    stance = seated_stance(lengths["thigh_R"], lengths["calf_R"])
    torso_origin_y = stance.seat_plane_y - attach["hip"][1]  # upper_dy == 0 at rest
    head_top_y = torso_origin_y + attach["neck"][1] - head_h * head_pivot_y
    return stance.ground_plane_y - head_top_y


# ------------------------------------------------------------------- compositing ----

@dataclass
class _Placement:
    name: str
    image: Image.Image
    pivot_px: tuple[float, float]
    target_xy: tuple[float, float]
    z: int


def _pad_for_rotation(
    img: Image.Image, pivot_px: tuple[float, float]
) -> tuple[Image.Image, tuple[float, float]]:
    """Embed `img` in a transparent square big enough that rotating it by ANY angle about
    `pivot_px` cannot clip content.

    `Image.rotate(..., expand=False)` keeps the ORIGINAL canvas size, which silently clips
    a non-square part at a large rotation -- the seated thigh's ~90 degree swing (175x257,
    portrait) needs ~257px of horizontal room once rotated, and the unpadded 175px-wide
    canvas cut it off. The diagonal of the source image is a safe upper bound on the
    distance from any interior point (the pivot included) to any other point in it, so
    padding to twice that in every direction, centred on the pivot, is always enough.
    """
    radius = math.ceil(math.hypot(img.width, img.height)) + 2
    side = 2 * radius
    pad_left = radius - round(pivot_px[0])
    pad_top = radius - round(pivot_px[1])
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(img, dest=(pad_left, pad_top))
    new_pivot = (pivot_px[0] + pad_left, pivot_px[1] + pad_top)
    return canvas, new_pivot


def _placements(
    phase: float,
    scaled: dict[str, Image.Image],
    rig_entries: dict,
    attach: dict,
    stance: SeatedStance,
    lengths: dict[str, float],
) -> list[_Placement]:
    torso = scaled["torso"]
    pose = pose_at(phase, torso.height, stance=stance)

    def pivot_of(name: str) -> tuple[float, float]:
        img = scaled[name]
        fx, fy = rig_entries[name]["pivot"]
        return (img.width * fx, img.height * fy)

    def place(name: str, angle_deg: float, target: tuple[float, float]) -> _Placement:
        img = scaled[name]
        pivot_px = pivot_of(name)
        if angle_deg:
            img, pivot_px = _pad_for_rotation(img, pivot_px)
            img = img.rotate(
                angle_deg, center=pivot_px, resample=Image.Resampling.BICUBIC, expand=False
            )
        return _Placement(name, img, pivot_px, target, rig_entries[name]["z"])

    placements: list[_Placement] = []

    hip = (0.0, stance.seat_plane_y)
    torso_tl = (hip[0] - attach["hip"][0], hip[1] - attach["hip"][1] + pose.upper_dy)
    placements.append(
        _Placement("torso", torso, (0.0, 0.0), torso_tl, rig_entries["torso"]["z"])
    )

    neck_world = (torso_tl[0] + attach["neck"][0], torso_tl[1] + attach["neck"][1])
    placements.append(place("head", pose.head_deg, neck_world))

    shoulder_world = (torso_tl[0] + attach["shoulder"][0], torso_tl[1] + attach["shoulder"][1])
    for side in ("R", "L"):
        sh_name, fa_name = f"shoulder_{side}", f"forearm_{side}"
        placements.append(place(sh_name, pose.shoulder_deg, shoulder_world))
        elbow = distal_joint(shoulder_world, lengths[sh_name], pose.shoulder_deg)
        placements.append(place(fa_name, pose.shoulder_deg + pose.elbow_deg, elbow))

    far_leg_dx = FAR_LEG_OFFSET_FRAC * torso.width
    for side, dx in (("R", 0.0), ("L", far_leg_dx)):
        hip_side = (hip[0] + dx, hip[1])
        th_name, cf_name = f"thigh_{side}", f"calf_{side}"
        placements.append(place(th_name, pose.thigh_deg, hip_side))
        knee = distal_joint(hip_side, lengths[th_name], pose.thigh_deg)
        calf_deg = pose.thigh_deg - pose.knee_flexion_deg
        placements.append(place(cf_name, calf_deg, knee))

    return placements


def _placement_bbox(placements: list[_Placement]) -> tuple[float, float, float, float]:
    tls = [(p.target_xy[0] - p.pivot_px[0], p.target_xy[1] - p.pivot_px[1]) for p in placements]
    brs = [(tl[0] + p.image.width, tl[1] + p.image.height) for tl, p in zip(tls, placements)]
    return (
        min(tl[0] for tl in tls), min(tl[1] for tl in tls),
        max(br[0] for br in brs), max(br[1] for br in brs),
    )


@dataclass
class RenderResult:
    native_frames: list[Image.Image]
    descended_frames: list[Image.Image]
    cell_px: int
    figure_px: int
    descent_scale: float
    native_figure_height: float
    lower_body_band: tuple[int, int, int, int]
    changed_px_per_frame_pair: list[int]
    upper_body_travel_final_px: float
    stance: SeatedStance


def render_frames(
    parts_dir: Path = PARTS_DIR,
    rig_path: Path = RIG_PATH,
    frame_count: int = FRAME_COUNT,
    cell_px: int = CELL_PX,
    figure_px: int = FIGURE_PX,
) -> RenderResult:
    parts = load_parts(parts_dir)
    rig = load_rig(rig_path)
    scaled = _scaled_parts(parts, rig)
    rig_entries = rig["rig"]
    attach = rig["attach_torso_local_px"]
    lengths = measured_bone_lengths(parts, rig)
    stance = seated_stance(lengths["thigh_R"], lengths["calf_R"])

    phases = [i / frame_count for i in range(frame_count)]
    all_placements = [
        _placements(ph, scaled, rig_entries, attach, stance, lengths) for ph in phases
    ]

    margin = 4.0
    boxes = [_placement_bbox(pl) for pl in all_placements]
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

    fig_h = native_figure_height(parts, rig)
    scale = figure_px / fig_h
    descended_frames = [
        f.resize(
            (max(1, round(f.width * scale)), max(1, round(f.height * scale))),
            Image.Resampling.LANCZOS,
        )
        for f in native_frames
    ]

    bottom_margin = max(0.0, (cell_px - figure_px) / 2.0)
    ground_canvas_y = stance.ground_plane_y + offset[1]
    ground_descended_y = ground_canvas_y * scale
    cell_frames = []
    for d in descended_frames:
        cell = Image.new("RGBA", (cell_px, cell_px), (0, 0, 0, 0))
        dest_x = round((cell_px - d.width) / 2.0)
        dest_y = round(cell_px - bottom_margin - ground_descended_y)
        cell.alpha_composite(d, dest=(dest_x, dest_y))
        cell_frames.append(cell)

    leg_names = {"thigh_R", "thigh_L", "calf_R", "calf_L"}
    upper_body_names = {"torso", "head", "shoulder_R", "shoulder_L", "forearm_R", "forearm_L"}
    leg_box = _placement_bbox([p for p in all_placements[0] if p.name in leg_names])
    # Everything that rides the breath (torso, head, both arms) overlaps the top of the leg
    # bounding box near the hip -- anatomically unavoidable, since that is where the upper
    # body meets the legs, and a side-view forearm hangs down past the thigh. Clip the band
    # to start just below the upper body's own lowest reach across every phase, so the band
    # is provably free of anything that moves and the equality check below cannot be
    # confounded by it -- it covers both knees and both ankles either way.
    upper_body_max_bottom = max(
        p.target_xy[1] - p.pivot_px[1] + p.image.height
        for pl in all_placements
        for p in pl
        if p.name in upper_body_names
    )
    band_top = max(leg_box[1], upper_body_max_bottom + 1.0)
    lower_body_band = (
        max(0, math.floor(leg_box[0] + offset[0])),
        max(0, math.floor(band_top + offset[1])),
        min(canvas_w, math.ceil(leg_box[2] + offset[0])),
        min(canvas_h, math.ceil(leg_box[3] + offset[1])),
    )

    arrays = [np.asarray(f) for f in native_frames]
    changed_px = [
        int(np.count_nonzero(np.any(arrays[i] != arrays[(i + 1) % frame_count], axis=-1)))
        for i in range(frame_count)
    ]

    upper_body_travel_final_px = BREATH_RISE_FRAC * scaled["torso"].height * scale

    return RenderResult(
        native_frames=native_frames,
        descended_frames=cell_frames,
        cell_px=cell_px,
        figure_px=figure_px,
        descent_scale=scale,
        native_figure_height=fig_h,
        lower_body_band=lower_body_band,
        changed_px_per_frame_pair=changed_px,
        upper_body_travel_final_px=upper_body_travel_final_px,
        stance=stance,
    )


def save_sheet(frames: list[Image.Image], out_path: Path | str) -> Path:
    cell_w, cell_h = frames[0].size
    sheet = Image.new("RGBA", (cell_w * len(frames), cell_h), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        sheet.alpha_composite(frame, dest=(i * cell_w, 0))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    return out_path


def save_gif(
    frames: list[Image.Image],
    out_path: Path | str,
    upscale: int = 8,
    duration_ms: int = 140,
    background: tuple[int, int, int] = (32, 32, 36),
) -> Path:
    """An integer-upscaled looping preview. GIF has no real alpha, so each frame is
    flattened onto a flat background colour first -- a review aid, not a shipped asset."""
    flattened = []
    for frame in frames:
        flat = Image.new("RGB", frame.size, background)
        flat.paste(frame, mask=frame.split()[3])
        big = flat.resize(
            (frame.width * upscale, frame.height * upscale), Image.Resampling.NEAREST
        )
        flattened.append(big.convert("P", palette=Image.Palette.ADAPTIVE, colors=256))

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    flattened[0].save(
        out_path,
        save_all=True,
        append_images=flattened[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
    )
    return out_path


def main() -> None:
    result = render_frames()
    sheet_path = save_sheet(result.descended_frames, EVIDENCE_DIR / "sitting_idle_sheet_48.png")
    gif_path = save_gif(result.descended_frames, EVIDENCE_DIR / "sitting_idle_loop_x8.gif")

    report = {
        "frames": FRAME_COUNT,
        "cell_px": result.cell_px,
        "figure_px": result.figure_px,
        "descent_scale": result.descent_scale,
        "native_figure_height_px": result.native_figure_height,
        "seated_stance": {
            "seat_plane_y": result.stance.seat_plane_y,
            "ground_plane_y": result.stance.ground_plane_y,
            "hip_forward_x": result.stance.hip_forward_x,
            "thigh_deg": result.stance.thigh_deg,
            "knee_flexion_deg": result.stance.knee_flexion_deg,
        },
        "upper_body_travel_final_px": result.upper_body_travel_final_px,
        "changed_px_per_frame_pair": result.changed_px_per_frame_pair,
        "loop_seam_changed_px": result.changed_px_per_frame_pair[-1],
        "lower_body_band": result.lower_body_band,
        "sheet": str(sheet_path),
        "gif": str(gif_path),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
