from __future__ import annotations

import numpy as np
import pytest
from PIL import Image


def make_block_image(colours: list[tuple[int, int, int]], block: int = 8) -> Image.Image:
    """A solid-colour-block image: one `block x block` square per colour,
    laid out in a single row. Distinct, unambiguous clusters -- exactly
    what a clustering algorithm should recover with no ambiguity."""
    n = len(colours)
    arr = np.zeros((block, block * n, 3), dtype=np.uint8)
    for i, rgb in enumerate(colours):
        arr[:, i * block : (i + 1) * block] = rgb
    return Image.fromarray(arr, mode="RGB")


@pytest.fixture
def four_colour_image() -> Image.Image:
    # Deliberately spans dark -> light so ramp ordering is easy to assert.
    return make_block_image(
        [
            (10, 10, 10),  # near-black
            (200, 30, 30),  # mid-value red
            (60, 120, 60),  # mid-value green
            (245, 245, 245),  # near-white
        ]
    )
