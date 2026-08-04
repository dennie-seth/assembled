"""Descent chain (T-0073): box/area downscale -> Oklab nearest-colour
quantize (dithering off) -> orphan cleanup -> indexed PNG."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from comfy_client.descend import descend, descend_stub

# Deliberately spans dark -> light so nearest-colour assignment is unambiguous.
TEST_PALETTE = [
    (10, 10, 10),
    (90, 90, 90),
    (170, 40, 40),
    (240, 240, 240),
]


def test_descend_stub_is_an_identity_passthrough(tmp_path):
    raw = tmp_path / "raw.png"
    raw.write_bytes(b"fake-png-bytes")
    assert descend_stub(raw) == raw
    assert raw.read_bytes() == b"fake-png-bytes"


def _save_solid_image(path, rgb: tuple[int, int, int], size: tuple[int, int]):
    Image.new("RGB", size, rgb).save(path)
    return path


def test_downscale_uses_exact_integer_box_average(tmp_path):
    # 8x8 image, four solid 4x4 quadrants -> downscale by factor 2 to 4x4.
    # Each quadrant becomes a 2x2 block of matching indices in the output
    # (not a single isolated pixel), so orphan cleanup has no effect here
    # and this isolates the downscale+quantize behaviour specifically.
    arr = np.zeros((8, 8, 3), dtype=np.uint8)
    arr[:4, :4] = (0, 0, 0)  # top-left quadrant -> palette[0]
    arr[:4, 4:] = (100, 100, 100)  # top-right quadrant -> palette[2]
    arr[4:, :4] = (200, 200, 200)  # bottom-left quadrant -> palette[3]
    arr[4:, 4:] = (50, 50, 50)  # bottom-right quadrant -> palette[1]
    raw = tmp_path / "raw.png"
    Image.fromarray(arr, mode="RGB").save(raw)

    palette = [(0, 0, 0), (50, 50, 50), (100, 100, 100), (200, 200, 200)]
    out_path = descend(raw, palette=palette, target_size=4)
    result = Image.open(out_path)

    assert result.mode == "P"
    assert result.size == (4, 4)
    px = np.array(result)
    assert (px[:2, :2] == 0).all()
    assert (px[:2, 2:] == 2).all()
    assert (px[2:, :2] == 3).all()
    assert (px[2:, 2:] == 1).all()


def test_raises_on_non_integer_scale_factor(tmp_path):
    raw = _save_solid_image(tmp_path / "raw.png", (128, 128, 128), (17, 17))
    with pytest.raises(ValueError, match="integer multiple"):
        descend(raw, palette=TEST_PALETTE, target_size=16)


def test_quantizes_to_nearest_palette_colour(tmp_path):
    # A colour close to (90,90,90) mid-grey should snap to that palette slot.
    raw = _save_solid_image(tmp_path / "raw.png", (95, 88, 92), (16, 16))
    out_path = descend(raw, palette=TEST_PALETTE, target_size=4)
    result = Image.open(out_path)
    used_indices = {i for i, count in enumerate(result.histogram()) if count > 0}
    assert used_indices == {1}  # index 1 == (90, 90, 90)


def test_output_uses_only_palette_colours_no_dithering(tmp_path):
    # A smooth gradient would dither into blended dot patterns if dithering
    # were on; with it off, every output pixel must be an exact palette
    # member, never an intermediate blend.
    arr = np.linspace(0, 255, 16, dtype=np.uint8)
    arr = np.tile(arr, (16, 1))
    rgb = np.stack([arr, arr, arr], axis=-1)
    raw = tmp_path / "raw.png"
    Image.fromarray(rgb, mode="RGB").save(raw)

    out_path = descend(raw, palette=TEST_PALETTE, target_size=4)
    result = Image.open(out_path)
    flat_palette = result.getpalette()
    px = np.array(result)
    palette_set = set(TEST_PALETTE)
    for idx in np.unique(px):
        rgb_val = tuple(flat_palette[3 * idx : 3 * idx + 3])
        assert rgb_val in palette_set


def test_output_is_indexed_p_mode_with_matching_palette(tmp_path):
    raw = _save_solid_image(tmp_path / "raw.png", (10, 10, 10), (8, 8))
    out_path = descend(raw, palette=TEST_PALETTE, target_size=8)
    result = Image.open(out_path)
    assert result.mode == "P"
    flat_palette = result.getpalette()
    for i, rgb in enumerate(TEST_PALETTE):
        assert tuple(flat_palette[3 * i : 3 * i + 3]) == rgb


def test_index_equals_palette_slot_p4(tmp_path):
    # Build a raw image where each quadrant should map to a distinct,
    # known palette slot, then confirm output index == that slot number.
    # Each quadrant is 2x2 in the downscaled output (not a single isolated
    # pixel) so orphan cleanup doesn't interfere with this assertion.
    arr = np.zeros((16, 16, 3), dtype=np.uint8)
    arr[:8, :8] = TEST_PALETTE[0]
    arr[:8, 8:] = TEST_PALETTE[1]
    arr[8:, :8] = TEST_PALETTE[2]
    arr[8:, 8:] = TEST_PALETTE[3]
    raw = tmp_path / "raw.png"
    Image.fromarray(arr, mode="RGB").save(raw)

    out_path = descend(raw, palette=TEST_PALETTE, target_size=4)
    result = Image.open(out_path)
    px = np.array(result)
    assert (px[:2, :2] == 0).all()
    assert (px[:2, 2:] == 1).all()
    assert (px[2:, :2] == 2).all()
    assert (px[2:, 2:] == 3).all()


def test_orphan_single_pixel_is_cleaned_up(tmp_path):
    # Build an already-quantized-looking raw image (post-downscale size) with
    # one isolated pixel surrounded on all 4 sides by a different index, by
    # constructing the raw source at exactly target_size so no averaging
    # blurs the deliberate single-pixel noise.
    arr = np.zeros((4, 4, 3), dtype=np.uint8)
    arr[:, :] = TEST_PALETTE[0]
    arr[2, 2] = TEST_PALETTE[3]  # isolated orphan pixel, index 3 amid index 0
    raw = tmp_path / "raw.png"
    Image.fromarray(arr, mode="RGB").save(raw)

    out_path = descend(raw, palette=TEST_PALETTE, target_size=4)
    result = Image.open(out_path)
    px = np.array(result)
    assert px[2, 2] == 0  # cleaned up to match its all-index-0 neighbours
    assert set(np.unique(px).tolist()) == {0}


def test_writes_to_default_path_next_to_raw(tmp_path):
    raw = _save_solid_image(tmp_path / "raw.png", (10, 10, 10), (4, 4))
    out_path = descend(raw, palette=TEST_PALETTE, target_size=4)
    assert out_path == tmp_path / "raw_4px.png"
    assert out_path.exists()


def test_writes_to_explicit_out_path(tmp_path):
    raw = _save_solid_image(tmp_path / "raw.png", (10, 10, 10), (4, 4))
    explicit = tmp_path / "nested" / "final.png"
    explicit.parent.mkdir()
    out_path = descend(raw, palette=TEST_PALETTE, target_size=4, out_path=explicit)
    assert out_path == explicit
    assert explicit.exists()
