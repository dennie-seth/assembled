"""Content-aware foreground/background segmentation for §24-e-style
character generation (`docs/design/13-asset-pipeline.md` §3.5), shared by
every generator that applies a per-frame background cutout after descent +
palette quantization: `gen_chained_idle_T0250`, `gen_hybrid_source_idle_T0252`,
`gen_hybrid_walk_T0259`, `gen_hybrid_profile_T0272`.

T-0272 round 4: `cutout_foreground_mask` originally intersected the
border-connected Oklab-space background flood with "outside this frame's own
keypoint bbox (+margin) is background," unconditionally -- a correct prior
only while the rendered figure stays near the ControlNet skeleton's own
keypoint positions. A pose that genuinely deviates from the skeleton (a
second IP-Adapter reference pulling the pose toward a real side profile,
T-0272 round 3's Test D) breaks that assumption outright: attempts 13-15
produced legible silhouettes that the old hard bbox clip zeroed entirely
(attempt 13, 0 surviving px) or shrank just under the foreground floor
(attempts 14-15, 43/45 px against a 50px floor).

This module keeps the border-connected flood as the (genuinely content-based)
background detector, and replaces the hard bbox intersection with connected-
component selection over the resulting foreground: EVERY component that
overlaps a keypoints HINT region is kept -- not just the single best-
overlapping one -- because a real figure routinely splits into several
components (a limb or head separated from the torso by a background-coloured
outline seam). Round 4's first cut kept only the single best-overlap
component and was caught regressing the already-promoted
`player_idle_sheet_hybrid_T0252.png`: every one of that sheet's 9 cells is
3-4 components, and single-best selection silently dropped up to 161 of
455px on some cells (see `test_promoted_front_sheet_cells_survive_the_new_selection_whole`).
If nothing overlaps the hint at all -- the case a shifted pose produces
(T-0272 round 3's Test D) -- the single largest foreground component is kept
instead of reporting "no figure." `keypoints_norm` therefore never clips a
pixel outside its own bbox; it only disambiguates which blob(s) are "the
figure" when the flood leaves more than one candidate. Nothing here assumes
an upright human, a front view, two legs, or any fixed aspect ratio -- only
pixel content and (optionally) a keypoints hint drive the selection, so the
same function is expected to serve non-human entity sheets (the owl-Watcher,
robot-Sound, spider-Still-Air) unmodified.
"""

from __future__ import annotations

from collections import deque

import numpy as np
from PIL import Image

#: Measured on the already-promoted T-0250 attempt 8 frames: tolerance 0.03
#: recovers a foreground fraction stable across frames with no visible
#: clipping of the figure's silhouette (see gen_chained_idle_T0250's own
#: derivation, unchanged by this module's move).
CUTOUT_OKLAB_TOLERANCE = 0.03

