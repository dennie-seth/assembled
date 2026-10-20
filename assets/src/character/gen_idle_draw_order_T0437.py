#!/usr/bin/env python3
"""T-0437 evidence: a labeled draw-order render for the standing idle, now rooted on
the canonical rig's two-point shoulder/pelvis attach.

Same technique `gen_draw_order_audit_T0436.py` uses for the reference lunge: replay
the actual paint loop (`char_gen.draw_order_audit_T0436`, not a re-print of
`rig.*.z`) against one frame of `char_gen.idle_cycle.build_placements_at`, label every
part with its REALIZED draw rank and published z, and print the contested-pixel
audit alongside it.

Writes:
    docs/assets/evidence/T-0437/idle_draw_order.png

No test file: the logic it calls (`char_gen.idle_cycle`, `char_gen.
draw_order_audit_T0436`) carries the actual test coverage
(`tests/test_idle_canonical_rig.py::TestDrawOrderIsRealizedFromPixels`).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from char_gen import idle_cycle
from char_gen.draw_order_audit_T0436 import (
    canvas_geometry,
    contested_pairs,
    part_alpha_masks,
    realized_draw_rank,
)

OUT_DIR = Path(__file__).resolve().parents[3] / "docs" / "assets" / "evidence" / "T-0437"

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
    """Centroid of THIS part's own realized-visible pixels, not its full bounding
    box -- so a label never lands on a region the part doesn't actually win."""
    ys, xs = np.nonzero(mask >= 128)
    if len(xs) == 0:
        return None
    return (int(xs.mean()), int(ys.mean()))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    placements = idle_cycle.build_placements_at(phase=0.0)
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
        f"idle, canonical rig (T-0437) -- realized draw order replayed from the "
        f"paint loop -- {len(pairs)} contested pairs, {len(violations)} resolve "
        f"against the published z-order"
    )
    cap_bbox = draw.textbbox((8, flat.height - 20), caption)
    draw.rectangle(
        [cap_bbox[0] - 2, cap_bbox[1] - 2, cap_bbox[2] + 2, cap_bbox[3] + 2], fill=LABEL_BG,
    )
    draw.text((8, flat.height - 20), caption, fill=LABEL_FG)

    out_path = OUT_DIR / "idle_draw_order.png"
    flat.save(out_path)

    print("ranks:", {k: (v, z_of[k]) for k, v in ranks.items()})
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
