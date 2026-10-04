"""Post-process background keying for flat-backdrop character renders.

Why this exists
---------------
Controlling the backdrop colour from the positive prompt does not work on this recipe.
Four magenta rounds and one grey round (2026-10-04) all showed the same mechanism: a
colour named and weighted in the positive prompt bleeds onto the *subject* -- the costume
rendered pink under magenta and pale blue-grey under an emphasised grey. The cleanest
keyable render in the corpus is one generated with the stock prompt and no background
instruction at all.

So the backdrop is removed *after* generation instead, here.

The one design decision that matters
------------------------------------
Background is found by flooding in **from the frame border**, not by thresholding globally.
A costume highlight that happens to match the backdrop colour is not reachable from the
border, so it survives by construction. A global threshold would punch a hole through it.
`figure_pixels_colliding_with_backdrop` in the returned stats reports exactly how many
figure pixels a global threshold *would* have eaten, so a backdrop colour can be judged on
evidence rather than assumption.
"""
from __future__ import annotations

from collections import deque

import numpy as np
from PIL import Image, ImageFilter

#: RGB manhattan distance within which a pixel counts as "the backdrop colour".
DEFAULT_TOLERANCE = 42
#: Width of the soft alpha ramp just outside the hard threshold, in the same units.
DEFAULT_FEATHER = 22
#: How far the alpha ramp may reach inward from the flooded background, in pixels.
_EDGE_BAND_RADIUS = 3


def _flood_from_border(candidate: np.ndarray) -> np.ndarray:
    """Pixels reachable from the frame edge through `candidate`, 4-connected."""
    h, w = candidate.shape
    seen = np.zeros((h, w), bool)
    q: deque[tuple[int, int]] = deque()

    def push(y: int, x: int) -> None:
        if candidate[y, x] and not seen[y, x]:
            seen[y, x] = True
            q.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w:
                push(ny, nx)
    return seen


def key_background(
    image: Image.Image,
    tolerance: int = DEFAULT_TOLERANCE,
    feather: int = DEFAULT_FEATHER,
) -> tuple[Image.Image, dict]:
    """Return `(rgba, stats)` with the flat backdrop keyed to transparent.

    The backdrop colour is taken as the median of the frame's own border pixels, so the
    caller does not have to name it.
    """
    rgb = image.convert("RGB")
    a = np.asarray(rgb).astype(np.int16)
    h, w = a.shape[:2]

    border = np.concatenate([a[0, :], a[-1, :], a[:, 0], a[:, -1]])
    backdrop = np.median(border, axis=0)
    dist = np.abs(a - backdrop).sum(axis=2).astype(np.float32)

    background = _flood_from_border(dist < tolerance)

    alpha = np.where(background, 0.0, 1.0).astype(np.float32)
    if feather > 0:
        # Ramp ONLY in a thin band hugging the flooded background. Feathering every
        # pixel within the distance band would also ramp an ENCLOSED
        # backdrop-coloured region down to zero -- destroying exactly the pixels the
        # border flood exists to protect.
        grown = np.asarray(
            Image.fromarray((background * 255).astype(np.uint8), "L").filter(
                ImageFilter.MaxFilter(2 * _EDGE_BAND_RADIUS + 1)
            )
        ) > 127
        near = (~background) & grown & (dist < tolerance + feather)
        alpha[near] = np.clip((dist[near] - tolerance) / feather, 0.0, 1.0)

    figure = alpha > 0.5
    collisions = int((figure & (dist < tolerance)).sum())

    touches: list[str] = []
    ys, xs = np.where(figure)
    if len(xs):
        if xs.min() == 0:
            touches.append("left")
        if xs.max() == w - 1:
            touches.append("right")
        if ys.min() == 0:
            touches.append("top")
        if ys.max() == h - 1:
            touches.append("bottom")

    stats = {
        "backdrop_rgb": [int(v) for v in backdrop],
        "tolerance": tolerance,
        "feather": feather,
        "keyed_out_fraction": round(float(background.mean()), 4),
        "figure_fraction": round(float(figure.mean()), 4),
        # how many figure pixels a naive global threshold would have destroyed
        "figure_pixels_colliding_with_backdrop": collisions,
        "soft_edge_pixels": int(((alpha > 0.0) & (alpha < 1.0)).sum()),
        "figure_touches_frame": touches,
    }
    rgba = np.dstack([np.asarray(rgb), (alpha * 255).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA"), stats
