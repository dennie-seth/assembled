"""Looping, upscaled GIF export -- T-0259 unit tests.

New shared helper (`char_gen.gif_export`), not walk-specific: T-0259's own
acceptance criteria call for "a committed deliverable... written so it
generalizes to hide (T-0260) and action (T-0261) -- take frame count /
layout / scale as parameters rather than hardcoding the walk's 4x2". This
suite exercises the helper directly against a small synthetic indexed sheet
(no ComfyUI/network dependency), independent of the walk sheet's own 4x2
layout, so a reviewer can see the parameterisation is real rather than
walk shape baked in.

RED state: char_gen.gif_export does not exist -> import fails, every test
ERRORs.
GREEN state: `make_looping_gif` crops a sheet into the given playback
order, upscales each cell with nearest-neighbour (crisp pixels), and writes
an infinitely-looping animated GIF carrying the sheet's own transparency
index.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
_SRC_DIR = _CHARACTER_DIR / "src"
for p in (_CHARACTER_DIR, _SRC_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from char_gen import gif_export  # noqa: E402
from char_gen.sprite_io import to_indexed_image  # noqa: E402

CELL_PX = 4
COLS = 3
ROWS = 1
BACKGROUND_INDEX = 0
PALETTE = [(0, 0, 0), (255, 0, 0), (0, 255, 0), (0, 0, 255)]


def _make_sheet() -> Image.Image:
    """A 3x1 grid of 4x4 cells, each cell a distinct flat colour index (so
    a test can tell frames apart) over a background of index 0."""
    arr = np.zeros((ROWS * CELL_PX, COLS * CELL_PX), dtype=np.uint8)
    for col, fill_index in enumerate((1, 2, 3)):
        arr[:, col * CELL_PX : (col + 1) * CELL_PX] = fill_index
        # leave one corner pixel as background so the cell isn't 100% filled
        arr[0, col * CELL_PX] = BACKGROUND_INDEX
    img = to_indexed_image(arr, PALETTE)
    img.info["transparency"] = BACKGROUND_INDEX
    return img


def test_writes_a_gif_with_one_frame_per_cell(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"
    frame_cells = [(0, 0), (0, 1), (0, 2)]

    result = gif_export.make_looping_gif(
        sheet, frame_cells=frame_cells, cell_px=CELL_PX, out_path=out_path
    )

    assert result == out_path
    assert out_path.is_file()
    with Image.open(out_path) as gif:
        assert gif.format == "GIF"
        assert gif.n_frames == len(frame_cells)


def test_frames_are_integer_upscaled_with_crisp_pixels(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"
    scale = 5

    gif_export.make_looping_gif(
        sheet, frame_cells=[(0, 0), (0, 1), (0, 2)], cell_px=CELL_PX, out_path=out_path, scale=scale
    )

    with Image.open(out_path) as gif:
        assert gif.size == (CELL_PX * scale, CELL_PX * scale)
        gif.seek(1)  # second frame -> fill index 2, green
        arr = np.array(gif.convert("RGB"))
        # Away from the deliberately-zeroed corner pixel: nearest-neighbour
        # upscale of a flat-colour cell must stay flat, no interpolation
        # blur introduced between palette colours.
        centre = arr[scale * 2, scale * 2]
        assert tuple(centre) == PALETTE[2]


def test_loops_infinitely(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"

    gif_export.make_looping_gif(
        sheet, frame_cells=[(0, 0), (0, 1), (0, 2)], cell_px=CELL_PX, out_path=out_path
    )

    with Image.open(out_path) as gif:
        assert gif.info.get("loop") == 0, "GIF must loop infinitely (loop=0), not play once"


def test_frame_duration_is_applied(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"
    duration_ms = 250

    gif_export.make_looping_gif(
        sheet,
        frame_cells=[(0, 0), (0, 1), (0, 2)],
        cell_px=CELL_PX,
        out_path=out_path,
        frame_duration_ms=duration_ms,
    )

    with Image.open(out_path) as gif:
        assert gif.info.get("duration") == duration_ms


def test_carries_the_sheets_own_transparency_index(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"

    gif_export.make_looping_gif(
        sheet, frame_cells=[(0, 0), (0, 1), (0, 2)], cell_px=CELL_PX, out_path=out_path
    )

    with Image.open(out_path) as gif:
        assert gif.info.get("transparency") == BACKGROUND_INDEX


def test_parameterised_layout_not_hardcoded_to_walks_4x2(tmp_path: Path) -> None:
    """Acceptance: 'written so it generalizes to hide (T-0260) and action
    (T-0261) -- take frame count / layout / scale as parameters rather than
    hardcoding the walk's 4x2.' Exercise a completely different shape (a
    single row of 3, not 4x2) end to end to prove it isn't."""
    sheet = _make_sheet()
    out_path = tmp_path / "preview.gif"

    gif_export.make_looping_gif(
        sheet, frame_cells=[(0, 2), (0, 1), (0, 0)], cell_px=CELL_PX, out_path=out_path
    )

    with Image.open(out_path) as gif:
        assert gif.n_frames == 3
        gif.seek(0)
        first = np.array(gif.convert("RGB"))
        # Away from the deliberately-zeroed corner pixel (default scale=6,
        # so index [10, 10] maps back to original cell pixel [1, 1]).
        assert tuple(first[10, 10]) == PALETTE[3], (
            "playback order must follow frame_cells, not row-major"
        )


def test_rejects_empty_frame_cells(tmp_path: Path) -> None:
    sheet = _make_sheet()
    with pytest.raises(ValueError):
        gif_export.make_looping_gif(
            sheet, frame_cells=[], cell_px=CELL_PX, out_path=tmp_path / "x.gif"
        )


def test_rejects_non_positive_scale(tmp_path: Path) -> None:
    sheet = _make_sheet()
    with pytest.raises(ValueError):
        gif_export.make_looping_gif(
            sheet,
            frame_cells=[(0, 0)],
            cell_px=CELL_PX,
            out_path=tmp_path / "x.gif",
            scale=0,
        )


def test_creates_missing_parent_directories(tmp_path: Path) -> None:
    sheet = _make_sheet()
    out_path = tmp_path / "nested" / "dir" / "preview.gif"

    gif_export.make_looping_gif(
        sheet, frame_cells=[(0, 0), (0, 1)], cell_px=CELL_PX, out_path=out_path
    )

    assert out_path.is_file()
