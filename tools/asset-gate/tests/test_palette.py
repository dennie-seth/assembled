
import numpy as np

from asset_gate.palette import (
    check_index_semantics,
    check_palette_membership,
    load_palette,
)
from conftest import TEST_PALETTE_HEX, make_indexed_image


def test_load_palette_reads_slots_from_json(palette_path):
    pal = load_palette(palette_path)
    assert pal.size == 4
    assert pal.hex_by_index[1] == "#ff0000"


def test_load_placeholder_palette_v5_is_well_formed():
    import pathlib

    path = pathlib.Path(__file__).parent.parent / "config" / "palette.placeholder.json"
    pal = load_palette(path)
    assert pal.size > 0
    for hex_str in pal.hex_by_index.values():
        assert hex_str.startswith("#")
        assert len(hex_str) == 7


def test_membership_passes_when_all_used_colours_are_in_palette(test_palette):
    arr = np.array([[0, 1], [2, 3]], dtype=np.uint8)
    image = make_indexed_image(arr, TEST_PALETTE_HEX)
    result = check_palette_membership(image, test_palette)
    assert result.passed


def test_membership_fails_on_off_palette_colour(test_palette):
    arr = np.array([[0, 1], [2, 3]], dtype=np.uint8)
    embedded_palette = dict(TEST_PALETTE_HEX)
    embedded_palette[3] = "#123456"  # off-palette colour at index 3
    image = make_indexed_image(arr, embedded_palette)
    result = check_palette_membership(image, test_palette)
    assert not result.passed
    assert 3 in result.details["offenders"]


def test_index_semantics_passes_when_indices_match_canonical_slots(test_palette):
    arr = np.array([[0, 1], [2, 3]], dtype=np.uint8)
    image = make_indexed_image(arr, TEST_PALETTE_HEX)
    result = check_index_semantics(image, test_palette)
    assert result.passed


def test_index_semantics_fails_when_index_out_of_canonical_range(test_palette):
    arr = np.array([[0, 1], [2, 5]], dtype=np.uint8)  # index 5 has no canonical slot
    embedded_palette = dict(TEST_PALETTE_HEX)
    embedded_palette[5] = "#ffffff"
    image = make_indexed_image(arr, embedded_palette)
    result = check_index_semantics(image, test_palette)
    assert not result.passed
    assert 5 in result.details["out_of_range"]


def test_index_semantics_fails_when_slots_are_swapped_even_though_colours_are_members(test_palette):
    # P-4: index N must mean slot N. Swapping index 0 <-> 1's colours keeps
    # every used colour a palette member (membership would pass) but breaks
    # the slot mapping (index_semantics must fail).
    arr = np.array([[0, 1], [1, 0]], dtype=np.uint8)
    swapped_palette = dict(TEST_PALETTE_HEX)
    swapped_palette[0], swapped_palette[1] = swapped_palette[1], swapped_palette[0]
    image = make_indexed_image(arr, swapped_palette)

    membership = check_palette_membership(image, test_palette)
    assert membership.passed  # colours are still members of the home palette

    semantics = check_index_semantics(image, test_palette)
    assert not semantics.passed
    assert 0 in semantics.details["mismatched"]
    assert 1 in semantics.details["mismatched"]
