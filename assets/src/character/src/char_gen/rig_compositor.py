"""Generic part-compositing machinery shared by every side-view pose animation.

Factored out of T-0269 round 1's `sitting_idle_cycle` (round 2) so a new pose does not
duplicate part-loading, pivot math, the calf_L length correction, or the
rotation-padding fix -- it supplies its own leg stance (a fixed hip and both leg
angles) and its own per-phase upper-body pose, and gets a compositor for free.

A pose module (`char_gen.idle_cycle`, `char_gen.sitting_idle_cycle`) is responsible for:
* its own `LegStance` (hip position, ground plane, thigh/knee angles -- phase-independent)
* its own `phase -> UpperPose` function (only the upper body may vary with phase)

Everything else -- loading the ten committed parts, reading `side_view_rig.json`,
rotating a part about its own pivot without clipping, z-ordering, and descending to the
48px cell at the one shared `char_gen.character_scale.CHARACTER_SCALE` -- lives here,
once.
"""
from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, GROUND_ANCHOR_CELL_Y, figure_height
from char_gen.walk_cycle import bone_length, distal_joint

#: The ten parts every side-view animation is built from. No re-cut, no re-key --
#: consumed as they stand under assets/src/character/parts/side_view/.
PART_NAMES = [
    "head", "torso",
    "shoulder_R", "shoulder_L", "forearm_R", "forearm_L",
    "thigh_R", "thigh_L", "calf_R", "calf_L",
]

PARTS_DIR = Path(__file__).resolve().parents[2] / "parts" / "side_view"
RIG_PATH = PARTS_DIR / "side_view_rig.json"


def load_rig(rig_path: Path = RIG_PATH) -> dict:
    return json.loads(rig_path.read_text())


def load_parts(parts_dir: Path = PARTS_DIR) -> dict[str, Image.Image]:
    return {name: Image.open(parts_dir / f"{name}.png").convert("RGBA") for name in PART_NAMES}


def calf_l_scale(rig: dict) -> float:
    return float(rig["bone_length_fix"]["scaled"]["calf_L"])


def scaled_parts(parts: dict[str, Image.Image], rig: dict) -> dict[str, Image.Image]:
    """calf_L carries the rig's own length-scale correction -- its upper portion is
    occluded by the near leg in a side view, so the cut is short even though the bone is
    not. Scaling the part restores the bone; the normalized pivot keeps the chain intact."""
    scale = calf_l_scale(rig)
    out = dict(parts)
    w, h = parts["calf_L"].size
    out["calf_L"] = parts["calf_L"].resize(
        (round(w * scale), round(h * scale)), Image.Resampling.LANCZOS
    )
    return out


def measured_bone_lengths(parts: dict[str, Image.Image], rig: dict) -> dict[str, float]:
    """`bone_length(height, pivot_y)` for every part, read from the rig JSON's own pivot
    fractions -- no pixel size is hardcoded in any pose module."""
    scaled = scaled_parts(parts, rig)
    return {
        name: bone_length(scaled[name].height, rig["rig"][name]["pivot"][1])
        for name in PART_NAMES
    }


@dataclass(frozen=True)
class UpperPose:
    """Resolved upper-body pose at one phase. Only `upper_dy` is meant to vary across a
    loop -- the rest is each pose's own rest configuration, held constant."""
    upper_dy: float
    shoulder_deg: float
    elbow_deg: float
    head_deg: float


@dataclass(frozen=True)
class LegStance:
    """Phase-independent leg geometry: a fixed hip and both leg angles. Both ankles rest
    on `ground_plane_y` -- the only ground contact any pose needs. No seat, chair, or
    other plane is part of this shape; a pose that wants one hip-pinning convention or
    another expresses it when it computes `hip`, not here."""
    hip: tuple[float, float]
    ground_plane_y: float
    thigh_deg: float
    knee_flexion_deg: float
    far_leg_offset_frac: float


@dataclass
class Placement:
    name: str
    image: Image.Image
    pivot_px: tuple[float, float]
    target_xy: tuple[float, float]
    z: int


