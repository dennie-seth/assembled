"""Sprite background-transparency gate tests.

The §24-e character sheet (`player_idle_sheet_hybrid_T0252.png`) shipped as
a mode-'P' PNG whose background was a single palette index (0) with **no
tRNS chunk** -- the cutout was applied, but the file carried no alpha at
all, so it renders as an opaque black rectangle in Godot, GitHub and every
browser. `visibility.check_rendered_visibility` cannot catch that: it was
built for the opposite failure (PR #231's alpha-0-everywhere props) and an
opaque sheet passes it happily.

`check_background_transparency` is the complement: it rejects any sprite
whose background is opaque. Together the two gates bracket the valid range
-- a sprite must have *some* transparent pixels and *some* opaque ones.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from asset_gate.transparency import (
    OPAQUE_ALLOWED_CLASSES,
    check_background_transparency,
    load_transparency_baseline,
    sweep_sprite_transparency,
)

PALETTE = [(18, 17, 14), (61, 59, 49), (73, 73, 59), (100, 98, 88)]


def _indexed(arr: np.ndarray, transparency: int | None = None) -> Image.Image:
    """Build a mode-'P' image from an index array, optionally with tRNS."""
    img = Image.fromarray(arr.astype(np.uint8), mode="P")
    flat = [0] * (256 * 3)
    for i, rgb in enumerate(PALETTE):
        flat[3 * i : 3 * i + 3] = list(rgb)
    img.putpalette(flat)
    if transparency is not None:
        img.info["transparency"] = transparency
    return img


def _sprite_indices(h: int = 8, w: int = 8) -> np.ndarray:
    """Index-0 background with a solid non-background blob in the middle."""
    arr = np.zeros((h, w), dtype=np.uint8)
    arr[2:6, 2:6] = 2
    arr[3, 3] = 1
    return arr


def _rgba(rgb_value: tuple[int, int, int], alpha: np.ndarray) -> Image.Image:
    h, w = alpha.shape
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[:, :, :3] = rgb_value
    arr[:, :, 3] = alpha
    return Image.fromarray(arr, mode="RGBA")


def _write(root: Path, rel: str, image: Image.Image) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if "transparency" in image.info:
        image.save(path, transparency=image.info["transparency"])
    else:
        image.save(path)
    return path


# ---- check_background_transparency: indexed (mode 'P') -------------------


def test_fails_indexed_sprite_with_no_trns_chunk():
    """The exact T-0252 shape: cutout applied, background is one index, no tRNS."""
    result = check_background_transparency(_indexed(_sprite_indices()))
    assert not result.passed
    assert "trns" in result.reason.lower()
    assert result.details["mode"] == "P"


def test_passes_indexed_sprite_with_trns_on_the_background_index():
    result = check_background_transparency(_indexed(_sprite_indices(), transparency=0))
    assert result.passed
    assert result.details["transparent_index"] == 0


def test_passes_indexed_sprite_whose_trns_arrives_as_an_alpha_table():
    """Pillow hands back `transparency` as a bytes alpha table for some PNGs."""
    image = _indexed(_sprite_indices())
    image.info["transparency"] = bytes([0]) + bytes([255] * 3)
    result = check_background_transparency(image)
    assert result.passed
    assert result.details["transparent_index"] == 0


def test_fails_indexed_sprite_whose_trns_index_is_never_used():
    """A tRNS chunk pointing at an unused slot is decorative, not a cutout."""
    arr = _sprite_indices()
    arr[arr == 0] = 1  # no index-0 pixels remain
    result = check_background_transparency(_indexed(arr, transparency=0))
    assert not result.passed
    assert "never used" in result.reason.lower()


def test_fails_indexed_sprite_that_is_transparent_everywhere():
    """Complement of the visibility gate -- an all-transparent sheet is not a sprite."""
    image = _indexed(np.zeros((8, 8), dtype=np.uint8), transparency=0)
    result = check_background_transparency(image)
    assert not result.passed
    assert "opaque" in result.reason.lower()


# ---- check_background_transparency: true-alpha modes ---------------------


def test_passes_rgba_sprite_with_a_transparent_background():
    alpha = np.full((8, 8), 255, dtype=np.uint8)
    alpha[0, :] = 0
    assert check_background_transparency(_rgba((120, 120, 120), alpha)).passed


def test_fails_rgba_sprite_whose_alpha_is_255_everywhere():
    """The signal_tower prop shape: RGBA container, but a SolidMask alpha=255."""
    alpha = np.full((8, 8), 255, dtype=np.uint8)
    result = check_background_transparency(_rgba((120, 120, 120), alpha))
    assert not result.passed
    assert "opaque" in result.reason.lower()


def test_fails_plain_rgb_sprite():
    result = check_background_transparency(Image.new("RGB", (8, 8), (30, 30, 30)))
    assert not result.passed
    assert result.details["mode"] == "RGB"


# ---- sweep ---------------------------------------------------------------


def test_sweep_fails_an_opaque_sprite_under_a_transparency_required_class(tmp_path):
    _write(tmp_path, "character/opaque_sheet.png", _indexed(_sprite_indices()))
    results = sweep_sprite_transparency(tmp_path)
    assert len(results) == 1
    assert not results[0].passed
    assert results[0].details["path"] == "character/opaque_sheet.png"


def test_sweep_passes_a_transparent_sprite(tmp_path):
    _write(tmp_path, "entity/cut_sheet.png", _indexed(_sprite_indices(), transparency=0))
    results = sweep_sprite_transparency(tmp_path)
    assert all(r.passed for r in results)


def test_sweep_skips_classes_that_are_meant_to_be_opaque(tmp_path):
    """Tiles and the palette LUT are opaque by design -- they are not sprites."""
    for cls in OPAQUE_ALLOWED_CLASSES:
        _write(tmp_path, f"{cls}/thing.png", _indexed(_sprite_indices()))
    results = sweep_sprite_transparency(tmp_path)
    assert results
    assert all(r.passed for r in results)
    assert all("opaque by design" in r.reason for r in results)


def test_sweep_is_fail_closed_for_an_unrecognised_class(tmp_path):
    """A new asset class defaults to transparency-required, not to exempt."""
    _write(tmp_path, "vehicles/tank.png", _indexed(_sprite_indices()))
    results = sweep_sprite_transparency(tmp_path)
    assert not results[0].passed


def test_sweep_exempts_documented_baseline_paths(tmp_path):
    _write(tmp_path, "props/legacy.png", _indexed(_sprite_indices()))
    results = sweep_sprite_transparency(tmp_path, baseline=frozenset({"props/legacy.png"}))
    assert results[0].passed
    assert "documented" in results[0].reason.lower()


def test_sweep_reports_relative_posix_paths_on_every_platform(tmp_path):
    _write(tmp_path, "props/signal_tower/box.png", _indexed(_sprite_indices(), transparency=0))
    results = sweep_sprite_transparency(tmp_path)
    assert results[0].details["path"] == "props/signal_tower/box.png"


# ---- baseline file -------------------------------------------------------


def test_baseline_ignores_comments_and_blank_lines(tmp_path):
    path = tmp_path / "baseline.txt"
    path.write_text("# a comment\n\ncharacter/a.png\n  entity/b.png  \n")
    assert load_transparency_baseline(path) == frozenset({"character/a.png", "entity/b.png"})


def test_default_baseline_ships_with_the_package():
    assert isinstance(load_transparency_baseline(), frozenset)


def test_committed_finals_pass_the_sweep():
    """The repo's own assets/final must satisfy the gate, baseline included."""
    root = Path(__file__).resolve().parents[3] / "assets" / "final"
    if not root.is_dir():  # pragma: no cover - packaged install without the repo tree
        pytest.skip("assets/final is not present next to the package")
    results = sweep_sprite_transparency(root, baseline=load_transparency_baseline())
    failed = [r.reason for r in results if not r.passed]
    assert not failed, "\n".join(failed)
