"""Sprite sheets are written with a transparent background -- always (P-6).

The §24-e sheet shipped opaque because each writer in this package had its own
private `_save()` that called `Image.save()` directly. These tests pin the
shared writer, and the generator tests below pin that the three synth
generators actually go through it rather than around it.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from char_gen import synth_entities, synth_sheet, synth_states
from char_gen.sprite_io import (
    BACKGROUND_INDEX,
    save_sprite_sheet,
    to_indexed_image,
    transparency_index,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"


def _palette() -> list[tuple[int, int, int]]:
    data = json.loads(PALETTE_PATH.read_text())
    slots = sorted(data["slots"], key=lambda s: int(s["index"]))
    out = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        out.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return out


def _indices(h: int = 8, w: int = 8) -> np.ndarray:
    arr = np.zeros((h, w), dtype=np.uint8)
    arr[2:6, 2:6] = 6
    return arr


# ---- save_sprite_sheet ---------------------------------------------------


def test_background_index_is_slot_zero():
    assert BACKGROUND_INDEX == 0


def test_saved_sheet_declares_the_background_index_transparent(tmp_path):
    out = save_sprite_sheet(_indices(), tmp_path / "sheet.png", palette=_palette())
    assert transparency_index(Image.open(out)) == 0


def test_saved_sheet_keeps_mode_p_and_the_full_palette(tmp_path):
    palette = _palette()
    out = save_sprite_sheet(_indices(), tmp_path / "sheet.png", palette=palette)
    reloaded = Image.open(out)
    assert reloaded.mode == "P"
    flat = reloaded.getpalette()
    for i, rgb in enumerate(palette):
        assert tuple(flat[3 * i : 3 * i + 3]) == rgb


def test_saved_sheet_preserves_every_index(tmp_path):
    arr = _indices()
    out = save_sprite_sheet(arr, tmp_path / "sheet.png", palette=_palette())
    assert np.array_equal(np.array(Image.open(out)), arr)


def test_accepts_an_already_built_indexed_image(tmp_path):
    image = to_indexed_image(_indices(), _palette())
    out = save_sprite_sheet(image, tmp_path / "sheet.png")
    assert transparency_index(Image.open(out)) == 0


def test_rejects_a_non_indexed_image(tmp_path):
    with pytest.raises(ValueError, match="mode 'P'"):
        save_sprite_sheet(Image.new("RGB", (4, 4)), tmp_path / "sheet.png")


def test_requires_a_palette_when_saving_from_an_array(tmp_path):
    with pytest.raises(ValueError, match="palette is required"):
        save_sprite_sheet(_indices(), tmp_path / "sheet.png")


def test_can_opt_out_for_output_that_is_opaque_by_design(tmp_path):
    out = save_sprite_sheet(
        _indices(), tmp_path / "tile.png", palette=_palette(), background_index=None
    )
    assert transparency_index(Image.open(out)) is None


def test_creates_missing_parent_directories(tmp_path):
    out = save_sprite_sheet(_indices(), tmp_path / "a" / "b" / "s.png", palette=_palette())
    assert out.is_file()


def test_transparency_index_reads_a_bytes_alpha_table():
    image = to_indexed_image(_indices(), _palette())
    image.info["transparency"] = bytes([0]) + bytes([255] * 15)
    assert transparency_index(image) == 0


# ---- the generators actually use it --------------------------------------


def test_synth_sheet_generator_writes_a_transparent_sheet(tmp_path):
    out = synth_sheet.generate(_palette(), tmp_path / "idle.png")
    image = Image.open(out)
    assert image.mode == "P"
    assert transparency_index(image) == 0


def test_synth_states_generator_writes_a_transparent_sheet(tmp_path):
    out = synth_states.generate_move_sheet(_palette(), tmp_path / "move.png")
    assert transparency_index(Image.open(out)) == 0


def test_synth_entities_generator_writes_a_transparent_sheet(tmp_path):
    out = synth_entities.generate_watcher_idle_sheet(_palette(), tmp_path / "watcher.png")
    assert transparency_index(Image.open(out)) == 0


def test_generated_sheets_still_have_opaque_content(tmp_path):
    """A transparent background is not the same as an erased sprite."""
    out = synth_sheet.generate(_palette(), tmp_path / "idle.png")
    arr = np.array(Image.open(out))
    assert (arr != BACKGROUND_INDEX).any()
