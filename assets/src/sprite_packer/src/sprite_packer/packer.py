"""Sprite-sheet packer -> Godot .tres atlas (CI build step).

Packs all indexed PNG sprites in a source directory into a single atlas PNG and
emits a matching Godot .tres resource file describing where each sprite lives.

Design constraints (docs/design/13-asset-pipeline.md §3.6, T-0074):
- Atlases are CI build artifacts — never committed, never authored by hand.
- The same input set must produce byte-identical output every time (determinism):
  sprites are sorted by filename before packing; PNG is saved with a fixed
  compress_level; .tres entries are written in sorted key order.
- The packed atlas must stay PIL mode 'P' (indexed). Pillow silently converts to
  RGB on paste/composite operations; we avoid that by compositing through numpy
  uint8 arrays and reconstructing the image with Image.fromarray(arr, mode='P').
- TILE_SIZE is a single configurable constant — D-16 resolved tile size to 16px.

docs/design/13-asset-pipeline.md §2 (Atlas determinism, Indexed preservation)
docs/design/13-asset-pipeline.md §3.6 (atlases as CI build artifacts)
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import rectpack
from PIL import Image

# ── Constants ─────────────────────────────────────────────────────────────────

# D-16: tile grid is 16px. Single authoritative constant — never hardcode 16 elsewhere.
TILE_SIZE: int = 16

# PNG compress_level is fixed so byte-identical output is guaranteed across runs.
_PNG_COMPRESS_LEVEL: int = 9

# Godot resource header emitted at the top of every .tres file.
_TRES_FORMAT_VERSION: int = 3


# ── Result types ──────────────────────────────────────────────────────────────


@dataclass
class CheckResult:
    """Return type for gate-style checks (composable, no stdout side effects).

    Follows the pattern from .claude/rules/python.md — pure functions returning
    a shared result type keep checks testable without capturing stdout.
    """

    passed: bool
    reason: str


@dataclass
class PackResult:
    """Paths produced by pack_sprites() and the sprite-region mapping."""

    atlas_path: Path
    tres_path: Path
    # name (without .png) -> (x, y, w, h) in atlas pixel coordinates
    regions: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)


# ── Gate check ────────────────────────────────────────────────────────────────


def check_atlas_mode(img: Image.Image) -> CheckResult:
    """Assert atlas is PIL mode 'P' (indexed). Returns FAIL if RGB or any other mode.

    Pillow silently converts to RGB on several operations (paste, composite,
    quantize). A silent conversion would corrupt the index-semantics contract
    (D-17/T-0073) without raising an error.

    docs/design/13-asset-pipeline.md §2 (Indexed preservation)
    """
    if img.mode == "P":
        return CheckResult(passed=True, reason="mode is 'P' (indexed)")
    return CheckResult(
        passed=False,
        reason=f"expected mode 'P' (indexed) but got {img.mode!r} — "
        "a silent Pillow RGB conversion likely occurred inside pack_sprites()",
    )


# ── Internal helpers ──────────────────────────────────────────────────────────


def _collect_sprites(sprite_dir: Path) -> list[tuple[str, Image.Image]]:
    """Return (name_without_ext, PIL_image) pairs, sorted by name for determinism.

    Only `.png` files are collected. Sorting by name guarantees that filesystem
    iteration order (which varies by OS/filesystem) never affects the output.
    """
    pairs: list[tuple[str, Image.Image]] = []
    for p in sprite_dir.iterdir():
        if p.suffix.lower() != ".png":
            continue
        img = Image.open(p)
        img.load()  # force decode before closing file handle
        pairs.append((p.stem, img))
    return sorted(pairs, key=lambda t: t[0])


def _atlas_bin_size(n_sprites: int) -> tuple[int, int]:
    """Compute the smallest power-of-2 square atlas that can hold n_sprites 16px tiles.

    Returns (width, height) in pixels.
    """
    if n_sprites == 0:
        return TILE_SIZE, TILE_SIZE
    total_pixels = n_sprites * TILE_SIZE * TILE_SIZE
    side = 2 ** math.ceil(math.log2(math.sqrt(total_pixels)))
    # If the computed side can't fit all sprites in one row, double height.
    # This handles edge cases like n=1 (side=16, 1 row needed -> 16x16 ✓).
    while True:
        cols = side // TILE_SIZE
        rows = math.ceil(n_sprites / cols)
        if rows * TILE_SIZE <= side:
            return side, side
        side *= 2  # pragma: no branch


def _pack_rects(
    sprites: list[tuple[str, Image.Image]],
) -> tuple[int, int, dict[str, tuple[int, int, int, int]]]:
    """Pack sprite rects using rectpack. Returns (atlas_w, atlas_h, regions).

    regions maps sprite name -> (x, y, w, h) pixel coordinates in the atlas.
    Sprites are packed in the order supplied (pre-sorted by caller for determinism).
    rectpack is invoked with rotation=False to preserve tile orientation.
    """
    if not sprites:
        return TILE_SIZE, TILE_SIZE, {}

    atlas_w, atlas_h = _atlas_bin_size(len(sprites))

    # Grow atlas if needed (should not happen for square tiles, but be safe).
    while True:
        packer = rectpack.newPacker(sort_algo=rectpack.SORT_NONE, rotation=False)
        packer.add_bin(atlas_w, atlas_h)
        for name, img in sprites:
            packer.add_rect(img.width, img.height, rid=name)
        packer.pack()

        packed = packer.rect_list()
        if len(packed) == len(sprites):
            break
        # Not all rects fit — grow by doubling the width, then height alternately.
        if atlas_w <= atlas_h:
            atlas_w *= 2
        else:
            atlas_h *= 2

    regions: dict[str, tuple[int, int, int, int]] = {}
    for _bin, x, y, w, h, name in packed:
        regions[name] = (x, y, w, h)

    return atlas_w, atlas_h, regions


def _compose_atlas(
    sprites: list[tuple[str, Image.Image]],
    atlas_w: int,
    atlas_h: int,
    regions: dict[str, tuple[int, int, int, int]],
    palette: list[int],
) -> Image.Image:
    """Compose sprites into a numpy array and return a mode-P PIL image.

    Compositing through a numpy uint8 array avoids any Pillow mode-conversion
    (Pillow's paste() on mode-P images can silently promote to RGB depending on
    the Pillow version and whether the images share identical palette objects).
    """
    arr = np.zeros((atlas_h, atlas_w), dtype=np.uint8)
    for name, img in sprites:
        x, y, w, h = regions[name]
        sprite_arr = np.asarray(img, dtype=np.uint8)
        arr[y : y + h, x : x + w] = sprite_arr

    atlas = Image.fromarray(arr, mode="P")
    atlas.putpalette(palette)
    return atlas


def _write_tres(
    tres_path: Path,
    archetype: str,
    atlas_filename: str,
    regions: dict[str, tuple[int, int, int, int]],
) -> None:
    """Write a Godot .tres resource file describing the packed atlas.

    Format is valid Godot 4 text resource syntax. Sprite entries are written in
    sorted key order to guarantee deterministic .tres content across runs.

    The resource type is generic ("Resource") so Godot can load and inspect the
    file without needing a registered GDScript class. The client code reads
    `sprite/{name}` properties to locate each sprite in the atlas.

    docs/design/13-asset-pipeline.md §3.6
    """
    atlas_res_path = f"res://assets/tiles/{atlas_filename}"
    lines: list[str] = [
        f"[gd_resource type=\"Resource\" format={_TRES_FORMAT_VERSION}]",
        f"; Packed sprite atlas for archetype '{archetype}'.",
        "; Generated by sprite_packer CI step (T-0074). Do NOT commit this file.",
        "; docs/design/13-asset-pipeline.md §3.6",
        "",
        f"[ext_resource type=\"Texture2D\" path=\"{atlas_res_path}\" id=\"1\"]",
        "",
        "[resource]",
        f"tile_size = {TILE_SIZE}",
        f'atlas = ExtResource("1")',
    ]
    for name in sorted(regions):
        x, y, w, h = regions[name]
        lines.append(f"sprite/{name} = Rect2({x}, {y}, {w}, {h})")

    tres_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── Public API ────────────────────────────────────────────────────────────────


def pack_sprites(sprite_dir: Path, out_dir: Path, archetype: str) -> PackResult:
    """Pack all PNG sprites in sprite_dir into a single indexed atlas.

    Args:
        sprite_dir: Directory containing individual sprite PNGs (mode P, 16px tiles).
        out_dir:    Output directory for atlas PNG and .tres (created if absent).
        archetype:  Base name used for output files, e.g. "signal_tower".

    Returns:
        PackResult with paths to the atlas PNG and .tres file, plus the region map.

    Determinism guarantees:
      - Sprites are collected and packed in sorted filename order.
      - PNG is saved with a fixed compress_level so bytes are identical across runs.
      - .tres entries are written in sorted key order.

    docs/design/13-asset-pipeline.md §2 (Atlas determinism, Indexed preservation)
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    sprites = _collect_sprites(sprite_dir)

    if not sprites:
        raise ValueError(f"No PNG sprites found in {sprite_dir}")

    # All sprites must be mode P and share a palette (home palette invariant).
    # Use the palette from the first sprite for the composed atlas.
    first_mode = sprites[0][1].mode
    if first_mode != "P":
        raise ValueError(
            f"Sprite {sprites[0][0]!r} is mode {first_mode!r}; "
            "all sprites must be indexed (mode 'P')."
        )
    palette = sprites[0][1].getpalette()

    atlas_w, atlas_h, regions = _pack_rects(sprites)
    atlas_img = _compose_atlas(sprites, atlas_w, atlas_h, regions, palette)

    # Gate check: fail fast if compositing silently dropped mode P.
    gate = check_atlas_mode(atlas_img)
    if not gate.passed:
        raise RuntimeError(
            f"Atlas mode check FAILED after compositing: {gate.reason}. "
            "This is a build error — the atlas index-semantics contract is violated."
        )

    atlas_filename = f"{archetype}_atlas.png"
    atlas_path = out_dir / atlas_filename
    tres_path = out_dir / f"{archetype}_atlas.tres"

    # Fixed compress_level ensures byte-identical PNG output across runs.
    atlas_img.save(atlas_path, format="PNG", compress_level=_PNG_COMPRESS_LEVEL)
    _write_tres(tres_path, archetype, atlas_filename, regions)

    return PackResult(atlas_path=atlas_path, tres_path=tres_path, regions=regions)


# ── CLI entry point ───────────────────────────────────────────────────────────


def main() -> None:  # pragma: no cover
    parser = argparse.ArgumentParser(
        description="Pack sprite PNGs into a Godot .tres atlas (CI build step, T-0074)."
    )
    parser.add_argument("sprite_dir", type=Path, help="Directory of sprite PNGs.")
    parser.add_argument("out_dir", type=Path, help="Output directory for atlas files.")
    parser.add_argument("archetype", help="Archetype base name (e.g. 'signal_tower').")
    args = parser.parse_args()

    result = pack_sprites(args.sprite_dir, args.out_dir, args.archetype)
    print(f"atlas:  {result.atlas_path}")
    print(f".tres:  {result.tres_path}")
    print(f"sprites: {sorted(result.regions)}")

    # Gate check result already ran inside pack_sprites; report success.
    with Image.open(result.atlas_path) as img:
        gate = check_atlas_mode(img)
    status = "PASS" if gate.passed else "FAIL"
    print(f"mode-P gate: {status} ({gate.reason})")
    if not gate.passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
