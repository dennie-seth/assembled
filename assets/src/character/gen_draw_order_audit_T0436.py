#!/usr/bin/env python3
"""T-0436 fix round 4 evidence: a labeled draw-order render.

@DennieSeth's fix-round-3 comment claimed the z-order was wrong; measured
directly (by replaying the actual paint loop, not by re-printing `rig.*.z`), it
was not -- but that measurement lived only in prose (a reviewer verdict and a
human-attached PNG built by a one-off script that was never committed). This
script is the committed, re-runnable version of that same check: it labels every
part in the composited reference-pose render with its REALIZED draw rank
(derived by replaying `rig_compositor.render_frames`'s own paint order,
`char_gen.draw_order_audit_T0436`) and its published z, so the order can be
checked by eye, and prints the contested-pixel audit alongside it.

Writes:
    docs/assets/evidence/T-0436/draw_order_audit.png

No test file: a one-off evidence-generation script, like
`gen_reference_pose_evidence_T0436.py` -- the logic it calls
(`char_gen.draw_order_audit_T0436`) carries the actual test coverage
(`tests/test_draw_order_audit_T0436.py`).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from char_gen import reference_pose_T0436 as refpose
from char_gen.draw_order_audit_T0436 import (
    canvas_geometry,
    contested_pairs,
    part_alpha_masks,
    realized_draw_rank,
)

OUT_DIR = Path(__file__).resolve().parents[3] / "docs" / "assets" / "evidence" / "T-0436"

BG = (28, 28, 34, 255)
LABEL_BG = (0, 0, 0, 170)
LABEL_FG = (255, 255, 255, 255)


def flatten_on(img: Image.Image, bg: tuple[int, int, int, int]) -> Image.Image:
    flat = Image.new("RGBA", img.size, bg)
    flat.alpha_composite(img)
    return flat.convert("RGB")


def composite(placements, canvas_size, offset) -> Image.Image:
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    for p in sorted(placements, key=lambda pl: -pl.z):
        dest = (
            round(p.target_xy[0] - p.pivot_px[0] + offset[0]),
            round(p.target_xy[1] - p.pivot_px[1] + offset[1]),
        )
        canvas.alpha_composite(p.image, dest=dest)
    return canvas


def part_label_anchor(mask: np.ndarray) -> tuple[int, int] | None:
    """Centroid of THIS part's own realized-visible pixels (alpha >= threshold),
    not its full bounding box -- so a label never lands on a region the part
    doesn't actually win (e.g. the portion of shoulder_L hidden behind the
    torso)."""
    ys, xs = np.nonzero(mask >= 128)
    if len(xs) == 0:
        return None
    return (int(xs.mean()), int(ys.mean()))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    placements = refpose.build_reference_placements()
    offset, canvas_size = canvas_geometry(placements)
    masks = part_alpha_masks(placements, canvas_size, offset)
    ranks = realized_draw_rank(placements)
    pairs = contested_pairs(placements, masks)
    violations = [p for p in pairs if p["resolves_against_z_order"]]

    rendered = composite(placements, canvas_size, offset)
    flat = flatten_on(rendered, BG)
    draw = ImageDraw.Draw(flat, "RGBA")

    z_of = {p.name: p.z for p in placements}
    for name, mask in masks.items():
        anchor = part_label_anchor(mask)
        if anchor is None:
            continue
        label = f"{name}  z={z_of[name]} rank={ranks[name]}"
        bbox = draw.textbbox(anchor, label)
        pad = 2
        draw.rectangle(
            [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad], fill=LABEL_BG,
        )
        draw.text(anchor, label, fill=LABEL_FG)

    caption = (
        f"realized draw order replayed from the paint loop -- "
        f"{len(pairs)} contested pairs, {len(violations)} resolve against the published z-order"
    )
    cap_bbox = draw.textbbox((8, flat.height - 20), caption)
    draw.rectangle(
        [cap_bbox[0] - 2, cap_bbox[1] - 2, cap_bbox[2] + 2, cap_bbox[3] + 2], fill=LABEL_BG,
    )
    draw.text((8, flat.height - 20), caption, fill=LABEL_FG)

    out_path = OUT_DIR / "draw_order_audit.png"
    flat.save(out_path)

    print("contested pairs:", len(pairs))
    for p in sorted(pairs, key=lambda d: -d["contested_px"]):
        print(
            f"  {p['lower_z_part']} (lower z) vs {p['higher_z_part']} (higher z): "
            f"{p['contested_px']}px contested, lower_wins={p['lower_z_wins']} "
            f"higher_wins={p['higher_z_wins']} "
            f"resolves_against_order={p['resolves_against_z_order']}"
        )
    print("violations:", len(violations))
    print("wrote", out_path, flat.size)


if __name__ == "__main__":
    main()
