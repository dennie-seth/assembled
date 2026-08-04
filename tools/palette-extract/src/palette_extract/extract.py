"""T-0105: cluster an approved concept sheet's colours to N, order into a
value ramp, emit a LUT (`docs/design/13-asset-pipeline.md` §6.10, §3.0).

**Value-ramp semantics (P-4, P-A resolved):** slot index 0 is the *darkest*
cluster by Oklab lightness, slot N-1 the *lightest*, monotonically
increasing in between. This is the ramp order every downstream asset's
index N must agree on -- documented here because nothing enforces it
structurally past this module; `descend.py` (T-0073) and `asset_gate`
(T-0102) both just trust the LUT's slot order.

No reserved transparency/background slot: this extracts a *material*
palette from a solid interior sheet, not a sprite alphabet. Background/cutout
index conventions are a per-sprite concern for later sprite/prop work, not
this task.

Clustering runs in Oklab space (perceptually uniform, so cluster boundaries
track how the source actually reads, not how sRGB happens to be encoded).
Each cluster's representative colour is the mean *original* sRGB of the
pixels assigned to it, not the Oklab centroid converted back -- that keeps
reported hex values inside the sheet's actual colours instead of a
gamut-clipped round-trip.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy.cluster.vq import kmeans2

from palette_extract.oklab import srgb_to_oklab

# Fixed so the same sheet + same N always produce the same LUT (T-0105
# acceptance: "Deterministic: same input sheet + same N -> byte-identical
# LUT"). scipy's kmeans2 is exactly reproducible given a seeded Generator.
DETERMINISTIC_SEED = 42


@dataclass(frozen=True)
class PaletteSlot:
    index: int
    rgb: tuple[int, int, int]
    lightness: float  # Oklab L of this slot's mean colour, for reporting/debugging

    @property
    def hex(self) -> str:
        r, g, b = self.rgb
        return f"#{r:02x}{g:02x}{b:02x}"


def extract_palette(
    image: Image.Image, n: int, seed: int = DETERMINISTIC_SEED
) -> list[PaletteSlot]:
    """Cluster `image`'s pixels to `n` colours, ordered darkest -> lightest.

    Raises `ValueError` if the image has fewer than `n` distinct colours --
    clustering to more slots than there are colours to fill them produces
    duplicate/degenerate slots, which would silently break P-4's "each
    slot is a distinct ramp position" premise.
    """
    if n < 1:
        raise ValueError(f"n must be >= 1, got {n}")

    rgb_image = image.convert("RGB")
    pixels = np.array(rgb_image, dtype=np.uint8).reshape(-1, 3)

    unique_colours = np.unique(pixels, axis=0)
    if len(unique_colours) < n:
        raise ValueError(
            f"image has only {len(unique_colours)} distinct colour(s), cannot cluster to n={n}"
        )

    oklab = srgb_to_oklab(pixels)
    centroids, labels = kmeans2(oklab, n, minit="++", rng=np.random.default_rng(seed))

    slots = []
    for cluster_id in range(n):
        mask = labels == cluster_id
        if not mask.any():
            # k-means++ with distinct input colours and n <= unique count
            # shouldn't produce an empty cluster, but guard rather than
            # silently emit a garbage (0,0,0) slot if it ever does.
            raise ValueError(f"cluster {cluster_id} received no pixels -- degenerate clustering")
        mean_rgb = pixels[mask].mean(axis=0).round().astype(int)
        rgb = (int(mean_rgb[0]), int(mean_rgb[1]), int(mean_rgb[2]))
        lightness = float(srgb_to_oklab(np.array(rgb, dtype=np.uint8))[0])
        slots.append((rgb, lightness))

    # Order darkest -> lightest by the *representative* colour's own
    # lightness (not the raw Oklab centroid) so the reported hex and the
    # ramp order are always consistent with each other.
    slots.sort(key=lambda s: s[1])

    return [
        PaletteSlot(index=i, rgb=rgb, lightness=lightness)
        for i, (rgb, lightness) in enumerate(slots)
    ]
