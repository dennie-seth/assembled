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

import warnings
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

#: T-0315 round-3 fix: the fraction of the frame's own border PIXELS (by
#: count, not by distinct colour) that `_representative_border_colors` must
#: cover before it stops adding representatives. Deliberately not 1.0 -- see
#: that function's own docstring for why chasing literal 100% distinct-
#: colour coverage on a wide-spread border is actively harmful, not merely
#: unnecessary. 0.95 was chosen empirically against this card's own
#: diagnostic frame (a raw render whose figure legitimately touches the
#: frame border along most of one edge, `border_spread` 33x tolerance): it
#: closes round 2's regression (the frame's dominant true-background tone,
#: covered within the first handful of representatives since coverage is
#: frequency-ordered, is fully covered long before 95% mass is reached) while
#: still refusing the last, rarest, most steeply blended border colours --
#: exactly the ones a wide anti-aliased transition contributes and exactly
#: the ones that, if forced into coverage, produce representatives close
#: enough to genuine figure colours to sweep them (measured: chasing the
#: same frame to 100% mass swept the coat's own hood/shoulder fill into
#: background, dropping the final 48px keyframe from 490px at 90% coverage
#: to 117px at 100%).
BORDER_COLOR_COVERAGE_TARGET = 0.95

#: Hard cap on how many representative border colours
#: `_representative_border_colors` will accept before giving up on reaching
#: `BORDER_COLOR_COVERAGE_TARGET` and warning loudly instead. Bounds
#: worst-case cost and surfaces a frame whose border is so fragmented that
#: "a small set of sampled border colours" (this card's own Step 2 wording)
#: is no longer a meaningful description.
_MAX_BORDER_REPRESENTATIVES = 64

#: T-0315 round 4: the minimum fraction of a candidate foreground component's
#: OWN area that must fall inside the keypoints hint's own bbox+margin for
#: that component to be kept on overlap grounds alone. `extract_foreground_mask`
#: previously kept ANY component with `> 0` overlap, however small -- round 3's
#: own reviewer FAIL traced a 24%-of-foreground grey background panel in the
#: promoted attempt-28 sprite to exactly this: a genuinely disjoint 8,427px
#: (at 384px) background-panel component survived in full because only 698px
#: of it (8.3%) happened to fall inside the hint. Requiring a MAJORITY of the
#: component's own area to overlap keeps a real limb/head that is mostly
#: inside its own hint (T-0272 round 4's own regression, still covered by
#: `test_multi_part_figure_survives_whole_when_every_part_overlaps_hint`,
#: where both parts overlap 100%) while dropping a large decoy that is mostly
#: outside it (`test_component_barely_grazing_the_hint_is_excluded`).
MIN_HINT_OVERLAP_FRACTION = 0.5


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


