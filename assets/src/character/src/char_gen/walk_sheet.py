"""Deterministic side-view walk-sheet composite (T-0431).

Promotes nothing itself -- this module only renders frames and derives the
per-frame COCO-18 keypoints describing what the rig actually commanded. It
is built entirely from already-committed, untouched inputs: the ten parts
under `assets/src/character/parts/side_view/`, `side_view_rig.json`, and
`char_gen.walk_cycle`'s gait curves. No GPU call, no network call, no
sampling -- the same inputs always produce the same frames.

Why this is not just `rig_compositor.render_frames(leg, upper_pose_at, ...)`
--------------------------------------------------------------------------
That function takes ONE static `LegStance` (and one shared `shoulder_deg`/
`elbow_deg` pair applied to BOTH arms) for the whole animation -- correct for
`idle_cycle`/`sitting_idle_cycle`, whose legs (and arm rest pose) do not
change across the loop, wrong for a walk, where the far leg/arm must swing
half a cycle out of phase with the near one (`char_gen.walk_cycle.angles_at`,
`far_side=True`). Rather than widen `rig_compositor`'s shared API for a
single caller, this module calls `rig_compositor.build_placements` TWICE per
frame -- once with the near side's angles, once with the far side's -- and
keeps only `shoulder_L`/`forearm_L` from the far call (the leg split is
already per-side via `LegStance.thigh_deg_l`/`knee_flexion_deg_l`, T-0269
round 3). `rig_compositor.py` itself is untouched.

Root bob
--------
`walk_cycle.root_bob` moves the whole figure -- hip AND legs together, via
`LegStance.hip`, not `UpperPose.upper_dy` (which in the shared compositor
only carries the torso/head/arms, leaving the legs static -- correct for
idle's static stance, wrong here). The amplitude is read from
`side_view_rig.json["root_bob_px"]` (5.65 native px) -- the rig's own
recorded calibration for this exact parts/curve combination, not a new
constant invented here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image

from char_gen import rig_compositor as rc
from char_gen.character_scale import CELL_PX, CHARACTER_SCALE, GROUND_ANCHOR_CELL_Y
from char_gen.walk_cycle import angles_at, distal_joint, root_bob

#: Matches `walk_cycle.py`'s own `PHASES = [i / 8 for i in range(8)]` test
#: convention, and the committed rig's `side_view_rig.json["frames"]`.
FRAME_COUNT = 8

#: 4x2 grid, same layout convention the (unrelated, GPU-generated) placeholder
#: `player_walk_sheet_hybrid.png` already uses -- a documented layout, not an
#: assumption this module invents.
COLS, ROWS = 4, 2

#: Head joints (nose=0, R/L eye=14/15, R/L ear=16/17) collapse onto the
#: head part's own OPAQUE-pixel centroid, measured relative to its rig pivot
#: (the neck attach point) -- not the front-facing `_POSE_KEYPOINTS_NORM`
#: proportions `gen_arm_a_idle_T0228.py` uses for an unrelated, front-view
#: skeleton. This profile head is small enough at this scale (native bbox
#: ~150x184px, ~6x7px once descended) that a single collapsed point for all
#: five joints is the right fidelity: the borrowed front-view deltas
#: overshot the real head silhouette by several final pixels and inflated
#: every frame's rig-capsule footprint well past where the art renders.
_HEAD_JOINTS: tuple[int, ...] = (0, 14, 15, 16, 17)

#: Joints this module derives directly (hips/knees/ankles/shoulders/elbows/
#: wrists/neck) -- everything in `_HEAD_JOINTS` is derived from joint 1
#: (neck) afterwards.
_NECK = 1


@dataclass(frozen=True)
class WalkSheetResult:
    cell_frames: list  # list[Image.Image], RGBA, CELL_PX x CELL_PX, pre-quantization
    keypoints: list  # list[dict[int, tuple[float, float]]], one per frame
    native_frames: list  # list[Image.Image], pre-descent, for debugging/evidence
    canvas_size: tuple
    offset: tuple
    dest: tuple
    ground_plane_y: float
    root_bob_amplitude_px: float


def _head_centroid_delta(
    head_img: Image.Image, pivot_px: tuple[float, float]
) -> tuple[float, float]:
    """The head part's own opaque-pixel centroid, relative to its rig pivot,
    in NATIVE px -- measured from the committed part itself, never a
    borrowed constant from an unrelated pose/camera angle."""
    arr = np.array(head_img)
    alpha = arr[..., 3]
    ys, xs = np.nonzero(alpha > 10)
    if xs.size == 0:
        return (0.0, 0.0)
    return (float(xs.mean()) - pivot_px[0], float(ys.mean()) - pivot_px[1])


def _build_frame_placements(phase: float, leg: rc.LegStance, scaled, rig_entries, attach, lengths):
    """One frame's placements: the near side's angles drive torso/head/
    shoulder_R/forearm_R (and, via `leg`, both legs already); the far call
    supplies only `shoulder_L`/`forearm_L`, half a cycle out of phase."""
    near = angles_at(phase, far_side=False)
    far = angles_at(phase, far_side=True)
    upper_near = rc.UpperPose(
        upper_dy=0.0, shoulder_deg=near.shoulder, elbow_deg=near.elbow_flexion, head_deg=0.0
    )
    upper_far = rc.UpperPose(
        upper_dy=0.0, shoulder_deg=far.shoulder, elbow_deg=far.elbow_flexion, head_deg=0.0
    )
    pl_near = rc.build_placements(upper_near, leg, scaled, rig_entries, attach, lengths)
    pl_far = rc.build_placements(upper_far, leg, scaled, rig_entries, attach, lengths)
    by_near = {p.name: p for p in pl_near}
    by_far = {p.name: p for p in pl_far}
    merged = [
        by_far[name] if name in ("shoulder_L", "forearm_L") else by_near[name]
        for name in rc.PART_NAMES
    ]
    return merged, near, far


def render_frames(frame_count: int = FRAME_COUNT) -> WalkSheetResult:
    """Composite `frame_count` walk-cycle frames from the committed parts +
    rig, driven entirely by `char_gen.walk_cycle`'s curves. Re-reads the
    parts and rig from disk on every call (same convention `idle_cycle`/
    `sitting_idle_cycle` use) so the render always reflects the committed
    inputs, never a cached copy."""
    parts = rc.load_parts()
    rig = rc.load_rig()
    scaled = rc.scaled_parts(parts, rig)
    rig_entries = rig["rig"]
    attach = rig["attach_torso_local_px"]
    lengths = rc.measured_bone_lengths(parts, rig)

    ground_plane_y = lengths["thigh_R"] + lengths["calf_R"]
    bob_amplitude = float(rig.get("root_bob_px", 0.0))

    phases = [i / frame_count for i in range(frame_count)]
    legs: list[rc.LegStance] = []
    all_placements = []
    near_far = []
    for phase in phases:
        near = angles_at(phase, far_side=False)
        far = angles_at(phase, far_side=True)
        hip_y = root_bob(phase, bob_amplitude)
        leg = rc.LegStance(
            hip=(0.0, hip_y),
            ground_plane_y=ground_plane_y,
            thigh_deg_r=near.hip, knee_flexion_deg_r=near.knee_flexion,
            thigh_deg_l=far.hip, knee_flexion_deg_l=far.knee_flexion,
            far_leg_offset_frac=0.0,
        )
        legs.append(leg)
        placements, near2, far2 = _build_frame_placements(
            phase, leg, scaled, rig_entries, attach, lengths
        )
        all_placements.append(placements)
        near_far.append((near2, far2))

    margin = 4.0
    boxes = [rc.placement_bbox(pl) for pl in all_placements]
    x0 = min(b[0] for b in boxes) - margin
    y0 = min(b[1] for b in boxes) - margin
    x1 = max(b[2] for b in boxes) + margin
    y1 = max(b[3] for b in boxes) + margin
    canvas_w, canvas_h = math.ceil(x1 - x0), math.ceil(y1 - y0)
    offset = (-x0, -y0)

    native_frames = []
    for placements in all_placements:
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        for placement in sorted(placements, key=lambda p: -p.z):
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
    d0 = descended[0]
    ground_canvas_y = ground_plane_y + offset[1]
    ground_descended_y = ground_canvas_y * CHARACTER_SCALE
    dest_x = round((CELL_PX - d0.width) / 2.0)
    dest_y = round(GROUND_ANCHOR_CELL_Y - ground_descended_y)

    cell_frames = []
    for d in descended:
        cell = Image.new("RGBA", (CELL_PX, CELL_PX), (0, 0, 0, 0))
        cell.alpha_composite(d, dest=(dest_x, dest_y))
        cell_frames.append(cell)

    def native_to_norm(pt: tuple[float, float]) -> tuple[float, float]:
        cx = (pt[0] + offset[0]) * CHARACTER_SCALE + dest_x
        cy = (pt[1] + offset[1]) * CHARACTER_SCALE + dest_y
        return (cx / CELL_PX, cy / CELL_PX)

    # pivot_of isn't exposed by rig_compositor; recompute the head pivot here
    # from the same rig-entry fraction `build_placements` uses internally.
    head_img = scaled["head"]
    head_pivot_frac = rig_entries["head"]["pivot"]
    head_pivot_px = (head_img.width * head_pivot_frac[0], head_img.height * head_pivot_frac[1])
    head_delta_native = _head_centroid_delta(head_img, head_pivot_px)
    head_delta_norm = (
        head_delta_native[0] * CHARACTER_SCALE / CELL_PX,
        head_delta_native[1] * CHARACTER_SCALE / CELL_PX,
    )

    hip_local = tuple(attach["hip"])
    neck_local = tuple(attach["neck"])

    keypoints: list[dict[int, tuple[float, float]]] = []
    for i, phase in enumerate(phases):
        near, far = near_far[i]
        leg = legs[i]
        by_name = {p.name: p for p in all_placements[i]}
        hip_points = rc.leg_hip_points(leg, scaled["torso"].width)
        knee_r, ankle_r = rc.leg_chain(
            hip_points["R"], lengths["thigh_R"], lengths["calf_R"], leg, "R"
        )
        knee_l, ankle_l = rc.leg_chain(
            hip_points["L"], lengths["thigh_L"], lengths["calf_L"], leg, "L"
        )

        shoulder_r = by_name["shoulder_R"].target_xy
        elbow_r = by_name["forearm_R"].target_xy
        wrist_r = distal_joint(elbow_r, lengths["forearm_R"], near.shoulder + near.elbow_flexion)

        shoulder_l = by_name["shoulder_L"].target_xy
        elbow_l = by_name["forearm_L"].target_xy
        wrist_l = distal_joint(elbow_l, lengths["forearm_L"], far.shoulder + far.elbow_flexion)

        neck_world = (
            leg.hip[0] + (neck_local[0] - hip_local[0]),
            leg.hip[1] + (neck_local[1] - hip_local[1]),
        )

        pts_native = {
            _NECK: neck_world,
            2: shoulder_r, 3: elbow_r, 4: wrist_r,
            5: shoulder_l, 6: elbow_l, 7: wrist_l,
            8: hip_points["R"], 9: knee_r, 10: ankle_r,
            11: hip_points["L"], 12: knee_l, 13: ankle_l,
        }
        pts_norm = {j: native_to_norm(p) for j, p in pts_native.items()}
        neck_norm = pts_norm[_NECK]
        for j in _HEAD_JOINTS:
            pts_norm[j] = (neck_norm[0] + head_delta_norm[0], neck_norm[1] + head_delta_norm[1])
        keypoints.append(pts_norm)

    return WalkSheetResult(
        cell_frames=cell_frames,
        keypoints=keypoints,
        native_frames=native_frames,
        canvas_size=(canvas_w, canvas_h),
        offset=offset,
        dest=(dest_x, dest_y),
        ground_plane_y=ground_plane_y,
        root_bob_amplitude_px=bob_amplitude,
    )


def keypoints_to_coco_list(points: dict) -> list:
    """Serialise one frame's keypoints dict, ascending joint order -- the
    shape `asset_gate.character._load_rig_keypoints` reads back."""
    return [{"joint": j, "x": points[j][0], "y": points[j][1]} for j in sorted(points)]


def _srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Duplicated deliberately from `part_descend._srgb_to_oklab` (itself
    duplicated from `cutout._srgb_to_oklab`) -- same rationale: a small,
    stable colour-space conversion, not business logic that could drift."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l_), np.cbrt(m_), np.cbrt(s_)
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([lightness, a, b2], axis=-1)


def quantize_to_indexed(
    frames: list, palette: list, background_index: int = 0, alpha_threshold: int = 128
) -> list:
    """Nearest-neighbour (Oklab space, no dithering) quantize of each RGBA
    frame to `palette`, forcing every pixel below `alpha_threshold` to
    `background_index` -- same order `part_descend.box_descend_part` already
    applies (quantize excluding the background slot, then force background
    by mask) so a foreground pixel can never land on, and silently vanish
    into, the transparent index."""
    out = []
    allowed = [i for i in range(len(palette)) if i != background_index]
    slot_oklab = _srgb_to_oklab(np.array([palette[i] for i in allowed], dtype=np.float64))
    for frame in frames:
        arr = np.array(frame)
        rgb, alpha = arr[..., :3], arr[..., 3]
        h, w = rgb.shape[:2]
        pixels_oklab = _srgb_to_oklab(rgb.reshape(-1, 3))
        diff = pixels_oklab[:, None, :] - slot_oklab[None, :, :]
        dist2 = np.einsum("pnc,pnc->pn", diff, diff)
        nearest_local = np.argmin(dist2, axis=1)
        nearest = np.array(allowed, dtype=np.uint8)[nearest_local].reshape(h, w)
        nearest[alpha < alpha_threshold] = background_index
        img = Image.fromarray(nearest.astype(np.uint8), mode="P")
        flat = [0] * (256 * 3)
        for i, (r, g, b) in enumerate(palette):
            flat[3 * i], flat[3 * i + 1], flat[3 * i + 2] = r, g, b
        img.putpalette(flat)
        out.append(img)
    return out


def save_sheet(frames: list, out_path) -> None:
    """Assemble `frames` (all mode 'P', same palette) into one `COLS x ROWS`
    sheet and write it with a tRNS chunk on the background index -- the P-6
    contract `asset_gate.transparency` enforces."""
    from pathlib import Path

    cell_w, cell_h = frames[0].size
    sheet = Image.new("P", (cell_w * COLS, cell_h * ROWS))
    sheet.putpalette(frames[0].getpalette())
    for i, frame in enumerate(frames):
        row, col = divmod(i, COLS)
        sheet.paste(frame, (col * cell_w, row * cell_h))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, transparency=0)