def pad_for_rotation(
    img: Image.Image, pivot_px: tuple[float, float]
) -> tuple[Image.Image, tuple[float, float]]:
    """Embed `img` in a transparent square big enough that rotating it by ANY angle about
    `pivot_px` cannot clip content.

    `Image.rotate(..., expand=False)` keeps the ORIGINAL canvas size, which silently
    clips a non-square part at a large rotation -- a deep knee bend's thigh swing needs
    real horizontal room once rotated, and an unpadded canvas cuts it off. The diagonal
    of the source image is a safe upper bound on the distance from any interior point
    (the pivot included) to any other point in it, so padding to twice that in every
    direction, centred on the pivot, is always enough -- for a 90-degree swing or a
    much deeper one.
    """
    radius = math.ceil(math.hypot(img.width, img.height)) + 2
    side = 2 * radius
    pad_left = radius - round(pivot_px[0])
    pad_top = radius - round(pivot_px[1])
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(img, dest=(pad_left, pad_top))
    new_pivot = (pivot_px[0] + pad_left, pivot_px[1] + pad_top)
    return canvas, new_pivot


def build_placements(
    upper: UpperPose,
    leg: LegStance,
    scaled: dict[str, Image.Image],
    rig_entries: dict,
    attach: dict,
    lengths: dict[str, float],
) -> list[Placement]:
    """Place all ten parts for one phase. Generic over pose: the hip, both leg angles
    and the far-leg offset all come from `leg`; the only thing that may differ frame to
    frame is `upper.upper_dy`."""
    torso = scaled["torso"]

    def pivot_of(name: str) -> tuple[float, float]:
        img = scaled[name]
        fx, fy = rig_entries[name]["pivot"]
        return (img.width * fx, img.height * fy)

    def place(name: str, angle_deg: float, target: tuple[float, float]) -> Placement:
        img = scaled[name]
        pivot_px = pivot_of(name)
        if angle_deg:
            img, pivot_px = pad_for_rotation(img, pivot_px)
            img = img.rotate(
                angle_deg, center=pivot_px, resample=Image.Resampling.BICUBIC, expand=False
            )
        return Placement(name, img, pivot_px, target, rig_entries[name]["z"])

    placements: list[Placement] = []

    hip = leg.hip
    torso_tl = (hip[0] - attach["hip"][0], hip[1] - attach["hip"][1] + upper.upper_dy)
    placements.append(Placement("torso", torso, (0.0, 0.0), torso_tl, rig_entries["torso"]["z"]))

    neck_world = (torso_tl[0] + attach["neck"][0], torso_tl[1] + attach["neck"][1])
    placements.append(place("head", upper.head_deg, neck_world))

    shoulder_world = (torso_tl[0] + attach["shoulder"][0], torso_tl[1] + attach["shoulder"][1])
    for side in ("R", "L"):
        sh_name, fa_name = f"shoulder_{side}", f"forearm_{side}"
        placements.append(place(sh_name, upper.shoulder_deg, shoulder_world))
        elbow = distal_joint(shoulder_world, lengths[sh_name], upper.shoulder_deg)
        placements.append(place(fa_name, upper.shoulder_deg + upper.elbow_deg, elbow))

    far_leg_dx = leg.far_leg_offset_frac * torso.width
    for side, dx in (("R", 0.0), ("L", far_leg_dx)):
        hip_side = (hip[0] + dx, hip[1])
        th_name, cf_name = f"thigh_{side}", f"calf_{side}"
        placements.append(place(th_name, leg.thigh_deg, hip_side))
        knee = distal_joint(hip_side, lengths[th_name], leg.thigh_deg)
        calf_deg = leg.thigh_deg - leg.knee_flexion_deg
        placements.append(place(cf_name, calf_deg, knee))

    return placements


def placement_bbox(placements: list[Placement]) -> tuple[float, float, float, float]:
    tls = [(p.target_xy[0] - p.pivot_px[0], p.target_xy[1] - p.pivot_px[1]) for p in placements]
    brs = [(tl[0] + p.image.width, tl[1] + p.image.height) for tl, p in zip(tls, placements)]
    return (
        min(tl[0] for tl in tls), min(tl[1] for tl in tls),
        max(br[0] for br in brs), max(br[1] for br in brs),
    )