def _representative_border_colors(
    unique_border_colors: np.ndarray, counts: np.ndarray, tolerance: float
) -> np.ndarray:
    """Reduce every distinct colour actually present on the frame's own edge
    to a genuinely small set of representatives, chosen by GREEDY SET COVER
    over border PIXEL MASS (not distinct-colour count): repeatedly take the
    most-frequent still-uncovered colour as a new representative, then mark
    every sampled colour within `tolerance` of it -- and the border pixels
    that colour accounts for -- as covered, until at least
    `BORDER_COLOR_COVERAGE_TARGET` of the frame's own border PIXELS are
    covered (or the representative cap is hit). Every representative anchors
    a classification ball of radius `tolerance`; a pixel qualifies as
    background only by its own distance to the NEAREST representative.

    T-0315 round 2's fix chose representatives by a minimum *separation*
    (>= 2.5x tolerance apart) instead of by coverage. That guarantees the
    accepted set is spread out; it does not guarantee every rejected colour
    ends up within classification range of one of them. Measured on this
    card's own diagnostic frame: 222 of 511 sampled border colours (259 of
    1,532 actual border pixels) sat strictly between 1x and 2.5x tolerance
    from every accepted representative -- too close to survive the
    separation floor as their own representative, but too far to classify as
    background under any survivor. Those pixels never seeded the flood, so
    the background region connected only through them was kept as
    foreground -- a large, detached, background-coloured blob survived
    inside the promoted cutout.

    T-0315 round 3 first tried closing that gap with LITERAL 100% coverage
    (every sampled colour, no exceptions) and found it, measured against the
    same diagnostic frame, actively worse: that frame's figure legitimately
    touches the frame border along most of one edge and the anti-aliased
    transition there is a wide gradual blend, not a thin seam, so its border
    samples span the full Oklab lightness range (33x `tolerance`). Chasing
    literal 100% coverage of that span requires representatives packed
    closely enough across the whole range that some of them end up within
    `tolerance` of genuine, non-border figure colours elsewhere in the frame
    (the coat's own pale hood/shoulder fill sits close, in Oklab space, to
    the pale end of that same blend) -- reproducing this module's original
    hop-to-hop leak defect via absolute distance instead of connectivity, and
    measurably worse than round 2's own bug (48px foreground dropped to
    117px, below even the pre-T-0315 baseline of 351px, with the coat's own
    hood visibly swept into background). Targeting a strong PIXEL-MASS
    majority instead of every last distinct colour closes round 2's actual
    regression -- the dominant true-background tone is always covered within
    the first handful of representatives, since coverage proceeds most-
    frequent-colour-first -- without chasing the rarest, most-blended border
    samples into coverage, which is exactly what caused the sweep."""
    order = np.argsort(-counts)
    ordered_colors = unique_border_colors[order]
    ordered_counts = counts[order]
    total = int(ordered_counts.sum())
    tol2 = tolerance * tolerance
    covered = np.zeros(len(ordered_colors), dtype=bool)
    representatives: list[np.ndarray] = []
    covered_mass = 0
    for i in range(len(ordered_colors)):
        if covered[i]:
            continue
        if covered_mass / total >= BORDER_COLOR_COVERAGE_TARGET:
            break
        if len(representatives) >= _MAX_BORDER_REPRESENTATIVES:
            warnings.warn(
                "border_flood_background_mask: hit the "
                f"{_MAX_BORDER_REPRESENTATIVES}-representative cap on this frame's border "
                f"colours with only {covered_mass / total:.1%} of border pixels covered "
                f"(target {BORDER_COLOR_COVERAGE_TARGET:.0%}) -- classification proceeded, but "
                "the result should be checked visually.",
                UserWarning,
                stacklevel=3,
            )
            break
        color = ordered_colors[i]
        representatives.append(color)
        dist2 = ((ordered_colors - color) ** 2).sum(axis=1)
        newly_covered = (dist2 <= tol2) & ~covered
        covered_mass += int(ordered_counts[newly_covered].sum())
        covered |= newly_covered
    return np.array(representatives)


