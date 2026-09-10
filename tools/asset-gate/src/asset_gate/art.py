"""Art-side validation checks, `13-asset-pipeline.md` §2 and §3.6.

All checks operate on already-loaded `PIL.Image` objects (mode 'P', indexed)
so callers control I/O; the CLI (`asset_gate.cli`) handles loading from disk.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw

from asset_gate.determinism import check_reproducible, image_bytes
from asset_gate.palette import Palette
from asset_gate.result import CheckResult

Point = tuple[float, float]


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
    try:
        from scipy import ndimage as _ndimage
    except ImportError:
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


def slice_sheet_frames(
    sheet: Image.Image,
    cell_width: int,
    cell_height: int,
    cols: int,
    rows: int,
) -> list[Image.Image]:
    """Crop a sprite sheet into its per-cell frames, row-major order (row 0
    left-to-right, then row 1, ...) -- the canonical frame order every
    per-frame gate check and report in this package assumes."""
    expected_w, expected_h = cell_width * cols, cell_height * rows
    if sheet.size != (expected_w, expected_h):
        raise ValueError(
            f"sheet is {sheet.size[0]}x{sheet.size[1]}, expected {expected_w}x{expected_h} "
            f"for a {cols}x{rows} grid of {cell_width}x{cell_height} cells"
        )
    frames = []
    for row in range(rows):
        for col in range(cols):
            x0, y0 = col * cell_width, row * cell_height
            frames.append(sheet.crop((x0, y0, x0 + cell_width, y0 + cell_height)))
    return frames


def count_pixel_deltas(frame_a: Image.Image, frame_b: Image.Image) -> int:
    """Count of pixels whose palette index differs between two same-shaped
    indexed frames -- ANY change, not just a foreground/background
    silhouette *state* flip.

    Distinct from `check_frame_consistency`, which only counts a pixel if
    its fg/bg state changed (a foreground pixel changing to a *different*
    foreground index is invisible to it). This is the metric a reviewer
    eyeballing a sheet by hand actually sees, and the one
    `asset_gate.character.build_character_gate_report` (T-0349) reports per
    adjacent frame pair.
    """
    a, b = _to_array(frame_a), _to_array(frame_b)
    if a.shape != b.shape:
        raise ValueError(f"frame shapes differ: {a.shape} vs {b.shape}")
    return int(np.count_nonzero(a != b))


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


def render_rig_silhouette(
    size: int,
    limbs: Sequence[tuple[Point, Point]],
    radius: float,
) -> np.ndarray:
    """Render a pose rig's own skeleton as capsules -- a thick line plus a
    rounded cap at each endpoint, per limb segment -- onto a `size x size`
    boolean canvas (T-0340).

    `limbs` are pixel-space `((x0, y0), (x1, y1))` endpoint pairs (the
    caller scales its rig's normalised keypoints to the target size and
    supplies its own limb topology -- this function has no opinion on
    joint numbering). `radius` is the capsule half-width in pixels.

    This is the geometric prediction `check_pose_fidelity` compares an
    actual rendered frame's silhouette against: what the rig commanded,
    not what the previous frame looked like.
    """
    canvas = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(canvas)
    line_width = max(1, round(radius * 2))
    for (x0, y0), (x1, y1) in limbs:
        draw.line([(x0, y0), (x1, y1)], fill=255, width=line_width)
        for cx, cy in ((x0, y0), (x1, y1)):
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=255)
    return np.array(canvas) > 0


def check_pose_fidelity(
    frame: Image.Image,
    rig_silhouette: np.ndarray,
    background_index: int,
    min_iou: float,
) -> CheckResult:
    """IoU between a rendered frame's own foreground silhouette and the
    rig's predicted (capsule) silhouette for that same frame's commanded
    pose (T-0340).

    Replaces whole-silhouette XOR/union (`check_frame_consistency`) for the
    locomotion/transition/loop motion classes: that measure compares a
    frame against the PREVIOUS frame, so a rig's own legitimate motion --
    a leg mid-stride is nowhere near where it was a frame ago -- already
    consumes most of its budget at perfect pose fidelity and zero drift
    (see `asset_gate.character`'s T-0340 module note: rendering the rig's
    own skeletons as capsules measured 0.23-0.49 of the old 0.50 cap on
    legitimate motion alone). Comparing each frame against WHAT ITS OWN
    POSE COMMANDS, instead of against the previous frame, is invariant to
    how far the pose itself swings frame to frame -- only whether the
    render actually matches the commanded pose.
    """
    actual = _to_array(frame) != background_index
    if actual.shape != rig_silhouette.shape:
        raise ValueError(
            f"frame shape {actual.shape} != rig_silhouette shape {rig_silhouette.shape}"
        )
    intersection = int(np.count_nonzero(actual & rig_silhouette))
    union = int(np.count_nonzero(actual | rig_silhouette))
    iou = (intersection / union) if union else 1.0

    passed = iou >= min_iou
    return CheckResult(
        check="pose_fidelity",
        passed=passed,
        reason=f"pose-fidelity IoU {iou:.4f} {'>=' if passed else '<'} floor {min_iou}",
        details={"iou": iou, "intersection_pixels": intersection, "union_pixels": union},
    )


def check_identity_stability(
    frame_a: Image.Image,
    frame_b: Image.Image,
    background_index: int,
    region: tuple[int, int, int, int],
    max_histogram_distance: float,
) -> CheckResult:
    """Total-variation distance between a fixed torso region's palette-index
    histograms across two adjacent frames (T-0340).

    `region` is a pixel-space `(x0, y0, x1, y1)` box (numpy slice
    semantics, exclusive of `x1`/`y1`), the same box in both frames --
    the torso doesn't stride, so a fixed box sidesteps limb motion
    entirely and isolates colour/identity drift, which whole-silhouette
    XOR/union (`check_frame_consistency`) cannot separate from a real
    gait's own silhouette motion: a torso fading toward the background
    palette shrinks the silhouette exactly the way real motion does, and a
    frame that shrinks for either reason reads as an equally low delta
    ratio to a check that only sees the whole frame. This is precisely the
    corroborating failure the review found overnight: a sequential-chained
    walk candidate scored a deceptively even delta and passed most of its
    interior pairs because colour drift was shrinking the silhouette, not
    because it walked.
    """
    a, b = _to_array(frame_a), _to_array(frame_b)
    if a.shape != b.shape:
        raise ValueError(f"frame shapes differ: {a.shape} vs {b.shape}")
    x0, y0, x1, y1 = region
    region_a, region_b = a[y0:y1, x0:x1], b[y0:y1, x0:x1]
    if region_a.size == 0:
        raise ValueError(f"region {region} is empty")

    depth = max(int(region_a.max()), int(region_b.max()), background_index) + 1
    hist_a = np.bincount(region_a.ravel(), minlength=depth).astype(float)
    hist_b = np.bincount(region_b.ravel(), minlength=depth).astype(float)
    hist_a /= hist_a.sum()
    hist_b /= hist_b.sum()
    distance = 0.5 * float(np.abs(hist_a - hist_b).sum())

    passed = distance <= max_histogram_distance
    return CheckResult(
        check="identity_stability",
        passed=passed,
        reason=(
            f"torso palette-histogram distance {distance:.4f} "
            f"{'<=' if passed else '>'} cap {max_histogram_distance}"
        ),
        details={"distance": distance, "region": region},
    )


def check_background_growth(
    frames: Sequence[Image.Image],
    background_index: int,
    max_growth_ratio: float,
) -> CheckResult:
    """Non-background pixel count must not grow past `max_growth_ratio` of
    frame 0's count, for any frame in the sequence.

    Catches img2img-chaining noise accumulation (T-0250, HANDOFF §24-c,
    human review 2026-08-30): each frame's own background speckle feeding
    into the next frame's init image, so the figure visibly dissolves into
    noise by the end of the sheet even though `check_frame_consistency`
    (inter-frame silhouette *delta*, not absolute pixel-count growth against
    a fixed baseline) passed. Ordinary pose-driven fluctuation (no trend)
    stays within a fairly tight ratio of frame 0's count; a compounding
    chain does not.
    """
    if not frames:
        raise ValueError("frames must be non-empty")
    counts = [int(np.count_nonzero(_to_array(f) != background_index)) for f in frames]
    baseline = counts[0]
    if baseline == 0:
        offending = [(i, c) for i, c in enumerate(counts) if c > 0]
    else:
        offending = [
            (i, c) for i, c in enumerate(counts) if c / baseline > max_growth_ratio
        ]
    passed = not offending
    if not passed:
        return CheckResult(
            check="background_growth",
            passed=False,
            reason=(
                f"{len(offending)} frame(s) exceed {max_growth_ratio}x frame 0's "
                f"non-background pixel count ({baseline}px): {offending}"
            ),
            details={"counts": counts, "baseline": baseline, "max_growth_ratio": max_growth_ratio},
        )
    return CheckResult(
        check="background_growth",
        passed=True,
        reason=(
            f"non-background pixel count stays within {max_growth_ratio}x of "
            f"frame 0's count ({baseline}px) across all {len(frames)} frames"
        ),
        details={"counts": counts, "baseline": baseline, "max_growth_ratio": max_growth_ratio},
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
