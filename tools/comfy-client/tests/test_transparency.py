"""Sprite output carries true transparency -- always (P-6).

The §24-e sheet shipped opaque because every writer in the pipeline called
`Image.save()` directly and Pillow does not add a tRNS chunk unless it is
asked to. This module is the one place that knows how a sprite is written,
so "transparent" is a property of the save path rather than of whoever
remembered.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from comfy_client.errors import BackgroundCutoutError
from comfy_client.transparency import (
    BACKGROUND_INDEX,
    apply_indexed_transparency,
    cut_background_alpha,
    indexed_transparency_index,
    save_indexed_sprite,
)

PALETTE = [(18, 17, 14), (61, 59, 49), (73, 73, 59), (240, 240, 240)]


def _indexed(arr: np.ndarray) -> Image.Image:
    img = Image.fromarray(arr.astype(np.uint8), mode="P")
    flat = [0] * (256 * 3)
    for i, rgb in enumerate(PALETTE):
        flat[3 * i : 3 * i + 3] = list(rgb)
    img.putpalette(flat)
    return img


def _sprite(h: int = 8, w: int = 8) -> np.ndarray:
    arr = np.zeros((h, w), dtype=np.uint8)
    arr[2:6, 2:6] = 2
    return arr


# ---- apply_indexed_transparency ------------------------------------------


def test_marks_the_background_index_transparent():
    out = apply_indexed_transparency(_indexed(_sprite()))
    assert out.info["transparency"] == BACKGROUND_INDEX


def test_background_index_defaults_to_slot_zero():
    assert BACKGROUND_INDEX == 0


def test_honours_a_non_default_background_index():
    out = apply_indexed_transparency(_indexed(_sprite()), background_index=3)
    assert out.info["transparency"] == 3


def test_leaves_the_source_image_untouched():
    source = _indexed(_sprite())
    apply_indexed_transparency(source)
    assert "transparency" not in source.info


def test_rejects_a_non_indexed_image():
    with pytest.raises(ValueError, match="mode 'P'"):
        apply_indexed_transparency(Image.new("RGB", (4, 4)))


# ---- save_indexed_sprite -------------------------------------------------


def test_saved_sprite_round_trips_with_a_trns_chunk(tmp_path):
    out = save_indexed_sprite(_indexed(_sprite()), tmp_path / "sprite.png")
    reloaded = Image.open(out)
    assert reloaded.mode == "P"
    assert indexed_transparency_index(reloaded) == 0


def test_saving_preserves_every_index_and_the_whole_palette(tmp_path):
    """A format change must not move a single pixel or a single palette slot."""
    arr = _sprite()
    source = _indexed(arr)
    reloaded = Image.open(save_indexed_sprite(source, tmp_path / "sprite.png"))

    assert np.array_equal(np.array(reloaded), arr)
    assert reloaded.getpalette() == source.getpalette()


def test_saving_is_deterministic(tmp_path):
    a = save_indexed_sprite(_indexed(_sprite()), tmp_path / "a.png")
    b = save_indexed_sprite(_indexed(_sprite()), tmp_path / "b.png")
    assert a.read_bytes() == b.read_bytes()


def test_opting_out_of_transparency_writes_an_opaque_png(tmp_path):
    """Tiles are base fields -- a transparent floor tile is a hole in the world."""
    out = save_indexed_sprite(_indexed(_sprite()), tmp_path / "tile.png", background_index=None)
    assert indexed_transparency_index(Image.open(out)) is None


def test_creates_missing_parent_directories(tmp_path):
    out = save_indexed_sprite(_indexed(_sprite()), tmp_path / "nested" / "deep" / "s.png")
    assert out.is_file()


# ---- indexed_transparency_index ------------------------------------------


def test_reads_back_a_bytes_alpha_table():
    image = _indexed(_sprite())
    image.info["transparency"] = bytes([0, 255, 255, 255])
    assert indexed_transparency_index(image) == 0


def test_returns_none_when_there_is_no_trns_chunk():
    assert indexed_transparency_index(_indexed(_sprite())) is None


# ---- cut_background_alpha (the RGBA prop path) ---------------------------


def _rgba_subject_on_background(
    bg: tuple[int, int, int] = (12, 12, 14),
    fg: tuple[int, int, int] = (220, 60, 40),
    size: int = 12,
) -> Image.Image:
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[:, :, :3] = bg
    arr[3:9, 3:9, :3] = fg
    arr[:, :, 3] = 255
    return Image.fromarray(arr, mode="RGBA")


def test_clears_alpha_on_the_border_connected_background():
    out = cut_background_alpha(_rgba_subject_on_background())
    alpha = np.array(out)[:, :, 3]
    assert alpha[0, 0] == 0
    assert alpha[5, 5] == 255


def test_leaves_the_subject_rgb_byte_identical():
    source = _rgba_subject_on_background()
    out = cut_background_alpha(source)
    assert np.array_equal(np.array(out)[:, :, :3], np.array(source)[:, :, :3])


def test_does_not_cut_an_interior_region_that_merely_matches_the_background():
    """Region growing is border-seeded: an enclosed dark pocket stays opaque."""
    arr = np.array(_rgba_subject_on_background())
    arr[5:7, 5:7, :3] = (12, 12, 14)  # background-coloured pocket inside the subject
    out = cut_background_alpha(Image.fromarray(arr, mode="RGBA"))
    assert np.array(out)[5, 5, 3] == 255


def test_raises_when_almost_nothing_would_stay_opaque():
    """An edge-to-edge crop has no background -- refuse rather than erase the art."""
    arr = np.zeros((12, 12, 4), dtype=np.uint8)
    arr[:, :, :3] = (12, 12, 14)
    arr[:, :, 3] = 255
    with pytest.raises(BackgroundCutoutError, match="opaque"):
        cut_background_alpha(Image.fromarray(arr, mode="RGBA"))


def test_border_pixels_are_unconditional_seeds():
    """Region growing starts at the frame edge, whatever colour sits there."""
    out = cut_background_alpha(_rgba_subject_on_background(), tolerance=0.0)
    assert np.array(out)[0, 0, 3] == 0


def test_tolerance_of_zero_only_grows_through_exactly_matching_pixels():
    arr = np.array(_rgba_subject_on_background())
    arr[1, 1, :3] = (13, 12, 14)  # interior, off by one from the background
    out = cut_background_alpha(Image.fromarray(arr, mode="RGBA"), tolerance=0.0)
    assert np.array(out)[1, 1, 3] == 255
    assert np.array(out)[1, 5, 3] == 0


def test_accepts_an_rgb_image_and_returns_rgba():
    rgb = Image.fromarray(np.array(_rgba_subject_on_background())[:, :, :3], mode="RGB")
    assert cut_background_alpha(rgb).mode == "RGBA"