def border_flood_background_mask(img: Image.Image, tolerance: float) -> np.ndarray:
    """Boolean HxW array, True = background. T-0315: every pixel's own
    qualifying test is its absolute Oklab distance to a small set of sampled
    *true* border colours (a small set of representatives covering at least
    `BORDER_COLOR_COVERAGE_TARGET` of the frame's own border pixels, drawn
    from the colours actually present on the frame's own edge -- see
    `_representative_border_colors`) -- never a hop-to-hop tolerance test
    against whatever neighbour it happened to grow from. Background is still
    exactly the border-connected region of qualifying pixels (a real figure
    that is merely the same shade as the background *somewhere else in the
    frame*, without itself touching the edge through a connected qualifying
    path, must not be swept -- verified against every promoted sheet this
    module already serves, not just asserted).

    The previous implementation (kept in git history, not here) was a
    tolerance-chained ("magic wand, contiguous") BFS: a pixel qualified as
    background if it was within `tolerance` of the *neighbour it grew from*.
    That let a long chain of small hops -- a heavy anti-aliased outline
    stroke -- walk from the true background, through the outline, into a
    figure's interior, even when the *direct* distance from background to
    interior was many times `tolerance` (T-0272 round 5's own diagnosis of
    attempt 28's lost coat colour: `ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s
    "Lever 3" section). Testing every pixel against a small, majority-
    coverage set of border representatives directly, instead of against its
    immediate predecessor or every raw distinct border colour, closes that
    path: a chain of small hops can no longer accumulate into a large total
    displacement, since every step of the walk must independently stay
    within `tolerance` of a *real, dominant* border colour, not merely close
    to the previous step or to a densely-sampled neighbour of one -- and the
    frame's true background tone, being dominant by construction, is
    guaranteed such a representative well before the coverage target is
    reached (`_representative_border_colors`'s own docstring explains why the
    target is a strong majority, not literal 100%: chasing every last,
    rarest, most-blended border sample into coverage reintroduces this same
    leak defect via absolute distance instead of connectivity, on a frame
    whose border spans a wide colour range).

    A smoothly-varying background (a vignette/gradient) is still handled
    without any special-casing: sampling from *every* border pixel, not just
    one seed colour, means a gradient's full value range is already in the
    sample set whenever that range is reached at the frame's own edge (the
    common case -- a vignette darkens toward the corners, which are on the
    border). When that range itself exceeds `tolerance` -- so no single
    small set of representatives can be trusted to capture it without also
    risking a real figure edge -- a `UserWarning` is raised: a loud signal a
    caller or test can observe, rather than a silent guess in either
    direction (T-0315's own "fail loudly rather than silently mis-cutting"
    edge case)."""
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    oklab = _oklab_grid(arr)

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = True
    border[h - 1, :] = True
    border[:, 0] = True
    border[:, w - 1] = True
    unique_border_colors, counts = np.unique(oklab[border], axis=0, return_counts=True)

    if len(unique_border_colors) > 1:
        diffs = unique_border_colors[:, None, :] - unique_border_colors[None, :, :]
        border_spread = float(np.sqrt((diffs**2).sum(axis=-1)).max())
    else:
        border_spread = 0.0
    if border_spread > tolerance:
        warnings.warn(
            "border_flood_background_mask: this frame's own border colours span "
            f"{border_spread / tolerance:.2f}x the classification tolerance "
            f"({tolerance}) -- too wide to trust a small representative set without "
            "risking either a missed background region or a swept figure edge. "
            "Classification proceeded, but the result should be checked visually "
            "(T-0315's 'fail loudly rather than silently mis-cutting' edge case).",
            UserWarning,
            stacklevel=2,
        )

    border_colors = _representative_border_colors(unique_border_colors, counts, tolerance)

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
    to every connected component whose OWN area sits at least
    `MIN_HINT_OVERLAP_FRACTION` inside `keypoints_norm`'s own bbox+margin (a
    real figure often splits into several -- a limb or head separated from
    the torso by a background-coloured outline seam, and ALL of them must
    survive, not just the largest), or (when nothing meets that bar, or when
    no hint is given at all) a looser fallback -- see below. `keypoints_norm`
    is a HINT, never a hard frame: it can never cause a pixel belonging to a
    kept component to be dropped.

    T-0315 round 4: a plain `> 0` overlap test (any overlap at all, however
    small) let a large, genuinely disjoint component survive in full merely
    because a sliver of it grazed the hint -- see `MIN_HINT_OVERLAP_FRACTION`'s
    own docstring for the measured attempt-28 defect this closed. Requiring a
    MAJORITY of the component's own area to overlap still keeps a real
    limb/head that sits mostly inside its own hint, while dropping a decoy
    that sits mostly outside it."""
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
    areas = {lbl: int((labels == lbl).sum()) for lbl in range(1, count + 1)}
    overlaps = {lbl: int(((labels == lbl) & hint).sum()) for lbl in range(1, count + 1)}

    majority_labels = [
        lbl
        for lbl, ov in overlaps.items()
        if areas[lbl] and ov / areas[lbl] >= MIN_HINT_OVERLAP_FRACTION
    ]
    if majority_labels:
        return np.isin(labels, majority_labels)

    overlapping_labels = [lbl for lbl, ov in overlaps.items() if ov > 0]
    if not overlapping_labels:
        # The rendered figure sits entirely outside the hint region (a
        # stacked profile reference pulling the pose off-rig, T-0272 round
        # 3's attempts 13-15) -- fall back to the largest foreground blob
        # rather than reporting "no figure."
        largest_label = max(areas, key=areas.get)
        return labels == largest_label
    # Nothing clears the majority bar, but something grazes the hint at all --
    # keep every component that does, the pre-round-4-fix fallback, rather
    # than reporting "no figure" outright.
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


#: T-0319: the promoted T-0252 idle keyframe's own achieved background --
#: what a genuinely dark background looks like on this pipeline, not an
#: arbitrary "any dark colour". Used as the default fill whenever a frame's
#: own border-connected background region is forced dark rather than trusted
#: to have sampled that way on its own (see `force_border_background_to_fill`
#: below, and its two call sites: `gen_hybrid_walk_T0259.crop_identity_reference`
#: -- the generation-time fix -- and the T-0319 re-cut path, which reprocesses
#: already-sampled frames with no new GPU spend).
DARK_BACKGROUND_FILL = (18, 17, 14)


def force_border_background_to_fill(
    img: Image.Image,
    tolerance: float,
    fill_rgb: tuple[int, int, int] = DARK_BACKGROUND_FILL,
) -> Image.Image:
    """Paint every pixel `border_flood_background_mask` classifies as
    background to `fill_rgb`; every other pixel is byte-identical to `img`.

    T-0319's diagnosis: `gen_hybrid_walk_T0259`'s IP-Adapter identity
    reference (a crop of the committed concept sheet) has its own mid-grey
    panel background (~144,143,145) -- not the black the text prompt asks
    for. IP-Adapter conditions on the whole reference image, background
    included, through a pathway the CLIP text encoder's negative prompt
    (which already names "grey background" explicitly, inherited from the
    idle recipe unchanged) cannot reach -- so the reference's own background
    tone bled into every generated frame regardless of what the prompt said.
    Measured modal border RGB on the affected frames (142-153 range) matches
    the reference crop's own modal border colour almost exactly.

    This function adds no new segmentation logic: it reuses the same
    border-connected Oklab-tolerant flood already proven out (T-0315) as the
    single shared "what is background" detector across this pipeline, so a
    reference image and an already-sampled frame are corrected by the exact
    same rule a fresh generation's own post-cutout step already applies --
    never a second, independently-tuned heuristic that could drift from it.
    """
    mask = border_flood_background_mask(img, tolerance)
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    arr[mask] = fill_rgb
    return Image.fromarray(arr, mode="RGB")


CUTOUT_METHOD_DESCRIPTION = (
    "Per-frame border-connected background classification in Oklab space "
    f"(tolerance={CUTOUT_OKLAB_TOLERANCE}) over that frame's own 384x384 sampled/held image: "
    "every distinct colour on the frame's own border is reduced to a small set of "
    f"representatives via greedy set cover over border pixel mass -- covering at least "
    f"{BORDER_COLOR_COVERAGE_TARGET:.0%} of the frame's own border pixels, most-frequent-colour-"
    "first (T-0315) -- each pixel "
    "qualifies as background by its own absolute Oklab distance to the NEAREST representative "
    "(never by a hop-to-hop tolerance test against whatever neighbour it grew from), and "
    "background is the border-connected region of qualifying pixels -- removes background "
    "clutter connected to the frame edge regardless of how many distinct palette indices it "
    "later quantizes to. The resulting "
    "foreground is reduced to every connected component whose OWN area sits at least "
    f"{MIN_HINT_OVERLAP_FRACTION:.0%} inside a keypoints hint region (T-0315 round 4 -- a plain "
    "'any overlap counts' rule let a large, genuinely disjoint background-panel component "
    "survive in full on a mere sliver of incidental overlap), falling back to every component "
    "with any overlap at all, then to the single largest component, when nothing clears that "
    "majority bar -- a content-aware selection (T-0272 round 4, refined T-0315 round 4) that "
    "supersedes the original hard 'outside this frame's own keypoint bbox is background' clip, "
    "which could zero or clip a real figure whose rendered pose deviates from its own ControlNet "
    "skeleton. "
    "Applied to each frame's own image and downscaled alongside it BEFORE the frames are "
    "assembled into the sheet -- not to the assembled sheet. Character-foreground pixels keep "
    "their quantized palette index; every other pixel is forced to background_index=0."
)
