"""The one place a character/entity sprite sheet gets written (P-6).

Every sheet writer in this package used to end with a private `_save()` that
called `Image.save()` directly. Pillow does not emit a tRNS chunk unless it is
asked to, so every sheet shipped opaque -- `player_idle_sheet_hybrid_T0252.png`
(HANDOFF §24-e) had its cutout correctly applied, every background pixel really
was index 0, and it still rendered as a solid black rectangle in Godot because
the file declared no transparency at all.

`save_sprite_sheet` is that `_save()`, hoisted into one module and made
transparent by default. `BG_IDX = 0  # background / transparent` has been in
`synth_sheet.py` since T-0198; this makes the file say what the code has always
meant.

Format: indexed PNG (mode 'P') + tRNS on the background index. It keeps the
16-slot palette that P-4 index semantics and the palette gates require, and
Godot's PNG decoder expands tRNS into a real alpha channel on load (verified
against the engine build `client/project.godot` targets, 4.7.1). Mirrors
`comfy_client.transparency.save_indexed_sprite`, which is the same contract on
the generation side -- the two packages pin different Pillow versions and
cannot share a module, so `asset_gate.transparency` is the single gate that
holds both of them to it.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

#: P-4 slot 0 is the background/transparent key for every sprite in the game.
BACKGROUND_INDEX = 0


def to_indexed_image(arr: np.ndarray, palette: list[tuple[int, int, int]]) -> Image.Image:
    """Wrap an (H, W) uint8 index array as a mode-'P' image carrying *palette*."""
    img = Image.fromarray(arr.astype(np.uint8), mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette):
        flat[3 * i] = r
        flat[3 * i + 1] = g
        flat[3 * i + 2] = b
    img.putpalette(flat)
    return img


def save_sprite_sheet(
    image_or_array: Image.Image | np.ndarray,
    out_path: Path | str,
    palette: list[tuple[int, int, int]] | None = None,
    background_index: int | None = BACKGROUND_INDEX,
) -> Path:
    """Write a sprite sheet as an indexed PNG with a transparent background.

    Accepts either an already-built mode-'P' image or an index array plus the
    *palette* to embed. Missing parent directories are created.

    `background_index=None` opts out, for the deliberate exceptions (base-field
    tiles, the palette LUT strip) where an opaque PNG is correct.
    """
    if isinstance(image_or_array, np.ndarray):
        if palette is None:
            raise ValueError("palette is required when saving from an index array")
        image = to_indexed_image(image_or_array, palette)
    else:
        image = image_or_array
        if image.mode != "P":
            raise ValueError(f"expected an indexed image (mode 'P'), got {image.mode!r}")

    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if background_index is None:
        image.save(path)
    else:
        image.save(path, transparency=background_index)
    return path


def transparency_index(image: Image.Image) -> int | None:
    """The palette index *image* declares fully transparent, or None.

    Pillow surfaces tRNS as either a bare ``int`` or a ``bytes`` alpha table.
    """
    raw = image.info.get("transparency")
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    zeros = [i for i, alpha in enumerate(raw) if alpha == 0]
    return zeros[0] if zeros else None
