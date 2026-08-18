"""Art-side validation checks, `13-asset-pipeline.md` §2 and §3.6.

All checks operate on already-loaded `PIL.Image` objects (mode 'P', indexed)
so callers control I/O; the CLI (`asset_gate.cli`) handles loading from disk.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Literal

import numpy as np
from PIL import Image

from asset_gate.determinism import check_reproducible, image_bytes
from asset_gate.palette import Palette
from asset_gate.result import CheckResult

try:
    from scipy import ndimage as _ndimage

    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False


def _to_array(image: Image.Image) -> np.ndarray:
    if image.mode != "P":
        raise ValueError(f"expected an indexed (mode 'P') image, got mode {image.mode!r}")
    return np.array(image)


def check_tile_seamlessness(image: Image.Image) -> CheckResult:
    """Base-field tiles: left edge column == right edge column, top row == bottom
    row, pixel equality (index equality, since these are indexed images)."""
    arr = _to_array(image)
    left, right = arr[:, 0], arr[:, -1]
    top, bottom = arr[0, :], arr[-1, :]

    col_mismatch = int(np.count_nonzero(left != right))
    row_mismatch = int(np.count_nonzero(top != bottom))

    if col_mismatch or row_mismatch:
        return CheckResult(
            check="tile_seamlessness",
            passed=False,
            reason=(
                f"{col_mismatch} mismatched pixel(s) on left/right edge, "
                f"{row_mismatch} on top/bottom edge"
            ),
            details={"col_mismatch": col_mismatch, "row_mismatch": row_mismatch},
        )
    return CheckResult(
        check="tile_seamlessness",
        passed=True,
        reason="left/right and top/bottom edges match exactly",
        details={},
    )


def check_transition_adjacency(
    tile_a: Image.Image,
    tile_b: Image.Image,
    edge: Literal["horizontal", "vertical"],
) -> CheckResult:
    """Declared tile pairs must match on their shared edge.

    `edge="horizontal"` means A sits left of B: A's right column must equal
    B's left column. `edge="vertical"` means A sits above B: A's bottom row
    must equal B's top row.
    """
    a, b = _to_array(tile_a), _to_array(tile_b)

    if edge == "horizontal":
        a_edge, b_edge = a[:, -1], b[:, 0]
    elif edge == "vertical":
        a_edge, b_edge = a[-1, :], b[0, :]
    else:
        raise ValueError(f"edge must be 'horizontal' or 'vertical', got {edge!r}")

    mismatch = int(np.count_nonzero(a_edge != b_edge))
    if mismatch:
        return CheckResult(
            check="transition_adjacency",
            passed=False,
            reason=f"{mismatch} mismatched pixel(s) on the shared {edge} edge",
            details={"edge": edge, "mismatch": mismatch},
        )
    return CheckResult(
        check="transition_adjacency",
        passed=True,
        reason=f"shared {edge} edge matches exactly",
        details={"edge": edge},
    )


def check_cell_fit(
    sheet: Image.Image,
    cell_width: int,
    cell_height: int,
    cols: int,
    rows: int,
    background_index: int = 0,
) -> list[CheckResult]:
    """Every sprite fits its cell -- no foreground pixel touches a border
    shared with a neighbouring cell. Outer sheet edges are exempt (a sprite
    is allowed to touch the true edge of the sheet)."""
    arr = _to_array(sheet)
    expected_w, expected_h = cell_width * cols, cell_height * rows
    if arr.shape[1] != expected_w or arr.shape[0] != expected_h:
        raise ValueError(
            f"sheet is {arr.shape[1]}x{arr.shape[0]}, expected {expected_w}x{expected_h} "
            f"for a {cols}x{rows} grid of {cell_width}x{cell_height} cells"
        )

    results = []
    for row in range(rows):
        for col in range(cols):
            x0, y0 = col * cell_width, row * cell_height
            x1, y1 = x0 + cell_width, y0 + cell_height
            cell = arr[y0:y1, x0:x1]
            fg = cell != background_index

            violations = []
            if col > 0 and fg[:, 0].any():
                violations.append("left")
            if col < cols - 1 and fg[:, -1].any():
                violations.append("right")
            if row > 0 and fg[0, :].any():
                violations.append("top")
            if row < rows - 1 and fg[-1, :].any():
                violations.append("bottom")

            passed = not violations
            reason = (
                "no bleed into neighbouring cells"
                if passed
                else f"bleed into neighbour(s) on edge(s): {', '.join(violations)}"
            )
            results.append(
                CheckResult(
                    check="cell_fit",
                    passed=passed,
                    reason=reason,
                    details={"cell": (row, col), "violations": violations},
                )
            )
    return results


def check_orphan_pixels(
    image: Image.Image,
    background_index: int,
    size_threshold: int,
) -> CheckResult:
    """Isolated foreground blobs smaller than `size_threshold` pixels are
    orphans -- downscale artifacts that read as noise at 16px (P-B tunes
    the threshold per-set).

    Requires scipy. Returns a skipped-pass result when scipy is unavailable
    so the check does not block import or test collection on minimal envs.
    """
    if not _HAS_SCIPY:
        return CheckResult(
            check="orphan_pixels",
            passed=True,
            reason="scipy not installed — orphan-pixel check skipped (install scipy to enable)",
            details={"skipped_reason": "scipy_not_installed"},
        )
    arr = _to_array(image)
    fg = arr != background_index
    labeled, num_features = _ndimage.label(fg)
    if num_features == 0:
        return CheckResult(
            check="orphan_pixels",
            passed=True,
            reason="no foreground pixels to evaluate",
            details={"orphans": []},
        )

    sizes = _ndimage.sum(fg, labeled, index=range(1, num_features + 1))
    orphan_labels = [i + 1 for i, size in enumerate(sizes) if size < size_threshold]

    if orphan_labels:
        return CheckResult(
            check="orphan_pixels",
            passed=False,
            reason=f"{len(orphan_labels)} orphan blob(s) below the {size_threshold}px threshold",
            details={"orphans": orphan_labels, "sizes": sizes.tolist()},
        )
    return CheckResult(
        check="orphan_pixels",
        passed=True,
        reason=f"no blobs below the {size_threshold}px threshold ({num_features} blob(s) total)",
        details={"blob_count": num_features},
    )


def check_frame_consistency(
    frame_a: Image.Image,
    frame_b: Image.Image,
    background_index: int,
    max_delta_ratio: float,
) -> CheckResult:
    """Silhouette delta between adjacent animation frames must stay within
    bounds -- catches identity drift between frames."""
    a, b = _to_array(frame_a), _to_array(frame_b)
    if a.shape != b.shape:
        raise ValueError(f"frame shapes differ: {a.shape} vs {b.shape}")

    silhouette_a = a != background_index
    silhouette_b = b != background_index
    delta = np.count_nonzero(silhouette_a != silhouette_b)
    union = np.count_nonzero(silhouette_a | silhouette_b)
    ratio = (delta / union) if union else 0.0

    passed = ratio <= max_delta_ratio
    return CheckResult(
        check="frame_consistency",
        passed=passed,
        reason=(
            f"silhouette delta ratio {ratio:.4f} "
            f"{'<=' if passed else '>'} bound {max_delta_ratio}"
        ),
        details={"delta_pixels": delta, "union_pixels": union, "ratio": ratio},
    )


def check_atlas_determinism(
    pack_fn: Callable[[Sequence[Image.Image]], Image.Image],
    inputs: Sequence[Image.Image],
    runs: int = 2,
) -> CheckResult:
    """Same input set -> byte-identical atlas layout (T-0074)."""
    return check_reproducible(
        "atlas_determinism",
        lambda: image_bytes(pack_fn(inputs)),
        runs=runs,
    )


def check_indexed_preservation(image: Image.Image, palette: Palette) -> CheckResult:
    """The packed atlas must still be PIL mode 'P' with the expected
    palette -- Pillow silently converts to RGB on several operations."""
    if image.mode != "P":
        return CheckResult(
            check="indexed_preservation",
            passed=False,
            reason=f"expected mode 'P', got {image.mode!r} -- Pillow converted away from indexed",
            details={"mode": image.mode},
        )

    flat = image.getpalette() or []
    image_rgb_by_index = {
        i: (flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]) for i in range(len(flat) // 3)
    }
    mismatched = {
        i: {"image_rgb": image_rgb_by_index.get(i), "home_rgb": rgb}
        for i, rgb in palette.rgb_by_index.items()
        if image_rgb_by_index.get(i) != rgb
    }
    if mismatched:
        return CheckResult(
            check="indexed_preservation",
            passed=False,
            reason=f"{len(mismatched)} palette slot(s) drifted from the expected palette",
            details={"mismatched": mismatched},
        )
    return CheckResult(
        check="indexed_preservation",
        passed=True,
        reason="mode is 'P' and the embedded palette matches the expected palette",
        details={},
    )
