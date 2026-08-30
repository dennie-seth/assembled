"""Descent chain (T-0073): `recipe -> generate -> descend -> validate ->
provenance` (`13-asset-pipeline.md` §1/§3.1).

```
box/area downscale (exact integer factor)
  -> quantize to locked palette (Oklab nearest-colour, dithering OFF)
  -> cleanup (orphan single pixels)
  -> indexed PNG (mode 'P', palette == the locked LUT, tRNS on the background index)
```

Output is transparent by default (P-6, §3.7): the indexed PNG carries a tRNS
chunk marking `background_index` fully transparent, so the file renders with a
real alpha channel while keeping the 16-slot palette P-4 requires. Base-field
tiles are the deliberate exception -- pass `background_index=None` there, since
a transparent floor tile is a hole in the world.

`descend_stub` (identity passthrough) stays as the T-0071 seam's default --
`pipeline.generate()` doesn't require a palette to run (concept sheets,
§6, are deliberately *never* descended/quantized), so making descent
mandatory there would break that path. Callers that do want the real
chain call `descend()` directly, passing the locked palette from T-0105.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from PIL.Image import Resampling

from comfy_client.oklab import srgb_to_oklab
from comfy_client.transparency import BACKGROUND_INDEX, save_indexed_sprite


def descend_stub(raw_path: Path) -> Path:
    """Identity passthrough, used when no descent is wanted (e.g. concept art)."""
    return raw_path


def _box_downscale(image: Image.Image, target_size: int) -> Image.Image:
    width, height = image.size
    if width % target_size != 0 or height % target_size != 0:
        raise ValueError(
            f"image is {width}x{height}, not an exact integer multiple of "
            f"target_size={target_size} in both dimensions (13-asset-pipeline.md §3.1)"
        )
    return image.resize((target_size, target_size), Resampling.BOX)


def _quantize_to_palette(
    image: Image.Image, palette: list[tuple[int, int, int]]
) -> np.ndarray:
    """Nearest-colour (Oklab) assignment per pixel, independently -- no
    dithering, no error diffusion. Returns an (H, W) uint8 index array."""
    arr = np.array(image.convert("RGB"), dtype=np.uint8)
    h, w, _ = arr.shape
    pixel_oklab = srgb_to_oklab(arr.reshape(-1, 3))
    palette_oklab = srgb_to_oklab(np.array(palette, dtype=np.uint8))

    dists = ((pixel_oklab[:, None, :] - palette_oklab[None, :, :]) ** 2).sum(axis=-1)
    return dists.argmin(axis=1).astype(np.uint8).reshape(h, w)


def _cleanup_orphans(index_arr: np.ndarray) -> np.ndarray:
    """Replace 4-connected single-pixel orphans (a pixel whose index matches
    none of its orthogonal neighbours) with the majority neighbour index --
    minimal edge repair for downscale/quantize noise (13-asset-pipeline.md
    §3.1, §2 orphan-pixels check)."""
    h, w = index_arr.shape
    out = index_arr.copy()
    for y in range(h):
        for x in range(w):
            idx = index_arr[y, x]
            neighbours = []
            if y > 0:
                neighbours.append(index_arr[y - 1, x])
            if y < h - 1:
                neighbours.append(index_arr[y + 1, x])
            if x > 0:
                neighbours.append(index_arr[y, x - 1])
            if x < w - 1:
                neighbours.append(index_arr[y, x + 1])
            if neighbours and idx not in neighbours:
                values, counts = np.unique(neighbours, return_counts=True)
                out[y, x] = values[np.argmax(counts)]
    return out


def _to_indexed_image(
    index_arr: np.ndarray, palette: list[tuple[int, int, int]]
) -> Image.Image:
    image = Image.fromarray(index_arr, mode="P")
    flat_palette = [0] * (256 * 3)
    for i, rgb in enumerate(palette):
        flat_palette[3 * i : 3 * i + 3] = list(rgb)
    image.putpalette(flat_palette)
    return image


def descend(
    raw_path: Path,
    palette: list[tuple[int, int, int]],
    target_size: int,
    out_path: Path | None = None,
    background_index: int | None = BACKGROUND_INDEX,
) -> Path:
    """The real T-0073 chain. `palette` is index-ordered RGB (as returned by
    `comfy_client.palette.load_palette_lut`) -- index i in the output PNG
    means `palette[i]`, satisfying P-4 by construction.

    `background_index` is the palette slot the output declares fully
    transparent (P-6). It defaults to slot 0, the background/transparent key
    every sprite in the game shares; pass `None` for base-field tiles and other
    output that is opaque by design."""
    image = Image.open(raw_path)
    downscaled = _box_downscale(image, target_size)
    index_arr = _quantize_to_palette(downscaled, palette)
    index_arr = _cleanup_orphans(index_arr)
    out_image = _to_indexed_image(index_arr, palette)

    out_path = out_path or raw_path.with_name(f"{raw_path.stem}_{target_size}px.png")
    return save_indexed_sprite(out_image, out_path, background_index=background_index)
