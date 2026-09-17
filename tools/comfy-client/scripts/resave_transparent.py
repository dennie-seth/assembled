#!/usr/bin/env python3
"""Re-save an already-cut-out indexed sprite as mode 'P' + tRNS (P-6).

This is a **format** change, not a regeneration. Every pixel index and every
palette slot in the output is byte-identical to the input; the only difference
is a tRNS chunk declaring the background index fully transparent. That is why
it does not invalidate `model_hash`, `concept_hash` or `generator` in the
sidecar -- the pixels those fields describe are exactly the pixels still on
disk. The script records what it did under a `transparency` key so the change
is visible in provenance rather than only in the git diff.

It refuses anything it cannot convert losslessly:

* not mode 'P' -- there is no index to key on;
* the four corners disagree on the background index -- the image was never cut
  out, so "the background" is not a single index and marking one transparent
  would punch holes in the art;
* the background index is unused, or used by every pixel;
* the round-trip changed an index or a palette slot.

The §24-e sheet and the T-0199/T-0200 synth sheets pass; the v2 img2img sheets
and the signal_tower props correctly do not -- they need regeneration through
the cutout path, and are documented in
`tools/asset-gate/src/asset_gate/transparency_baseline.txt`.

Usage:
    python scripts/resave_transparent.py assets/final/character/*.png
    python scripts/resave_transparent.py --dry-run --sweep assets/final
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from comfy_client.transparency import (  # noqa: E402
    BACKGROUND_INDEX,
    indexed_transparency_index,
    save_indexed_sprite,
)

APPLIED_BY = "tools/comfy-client/scripts/resave_transparent.py"
SPEC = "docs/design/13-asset-pipeline.md §3.7 (P-6)"
NOTE = (
    "Format re-save only (P-6): a tRNS chunk marking the background index fully "
    "transparent was added. Pixel indices and the 16-slot palette are byte-identical "
    "to the previously committed file -- nothing was regenerated, so model_hash, "
    "concept_hash and generator continue to describe exactly these pixels."
)


class Refused(Exception):
    """The image cannot be converted losslessly."""


def _border_connected(arr: np.ndarray, index: int) -> np.ndarray:
    """Mask of the *index*-valued pixels reachable from the image border."""
    h, w = arr.shape
    seen = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if arr[y, x] == index and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))

    for x in range(w):
        seed(0, x)
        seed(h - 1, x)
    for y in range(h):
        seed(y, 0)
        seed(y, w - 1)

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w:
                seed(ny, nx)
    return seen


def inspect(path: Path, background_index: int = BACKGROUND_INDEX) -> dict:
    """Describe *path* and raise `Refused` if it is not losslessly convertible."""
    image = Image.open(path)
    if image.mode != "P":
        raise Refused(f"mode {image.mode!r}, not indexed -- no palette index to key on")

    arr = np.array(image)
    h, w = arr.shape
    corners = {int(arr[0, 0]), int(arr[0, w - 1]), int(arr[h - 1, 0]), int(arr[h - 1, w - 1])}
    if corners != {background_index}:
        raise Refused(
            f"corner indices are {sorted(corners)}, not a single background index "
            f"{background_index} -- this sheet was never cut out"
        )

    background_px = int((arr == background_index).sum())
    if background_px == 0:
        raise Refused(f"index {background_index} is never used")
    if background_px == arr.size:
        raise Refused(f"every pixel is index {background_index} -- nothing would render")

    border = _border_connected(arr, background_index)
    return {
        "path": path,
        "size": [w, h],
        "background_index": background_index,
        "background_px": background_px,
        "border_connected_px": int(border.sum()),
        "interior_background_px": background_px - int(border.sum()),
        "already_transparent": indexed_transparency_index(image) == background_index,
    }


def resave(path: Path, background_index: int = BACKGROUND_INDEX, dry_run: bool = False) -> dict:
    """Re-save *path* with tRNS, verifying nothing else changed."""
    report = inspect(path, background_index)
    if dry_run:
        return report

    image = Image.open(path)
    before_indices = np.array(image)
    before_palette = image.getpalette()

    save_indexed_sprite(image, path, background_index=background_index)

    after = Image.open(path)
    if not np.array_equal(np.array(after), before_indices):
        raise Refused("round-trip changed a pixel index -- refusing to leave this on disk")
    if after.getpalette() != before_palette:
        raise Refused("round-trip changed the palette -- refusing to leave this on disk")
    if indexed_transparency_index(after) != background_index:
        raise Refused("round-trip did not produce a tRNS chunk")
    return report


def update_sidecar(image_path: Path, report: dict, branch: str | None = None) -> Path | None:
    """Record the format change in the sprite's provenance sidecar, if it has one."""
    sidecar = image_path.with_suffix("").with_suffix(".provenance.json")
    if not sidecar.is_file():
        sidecar = image_path.with_name(f"{image_path.stem}.provenance.json")
    if not sidecar.is_file():
        return None

    data = json.loads(sidecar.read_text())
    block = {
        "format": "indexed_png_trns",
        "background_index": report["background_index"],
        "applied_by": APPLIED_BY,
        "spec": SPEC,
    }
    if branch:
        block["branch"] = branch
    block["note"] = NOTE
    block["background_px"] = report["background_px"]
    block["interior_background_px"] = report["interior_background_px"]
    data["transparency"] = block
    sidecar.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return sidecar


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path, help="PNG files to re-save")
    parser.add_argument(
        "--sweep",
        type=Path,
        help="re-save every convertible *.png under this directory instead",
    )
    parser.add_argument("--background-index", type=int, default=BACKGROUND_INDEX)
    parser.add_argument(
        "--branch", default=None, help="branch name recorded in the sidecar (optional)"
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    targets = list(args.paths)
    if args.sweep:
        targets.extend(sorted(args.sweep.rglob("*.png")))
    if not targets:
        parser.error("give at least one path, or --sweep DIR")

    converted, refused = 0, 0
    for path in targets:
        try:
            report = resave(path, args.background_index, dry_run=args.dry_run)
        except Refused as exc:
            refused += 1
            print(f"SKIP {path}: {exc}")
            continue
        converted += 1
        sidecar = None
        if not args.dry_run:
            sidecar = update_sidecar(path, report, args.branch)
        print(
            f"OK   {path}: bg index {report['background_index']}, "
            f"{report['background_px']} bg px "
            f"({report['interior_background_px']} not border-connected)"
            + (f", sidecar {sidecar.name}" if sidecar else "")
        )

    verb = "would convert" if args.dry_run else "converted"
    print(f"\n{verb} {converted}, skipped {refused}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
