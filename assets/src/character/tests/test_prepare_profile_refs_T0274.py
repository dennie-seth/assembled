"""Unit tests for char_gen.prepare_profile_refs — T-0274.

The six curated T-0273 profile references are real photographs/illustrations
of varying aspect ratio (1536x929 Muybridge plates, 600x900 silhouette
portraits). sd-scripts' default (non-bucketed) dataset path used elsewhere in
this repo (see test_identity_curation_T0248.py::test_ref_images_are_square)
requires square input images -- so, unlike T-0248's already-square
IP-Adapter-generated views, these need a deterministic letterbox-to-square
step before they can become a training set.

Pure-function tests only, against synthetic in-memory images (no binary
fixtures committed, per .claude/rules/python.md) -- the real six JPGs are
exercised by the driver script and validated statically by
test_identity_curation_profile_T0274.py.

RED state: char_gen.prepare_profile_refs does not exist -> every test
           ERRORs on import.
GREEN state: letterbox_to_square produces a square canvas of the requested
             size, preserves the source aspect ratio (no stretch/squash),
             pads with the requested background colour, and always returns
             RGB regardless of input mode.
"""

from __future__ import annotations

import pytest

PIL_Image = pytest.importorskip("PIL.Image")

from char_gen.prepare_profile_refs import letterbox_to_square  # noqa: E402


def _solid(size: tuple[int, int], color: tuple[int, int, int], mode: str = "RGB"):
    return PIL_Image.new(mode, size, color)


def test_output_is_square_default_size():
    img = _solid((400, 200), (200, 50, 50))
    out = letterbox_to_square(img)
    assert out.size == (1024, 1024)


def test_output_is_square_custom_size():
    img = _solid((100, 200), (10, 200, 10))
    out = letterbox_to_square(img, size=256)
    assert out.size == (256, 256)


def test_grayscale_input_converted_to_rgb():
    img = _solid((300, 300), 128, mode="L")
    out = letterbox_to_square(img, size=64)
    assert out.mode == "RGB"


def test_landscape_letterboxed_top_and_bottom():
    # 400x200 (2:1) into a 100x100 canvas -> content scales to 100x50,
    # centred with 25px background bars top and bottom.
    content_color = (200, 40, 40)
    background = (10, 10, 10)
    img = _solid((400, 200), content_color)
    out = letterbox_to_square(img, size=100, background_rgb=background)

    assert out.getpixel((50, 5)) == background
    assert out.getpixel((50, 94)) == background
    assert out.getpixel((50, 50)) == content_color


def test_portrait_letterboxed_left_and_right():
    content_color = (40, 200, 40)
    background = (20, 20, 20)
    img = _solid((200, 400), content_color)
    out = letterbox_to_square(img, size=100, background_rgb=background)

    assert out.getpixel((5, 50)) == background
    assert out.getpixel((94, 50)) == background
    assert out.getpixel((50, 50)) == content_color


def test_square_input_fills_canvas_with_no_background_bars():
    content_color = (60, 60, 200)
    background = (0, 0, 0)
    img = _solid((300, 300), content_color)
    out = letterbox_to_square(img, size=100, background_rgb=background)

    # A square source should scale to fill the square canvas edge-to-edge --
    # every sampled pixel (including corners) is content, never background.
    for xy in [(0, 0), (99, 0), (0, 99), (99, 99), (50, 50)]:
        assert out.getpixel(xy) == content_color


def test_default_background_is_mid_grey():
    img = _solid((400, 200), (255, 255, 255))
    out = letterbox_to_square(img, size=100)
    assert out.getpixel((50, 5)) == (128, 128, 128)