#: Fraction of the keypoints hint's own bbox extent, each side -- shared with
#: `background_hold_mask` (gen_chained_idle_T0250), which still owns its own
#: definition site for that unrelated frame-to-frame compositing fix.
BACKGROUND_MASK_MARGIN_FRAC = 0.14


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Duplicated deliberately from `gen_arm_a_idle_T0228._srgb_to_oklab`
    rather than imported from it: a generator script importing from this
    shared package is the intended dependency direction, not the reverse,
    and this is a small, stable colour-space conversion, not business logic
    that could drift out of sync."""
    lin = _srgb_to_linear(np.asarray(rgb, dtype=np.float64))
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l_), np.cbrt(m_), np.cbrt(s_)
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([lightness, a, b2], axis=-1)


def _oklab_grid(rgb_uint8: np.ndarray) -> np.ndarray:
    h, w = rgb_uint8.shape[:2]
    flat = _srgb_to_oklab(rgb_uint8.reshape(-1, 3).astype(np.float64))
    return flat.reshape(h, w, 3)


def border_flood_background_mask(img: Image.Image, tolerance: float) -> np.ndarray:
    """Boolean HxW array, True = background. T-0315: every pixel's own
    qualifying test is its absolute Oklab distance to a small set of sampled
    *true* border colours (every distinct colour actually present on the
    frame's own edge) -- never a hop-to-hop tolerance test against whatever
    neighbour it happened to grow from. Background is still exactly the
    border-connected region of qualifying pixels (a real figure that is
    merely the same shade as the background *somewhere else in the frame*,
    without itself touching the edge through a connected qualifying path,
    must not be swept -- verified against every promoted sheet this module
    already serves, not just asserted).

    The previous implementation (kept in git history, not here) was a
    tolerance-chained ("magic wand, contiguous") BFS: a pixel qualified as
    background if it was within `tolerance` of the *neighbour it grew from*.
    That let a long chain of small hops -- a heavy anti-aliased outline
    stroke -- walk from the true background, through the outline, into a
    figure's interior, even when the *direct* distance from background to
    interior was many times `tolerance` (T-0272 round 5's own diagnosis of
    attempt 28's lost coat colour: `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s
    "Lever 3" section). Testing every pixel against the border's own sampled
    colours directly, instead of against its immediate predecessor, closes
    that path: a chain of small hops can no longer accumulate into a large
    total displacement the way repeated hop-to-hop comparison allowed, since
    every step of the walk must independently stay close to a *real*
    border colour, not merely close to the previous step.

    A smoothly-varying background (a vignette/gradient) is still handled
    without any special-casing: sampling from *every* border pixel, not just
    one seed colour, means a gradient's full value range is already in the
    sample set whenever that range is reached at the frame's own edge (the
    common case -- a vignette darkens toward the corners, which are on the
    border)."""
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    oklab = _oklab_grid(arr)

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = True
    border[h - 1, :] = True
    border[:, 0] = True
    border[:, w - 1] = True
    border_colors = np.unique(oklab[border], axis=0)

    tol2 = tolerance * tolerance
    min_dist2 = np.full((h, w), np.inf, dtype=np.float64)
    for color in border_colors:
        diff = oklab - color
        dist2 = diff[..., 0] ** 2 + diff[..., 1] ** 2 + diff[..., 2] ** 2
        np.minimum(min_dist2, dist2, out=min_dist2)
    qualifies = min_dist2 <= tol2

    visited = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if qualifies[y, x] and not visited[y, x]:
            visited[y, x] = True
            queue.append((y, x))

    for x in range(w):
        seed(0, x)
        seed(h - 1, x)
    for y in range(h):
        seed(y, 0)
        seed(y, w - 1)

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and qualifies[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))
    return visited


def label_foreground_components(foreground: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected connected-component labelling over a boolean foreground
    mask. Returns (labels, count): `labels` is an int32 HxW array, 0 for
    unlabeled/background, 1..count for each component; `count` is the number
    of distinct components found."""
    h, w = foreground.shape
    labels = np.zeros((h, w), dtype=np.int32)
    next_label = 0
    for y in range(h):
        for x in range(w):
            if foreground[y, x] and labels[y, x] == 0:
                next_label += 1
                labels[y, x] = next_label
                queue: deque[tuple[int, int]] = deque([(y, x)])
                while queue:
                    cy, cx = queue.popleft()
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        ny, nx = cy + dy, cx + dx
                        if (
                            0 <= ny < h
                            and 0 <= nx < w
                            and foreground[ny, nx]
                            and labels[ny, nx] == 0
                        ):
                            labels[ny, nx] = next_label
                            queue.append((ny, nx))
    return labels, next_label


def _keypoints_hint_mask(
    points_norm: dict[int, tuple[float, float]], bbox_margin_frac: float, size: int
) -> np.ndarray:
    """A boolean HxW region -- the keypoints' own bbox + margin -- used only
    to score candidate foreground blobs, never to clip pixels directly."""
    xs = [x for x, _ in points_norm.values()]
    ys = [y for _, y in points_norm.values()]
    x0n, x1n = min(xs), max(xs)
    y0n, y1n = min(ys), max(ys)
    wn, hn = x1n - x0n, y1n - y0n
    x0n = max(0.0, x0n - wn * bbox_margin_frac)
    x1n = min(1.0, x1n + wn * bbox_margin_frac)
    y0n = max(0.0, y0n - hn * bbox_margin_frac)
    y1n = min(1.0, y1n + hn * bbox_margin_frac)
    x0, x1 = int(x0n * size), int(x1n * size)
    y0, y1 = int(y0n * size), int(y1n * size)
    hint = np.zeros((size, size), dtype=bool)
    hint[y0:y1, x0:x1] = True
    return hint


