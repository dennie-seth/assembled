#!/usr/bin/env python3
"""T-0436 evidence: render the canonical rig posed to @DennieSeth's skeleton
reference, and overlay the measured/adopted reference skeleton on it so the match
(and the deliberately-deferred mismatch) is visible rather than asserted.

Writes:
    docs/assets/evidence/T-0436/reference_pose_render.png
    docs/assets/evidence/T-0436/rig_vs_reference_overlay.png

Deliverable-path note: the task card's own Deliverable section names
`docs/assets/evidence/T-0435/...` for both files. T-0435 is a different,
unrelated, already-existing backlog card (a flow-health rework-rate report) --
not this one. Writing under T-0435 would misattribute this evidence to that
card, so this script uses T-0436 (this card's own id) instead; see
docs/design/23-canonical-rig.md's "Evidence path correction" note.

No test file: this is a one-off evidence-generation script, like the other
`gen_*_T0NNN.py` scripts in this directory -- the rig logic it calls
(`char_gen.reference_pose_T0436`, `char_gen.rig_compositor`) is what carries
the test coverage (`tests/test_reference_pose_render_T0436.py`,
`tests/test_canonical_rig_T0436.py`).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from char_gen import reference_pose_T0436 as refpose
from char_gen import rig_compositor
from char_gen.shoulder_attachment_T0436 import (
    armhole_wedge_px,
    sleeve_torso_overlap_px,
    visible_pixel_count,
)

OUT_DIR = Path(__file__).resolve().parents[3] / "docs" / "assets" / "evidence" / "T-0436"

RED = (220, 40, 40, 255)
CYAN = (40, 200, 220, 255)
ORANGE = (230, 150, 30, 255)
YELLOW = (230, 210, 60, 255)
WHITE = (240, 240, 240, 255)
BG = (28, 28, 34, 255)


def flatten_on(img: Image.Image, bg: tuple[int, int, int, int]) -> Image.Image:
    flat = Image.new("RGBA", img.size, bg)
    flat.alpha_composite(img)
    return flat.convert("RGB")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    result = refpose.render()
    native = result.native_frames[0]
    hip_px = result.hip_px  # canvas pixel for world (0, 0) -- this pose's hip

    def to_canvas(world_xy: tuple[float, float]) -> tuple[float, float]:
        return (world_xy[0] + hip_px[0], world_xy[1] + hip_px[1])

    reference_render = flatten_on(native, BG)
    reference_render.save(OUT_DIR / "reference_pose_render.png")

    with_offset = refpose.build_reference_placements()
    without_offset = refpose.build_reference_placements(lateral_offset_frac={})
    shoulder_l_px = visible_pixel_count(with_offset, "shoulder_L")
    forearm_l_px = visible_pixel_count(with_offset, "forearm_L")
    shoulder_l_px_no_offset = visible_pixel_count(without_offset, "shoulder_L")

    rig = rig_compositor.load_rig()
    parts = rig_compositor.load_parts()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    spine = rig["canonical_rig"]["spine_px"]
    points = refpose.canonical_world_points(rig, (0.0, 0.0))

    attach = rig["attach_torso_local_px"]
    neck_world = (
        attach["neck"][0] - attach["hip"][0],
        attach["neck"][1] - attach["hip"][1],
    )

    overlay = reference_render.copy()
    draw = ImageDraw.Draw(overlay, "RGBA")

    sh_r, sh_l = to_canvas(points["shoulder_R"]), to_canvas(points["shoulder_L"])
    hip_r, hip_l = to_canvas(points["hip_R"]), to_canvas(points["hip_L"])
    hip_c, neck_c = to_canvas((0.0, 0.0)), to_canvas(neck_world)

    draw.line([neck_c, hip_c], fill=YELLOW, width=1)
    draw.line([sh_r, sh_l], fill=RED, width=2)
    draw.line([hip_r, hip_l], fill=RED, width=2)
    for pt in (sh_r, sh_l, hip_r, hip_l):
        draw.ellipse([pt[0] - 3, pt[1] - 3, pt[0] + 3, pt[1] + 3], outline=RED, width=1)

    # The worst-joint deviation: the FRONT (R) shin. Draw the rig's CURRENT (active,
    # unreconciled) shin solid, and the reconciled/adopted-target shin dashed from the
    # same knee -- the gap between them IS the deviation this card records but does
    # not apply (canonical_rig.leg_proportions.applied_to_active_rig == false).
    from char_gen.walk_cycle import distal_joint

    front_stance = refpose.leg_stance((0.0, 0.0), result.leg.ground_plane_y)
    hip_r_world = points["hip_R"]
    thigh_deg = front_stance.thigh_deg_r
    knee_flexion = front_stance.knee_flexion_deg_r
    knee_world = distal_joint(hip_r_world, lengths["thigh_R"], thigh_deg)
    calf_deg = thigh_deg - knee_flexion
    actual_ankle_world = distal_joint(knee_world, lengths["calf_R"], calf_deg)
    target_calf_len = rig["canonical_rig"]["leg_proportions"]["adopted"]["shin_frac"] * spine
    target_ankle_world = distal_joint(knee_world, target_calf_len, calf_deg)

    knee_c = to_canvas(knee_world)
    actual_ankle_c = to_canvas(actual_ankle_world)
    target_ankle_c = to_canvas(target_ankle_world)
    draw.line([knee_c, actual_ankle_c], fill=ORANGE, width=2)
    _dashed_line(draw, knee_c, target_ankle_c, CYAN)
    r, tax, tay = 3, target_ankle_c[0], target_ankle_c[1]
    draw.ellipse([tax - r, tay - r, tax + r, tay + r], outline=CYAN, width=2)

    adopted_shin_frac = rig["canonical_rig"]["leg_proportions"]["adopted"]["shin_frac"]
    deviation_shin = lengths["calf_R"] / spine - adopted_shin_frac

    armhole_wedge = armhole_wedge_px(with_offset)
    sleeve_overlap = sleeve_torso_overlap_px(with_offset)

    shoulder_bar = rig["canonical_rig"]["shoulder_bar"]
    pelvis_bar = rig["canonical_rig"]["pelvis_bar"]
    caption_lines = [
        f"shoulder bar: {shoulder_bar['px']:.1f}px ({shoulder_bar['reference_frac']} x spine)",
        f"pelvis bar: {pelvis_bar['px']:.1f}px ({pelvis_bar['reference_frac']} x spine)",
        f"shoulder_L visible px: {shoulder_l_px_no_offset} (no offset) "
        f"-> {shoulder_l_px} (with offset)",
        f"forearm_L visible px: {forearm_l_px}",
        f"armhole wedge: {armhole_wedge}px  sleeve/torso overlap: {sleeve_overlap}px",
        f"WORST JOINT: front shin (calf_R), deviation {deviation_shin:+.2f} x spine"
        " (current, unreconciled, vs adopted far-side target -- deliberately not applied)",
    ]
    text_y = 8
    for line in caption_lines:
        draw.text((8, text_y), line, fill=WHITE)
        text_y += 14

    overlay.save(OUT_DIR / "rig_vs_reference_overlay.png")

    print("shoulder_L visible px (no offset):", shoulder_l_px_no_offset)
    print("shoulder_L visible px (with offset):", shoulder_l_px)
    print("forearm_L visible px (with offset):", forearm_l_px)
    print("armhole wedge px:", armhole_wedge)
    print("sleeve/torso overlap px:", sleeve_overlap)
    print("front shin deviation (x spine):", deviation_shin)
    print("wrote", OUT_DIR / "reference_pose_render.png")
    print("wrote", OUT_DIR / "rig_vs_reference_overlay.png")


def _dashed_line(draw: ImageDraw.ImageDraw, p0, p1, color, dash=6, gap=4) -> None:
    import math

    length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    if length == 0:
        return
    steps = max(1, int(length // (dash + gap)))
    for i in range(steps + 1):
        t0 = (i * (dash + gap)) / length
        t1 = min(1.0, (i * (dash + gap) + dash) / length)
        a = (p0[0] + (p1[0] - p0[0]) * t0, p0[1] + (p1[1] - p0[1]) * t0)
        b = (p0[0] + (p1[0] - p0[0]) * t1, p0[1] + (p1[1] - p0[1]) * t1)
        draw.line([a, b], fill=color, width=2)


if __name__ == "__main__":
    main()
