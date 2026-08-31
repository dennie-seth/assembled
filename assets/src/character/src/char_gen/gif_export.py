"""Looping, upscaled GIF export for a character sprite sheet (T-0259).

The single shared home for turning an already-assembled indexed sheet into
a preview GIF -- WALK (`gen_hybrid_walk_T0259.py`) wires this in below, and
HIDE/ACTION (T-0260/T-0261) reuse it unchanged once they exist, per this
card's own acceptance criteria: "written so it generalizes ... take frame
count / layout / scale as parameters rather than hardcoding the walk's
4x2." Nothing here knows about a walk gait, 8 frames, or a 4x2 grid --
`frame_cells` (playback order), `cell_px`, `scale` and `frame_duration_ms`
are all caller-supplied.

Nearest-neighbour upscaling keeps pixel edges crisp at typical preview
sizes (no interpolation blur between palette colours); `loop=0` makes the
GIF play forever, matching a sprite sheet's own looping-cycle semantics;
`disposal=2` (restore to background between frames) avoids ghosting from
one frame's pixels bleeding into the next. The sheet's own declared
transparency index (P-6, `char_gen.sprite_io.save_sprite_sheet`) is carried
through onto the GIF unless the caller overrides it, since GIF -- like the
indexed PNGs this package ships -- supports exactly one transparent
palette index.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from PIL import Image

#: Default upscale factor and per-frame duration for a game-scale preview --
#: large enough to read the gait clearly, not so large the GIF is unwieldy.
DEFAULT_SCALE = 6
DEFAULT_FRAME_DURATION_MS = 120


def make_looping_gif(
    sheet: Image.Image,
    *,
    frame_cells: Sequence[tuple[int, int]],
    cell_px: int,
    out_path: Path | str,
    scale: int = DEFAULT_SCALE,
    frame_duration_ms: int = DEFAULT_FRAME_DURATION_MS,
    background_index: int | None = None,
) -> Path:
    """Crop *sheet* into `frame_cells` (row, col) playback order, upscale
    each cell `scale`x with nearest-neighbour, and write an infinitely
    looping animated GIF to *out_path*.

    `background_index` overrides the transparent palette index; when
    omitted, the sheet's own declared transparency (`sheet.info
    ["transparency"]`, as `char_gen.sprite_io.save_sprite_sheet` sets it) is
    used, so a caller doesn't have to re-derive a value the sheet already
    carries.
    """
    if not frame_cells:
        raise ValueError("frame_cells must not be empty")
    if scale < 1:
        raise ValueError(f"scale must be >= 1, got {scale}")

    transparency = (
        background_index if background_index is not None else sheet.info.get("transparency")
    )

    frames = []
    for r, c in frame_cells:
        box = (c * cell_px, r * cell_px, c * cell_px + cell_px, r * cell_px + cell_px)
        cell = sheet.crop(box)
        frames.append(cell.resize((cell_px * scale, cell_px * scale), Image.Resampling.NEAREST))

    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs = {
        "save_all": True,
        "append_images": frames[1:],
        "duration": frame_duration_ms,
        "loop": 0,
        "disposal": 2,
    }
    if transparency is not None:
        save_kwargs["transparency"] = transparency
    frames[0].save(path, **save_kwargs)
    return path
