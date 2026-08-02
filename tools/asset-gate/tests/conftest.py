"""Shared fixture builders: tiny synthetic PNG/WAV fixtures generated
in-process, never committed as binaries (P-1/P-3 spirit -- everything here
is reproducible from code)."""

from __future__ import annotations

import json

import numpy as np
import pytest
import soundfile as sf
from PIL import Image

from asset_gate.palette import Palette

TEST_PALETTE_HEX = {
    0: "#000000",  # background
    1: "#ff0000",
    2: "#00ff00",
    3: "#0000ff",
}

OFF_PALETTE_HEX = "#123456"


@pytest.fixture
def test_palette() -> Palette:
    return Palette(hex_by_index=dict(TEST_PALETTE_HEX))


@pytest.fixture
def palette_path(tmp_path, test_palette) -> str:
    path = tmp_path / "palette.json"
    slots = [{"index": i, "hex": h} for i, h in test_palette.hex_by_index.items()]
    path.write_text(json.dumps({"slots": slots}))
    return str(path)


def make_indexed_image(
    index_array: np.ndarray, palette_hex_by_index: dict[int, str]
) -> Image.Image:
    """Build a mode-'P' PIL image whose embedded palette matches
    `palette_hex_by_index` exactly (position i -> that index's RGB)."""
    img = Image.fromarray(index_array.astype(np.uint8), mode="P")
    max_index = max(palette_hex_by_index.keys())
    flat: list[int] = [0] * ((max_index + 1) * 3)
    for i, hex_str in palette_hex_by_index.items():
        h = hex_str.lstrip("#")
        flat[3 * i : 3 * i + 3] = [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]
    img.putpalette(flat)
    return img


@pytest.fixture
def seamless_tile() -> Image.Image:
    """An 8x8 indexed tile whose left/right columns and top/bottom rows match."""
    arr = np.zeros((8, 8), dtype=np.uint8)
    arr[:, 0] = 1
    arr[:, -1] = 1
    arr[0, :] = 2
    arr[-1, :] = 2
    arr[1:-1, 1:-1] = 0
    return make_indexed_image(arr, TEST_PALETTE_HEX)


@pytest.fixture
def unseamless_tile() -> Image.Image:
    """Same as `seamless_tile` but with one pixel broken on the right edge."""
    arr = np.zeros((8, 8), dtype=np.uint8)
    arr[:, 0] = 1
    arr[:, -1] = 1
    arr[0, :] = 2
    arr[-1, :] = 2
    arr[1:-1, 1:-1] = 0
    arr[3, -1] = 3  # break left/right equality at row 3
    return make_indexed_image(arr, TEST_PALETTE_HEX)


def make_wav(path, samples: np.ndarray, sample_rate: int = 44100, subtype: str = "PCM_16") -> str:
    sf.write(str(path), samples, sample_rate, subtype=subtype)
    return str(path)


@pytest.fixture
def clean_loop_wav(tmp_path):
    """A sine loop whose first and last samples match (clean seam)."""
    sample_rate = 44100
    duration_s = 1.0
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    # An integer number of cycles over the buffer makes start == end exactly.
    cycles = 4
    samples = 0.3 * np.sin(2 * np.pi * cycles * t / duration_s)
    return make_wav(tmp_path / "clean_loop.wav", samples, sample_rate)


@pytest.fixture
def clicking_loop_wav(tmp_path):
    """Same sine but with a discontinuity injected at the loop seam."""
    sample_rate = 44100
    duration_s = 1.0
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    cycles = 4
    samples = 0.3 * np.sin(2 * np.pi * cycles * t / duration_s)
    samples[-1] = 0.9  # click: last sample far from the first
    return make_wav(tmp_path / "clicking_loop.wav", samples, sample_rate)
