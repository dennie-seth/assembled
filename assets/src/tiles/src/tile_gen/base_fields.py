"""Base-field tile generator for T-0232's Signal Tower tileset -- the
circular-pad path (`docs/design/13-asset-pipeline.md` §3.4).

Produces three deterministic, self-seamless 16x16 indexed (mode-P) PNGs:
wall, floor, concrete. See `tile_gen.fields` for the deterministic-
construction rationale and `tile_gen.signal_tower_sheet` for the
transition sheet that dresses the boundaries between them.

HANDOFF §23-i (T-0232).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from tile_gen.fields import make_concrete, make_floor, make_wall
from tile_gen.transition_sheet import _load_palette

REPO_ROOT = Path(__file__).resolve().parents[5]
OUT_DIR = REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower"

_TILE_MAKERS = {
    "wall": make_wall,
    "floor": make_floor,
    "concrete": make_concrete,
}


def generate_tile(name: str) -> Image.Image:
    """Build and return one named base-field tile as an indexed PIL Image."""
    arr = _TILE_MAKERS[name]()
    img = Image.fromarray(arr, mode="P")
    img.putpalette(_load_palette())
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in _TILE_MAKERS:
        img = generate_tile(name)
        path = OUT_DIR / f"{name}_16px.png"
        img.save(path, format="PNG")
        print(f"Saved {path} ({img.size[0]}x{img.size[1]} px, mode {img.mode})")


if __name__ == "__main__":
    main()
