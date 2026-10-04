"""Deterministic side-view idle compositor.

Rotates nothing: every part in idle sits at a fixed rest angle (`idle_cycle.
LEG_REST_ANGLE_DEG` / `ARM_REST_ANGLE_DEG`, both 0 -- parts already hang correctly at
angle zero since they are authored facing +x in a natural relaxed pose), so compositing a
frame is placement and alpha-paste only: no affine rotation, no GPU, no network.

Anchoring
---------
The pelvis/hip point is the one fixed anchor every frame shares -- `HIP_ANCHOR` never
moves. Thigh and calf attach there directly, so the leg chain is pixel-identical in every
frame (see `foot_bottom_rows`, which proves this from actual composited pixels). Torso and
head translate from that same anchor by the frame's `(breath_dy, sway_dx)` -- the torso
pixels move for breathing/weight-shift, but the invisible pelvis point the legs hang from
does not. The ~10-15% overlap the cutting rules already require at every proximal joint
(`docs/design/21-character-rig-bones.md` §5.2) is what keeps this decoupling from showing
as a gap at the hip; breath/sway amplitudes are small enough in practice that no gap is
visible at the final figure height.

Arms attach to the torso's own shoulder point but only inherit a damped, delayed copy of
its sway (`idle_cycle.offsets_at.arm_lag_dx`) plus its full breath offset -- the chest
rising carries the shoulder with it, but the arm itself trails the torso's weight shift
instead of moving with it instantly.

Reused unmodified: `side_view_rig.json`'s pivots, bone-to-part mapping, and z/layer order,
and `char_gen.walk_cycle.bone_length` for deriving a segment's reach from its own pivot.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen.idle_cycle import ARM_REST_ANGLE_DEG, DESCEND_SCALE, IdleOffsets, offsets_at
from char_gen.walk_cycle import bone_length

assert ARM_REST_ANGLE_DEG == 0.0  # this module composites by placement only, never rotation

PARTS_DIR = Path(__file__).resolve().parents[2] / "parts" / "side_view"
RIG_PATH = PARTS_DIR / "side_view_rig.json"

PART_NAMES = (
    "head",
    "torso",
    "shoulder_R",
    "shoulder_L",
    "forearm_R",
    "forearm_L",
    "thigh_R",
    "thigh_L",
    "calf_R",
    "calf_L",
)

#: Margin (native px) around the measured figure extent, so breath/sway offsets and the
#: part crops' own width never clip the canvas.
_MARGIN_X = 160
_MARGIN_TOP = 140
_MARGIN_BOTTOM = 60


def _load_rig() -> dict:
    return json.loads(RIG_PATH.read_text())


RIG = _load_rig()
_ATTACH = RIG["attach_torso_local_px"]
_CALF_L_SCALE = RIG["bone_length_fix"]["scaled"]["calf_L"]


def load_parts() -> dict[str, Image.Image]:
    """Load the ten committed side-view parts unmodified, except for calf_L's existing
    uniform length-scale correction (`side_view_rig.json`'s own `bone_length_fix`,
    reused exactly as the walk applies it -- not a new correction)."""
    parts = {name: Image.open(PARTS_DIR / f"{name}.png").convert("RGBA") for name in PART_NAMES}
    calf_l = parts["calf_L"]
    w, h = calf_l.size
    parts["calf_L"] = calf_l.resize(
        (round(w * _CALF_L_SCALE), round(h * _CALF_L_SCALE)), Image.Resampling.LANCZOS
    )
    return parts


def _pivot(name: str) -> tuple[float, float]:
    return tuple(RIG["rig"][name]["pivot"])


def _z(name: str) -> int:
    return RIG["rig"][name]["z"]


def _canvas_size(parts: dict[str, Image.Image]) -> tuple[int, int, float, float]:
    """`(width, height, hip_x, hip_y)` -- the canvas dims and the one fixed anchor point
    every frame shares."""
    thigh_h = parts["thigh_R"].size[1]
    calf_h = parts["calf_R"].size[1]
    head_h = parts["head"].size[1]
    thigh_reach = bone_length(thigh_h, _pivot("thigh_R")[1])
    calf_reach = bone_length(calf_h, _pivot("calf_R")[1])
    head_reach = head_h * _pivot("head")[1]
    spine = _ATTACH["hip"][1] - _ATTACH["neck"][1]

    max_w = max(img.size[0] for img in parts.values())
    width = round(max_w + 2 * _MARGIN_X)
    height = round(head_reach + spine + thigh_reach + calf_reach + _MARGIN_TOP + _MARGIN_BOTTOM)
    hip_x = width / 2.0
    hip_y = _MARGIN_TOP + head_reach + spine
    return width, height, hip_x, hip_y


def _paste_by_pivot(
    canvas: Image.Image, img: Image.Image, pivot: tuple[float, float], anchor: tuple[float, float]
) -> None:
    """Paste `img` so its own normalized `pivot` lands exactly at `anchor` on `canvas`."""
    w, h = img.size
    x = round(anchor[0] - pivot[0] * w)
    y = round(anchor[1] - pivot[1] * h)
    canvas.alpha_composite(img, (x, y))


def _distal(anchor: tuple[float, float], reach: float) -> tuple[float, float]:
    """Straight-down distal joint at rest angle (0 degrees) -- see
    `char_gen.walk_cycle.distal_joint`, whose zero-angle case this is."""
    return (anchor[0], anchor[1] + reach)


def compose_frame(parts: dict[str, Image.Image], phase: float) -> Image.Image:
    """Composite one native-resolution idle frame at `phase` (0..1, wraps)."""
    width, height, hip_x, hip_y = _canvas_size(parts)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    o: IdleOffsets = offsets_at(phase)
    hip = (hip_x, hip_y)

    # Torso's own unshifted top-left, were it pasted with its hip attach point (the hip's
    # true local offset within the torso bitmap, per attach_torso_local_px -- torso's own
    # "pivot" field is a placement anchor since it never rotates, not literally the hip)
    # at the fixed anchor and no breath/sway offset applied yet.
    torso_base_origin = (hip[0] - _ATTACH["hip"][0], hip[1] - _ATTACH["hip"][1])

    # Breath lifts (screen-up = smaller y) and sway shifts fore-aft; both apply to the
    # torso's drawn position, never to `hip`, which stays fixed for the leg chain below.
    torso_draw = (torso_base_origin[0] + o.sway_dx, torso_base_origin[1] - o.breath_dy)
    neck = (torso_draw[0] + _ATTACH["neck"][0], torso_draw[1] + _ATTACH["neck"][1])
    shoulder_base = (
        torso_base_origin[0] + _ATTACH["shoulder"][0],
        torso_base_origin[1] + _ATTACH["shoulder"][1],
    )
    # Arms ride the torso's full breath (the chest carries the shoulder) but only a
    # damped, delayed copy of its sway (a trailing lag, not a rigid attachment).
    shoulder = (shoulder_base[0] + o.arm_lag_dx, shoulder_base[1] - o.breath_dy)

    placements: dict[str, tuple[Image.Image, tuple[float, float]]] = {
        "thigh_R": (parts["thigh_R"], hip),
        "thigh_L": (parts["thigh_L"], hip),
        "torso": (parts["torso"], None),  # placed directly below, not by pivot/anchor
        "head": (parts["head"], neck),
        "shoulder_R": (parts["shoulder_R"], shoulder),
        "shoulder_L": (parts["shoulder_L"], shoulder),
    }

    thigh_r_reach = bone_length(parts["thigh_R"].size[1], _pivot("thigh_R")[1])
    thigh_l_reach = bone_length(parts["thigh_L"].size[1], _pivot("thigh_L")[1])
    knee_r = _distal(hip, thigh_r_reach)
    knee_l = _distal(hip, thigh_l_reach)
    placements["calf_R"] = (parts["calf_R"], knee_r)
    placements["calf_L"] = (parts["calf_L"], knee_l)

    shoulder_r_reach = bone_length(parts["shoulder_R"].size[1], _pivot("shoulder_R")[1])
    shoulder_l_reach = bone_length(parts["shoulder_L"].size[1], _pivot("shoulder_L")[1])
    elbow_r = _distal(shoulder, shoulder_r_reach)
    elbow_l = _distal(shoulder, shoulder_l_reach)
    placements["forearm_R"] = (parts["forearm_R"], elbow_r)
    placements["forearm_L"] = (parts["forearm_L"], elbow_l)

    for name in sorted(PART_NAMES, key=_z):
        img, anchor = placements[name]
        if name == "torso":
            canvas.alpha_composite(img, (round(torso_draw[0]), round(torso_draw[1])))
        else:
            _paste_by_pivot(canvas, img, _pivot(name), anchor)

    return canvas


def descend(frame: Image.Image) -> Image.Image:
    """Resize a native-resolution composite down to the standard 40px figure scale
    (`idle_cycle.DESCEND_SCALE`), for judging and measurement at the resolution the game
    actually ships."""
    w, h = frame.size
    size = (round(w * DESCEND_SCALE), round(h * DESCEND_SCALE))
    return frame.resize(size, Image.Resampling.LANCZOS)


@lru_cache(maxsize=1)
def _foot_x_fractions() -> dict[str, tuple[float, float]]:
    """Each calf's own horizontal extent as a fraction of the native canvas width.

    Both legs hang from the same fixed hip point, so they are NOT separated left/right
    across the canvas -- a plain midline split would cut through both. Using each calf
    part's own width around that shared hip x-position isolates the two feet correctly,
    and expressing it as a fraction (rather than a raw pixel column) keeps the result valid
    at any resolution, native or descended.
    """
    parts = load_parts()
    width, _height, hip_x, _hip_y = _canvas_size(parts)
    fractions = {}
    for side, name in (("R", "calf_R"), ("L", "calf_L")):
        half_w = parts[name].size[0] / 2.0
        fractions[side] = ((hip_x - half_w) / width, (hip_x + half_w) / width)
    return fractions


def foot_bottom_rows(frame: Image.Image) -> tuple[int, int]:
    """`(right_foot_bottom_y, left_foot_bottom_y)` -- the lowest opaque row within each
    calf's own horizontal extent. Used to prove feet stay planted from actual composited
    pixels, not from intent: if either leg ever moved, its bottom row would change from
    frame to frame."""
    alpha = np.asarray(frame)[:, :, 3]
    w = alpha.shape[1]
    fractions = _foot_x_fractions()
    bottoms = []
    for side in ("R", "L"):
        f0, f1 = fractions[side]
        x0, x1 = max(0, round(f0 * w)), min(w, round(f1 * w))
        ys, _ = np.nonzero(alpha[:, x0:x1] > 0)
        bottoms.append(int(ys.max()) if ys.size else -1)
    return (bottoms[0], bottoms[1])
