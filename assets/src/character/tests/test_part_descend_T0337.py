"""RED: box-descend one cut master-sheet PART (not a whole frame/sheet) to
game scale (T-0337), preserving the existing descent/palette/transparency
guarantees this pipeline already holds everywhere else -- P-6 (indexed PNG +
tRNS, `char_gen.sprite_io.save_sprite_sheet`'s own contract, which Godot's
PNG decoder expands into real/"true" RGBA on load) and the locked palette
(nearest-Oklab quantization, same rule `cutout.py`'s own colour-space code
already uses, duplicated per that module's own documented "generator ->
shared package" dependency direction, not imported backwards).
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from char_gen.part_descend import box_descend_part, mask_bbox
from char_gen.sprite_io import BACKGROUND_INDEX, save_sprite_sheet, transparency_index

SIZE = 64
BACKGROUND_RGB = (0, 0, 0)
ARM_RGB = (0, 200, 90)

PALETTE = [
    (0, 0, 0),  # index 0: background
    (0, 200, 90),  # index 1: arm colour
    (255, 255, 255),
]


def _arm_image() -> tuple[Image.Image, np.ndarray]:
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = BACKGROUND_RGB
    arr[10:40, 20:30] = ARM_RGB  # a tall, narrow "arm" -- deliberately non-square
    mask = np.zeros((SIZE, SIZE), dtype=bool)
    mask[10:40, 20:30] = True
    return Image.fromarray(arr, mode="RGB"), mask


class TestMaskBbox:
    def test_returns_tight_bbox_around_foreground(self):
        _, mask = _arm_image()
        y0, y1, x0, x1 = mask_bbox(mask)
        assert (y0, y1, x0, x1) == (10, 40, 20, 30)

    def test_margin_expands_symmetrically_and_clamps_to_frame(self):
        _, mask = _arm_image()
        y0, y1, x0, x1 = mask_bbox(mask, margin_px=5)
        assert (y0, y1, x0, x1) == (5, 45, 15, 35)

    def test_raises_on_empty_mask(self):
        empty = np.zeros((SIZE, SIZE), dtype=bool)
        with pytest.raises(ValueError):
            mask_bbox(empty)


class TestBoxDescendPart:
    def test_output_size_matches_target_and_is_indexed(self):
        img, mask = _arm_image()
        out = box_descend_part(img, mask, PALETTE, target_size=(16, 32))
        assert out.size == (16, 32)
        assert out.mode == "P"

    def test_foreground_quantizes_to_the_arm_palette_slot(self):
        img, mask = _arm_image()
        out = box_descend_part(img, mask, PALETTE, target_size=(16, 32))
        arr = np.array(out)
        # The whole crop is the arm rectangle at full bleed (mask_bbox is tight
        # around it with no margin), so every descended pixel should quantize
        # to the arm's own palette slot, index 1 -- never background.
        assert set(np.unique(arr)) == {1}

    def test_background_outside_mask_becomes_background_index(self):
        img, mask = _arm_image()
        # Widen the crop with a margin so real background survives into the
        # descended output, then confirm it lands on BACKGROUND_INDEX.
        out = box_descend_part(img, mask, PALETTE, target_size=(16, 32), margin_px=8)
        arr = np.array(out)
        assert arr[0, 0] == BACKGROUND_INDEX

    def test_raises_on_empty_mask(self):
        img, _ = _arm_image()
        empty = np.zeros((SIZE, SIZE), dtype=bool)
        with pytest.raises(ValueError):
            box_descend_part(img, empty, PALETTE, target_size=(16, 32))

    def test_roundtrips_through_save_sprite_sheet_as_true_rgba(self, tmp_path):
        img, mask = _arm_image()
        out = box_descend_part(img, mask, PALETTE, target_size=(16, 32))
        path = save_sprite_sheet(out, tmp_path / "part.png", palette=PALETTE)
        reloaded = Image.open(path)
        assert reloaded.mode == "P"
        assert transparency_index(reloaded) == BACKGROUND_INDEX
