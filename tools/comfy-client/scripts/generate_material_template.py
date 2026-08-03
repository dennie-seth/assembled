#!/usr/bin/env python3
"""Hand-blocked layout template for img2img conditioning (T-0106).

Not part of the tested `comfy_client` package -- a one-off content-authoring
script (like `live_smoke.py`), run manually to produce a committed source
asset. Draws a flat, side-on reference panel layout matching the concept-
sheet requirements in `docs/design/13-asset-pipeline.md` §6.9: a WALL
surface panel, a FLOOR surface panel, a wall->floor TRANSITION strip, and
two prop boxes, each filled with a flat base-value hint (no gradients, no
perspective, no rendered detail) so the img2img KSampler has a layout to
preserve while SDXL paints material texture into it. Panel-divider strokes
break the wall/floor fields into sub-panels, matching "panels of material
and object, laid out to be read" rather than one undifferentiated field.

Usage:

    .venv/bin/python scripts/generate_material_template.py [out_path]
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024

# Flat brutalist-palette value hints (05-art-direction.md §3 family):
# concrete grey (wall), a darker warm grey (floor), near-black (transition/
# trim), oxide red-brown and institutional green (props). Deliberately flat
# fills, no gradients -- atmospheric depth is a key-art concern, not a
# concept-sheet one (§6.9).
WALL_GREY = (118, 116, 112)
WALL_GREY_DARK = (100, 98, 94)  # second wall sub-panel, for value separation
FLOOR_GREY = (68, 64, 58)
FLOOR_GREY_DARK = (54, 51, 46)  # second floor sub-panel
TRANSITION_SHADOW = (26, 24, 22)
PROP_OXIDE = (122, 61, 38)
PROP_GREEN = (58, 84, 58)
DIVIDER = (18, 17, 16)

WALL_TOP = 0
WALL_BOTTOM = 620
TRANSITION_BOTTOM = 716
FLOOR_BOTTOM = SIZE

DIVIDER_WIDTH = 6


def build_template() -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), WALL_GREY)
    draw = ImageDraw.Draw(img)

    # WALL surface: two sub-panels (left/right) so the sheet reads as
    # material panels, not one flat field.
    wall_mid_x = SIZE // 2
    draw.rectangle([0, WALL_TOP, wall_mid_x, WALL_BOTTOM], fill=WALL_GREY)
    draw.rectangle([wall_mid_x, WALL_TOP, SIZE, WALL_BOTTOM], fill=WALL_GREY_DARK)

    # wall -> floor TRANSITION strip: full-width, darkest value (trim/plinth
    # shadow), unmistakably separate from both neighbours.
    draw.rectangle([0, WALL_BOTTOM, SIZE, TRANSITION_BOTTOM], fill=TRANSITION_SHADOW)

    # FLOOR surface: two sub-panels, darker and warmer than the wall.
    floor_mid_x = SIZE // 3
    draw.rectangle([0, TRANSITION_BOTTOM, floor_mid_x, FLOOR_BOTTOM], fill=FLOOR_GREY)
    draw.rectangle([floor_mid_x, TRANSITION_BOTTOM, SIZE, FLOOR_BOTTOM], fill=FLOOR_GREY_DARK)

    # Panel-divider strokes -- reinforce the edges img2img needs to preserve
    # at moderate denoise, independent of the value contrast alone.
    draw.line(
        [(wall_mid_x, WALL_TOP), (wall_mid_x, WALL_BOTTOM)], fill=DIVIDER, width=DIVIDER_WIDTH
    )
    draw.line([(0, WALL_BOTTOM), (SIZE, WALL_BOTTOM)], fill=DIVIDER, width=DIVIDER_WIDTH)
    draw.line(
        [(0, TRANSITION_BOTTOM), (SIZE, TRANSITION_BOTTOM)], fill=DIVIDER, width=DIVIDER_WIDTH
    )
    draw.line(
        [(floor_mid_x, TRANSITION_BOTTOM), (floor_mid_x, FLOOR_BOTTOM)],
        fill=DIVIDER,
        width=DIVIDER_WIDTH,
    )

    # Two prop boxes sitting on the floor, at plausible relative scale
    # (roughly waist-to-shoulder height against the wall panel) -- simple
    # flat silhouettes, not rendered objects.
    prop1 = [140, 470, 300, 610]
    draw.rectangle(prop1, fill=PROP_OXIDE, outline=DIVIDER, width=4)

    prop2 = [700, 500, 880, 610]
    draw.rectangle(prop2, fill=PROP_GREEN, outline=DIVIDER, width=4)

    return img


def main() -> int:
    out_path = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path("assets/src/concept/signal_tower_material_template.png")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    build_template().save(out_path)
    print(f"wrote {out_path} ({SIZE}x{SIZE})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
