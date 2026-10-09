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


def scaled_parts(parts: dict[str, Image.Image], rig: dict) -> dict[str, Image.Image]:
    """Every part named in `bone_length_fix.scaled` carries the rig's own length-scale
    correction -- generic over however many entries that dict has (T-0436 added
    `shoulder_L` alongside `calf_L`; a future round can add more without a new code
    path here). The two existing corrections are for opposite reasons: `calf_L`'s
    upper portion is occluded by the near leg in a side view, so its cut is SHORT even
    though the bone is not; `shoulder_L` is cut further down the arm than `shoulder_R`,
    so its cut is LONG. Either way, scaling the part restores the bone, and the
    normalized pivot keeps the chain intact."""
    scales = rig["bone_length_fix"]["scaled"]
    out = dict(parts)
    for name, scale in scales.items():
        w, h = parts[name].size
        out[name] = parts[name].resize(
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
    loop -- the rest is each pose's own rest configuration, held constant.

    `torso_deg` rotates the torso itself about the hip attach point (T-0269 round 3).
    Default 0.0 so every caller that predates this field (`idle_cycle`) renders exactly
    as before. Everything that rides on the torso -- head, both shoulders, both
    forearms -- inherits it as a PARENT rotation (`child absolute angle = torso_deg +
    child's own local angle`, same additive-chain convention the legs and arms already
    use), so a leaning torso carries its head and arms with it rather than leaving them
    behind -- round 2's bug, where `TORSO_LEAN_DEG` was recorded but never consumed.

    `shoulder_deg_r`/`elbow_deg_r`/`shoulder_deg_l`/`elbow_deg_l` (T-0436, fix round
    4) are per-side overrides, all defaulting to `None` -- a complete no-op for every
    pre-existing caller. `shoulder_deg`/`elbow_deg` remain the single pair every pose
    module before this round still sets, and both arms still use it when a side's own
    override is absent. A 3/4 reference pose where the near arm reaches forward and
    the far arm trails back cannot be expressed by one shared scalar -- this is the
    minimal, additive split that lets `reference_pose_T0436` pose each arm from its
    own measured angle without touching what `idle_cycle`/`sitting_idle_cycle` (which
    never set these fields) render."""
    upper_dy: float
    shoulder_deg: float
    elbow_deg: float
    head_deg: float
    torso_deg: float = 0.0
    shoulder_deg_r: float | None = None
    elbow_deg_r: float | None = None
    shoulder_deg_l: float | None = None
    elbow_deg_l: float | None = None

    def shoulder_deg_for(self, side: str) -> float:
        override = self.shoulder_deg_r if side == "R" else self.shoulder_deg_l
        return self.shoulder_deg if override is None else override

    def elbow_deg_for(self, side: str) -> float:
        override = self.elbow_deg_r if side == "R" else self.elbow_deg_l
        return self.elbow_deg if override is None else override


@dataclass(frozen=True)
class LegStance:
    """Phase-independent leg geometry: a shared hip and EACH SIDE'S OWN leg angles
    (T-0269 round 3). A real stagger needs two different ankle targets, and therefore
    two different knee-flexion solves -- `far_leg_offset_frac` (a sideways shift of one
    hip) was round 2's bug, not a stagger: an identical leg pose shifted sideways still
    has both ankles landing a fraction of a pixel apart. Both ankles still rest on
    `ground_plane_y` -- the only ground contact any pose needs. No seat, chair, or
    other plane is part of this shape; a pose that wants one hip-pinning convention or
    another expresses it when it computes `hip`, not here."""
    hip: tuple[float, float]
    ground_plane_y: float
    thigh_deg_r: float
    knee_flexion_deg_r: float
    thigh_deg_l: float
    knee_flexion_deg_l: float
    far_leg_offset_frac: float


def leg_angles(leg: LegStance, side: str) -> tuple[float, float]:
    """This side's own `(thigh_deg, knee_flexion_deg)` -- the per-leg split a stagger
    needs, factored out so `build_placements` and `leg_chain` read it the same way."""
    return (leg.thigh_deg_r, leg.knee_flexion_deg_r) if side == "R" \
        else (leg.thigh_deg_l, leg.knee_flexion_deg_l)


def rotate_offset(offset: tuple[float, float], angle_deg: float) -> tuple[float, float]:
    """Rotate a LOCAL offset by `angle_deg`, in the SAME sign convention `distal_joint`
    (and therefore `Image.rotate`, which it was derived to match) already use --
    `distal_joint(origin, L, deg)` is the special case `offset=(0, L)`. A parent's
    rotation must carry its children's attachment points exactly as far as it carries
    its own rendered pixels, or a rotated torso visually detaches from the head and
    arms riding on it."""
    rad = math.radians(angle_deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    ox, oy = offset
    return (ox * cos_a + oy * sin_a, -ox * sin_a + oy * cos_a)


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
    *,
    z_override: dict[str, float] | None = None,
    foot_flatten: dict[str, float] | None = None,
    shoulder_points: dict[str, tuple[float, float]] | None = None,
    hip_points: dict[str, tuple[float, float]] | None = None,
    lateral_offset_frac: dict[str, float] | None = None,
) -> list[Placement]:
    """Place all ten parts for one phase. Generic over pose: the hip, both leg angles
    and the far-leg offset all come from `leg`; the only thing that may differ frame to
    frame is `upper.upper_dy`.

    Three keyword-only parameters, added for T-0436, all default to `None` and are a
    complete no-op when omitted -- every pre-existing pose module (`idle_cycle`,
    `walk_cycle`, `sitting_idle_cycle`) omits all three, so none of them changes
    behaviour because these exist:

    * `shoulder_points` -- `{"R": (x, y), "L": (x, y)}` world points, replacing the
      single shared `attach["shoulder"]` point every pose used before this card.
    * `hip_points` -- same shape, replacing `leg_hip_points`'s computed result.
    * `lateral_offset_frac` -- `{part_name: frac}`, a sideways shift (as a fraction of
      the torso's own width) applied ONCE per limb chain, at that chain's ROOT part
      (`shoulder_*` for the arm chain, `thigh_*` for the leg chain). The distal part
      (`forearm_*`/`calf_*`) is never shifted a second time -- it inherits the root's
      shift automatically through the forward-kinematics chain, since its own target
      is computed from the root's already-shifted position. A caller may still name
      the distal part in this dict at the SAME fraction as its root, to document "one
      offset for this whole chain" (the committed rig's own
      `canonical_rig.lateral_offset_axis.demonstration_values` does exactly this) --
      but that entry is not separately consulted, precisely so two equal values can
      never compound into a doubled shift that tears the chain's two sprites apart
      (T-0436 FAIL verdict 2026-10-08T21:54:30Z). This is the mechanism a 3/4 pose
      uses to pull a far-side limb clear of the torso's own rectangular silhouette --
      a z/depth value only changes which part wins a contested pixel, never where
      either one is."""
    torso = scaled["torso"]

    def lateral(point: tuple[float, float], name: str) -> tuple[float, float]:
        if not lateral_offset_frac or name not in lateral_offset_frac:
            return point
        return (point[0] + lateral_offset_frac[name] * torso.width, point[1])

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

    hip_local = tuple(attach["hip"])
    hip_world = (leg.hip[0], leg.hip[1] + upper.upper_dy)

    if upper.torso_deg:
        torso_img, torso_pivot_px = pad_for_rotation(torso, hip_local)
        torso_img = torso_img.rotate(
            upper.torso_deg, center=torso_pivot_px, resample=Image.Resampling.BICUBIC,
            expand=False,
        )
    else:
        torso_img, torso_pivot_px = torso, hip_local
    placements.append(
        Placement("torso", torso_img, torso_pivot_px, hip_world, rig_entries["torso"]["z"])
    )

    def attach_world(point_name: str) -> tuple[float, float]:
        """World position of a torso-local attach point, carrying the torso's own
        `torso_deg` rotation -- identity (the old unrotated formula) when it is 0."""
        local = attach[point_name]
        local_offset = (local[0] - hip_local[0], local[1] - hip_local[1])
        world_offset = rotate_offset(local_offset, upper.torso_deg)
        return (hip_world[0] + world_offset[0], hip_world[1] + world_offset[1])

    neck_world = attach_world("neck")
    placements.append(place("head", upper.torso_deg + upper.head_deg, neck_world))

    for side in ("R", "L"):
        sh_name, fa_name = f"shoulder_{side}", f"forearm_{side}"
        shoulder_abs_deg = upper.torso_deg + upper.shoulder_deg_for(side)
        sh_world = (
            shoulder_points[side] if shoulder_points is not None else attach_world("shoulder")
        )
        sh_world = lateral(sh_world, sh_name)
        placements.append(place(sh_name, shoulder_abs_deg, sh_world))
        # elbow inherits sh_world's own shift through this FK step -- the chain's
        # ONE lateral offset lives at the root; fa_name is never applied a second
        # time (see lateral_offset_frac's own docstring above).
        elbow = distal_joint(sh_world, lengths[sh_name], shoulder_abs_deg)
        placements.append(place(fa_name, shoulder_abs_deg + upper.elbow_deg_for(side), elbow))

    resolved_hip_points = hip_points if hip_points is not None else leg_hip_points(leg, torso.width)
    for side, hip_side in resolved_hip_points.items():
        th_name, cf_name = f"thigh_{side}", f"calf_{side}"
        hip_side = lateral(hip_side, th_name)
        thigh_deg, knee_flexion_deg = leg_angles(leg, side)
        placements.append(place(th_name, thigh_deg, hip_side))
        # knee/ankle inherit hip_side's own shift through this FK step -- same
        # one-offset-per-chain rule as the arm chain above; cf_name is never
        # applied a second time.
        knee, ankle = leg_chain(hip_side, lengths[th_name], lengths[cf_name], leg, side)
        calf_deg = thigh_deg - knee_flexion_deg
        extra = (foot_flatten or {}).get(cf_name, 0.0)
        if extra:
            # Rotate the shin about its OWN ANKLE rather than the knee: the sole plants
            # flat while the solved ankle stays exactly where the IK put it, so the
            # ground-contact assertions still hold. The knee end absorbs the offset.
            flat_deg = calf_deg + extra
            moved = distal_joint(knee, lengths[cf_name], flat_deg)
            knee = (knee[0] + (ankle[0] - moved[0]), knee[1] + (ankle[1] - moved[1]))
            calf_deg = flat_deg
        placements.append(place(cf_name, calf_deg, knee))

    if z_override:
        placements = [
            Placement(p.name, p.image, p.pivot_px, p.target_xy, z_override.get(p.name, p.z))
            for p in placements
        ]
    return placements


def leg_hip_points(leg: LegStance, torso_width: float) -> dict[str, tuple[float, float]]:
    """Each side's hip point -- the near (R) leg's hip is `leg.hip` itself; the far (L)
    leg's hip is offset by `far_leg_offset_frac` of the torso's width, same convention
    `build_placements` has always used to keep the two legs from coinciding exactly.
    A real stagger (T-0269 round 3) comes from each side's own `leg_angles`, not from
    widening this offset -- a pose with a genuine stagger sets `far_leg_offset_frac` to
    0.0 and lets the two different ankle targets do the separating."""
    far_leg_dx = leg.far_leg_offset_frac * torso_width
    return {"R": leg.hip, "L": (leg.hip[0] + far_leg_dx, leg.hip[1])}


def leg_chain(
    hip_side: tuple[float, float], thigh_len: float, calf_len: float, leg: LegStance, side: str
) -> tuple[tuple[float, float], tuple[float, float]]:
    """`(knee, ankle)` for one leg side -- the same two-bone forward kinematics
    `build_placements` uses to place that side's calf, factored out so a contact-point
    check can read the exact ankle coordinate the render actually used rather than a
    separately re-derived one. `side` selects that leg's OWN `(thigh_deg,
    knee_flexion_deg)` pair via `leg_angles` -- the two sides generally differ now."""
    thigh_deg, knee_flexion_deg = leg_angles(leg, side)
    knee = distal_joint(hip_side, thigh_len, thigh_deg)
    ankle = distal_joint(knee, calf_len, thigh_deg - knee_flexion_deg)
    return knee, ankle


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
    hip_px: tuple[int, int]
    knee_r_px: tuple[int, int]
    knee_l_px: tuple[int, int]
    ankle_r_px: tuple[int, int]
    ankle_l_px: tuple[int, int]
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
    z_override: dict[str, float] | None = None,
    foot_flatten: dict[str, float] | None = None,
    shoulder_points: dict[str, tuple[float, float]] | None = None,
    hip_points: dict[str, tuple[float, float]] | None = None,
    lateral_offset_frac: dict[str, float] | None = None,
) -> RenderResult:
    """Composite `frame_count` frames for one pose. `character_scale` and
    `ground_anchor_cell_y` default to the one shared convention in
    `char_gen.character_scale` -- a caller only overrides them in a test that is
    specifically checking the shared-scale behaviour itself.

    `shoulder_points`/`hip_points`/`lateral_offset_frac` (T-0436) pass straight
    through to `build_placements` -- see its own docstring. All three default to
    `None`, so every pre-existing caller is unaffected."""
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
                          lengths, z_override=z_override, foot_flatten=foot_flatten,
                          shoulder_points=shoulder_points, hip_points=hip_points,
                          lateral_offset_frac=lateral_offset_frac)
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

    # The hip itself sits UNDER the band above (the near leg's own top edge covers it,
    # not a separate exclusion) -- the near leg (thigh_R/calf_R) is the topmost z-order
    # layer of every frame, so wherever it is opaque the composited pixel is its own,
    # phase-invariant content regardless of what moves underneath. That makes the hip's
    # own canvas pixel, and both ankles', a direct pixel proof rather than a band that
    # has to dodge the breathing upper body. Same `leg_chain` two-bone solve
    # `build_placements` used to place each calf -- not a second, re-derived geometry.
    resolved_hip_points = hip_points if hip_points is not None else leg_hip_points(
        leg, scaled["torso"].width
    )

    def lateral_debug(point: tuple[float, float], name: str) -> tuple[float, float]:
        # Mirrors `build_placements`'s own `lateral()` closure exactly -- the leg
        # chain placed here is a debug re-derivation of the SAME geometry
        # `build_placements` already used for `calf_R`/`calf_L` (see the comment
        # above), so it must apply that chain's one lateral offset too, or this
        # debug `ankle_l_px`/`knee_l_px` silently disagrees with where `calf_L`
        # actually rendered whenever `lateral_offset_frac` is active.
        if not lateral_offset_frac or name not in lateral_offset_frac:
            return point
        return (point[0] + lateral_offset_frac[name] * scaled["torso"].width, point[1])

    knee_r, ankle_r = leg_chain(
        lateral_debug(resolved_hip_points["R"], "thigh_R"), lengths["thigh_R"], lengths["calf_R"],
        leg, "R",
    )
    knee_l, ankle_l = leg_chain(
        lateral_debug(resolved_hip_points["L"], "thigh_L"), lengths["thigh_L"], lengths["calf_L"],
        leg, "L",
    )

    def to_canvas(pt: tuple[float, float]) -> tuple[int, int]:
        return (round(pt[0] + offset[0]), round(pt[1] + offset[1]))

    # `hip_px` is always the canvas pixel for `leg.hip` -- the same world point
    # every other caller (sitting_idle_cycle's contact-point checks, etc.) has
    # relied on since before this card. `hip_points`, when supplied, overrides
    # the TWO leg hips' own roots; it never redefines what `leg.hip` itself means,
    # so `hip_px` must not switch to `resolved_hip_points["R"]` just because
    # `hip_points` was passed (T-0436 FAIL verdict 2026-10-08T22:18:16Z: that
    # switch silently shifted every overlay point in
    # `gen_reference_pose_evidence_T0436.py` by +9.06px, since that script's own
    # `to_canvas` is built on `hip_px` meaning the canvas pixel for world (0, 0)).
    hip_px = to_canvas(leg.hip)
    knee_r_px = to_canvas(knee_r)
    knee_l_px = to_canvas(knee_l)
    ankle_r_px = to_canvas(ankle_r)
    ankle_l_px = to_canvas(ankle_l)

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
        hip_px=hip_px,
        knee_r_px=knee_r_px,
        knee_l_px=knee_l_px,
        ankle_r_px=ankle_r_px,
        ankle_l_px=ankle_l_px,
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
