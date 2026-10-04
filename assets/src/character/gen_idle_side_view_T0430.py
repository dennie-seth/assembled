#!/usr/bin/env python3
"""Render the side-view idle reference evidence (T-0430).

Deterministic composite only: `char_gen.idle_cycle` + `char_gen.idle_render` against the
ten committed `parts/side_view/*.png` files. No GPU, no network, no sampling -- running
this script twice produces byte-identical output.

Writes `docs/assets/evidence/side-view-idle-reference/`:
    idle_sheet_native.png        -- all 12 frames, native resolution, one row
    idle_sheet_descended.png     -- the same, at the 40px final figure height
    idle_loop_descended.gif      -- the loop at the resolution the game actually ships
    idle_loop_upscaled.gif       -- the same loop, nearest-neighbour x8, for human viewing
    frames/frame_NN_native.png   -- each native-resolution frame
    frames/frame_NN_descended.png -- each descended frame
    rig_data_used.json           -- the rig/measurement data this run actually consumed
    README.md                    -- decisions, measurements, and reuse notes

Usage (from the repo root, inside this package's venv):
    assets/src/character/.venv/bin/python assets/src/character/gen_idle_side_view_T0430.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from PIL import Image  # noqa: E402

from char_gen import idle_cycle  # noqa: E402
from char_gen.idle_render import (  # noqa: E402
    PARTS_DIR,
    RIG,
    compose_frame,
    descend,
    foot_bottom_rows,
    load_parts,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = REPO_ROOT / "docs" / "assets" / "evidence" / "side-view-idle-reference"
UPSCALE_FACTOR = 8
#: Neutral opaque backdrop for the GIF outputs only -- GIF has no partial-alpha channel,
#: and saving an RGBA frame straight to GIF lets Pillow's palette quantizer assign
#: arbitrary saturated colours to the parts' soft (partially transparent) edge pixels.
#: Flattening onto a plain background first means every pixel GIF ever quantizes is fully
#: opaque, so this never happens. The sheet/frame PNGs below keep true RGBA -- only GIF
#: needs this.
_GIF_BACKDROP = (32, 34, 30, 255)


def _flatten_for_gif(img: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", img.size, _GIF_BACKDROP)
    bg.alpha_composite(img)
    return bg.convert("RGB")


def _opaque_centroid(img: Image.Image) -> tuple[float, float]:
    import numpy as np

    alpha = np.asarray(img)[:, :, 3]
    ys, xs = np.nonzero(alpha > 0)
    return float(xs.mean()), float(ys.mean())


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames_dir = OUT_DIR / "frames"
    frames_dir.mkdir(exist_ok=True)

    parts = load_parts()
    n = idle_cycle.FRAME_COUNT
    phases = [i / n for i in range(n)]

    native_frames = [compose_frame(parts, p) for p in phases]
    descended_frames = [descend(f) for f in native_frames]

    for i, (nat, desc) in enumerate(zip(native_frames, descended_frames)):
        nat.save(frames_dir / f"frame_{i:02d}_native.png")
        desc.save(frames_dir / f"frame_{i:02d}_descended.png")

    sheet_native = Image.new(
        "RGBA", (native_frames[0].width * n, native_frames[0].height), (0, 0, 0, 0)
    )
    for i, f in enumerate(native_frames):
        sheet_native.alpha_composite(f, (i * f.width, 0))
    sheet_native.save(OUT_DIR / "idle_sheet_native.png")

    sheet_descended = Image.new(
        "RGBA", (descended_frames[0].width * n, descended_frames[0].height), (0, 0, 0, 0)
    )
    for i, f in enumerate(descended_frames):
        sheet_descended.alpha_composite(f, (i * f.width, 0))
    sheet_descended.save(OUT_DIR / "idle_sheet_descended.png")

    gif_frames = [_flatten_for_gif(f) for f in descended_frames]
    gif_frames[0].save(
        OUT_DIR / "idle_loop_descended.gif",
        save_all=True,
        append_images=gif_frames[1:],
        duration=90,
        loop=0,
    )
    upscaled = [
        f.resize((f.width * UPSCALE_FACTOR, f.height * UPSCALE_FACTOR), Image.Resampling.NEAREST)
        for f in gif_frames
    ]
    upscaled[0].save(
        OUT_DIR / "idle_loop_upscaled.gif",
        save_all=True,
        append_images=upscaled[1:],
        duration=90,
        loop=0,
    )

    # Measurements the README quotes -- recomputed here from the actual composited
    # frames, not asserted from the curve math alone.
    feet = [foot_bottom_rows(f) for f in native_frames]
    feet_descended = [foot_bottom_rows(f) for f in descended_frames]
    centroids_descended = [_opaque_centroid(f) for f in descended_frames]
    ys = [c[1] for c in centroids_descended]
    xs = [c[0] for c in centroids_descended]

    measurements = {
        "frame_count": n,
        "breath_cycles_per_loop": idle_cycle.BREATH_CYCLES_PER_LOOP,
        "sway_cycles_per_loop": idle_cycle.SWAY_CYCLES_PER_LOOP,
        "figure_height_native_px": idle_cycle.FIGURE_HEIGHT_NATIVE_PX,
        "figure_px": idle_cycle.FIGURE_PX,
        "descend_scale": idle_cycle.DESCEND_SCALE,
        "breath_amplitude_native_px": idle_cycle.BREATH_AMPLITUDE_NATIVE_PX,
        "sway_amplitude_native_px": idle_cycle.SWAY_AMPLITUDE_NATIVE_PX,
        "breath_amplitude_descended_px": round(
            idle_cycle.BREATH_AMPLITUDE_NATIVE_PX * idle_cycle.DESCEND_SCALE, 3
        ),
        "sway_amplitude_descended_px": round(
            idle_cycle.SWAY_AMPLITUDE_NATIVE_PX * idle_cycle.DESCEND_SCALE, 3
        ),
        "measured_opaque_centroid_y_range_descended_px": round(max(ys) - min(ys), 3),
        "measured_opaque_centroid_x_range_descended_px": round(max(xs) - min(xs), 3),
        "foot_bottom_rows_native_all_frames_identical": len(set(feet)) == 1,
        "foot_bottom_rows_descended_all_frames_identical": len(set(feet_descended)) == 1,
        "foot_bottom_rows_native": feet[0],
        "foot_bottom_rows_descended": feet_descended[0],
        "arm_lag_phase": idle_cycle.ARM_LAG_PHASE,
        "arm_lag_damping": idle_cycle.ARM_LAG_DAMPING,
        "rig_attach_torso_local_px": RIG["attach_torso_local_px"],
        "rig_bone_length_fix": RIG["bone_length_fix"],
        "rig_pivots_and_z": RIG["rig"],
        "parts_source": str(PARTS_DIR.relative_to(REPO_ROOT)),
    }
    (OUT_DIR / "rig_data_used.json").write_text(json.dumps(measurements, indent=2) + "\n")

    print(json.dumps(measurements, indent=2))
    print(f"\nWrote evidence to {OUT_DIR.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
