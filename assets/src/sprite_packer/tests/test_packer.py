"""Tests for sprite_packer.packer (T-0074).

Implements acceptance criteria:
- Test: same input sprite set -> byte-identical packed .tres atlas layout, run twice
- Test: packed atlas is asserted to still be PIL mode P after packing; a silent
  RGB conversion fails the build
- Tile-grid constant is set to 16px per D-16 (single configurable value)

docs/design/13-asset-pipeline.md §2 (Atlas determinism, Indexed preservation)
docs/design/13-asset-pipeline.md §3.6 (atlases are build artifacts, not committed)
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from sprite_packer.packer import TILE_SIZE, CheckResult, PackResult, check_atlas_mode, pack_sprites

# ─── helpers ─────────────────────────────────────────────────────────────────


def _make_indexed_sprite(width: int, height: int, fill: int = 1) -> Image.Image:
    """Generate a synthetic indexed PNG (mode P) in-process. No binary fixtures committed."""
    img = Image.new("P", (width, height))
    # Flat dummy palette: entry N -> (N, N, N). All sprites share this palette so
    # paste compositing stays in index-space.
    palette = [v % 256 for triplet in range(256) for v in (triplet, triplet, triplet)]
    img.putpalette(palette)
    # Fill every pixel with the chosen index value
    for y in range(height):
        for x in range(width):
            img.putpixel((x, y), fill)
    return img


@pytest.fixture()
def sprite_dir(tmp_path: Path) -> Path:
    """Directory containing three synthetic 16x16 indexed sprites.

    Named alpha, beta, gamma so sorted order is predictable.
    """
    d = tmp_path / "sprites"
    d.mkdir()
    for name, fill in [("alpha.png", 1), ("beta.png", 2), ("gamma.png", 3)]:
        sprite = _make_indexed_sprite(TILE_SIZE, TILE_SIZE, fill=fill)
        sprite.save(d / name)
    return d


# ─── tests ───────────────────────────────────────────────────────────────────


def test_tile_size_constant():
    """TILE_SIZE is exactly 16 — D-16 (tile grid is 16px), single configurable value."""
    assert TILE_SIZE == 16


def test_pack_sprites_returns_packresult(sprite_dir: Path, tmp_path: Path):
    """pack_sprites returns a PackResult with both paths pointing to existing files."""
    result = pack_sprites(sprite_dir, tmp_path / "out", archetype="test")
    assert isinstance(result, PackResult)
    assert result.atlas_path.exists(), f"atlas PNG not found: {result.atlas_path}"
    assert result.tres_path.exists(), f".tres not found: {result.tres_path}"


def test_atlas_mode_p_after_packing(sprite_dir: Path, tmp_path: Path):
    """Packed atlas PNG must stay PIL mode 'P' (indexed) after all packing operations.

    Pillow silently converts to RGB on several operations (paste, composite, quantize).
    A silent conversion corrupts the index-semantics contract (D-17/T-0073) without
    raising an error — this test exists to catch exactly that failure mode.
    docs/design/13-asset-pipeline.md §2 (Indexed preservation).
    """
    result = pack_sprites(sprite_dir, tmp_path / "out", archetype="test")
    with Image.open(result.atlas_path) as atlas:
        assert atlas.mode == "P", (
            f"Atlas must stay indexed (mode='P') but got mode={atlas.mode!r}. "
            "Likely cause: implicit Pillow RGB conversion inside pack_sprites(). "
            "Use numpy array compositing to avoid it."
        )


def test_determinism_byte_identical(sprite_dir: Path, tmp_path: Path):
    """Same input sprites -> byte-identical atlas PNG and .tres, run twice.

    docs/design/13-asset-pipeline.md §2 (Atlas determinism): same inputs must
    produce byte-identical layout, or dev and CI disagree on sprite coordinates.
    """
    result1 = pack_sprites(sprite_dir, tmp_path / "run1", archetype="test")
    result2 = pack_sprites(sprite_dir, tmp_path / "run2", archetype="test")

    assert result1.atlas_path.read_bytes() == result2.atlas_path.read_bytes(), (
        "Atlas PNG is not byte-identical across two runs with the same inputs. "
        "Sort order or packing is non-deterministic — check sprite input sort "
        "and PNG save parameters (compress_level must be fixed)."
    )
    assert result1.tres_path.read_text() == result2.tres_path.read_text(), (
        ".tres layout is not byte-identical across two runs with the same inputs."
    )


def test_tres_format_valid_godot(sprite_dir: Path, tmp_path: Path):
    """Generated .tres starts with [gd_resource and contains tile_size and Rect2 regions."""
    result = pack_sprites(sprite_dir, tmp_path / "out", archetype="test")
    content = result.tres_path.read_text()
    assert content.startswith("[gd_resource"), (
        f".tres must start with [gd_resource (Godot resource header) "
        f"but got: {content[:80]!r}"
    )
    assert "tile_size = 16" in content, (
        ".tres must declare tile_size = 16 so Godot knows the grid constant."
    )
    assert "Rect2(" in content, (
        ".tres must contain Rect2(...) sprite region entries."
    )


def test_tres_references_atlas_png(sprite_dir: Path, tmp_path: Path):
    """Generated .tres references the atlas PNG via a res:// path."""
    result = pack_sprites(sprite_dir, tmp_path / "out", archetype="test")
    content = result.tres_path.read_text()
    atlas_name = result.atlas_path.name
    assert atlas_name in content, (
        f".tres must reference the atlas PNG filename {atlas_name!r} "
        f"so Godot can locate the texture."
    )


def test_sprites_listed_in_sorted_order(sprite_dir: Path, tmp_path: Path):
    """Sprites are listed in sorted (filename) order in the .tres.

    Sorted order guarantees the .tres content is deterministic regardless of
    filesystem iteration order (which varies by OS and filesystem).
    """
    result = pack_sprites(sprite_dir, tmp_path / "out", archetype="test")
    content = result.tres_path.read_text()
    lines = [line for line in content.splitlines() if line.startswith("sprite/")]
    names = [line.split("sprite/")[1].split(" =")[0] for line in lines]
    assert names == ["alpha", "beta", "gamma"], (
        f"Expected sprites in sorted order ['alpha', 'beta', 'gamma'], got {names!r}."
    )


def test_check_atlas_mode_passes_on_mode_p():
    """check_atlas_mode returns passed=True for a mode-P image."""
    img = _make_indexed_sprite(16, 16, fill=1)
    result = check_atlas_mode(img)
    assert isinstance(result, CheckResult)
    assert result.passed, f"Expected passed=True for mode-P, got reason={result.reason!r}"


def test_check_atlas_mode_fails_on_mode_rgb():
    """check_atlas_mode returns passed=False for a mode-RGB image.

    Guards against check_atlas_mode() accidentally passing on non-indexed images,
    which would defeat the silent-RGB-conversion detection.
    """
    rgb_img = Image.new("RGB", (64, 64))
    result = check_atlas_mode(rgb_img)
    assert isinstance(result, CheckResult)
    assert not result.passed, (
        "check_atlas_mode must return passed=False for a mode-RGB image "
        "so silent Pillow conversions are caught at build time."
    )
