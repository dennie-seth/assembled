from __future__ import annotations

from palette_extract.extract import extract_palette
from palette_extract.lut import build_lut_image, build_palette_json


def test_lut_image_is_indexed_p_mode_n_by_1(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    lut = build_lut_image(slots)
    assert lut.mode == "P"
    assert lut.size == (4, 1)


def test_lut_image_pixel_i_has_index_i_and_correct_rgb(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    lut = build_lut_image(slots)
    flat_palette = lut.getpalette()
    for slot in slots:
        assert lut.getpixel((slot.index, 0)) == slot.index
        rgb = tuple(flat_palette[3 * slot.index : 3 * slot.index + 3])
        assert rgb == slot.rgb


def test_palette_json_schema_matches_asset_gate_loader_shape(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    data = build_palette_json(slots, source="fake_sheet.png (sha256:deadbeef)")
    assert "slots" in data
    hex_by_index = {s["index"]: s["hex"] for s in data["slots"]}
    assert len(hex_by_index) == 4
    for slot in slots:
        assert hex_by_index[slot.index] == slot.hex
        assert hex_by_index[slot.index].startswith("#")
        assert len(hex_by_index[slot.index]) == 7


def test_palette_json_slots_are_contiguous_zero_indexed(four_colour_image):
    slots = extract_palette(four_colour_image, n=4)
    data = build_palette_json(slots, source="x")
    indices = sorted(s["index"] for s in data["slots"])
    assert indices == list(range(4))