def extract_foreground_mask(
    img: Image.Image,
    tolerance: float,
    keypoints_norm: dict[int, tuple[float, float]] | None = None,
    bbox_margin_frac: float = BACKGROUND_MASK_MARGIN_FRAC,
) -> np.ndarray:
    """Boolean HxW array, True = character. Background is the border-
    connected tolerant Oklab flood; the foreground is its complement, reduced
    to every connected component that overlaps `keypoints_norm`'s own
    bbox+margin (a real figure often splits into several -- a limb or head
    separated from the torso by a background-coloured outline seam, and
    ALL of them must survive, not just the largest), or (when nothing
    overlaps the hint, or when no hint is given at all) the single largest
    foreground component. `keypoints_norm` is a HINT, never a hard frame: it
    can never cause a pixel belonging to an overlapping component to be
    dropped."""
    size = img.size[0]
    background = border_flood_background_mask(img, tolerance)
    foreground = ~background
    labels, count = label_foreground_components(foreground)
    if count == 0:
        return foreground
    if count == 1:
        return labels == 1

    if keypoints_norm is None:
        areas = {lbl: int((labels == lbl).sum()) for lbl in range(1, count + 1)}
        largest_label = max(areas, key=areas.get)
        return labels == largest_label

    hint = _keypoints_hint_mask(keypoints_norm, bbox_margin_frac, size)
    overlaps = {lbl: int(((labels == lbl) & hint).sum()) for lbl in range(1, count + 1)}
    overlapping_labels = [lbl for lbl, ov in overlaps.items() if ov > 0]
    if not overlapping_labels:
        # The rendered figure sits entirely outside the hint region (a
        # stacked profile reference pulling the pose off-rig, T-0272 round
        # 3's attempts 13-15) -- fall back to the largest foreground blob
        # rather than reporting "no figure."
        areas = {lbl: int((labels == lbl).sum()) for lbl in range(1, count + 1)}
        largest_label = max(areas, key=areas.get)
        return labels == largest_label
    return np.isin(labels, overlapping_labels)


def cutout_foreground_mask(
    img: Image.Image,
    points_norm: dict[int, tuple[float, float]],
    tolerance: float,
    bbox_margin_frac: float,
) -> np.ndarray:
    """Pre-round-4 name, kept as a drop-in alias: every existing caller
    (`gen_chained_idle_T0250`, `gen_hybrid_source_idle_T0252`,
    `gen_hybrid_walk_T0259`, `gen_hybrid_profile_T0272`) calls this
    positionally as (img, points_norm, tolerance, bbox_margin_frac)."""
    return extract_foreground_mask(img, tolerance, points_norm, bbox_margin_frac)


def downscale_mask(fg_mask: np.ndarray, target_size: int) -> np.ndarray:
    """Area-downscale a boolean mask to `target_size`x`target_size` (matches
    the BOX filter already used for the RGB image itself) and re-threshold
    at 50% coverage."""
    mask_img = Image.fromarray((fg_mask * 255).astype(np.uint8))
    small = mask_img.resize((target_size, target_size), Image.Resampling.BOX)
    return np.array(small) >= 128


def apply_cutout_masks(
    indexed: Image.Image,
    fg_masks: dict[tuple[int, int], np.ndarray],
    cell_size: int,
    background_index: int,
) -> Image.Image:
    """Force every cell's non-character pixels (per that cell's own
    downscaled cutout mask) to `background_index`."""
    arr = np.array(indexed)
    out = arr.copy()
    for (r, c), mask in fg_masks.items():
        y0, x0 = r * cell_size, c * cell_size
        sub = out[y0 : y0 + cell_size, x0 : x0 + cell_size]
        sub[~mask] = background_index
    result = Image.fromarray(out, mode="P")
    result.putpalette(indexed.getpalette())
    return result


CUTOUT_METHOD_DESCRIPTION = (
    "Per-frame border-connected tolerant region-growing in Oklab space "
    f"(tolerance={CUTOUT_OKLAB_TOLERANCE}) over that frame's own 384x384 sampled/held image, "
    "seeded from every border pixel and grown through 4-connected neighbours within the "
    "tolerance of the pixel it grows from -- removes background clutter connected to the frame "
    "edge regardless of how many distinct palette indices it later quantizes to. The resulting "
    "foreground is reduced to every connected component that overlaps a keypoints hint region "
    "(falling back to the single largest component when nothing overlaps the hint, "
    "or when no hint is given) -- a content-aware selection (T-0272 round 4) that supersedes "
    "the original hard 'outside this frame's own keypoint bbox is background' clip, which could "
    "zero or clip a real figure whose rendered pose deviates from its own ControlNet skeleton. "
    "Applied to each frame's own image and downscaled alongside it BEFORE the frames are "
    "assembled into the sheet -- not to the assembled sheet. Character-foreground pixels keep "
    "their quantized palette index; every other pixel is forced to background_index=0."
)
