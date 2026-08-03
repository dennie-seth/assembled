from __future__ import annotations

import numpy as np

from palette_extract.oklab import srgb_to_oklab


def test_black_has_zero_lightness():
    lab = srgb_to_oklab(np.array([0, 0, 0], dtype=np.uint8))
    assert abs(lab[0]) < 1e-6


def test_white_has_approximately_unit_lightness():
    lab = srgb_to_oklab(np.array([255, 255, 255], dtype=np.uint8))
    assert abs(lab[0] - 1.0) < 1e-3


def test_lightness_is_monotonic_for_a_grey_ramp():
    greys = np.array([[v, v, v] for v in (0, 64, 128, 192, 255)], dtype=np.uint8)
    lightness = srgb_to_oklab(greys)[:, 0]
    assert list(lightness) == sorted(lightness)


def test_vectorized_matches_scalar_per_pixel():
    pixels = np.array([[10, 20, 30], [200, 100, 50]], dtype=np.uint8)
    batched = srgb_to_oklab(pixels)
    for i, px in enumerate(pixels):
        assert np.allclose(batched[i], srgb_to_oklab(px))
