"""Home-palette loading and the two palette checks from `13-asset-pipeline.md` §2.

TODO(V-5): the real palette (colour count + hex values) is not decided yet.
`config/palette.placeholder.json` ships a documented placeholder so these
checks are exercisable now; swap it once V-5 resolves. See PLACEHOLDER note
in that file.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from asset_gate.result import CheckResult


@dataclass(frozen=True)
class Palette:
    hex_by_index: dict[int, str]

    @property
    def size(self) -> int:
        return len(self.hex_by_index)

    @property
    def rgb_by_index(self) -> dict[int, tuple[int, int, int]]:
        return {i: _hex_to_rgb(h) for i, h in self.hex_by_index.items()}

    @property
    def rgb_set(self) -> set[tuple[int, int, int]]:
        return set(self.rgb_by_index.values())


def _hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_palette(path: str | Path) -> Palette:
    data = json.loads(Path(path).read_text())
    hex_by_index = {int(slot["index"]): slot["hex"] for slot in data["slots"]}
    return Palette(hex_by_index=hex_by_index)


def _image_palette_rgb(image: Image.Image) -> dict[int, tuple[int, int, int]]:
    """The RGB each index resolves to via the image's own embedded palette."""
    if image.mode != "P":
        raise ValueError(f"expected an indexed (mode 'P') image, got mode {image.mode!r}")
    flat = image.getpalette() or []
    out: dict[int, tuple[int, int, int]] = {}
    for i in range(len(flat) // 3):
        out[i] = (flat[3 * i], flat[3 * i + 1], flat[3 * i + 2])
    return out


def _used_indices(image: Image.Image) -> set[int]:
    if image.mode != "P":
        raise ValueError(f"expected an indexed (mode 'P') image, got mode {image.mode!r}")
    histogram = image.histogram()
    return {i for i, count in enumerate(histogram) if count > 0}


def check_palette_membership(image: Image.Image, palette: Palette) -> CheckResult:
    """Every colour actually used by the image must be an exact member of the
    home palette. No near-misses -- this is set membership, not distance."""
    img_rgb = _image_palette_rgb(image)
    used = _used_indices(image)
    home_rgb = palette.rgb_set

    offenders = {i: img_rgb[i] for i in used if img_rgb.get(i) not in home_rgb}
    if offenders:
        return CheckResult(
            check="palette_membership",
            passed=False,
            reason=f"{len(offenders)} used index(es) resolve to colours outside the home palette",
            details={"offenders": offenders},
        )
    return CheckResult(
        check="palette_membership",
        passed=True,
        reason=f"all {len(used)} used colour(s) are members of the home palette",
        details={"used_indices": sorted(used)},
    )


def check_index_semantics(image: Image.Image, palette: Palette) -> CheckResult:
    """P-4: index N must mean palette slot N in every asset.

    Every used index must (a) fall inside the canonical slot set, and
    (b) resolve, via the image's own embedded palette, to the same RGB the
    home palette declares for that index.
    """
    img_rgb = _image_palette_rgb(image)
    used = _used_indices(image)
    canonical = set(palette.hex_by_index.keys())

    out_of_range = sorted(used - canonical)
    if out_of_range:
        return CheckResult(
            check="index_semantics",
            passed=False,
            reason=(
                f"index(es) {out_of_range} fall outside the canonical "
                f"slot set (0..{palette.size - 1})"
            ),
            details={"out_of_range": out_of_range},
        )

    mismatched = {
        i: {"image_rgb": img_rgb[i], "home_rgb": palette.rgb_by_index[i]}
        for i in used
        if img_rgb[i] != palette.rgb_by_index[i]
    }
    if mismatched:
        return CheckResult(
            check="index_semantics",
            passed=False,
            reason=(
                f"{len(mismatched)} index(es) do not resolve to their "
                f"canonical home-palette slot"
            ),
            details={"mismatched": mismatched},
        )

    return CheckResult(
        check="index_semantics",
        passed=True,
        reason=f"all {len(used)} used index(es) match their canonical home-palette slot",
        details={"used_indices": sorted(used)},
    )