LEG_PART_NAMES = {"thigh_R", "thigh_L", "calf_R", "calf_L"}
UPPER_BODY_PART_NAMES = {"torso", "head", "shoulder_R", "shoulder_L", "forearm_R", "forearm_L"}


@dataclass
class RenderResult:
    native_frames: list[Image.Image]
    descended_frames: list[Image.Image]
    cell_px: int
    character_scale: float
    ground_anchor_cell_y: float
    native_figure_height: float
    lower_body_band: tuple[int, int, int, int]
    changed_px_per_frame_pair: list[int]
    leg: LegStance
    torso_px_size: tuple[int, int]


def render_frames(
    leg: LegStance,
    upper_pose_at: Callable[[float, float], UpperPose],
    frame_count: int,
    *,
    cell_px: int = CELL_PX,
    character_scale: float = CHARACTER_SCALE,
    ground_anchor_cell_y: float = GROUND_ANCHOR_CELL_Y,
    parts_dir: Path = PARTS_DIR,
    rig_path: Path = RIG_PATH,
) -> RenderResult:
    """Composite `frame_count` frames for one pose. `character_scale` and
    `ground_anchor_cell_y` default to the one shared convention in
    `char_gen.character_scale` -- a caller only overrides them in a test that is
    specifically checking the shared-scale behaviour itself."""
    parts = load_parts(parts_dir)
    rig = load_rig(rig_path)
    scaled = scaled_parts(parts, rig)
    rig_entries = rig["rig"]
    attach = rig["attach_torso_local_px"]
    lengths = measured_bone_lengths(parts, rig)
    torso_height = scaled["torso"].height

    phases = [i / frame_count for i in range(frame_count)]
    all_placements = [
        build_placements(upper_pose_at(ph, torso_height), leg, scaled, rig_entries, attach,
                          lengths)
        for ph in phases
    ]

    margin = 4.0
    boxes = [placement_bbox(pl) for pl in all_placements]
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

    descended_frames_native_space = [
        f.resize(
            (max(1, round(f.width * character_scale)), max(1, round(f.height * character_scale))),
            Image.Resampling.LANCZOS,
        )
        for f in native_frames
    ]

    ground_canvas_y = leg.ground_plane_y + offset[1]
    ground_descended_y = ground_canvas_y * character_scale
    cell_frames = []
    for d in descended_frames_native_space:
        cell = Image.new("RGBA", (cell_px, cell_px), (0, 0, 0, 0))
        dest_x = round((cell_px - d.width) / 2.0)
        dest_y = round(ground_anchor_cell_y - ground_descended_y)
        cell.alpha_composite(d, dest=(dest_x, dest_y))
        cell_frames.append(cell)

    leg_box = placement_bbox([p for p in all_placements[0] if p.name in LEG_PART_NAMES])
    # Everything that rides the breath (torso, head, both arms) overlaps the top of the
    # leg bounding box near the hip -- anatomically unavoidable, since that is where the
    # upper body meets the legs. Clip the band to start just below the upper body's own
    # lowest reach across every phase, so the band is provably free of anything that
    # moves and still covers both knees and both ankles.
    upper_body_max_bottom = max(
        p.target_xy[1] - p.pivot_px[1] + p.image.height
        for pl in all_placements
        for p in pl
        if p.name in UPPER_BODY_PART_NAMES
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

    native_fig_h = figure_height(leg.hip[1], leg.ground_plane_y, attach,
                                  scaled["head"].height, rig_entries["head"]["pivot"][1])

    return RenderResult(
        native_frames=native_frames,
        descended_frames=cell_frames,
        cell_px=cell_px,
        character_scale=character_scale,
        ground_anchor_cell_y=ground_anchor_cell_y,
        native_figure_height=native_fig_h,
        lower_body_band=lower_body_band,
        changed_px_per_frame_pair=changed_px,
        leg=leg,
        torso_px_size=scaled["torso"].size,
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
