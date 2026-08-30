"""Sprite output carries true transparency -- always (P-6, `13-asset-pipeline.md` §3.7).

The §24-e character sheet (`player_idle_sheet_hybrid_T0252.png`) shipped as a
mode-'P' PNG whose background really was a single palette index -- the cutout
had run -- but with **no tRNS chunk**, so the file declared no transparency at
all and Godot decoded it to `FORMAT_RGB8`: an opaque black rectangle behind the
figure. Every writer in the pipeline had called `Image.save()` directly, and
Pillow does not emit tRNS unless it is asked to.

This module is the one place that knows how a sprite is written, so
"transparent" becomes a property of the save path rather than of whoever
remembered to pass an argument.

**Format: indexed PNG (mode 'P') + tRNS on the background index.** It keeps the
16-slot indexed palette that the descent chain, P-4 index semantics and the
palette gates all require, *and* it renders transparent -- Godot's PNG decoder
expands tRNS into a real alpha channel on load. Verified on the engine build
`client/project.godot` targets (4.7.1): a P+tRNS PNG loads as `FORMAT_RGBA8`
with alpha 0.0 on the background index, the same file without tRNS loads as
`FORMAT_RGB8` with alpha 1.0 everywhere. `client/shaders/chroma_palette_swap.gdshader`
multiplies through `TEXTURE.a` to preserve the silhouette, so the alpha channel
is load-bearing for the chroma mechanic, not cosmetic.

`cut_background_alpha` is the true-RGBA counterpart, for output that never had
an index to key on (the ComfyUI cutout path, §6.15).
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

from comfy_client.errors import BackgroundCutoutError
from comfy_client.oklab import srgb_to_oklab

#: P-4 slot 0 is the background/transparent key for every sprite in the game.
#: `char_gen.synth_sheet` has documented it as "background / transparent" since
#: T-0198 and the whole gate stack (cell fit, orphan pixels, frame consistency)
#: already treats it as "not part of the sprite" -- tRNS just makes the file say
#: what the pipeline already means.
BACKGROUND_INDEX = 0

#: Default Oklab distance a pixel may sit from its already-background neighbour
#: and still be grown into the background region. Matches the tolerance the
#: committed T-0252 character cutout was proven at.
DEFAULT_CUTOUT_TOLERANCE = 0.03

#: A cutout that leaves less than this fraction of the canvas opaque has almost
#: certainly eaten the subject rather than the background.
MIN_OPAQUE_FRACTION = 0.05


def apply_indexed_transparency(
    image: Image.Image, background_index: int = BACKGROUND_INDEX
) -> Image.Image:
    """Return a copy of the indexed *image* whose *background_index* is fully
    transparent. Pixel indices and the embedded palette are untouched -- this
    adds a tRNS chunk and nothing else."""
    if image.mode != "P":
        raise ValueError(
            f"expected an indexed image (mode 'P') to mark transparent, got {image.mode!r}"
        )
    out = image.copy()
    out.info["transparency"] = background_index
    return out


def indexed_transparency_index(image: Image.Image) -> int | None:
    """The palette index *image* declares fully transparent, or None.

    Pillow surfaces the tRNS chunk either as a bare ``int`` or as a ``bytes``
    alpha table indexed by palette slot; both are legal PNG.
    """
    raw = image.info.get("transparency")
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    zeros = [i for i, alpha in enumerate(raw) if alpha == 0]
    return zeros[0] if zeros else None


def save_indexed_sprite(
    image: Image.Image,
    out_path: Path | str,
    background_index: int | None = BACKGROUND_INDEX,
) -> Path:
    """Write *image* as an indexed PNG with a transparent background.

    This is the sprite save path: every character, entity and prop sheet the
    pipeline finalizes goes through it, and transparency is the default rather
    than an argument someone has to remember.

    Pass ``background_index=None`` for the deliberate exceptions -- base-field
    tiles, the palette LUT strip -- where an opaque PNG is correct and a
    transparent one would be a hole in the world.
    """
    if image.mode != "P":
        raise ValueError(f"expected an indexed image (mode 'P') to save, got {image.mode!r}")
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if background_index is None:
        image.save(path)
    else:
        image.save(path, transparency=background_index)
    return path


def _border_connected_background(oklab: np.ndarray, tolerance: float) -> np.ndarray:
    """Boolean mask of the border-seeded, tolerance-grown background region.

    Seeded from every border pixel and grown through 4-connected neighbours
    that sit within *tolerance* (Oklab distance) of the pixel they grow from --
    so a gradient background is followed, while an enclosed pocket that merely
    happens to match the background colour is left alone because nothing
    connects it to the edge.
    """
    h, w, _ = oklab.shape
    mask = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    for x in range(w):
        for y in (0, h - 1):
            if not mask[y, x]:
                mask[y, x] = True
                queue.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y, x]:
                mask[y, x] = True
                queue.append((y, x))

    tolerance_sq = tolerance * tolerance
    while queue:
        y, x = queue.popleft()
        source = oklab[y, x]
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not mask[ny, nx]:
                if float(((oklab[ny, nx] - source) ** 2).sum()) <= tolerance_sq:
                    mask[ny, nx] = True
                    queue.append((ny, nx))
    return mask


def cut_background_alpha(
    image: Image.Image,
    tolerance: float = DEFAULT_CUTOUT_TOLERANCE,
    min_opaque_fraction: float = MIN_OPAQUE_FRACTION,
) -> Image.Image:
    """Return *image* as RGBA with the background matted out (alpha 0).

    The background is the border-connected region grown in Oklab space, the
    same content-aware segmentation the committed T-0252 character cutout uses.
    RGB is preserved byte-for-byte; only the alpha channel changes.

    Raises `BackgroundCutoutError` when the resulting opaque area falls below
    *min_opaque_fraction* of the canvas. An edge-to-edge crop has no background
    to key on, and silently returning a nearly-erased sprite is how PR #231's
    alpha-zero props shipped -- refusing is the safer failure.
    """
    rgba = image.convert("RGBA")
    arr = np.array(rgba)
    oklab = srgb_to_oklab(arr[:, :, :3])

    background = _border_connected_background(oklab, tolerance)
    opaque_fraction = 1.0 - float(background.mean())
    if opaque_fraction < min_opaque_fraction:
        raise BackgroundCutoutError(
            f"background cutout would leave only {opaque_fraction:.1%} of the image "
            f"opaque (minimum {min_opaque_fraction:.0%}) -- the border-connected region "
            f"grew into the subject at tolerance {tolerance}. The source is probably an "
            f"edge-to-edge crop with no background to key on."
        )

    arr[:, :, 3] = np.where(background, 0, arr[:, :, 3])
    return Image.fromarray(arr, mode="RGBA")
