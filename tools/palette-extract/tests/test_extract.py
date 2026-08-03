from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from conftest import make_block_image
from palette_extract.extract import extract_palette


def test_clusters_to_exactly_n_slots(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    assert len(slots) == 4
    assert [s.index for s in slots] == [0, 1, 2, 3]


def test_recovers_each_distinct_block_colour_exactly(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    recovered = {s.rgb for s in slots}
    assert recovered == {(10, 10, 10), (200, 30, 30), (60, 120, 60), (245, 245, 245)}


def test_ordered_darkest_to_lightest(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    lightness_values = [s.lightness for s in slots]
    assert lightness_values == sorted(lightness_values)
    assert slots[0].rgb == (10, 10, 10)
    assert slots[-1].rgb == (245, 245, 245)


def test_deterministic_same_input_same_n_byte_identical(four_colour_image):
    a = extract_palette(four_colour_image, n=4)
    b = extract_palette(four_colour_image, n=4)
    assert [(s.index, s.rgb) for s in a] == [(s.index, s.rgb) for s in b]


def test_raises_when_fewer_distinct_colours_than_n():
    image = make_block_image([(0, 0, 0), (255, 255, 255)])
    with pytest.raises(ValueError, match="distinct colour"):
        extract_palette(image, n=16)


def test_hex_property_matches_rgb(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    for slot in slots:
        r, g, b = slot.rgb
        assert slot.hex == f"#{r:02x}{g:02x}{b:02x}"


def test_converts_non_rgb_input_image():
    arr = np.zeros((8, 16, 3), dtype=np.uint8)
    arr[:, :8] = (20, 20, 20)
    arr[:, 8:] = (230, 230, 230)
    rgba = Image.fromarray(arr, mode="RGB").convert("RGBA")
    slots = extract_palette(rgba, n=2)
    assert len(slots) == 2
