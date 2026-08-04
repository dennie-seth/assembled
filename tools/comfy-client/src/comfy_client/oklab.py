"""sRGB <-> Oklab conversion (Bjoern Ottosson's Oklab).

Duplicated from `tools/palette-extract/src/palette_extract/oklab.py` --
each tool in `tools/` is a self-contained package with its own venv
(`tools/asset-gate/README.md` "Location + language"); ~30 lines of
well-known colour-science formulas isn't worth a new shared package for.
The descent chain's quantize step (T-0073, §3.1) needs the same
perceptually-uniform nearest-colour distance the extractor (T-0105) used
to build the ramp in the first place.
"""

from __future__ import annotations

import numpy as np


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """`rgb`: (..., 3) uint8/float sRGB in [0, 255]. Returns (..., 3) Oklab (L, a, b)."""
    lin = _srgb_to_linear(np.asarray(rgb, dtype=np.float64))
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]

    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

    l_ = np.cbrt(l_)
    m_ = np.cbrt(m_)
    s_ = np.cbrt(s_)

    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_

    return np.stack([lightness, a, b2], axis=-1)
