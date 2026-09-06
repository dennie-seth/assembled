"""RED: `border_flood_background_mask`'s outline-leak defect (T-0315).

T-0272 round 5's own conclusion (`ARM_PROFILE_ATTEMPT_LOG_T0272.md`, "Lever
3" section): the tolerance-chained ("magic wand, contiguous") flood can walk
from the true background, through a heavy anti-aliased black outline, into a
figure's interior, one small hop at a time -- even though the *direct*
Oklab distance from the plain background to the figure's own colour is far
outside `CUTOUT_OKLAB_TOLERANCE`. Attempt 28's own coat-wide olive colour
was lost this way: its outline stroke bridged, hop by hop, all the way into
the coat and split it into disconnected debris.

This module reproduces that failure on a synthetic frame -- concentric
square rings stepping from a plain background colour down through a bold
near-black "outline", then back up into a saturated green "coat" core, each
consecutive ring differing by *less* than `CUTOUT_OKLAB_TOLERANCE` even
though the background-to-coat distance is an order of magnitude larger --
and pins the fix: `border_flood_background_mask` must classify each pixel by
its own absolute Oklab distance to a sampled set of true border colours,
never by connectivity through intermediate hops. `label_foreground_components`
and `extract_foreground_mask`'s component-selection layer above it are
untouched by this change (per the card's own scope) and are exercised here
only to confirm the fix survives that layer too.

Regression coverage (`test_baseline_consumer_fixtures_do_not_regress`)
measures every real consumer fixture's per-cell foreground pixel count
*before* this change (recorded as literal constants below, computed by
running this same `border_flood_background_mask` call against each
committed sheet on the pre-fix code) and asserts the post-fix count is never
lower -- "nothing regressed" as a measured, enforced claim, not an
assertion made by eye.
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from char_gen.cutout import (
    BACKGROUND_MASK_MARGIN_FRAC,
    BORDER_COLOR_COVERAGE_TARGET,
    CUTOUT_OKLAB_TOLERANCE,
    _oklab_grid,
    _representative_border_colors,
    border_flood_background_mask,
    downscale_mask,
    extract_foreground_mask,
    label_foreground_components,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_ENTITY_DIR = REPO_ROOT / "assets" / "final" / "entity"
EVIDENCE_T0272_DIR = REPO_ROOT / "docs" / "assets" / "evidence" / "T-0272"

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_profile_T0272  # noqa: E402

# ── The outline-leak reproduction ────────────────────────────────────────
#
# A hand-built chain of colours, background -> near-black outline -> green
# coat, where every CONSECUTIVE pair is a smaller Oklab hop than
# CUTOUT_OKLAB_TOLERANCE (0.03) but the DIRECT background->coat distance is
# ~12x larger than the tolerance -- verified once, offline, with a greedy
# walk along the straight RGB line between each pair of anchor colours,
# picking the furthest reachable point at each step so every hop is as large
# as possible while still legal, and re-verified here (`test_ramp_is_a_valid_
# reproduction`) rather than only trusted as a comment.
_OUTLINE_LEAK_RAMP: list[tuple[int, int, int]] = [
    (40, 40, 40), (34, 34, 34), (28, 28, 28), (22, 22, 22), (16, 16, 16),
    (11, 11, 11), (6, 6, 6), (3, 3, 3), (2, 2, 2),
    (2, 5, 3), (2, 10, 5), (2, 16, 7), (2, 22, 10), (2, 29, 12), (2, 35, 15),
    (2, 42, 18), (2, 49, 20), (2, 56, 23), (2, 63, 26), (2, 71, 29), (2, 78, 32),
    (2, 86, 35), (2, 94, 38), (2, 101, 41), (2, 109, 44), (2, 117, 47),
    (2, 126, 50), (2, 134, 54), (2, 142, 57), (2, 150, 60),
]
_RING_SIZE = 70


def _oklab_dist(rgb_a: tuple[int, int, int], rgb_b: tuple[int, int, int]) -> float:
    from char_gen.cutout import _srgb_to_oklab

    a = _srgb_to_oklab(np.array([rgb_a], dtype=np.float64))[0]
    b = _srgb_to_oklab(np.array([rgb_b], dtype=np.float64))[0]
    return float(np.linalg.norm(a - b))


def _build_outline_leak_frame() -> tuple[Image.Image, np.ndarray]:
    """Concentric square rings, `_OUTLINE_LEAK_RAMP[0]` at the frame border
    (touching every edge, so the flood's own border seeding reaches it
    exactly as a real frame's background does) shrinking inward through
    every ramp colour, with the last colour filling a solid core -- the
    "coat" a real generation's outline stroke ate into (round 5's own
    diagnosis of attempt 28)."""
    yy, xx = np.mgrid[0:_RING_SIZE, 0:_RING_SIZE]
    layer = np.minimum(np.minimum(yy, xx), np.minimum(_RING_SIZE - 1 - yy, _RING_SIZE - 1 - xx))
    idx = np.minimum(layer, len(_OUTLINE_LEAK_RAMP) - 1)
    arr = np.array(_OUTLINE_LEAK_RAMP, dtype=np.uint8)[idx]
    return Image.fromarray(arr, mode="RGB"), idx == (len(_OUTLINE_LEAK_RAMP) - 1)


def test_ramp_is_a_valid_reproduction() -> None:
    """Sanity-check the fixture itself, not just the function under test:
    every consecutive ramp hop must be smaller than tolerance (so the old
    chained flood *can* walk it end to end), while the direct background-
    to-coat distance must be well outside tolerance (so an absolute-distance
    classifier correctly refuses to connect them)."""
    hops = [
        _oklab_dist(_OUTLINE_LEAK_RAMP[i], _OUTLINE_LEAK_RAMP[i + 1])
        for i in range(len(_OUTLINE_LEAK_RAMP) - 1)
    ]
    assert max(hops) < CUTOUT_OKLAB_TOLERANCE, "every hop must be a legal chained-flood step"
    direct = _oklab_dist(_OUTLINE_LEAK_RAMP[0], _OUTLINE_LEAK_RAMP[-1])
    assert direct > CUTOUT_OKLAB_TOLERANCE * 5, (
        "background must be far from the coat in absolute terms, or this fixture doesn't "
        "reproduce the defect"
    )


def test_outline_leak_no_longer_erases_the_coat_core() -> None:
    """RED (pre-fix): the tolerance-chained flood walks background -> outline
    -> coat one hop at a time and marks the entire frame, including the
    green coat core, as background. GREEN (post-fix): absolute distance to
    the sampled border colours keeps the coat core as foreground, since its
    direct distance from the background is far outside tolerance."""
    img, core_mask = _build_outline_leak_frame()
    assert int(core_mask.sum()) > 0, "sanity: the fixture must have a non-empty coat core"

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    foreground = ~background

    assert np.array_equal(foreground[core_mask], np.ones(int(core_mask.sum()), dtype=bool)), (
        "the coat core must survive as foreground -- an outline whose anti-aliased edge "
        "chains to the background must not be able to erase the interior it encloses"
    )


def test_outline_leak_survives_component_selection_too() -> None:
    """The fix is scoped to `border_flood_background_mask`'s classification
    rule; `extract_foreground_mask`'s component-selection layer above it is
    untouched (per the card's own scope) -- confirm the coat core still
    comes back once that layer runs too, with no keypoints hint (a non-human
    entity has none either)."""
    img, core_mask = _build_outline_leak_frame()
    mask = extract_foreground_mask(img, CUTOUT_OKLAB_TOLERANCE, keypoints_norm=None)
    assert np.array_equal(mask[core_mask], np.ones(int(core_mask.sum()), dtype=bool))


def test_subtle_vignette_background_is_still_all_background() -> None:
    """Edge case: a background that is not perfectly uniform (a subtle
    vignette, corners a little darker than the centre -- the realistic case
    for this pipeline's own "solid flat black background" renders, which are
    never perfectly flat) must still be classified as background in full.
    Sampling from every border pixel (not just one seed colour) means the
    gradient's own value range is already in the sample set whenever that
    range is small enough that a pixel anywhere in the gradient sits within
    absolute tolerance of *some* border sample -- true here since the total
    swing (corner to centre) is well under `CUTOUT_OKLAB_TOLERANCE`."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    # corners (~45px from centre) at 34, centre at 40 -- a swing verified
    # offline (Oklab distance ~0.025) to sit just under the 0.03 tolerance
    value = np.clip(40 - dist * 0.13, 34, 40).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    img = Image.fromarray(arr, mode="RGB")

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    assert background.all(), "a frame that is entirely one subtle gradient has no figure at all"


def test_subtle_vignette_background_does_not_hide_a_real_figure() -> None:
    """Companion to the subtle-vignette test above: a figure whose colour is
    far from every sampled border colour must still be recovered even when
    the background itself is a gentle gradient, not a flat fill."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    value = np.clip(40 - dist * 0.13, 34, 40).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    figure_rect = (24, 24, 40, 40)
    arr[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = (0, 200, 90)
    img = Image.fromarray(arr, mode="RGB")

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    foreground = ~background
    expected = np.zeros((size, size), dtype=bool)
    expected[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = True
    assert np.array_equal(foreground, expected)


def test_wide_range_vignette_fails_loud_rather_than_mis_cutting() -> None:
    """Edge case, the other named alternative: a background whose gradient
    range is too wide to sit within absolute tolerance of anything actually
    sampled at the border cannot be told apart from "a chain of small hops
    into a real figure" by colour alone -- that ambiguity is exactly what
    the old hop-chained algorithm resolved wrong (the outline-leak this card
    fixes). Rather than silently guessing and mis-cutting a real figure the
    way the old algorithm did, the region of a too-wide gradient that is too
    far from anything actually sampled at the border is left classified as
    foreground -- loud, in the sense that it survives as a real, visible
    blob a consumer's own component-count/foreground-floor mechanical gate
    or a human visual check can catch, rather than a silent bad cutout that
    quietly erases real figure pixels the way the pre-fix algorithm did."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    value = np.clip(60 - dist * 0.6, 4, 60).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    img = Image.fromarray(arr, mode="RGB")

    with pytest.warns(UserWarning, match="border colours span"):
        background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    assert not background.all(), (
        "a gradient wide enough that its centre sits far outside absolute tolerance of every "
        "border sample must not be silently swept into background -- that would be exactly "
        "the outline-leak failure mode this card fixes, just via a gradient instead of an "
        "outline stroke"
    )
    assert not background[size // 2, size // 2], (
        "the gradient's own centre (its furthest point from every border sample) must survive "
        "as foreground, not be silently absorbed as background"
    )


def test_narrow_vignette_and_flat_background_do_not_warn() -> None:
    """The loud signal above must actually be loud only for the ambiguous
    case -- a `UserWarning` on every call (flat single-colour borders,
    subtle vignettes whose own border spread stays inside tolerance) would
    train callers and CI logs to ignore it, defeating the point. Both
    companion fixtures above (subtle vignette, and its real-figure variant)
    must raise nothing."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    value = np.clip(40 - dist * 0.13, 34, 40).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    img = Image.fromarray(arr, mode="RGB")

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)

    flat = Image.new("RGB", (size, size), (40, 40, 40))
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        border_flood_background_mask(flat, CUTOUT_OKLAB_TOLERANCE)


# ── Baseline regression: every real consumer fixture, measured before the
# change, must not drop below that count after it ─────────────────────────

# Measured directly against this checkout's committed sheets, on the
# pre-fix `border_flood_background_mask` (tolerance-chained flood), before
# any change in this card -- one row per cell, in raster order. The fix
# must never cause any of these counts to drop.
_BASELINE_FG_PX: dict[str, tuple[Path, int, int, int, list[int]]] = {
    "player_idle_sheet_hybrid_T0252 (T-0252, promoted)": (
        FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png",
        48, 3, 3,
        [474, 456, 474, 455, 474, 456, 474, 455, 474],
    ),
    "player_idle_sheet_chained_T0250 (T-0250, promoted)": (
        FINAL_CHARACTER_DIR / "player_idle_sheet_chained_T0250.png",
        48, 3, 3,
        [271, 281, 281, 279, 280, 281, 282, 279, 282],
    ),
    "watcher_idle_sheet_v1": (
        FINAL_ENTITY_DIR / "watcher_idle_sheet_v1.png", 48, 3, 2,
        [560, 560, 560, 560, 560, 560],
    ),
    "watcher_move_sheet_v1": (
        FINAL_ENTITY_DIR / "watcher_move_sheet_v1.png", 48, 4, 2,
        [560, 560, 560, 560, 560, 560, 560, 560],
    ),
    "watcher_trapped_sheet_v1": (
        FINAL_ENTITY_DIR / "watcher_trapped_sheet_v1.png", 48, 2, 2,
        [560, 560, 560, 560],
    ),
    "sound_idle_sheet_v1": (
        FINAL_ENTITY_DIR / "sound_idle_sheet_v1.png", 48, 3, 2,
        [384, 384, 384, 384, 384, 384],
    ),
    "sound_move_sheet_v1": (
        FINAL_ENTITY_DIR / "sound_move_sheet_v1.png", 48, 4, 2,
        [384, 384, 384, 384, 384, 384, 384, 384],
    ),
    "sound_trapped_sheet_v1": (
        FINAL_ENTITY_DIR / "sound_trapped_sheet_v1.png", 48, 2, 2,
        [384, 384, 384, 384],
    ),
    "still_air_idle_sheet_v1": (
        FINAL_ENTITY_DIR / "still_air_idle_sheet_v1.png", 48, 3, 2,
        [256, 256, 256, 256, 256, 256],
    ),
    "still_air_move_sheet_v1": (
        FINAL_ENTITY_DIR / "still_air_move_sheet_v1.png", 48, 4, 2,
        [256, 256, 256, 256, 256, 256, 256, 256],
    ),
    "still_air_trapped_sheet_v1": (
        FINAL_ENTITY_DIR / "still_air_trapped_sheet_v1.png", 48, 2, 2,
        [256, 256, 256, 256],
    ),
}


@pytest.mark.parametrize("fixture_name", list(_BASELINE_FG_PX))
def test_baseline_consumer_fixtures_do_not_regress(fixture_name: str) -> None:
    path, cell, cols, rows, baseline = _BASELINE_FG_PX[fixture_name]
    if not path.exists():
        pytest.skip(f"fixture not present in this checkout: {path}")
    sheet = Image.open(path).convert("RGB")
    arr = np.array(sheet)
    counts = []
    for r in range(rows):
        for c in range(cols):
            sub = arr[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell]
            cell_img = Image.fromarray(sub, mode="RGB")
            fg = ~border_flood_background_mask(cell_img, CUTOUT_OKLAB_TOLERANCE)
            counts.append(int(fg.sum()))
    assert len(counts) == len(baseline), f"{fixture_name}: expected {len(baseline)} cells"
    for i, (before, after) in enumerate(zip(baseline, counts)):
        assert after >= before, (
            f"{fixture_name} cell {i}: foreground pixel count dropped from {before} to {after} "
            "-- the absolute-distance fix must never lose real foreground pixels a real "
            "consumer fixture already had"
        )


def test_promoted_front_sheet_whole_cell_hint_still_exact() -> None:
    """T-0252's own regression anchor (`test_cutout_T0272.py`'s
    `test_promoted_front_sheet_cells_survive_the_new_selection_whole`) must
    keep holding post-fix too: a whole-cell hint recovers every raw
    foreground pixel exactly, whatever the (possibly larger, post-fix) raw
    count is -- this module's own copy, run against the same fixture, to
    catch a regression in either file independently."""
    path = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
    if not path.exists():
        pytest.skip(f"regression anchor not present in this checkout: {path}")
    sheet = Image.open(path).convert("RGB")
    cell = 48
    arr = np.array(sheet)
    rows, cols = sheet.height // cell, sheet.width // cell
    whole_cell_hint = {0: (0.0, 0.0), 1: (1.0, 1.0)}
    for r in range(rows):
        for c in range(cols):
            sub = arr[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell]
            cell_img = Image.fromarray(sub, mode="RGB")
            raw_foreground = ~border_flood_background_mask(cell_img, CUTOUT_OKLAB_TOLERANCE)
            mask = extract_foreground_mask(
                cell_img, CUTOUT_OKLAB_TOLERANCE, whole_cell_hint, BACKGROUND_MASK_MARGIN_FRAC
            )
            assert int(mask.sum()) == int(raw_foreground.sum())


# ── Raw, un-quantized render regression (T-0315 round 2) ────────────────────
#
# Every fixture in `_BASELINE_FG_PX` above is an already-palette-quantized
# sheet, whose border (measured directly: `git show`-diffed against this
# card's own round-1 review) carries exactly ONE distinct Oklab colour --
# so round 1's "use every distinct border colour" fix was trivially
# equivalent to the true fix on all of them, and none could catch round 1's
# actual defect: on a raw SDXL render, the border can carry hundreds of
# distinct colours (anti-aliasing noise, or -- this frame -- a figure whose
# own black outline genuinely touches the frame edge), and using every one
# of them as an independent classification anchor reproduces the exact
# hop-to-hop bridging defect this module exists to close, just relocated
# from spatial adjacency to the border's own sample list. This fixture
# closes that gap: the actual, committed, hash-verified attempt 28 evidence
# frame (`docs/assets/evidence/T-0272/attempt_28_secondary_reference_colour_lean.png`,
# raw, never quantized), run through the REAL consumer pipeline
# (`extract_foreground_mask` with `gen_hybrid_profile_T0272`'s own profile
# rig keypoints as the hint, then `downscale_mask` to the real final cell
# size) -- exactly what `gen_hybrid_profile_T0272.build_indexed_cell` does.
#
# The count below is the PRE-T-0315 foreground pixel count at 48x48,
# measured by reconstructing the original tolerance-chained BFS flood
# (`git show <the pre-T-0315 commit>:.../cutout.py`'s own
# `border_flood_background_mask`, kept in git history, not duplicated here
# as importable code) against this same frame through the same real
# pipeline: 24,300px raw at 384, 351px after `downscale_mask`. It is kept
# here as documented HISTORY, not as a floor any more -- see the round-4
# note below for why a strictly *higher* count stopped being the right bar.
_ATTEMPT_28_PRE_T0315_FG_PX_48 = 351

#: T-0315 round 4: this project's own real mechanical gate floor
#: (`tests/test_player_profile_hybrid_T0272_gate.py`'s `MIN_FOREGROUND_PIXELS`,
#: duplicated here rather than imported -- a *test* asserting the same
#: numeric floor as the gate it is meant to double-check should not import
#: the gate's own module and risk both changing together silently).
_MIN_FOREGROUND_PIXELS = 50

#: A correct cutout's largest component must be the overwhelming majority of
#: its own surviving foreground -- "character-only," not "character plus a
#: retained background band." See the round-4 note below for the measured
#: history this bar replaces.
_MIN_LARGEST_COMPONENT_SHARE = 0.9


def test_raw_unquantized_render_is_character_only_not_merely_more_pixels() -> None:
    """T-0315 rounds 2 and 3 each chased a HIGHER `small.sum()` on this exact
    frame as the bar to clear -- and each time, reviewer inspection found the
    extra pixels were retained BACKGROUND, not recovered character: round 2
    promoted 529px whose second-largest component (129px, 24%) was a
    disjoint grey-blue panel; round 3 promoted 452px with the same defect
    worse (207px, 46%, across two components). Both passed the OLD version
    of this test (`>= 351`) trivially, because a monotone "more foreground
    survived" bound cannot distinguish genuine recovered detail from a
    spuriously-retained background blob inflating the same count -- exactly
    the property `test_no_surviving_raw_component_is_background_coloured`
    already exists to catch at the RAW (384px) resolution, but that test's
    own "dominant background colour" reference was independently found
    non-discriminating on this frame (it locked onto the frame's single most
    frequent border colour -- a white edge strip -- not the grey-lavender
    interior panel the retained blobs actually matched).

    Round 4's actual root cause, found by tracing the retained blobs back
    through `extract_foreground_mask`'s own component-selection layer rather
    than `border_flood_background_mask`'s colour classification: a large,
    genuinely disjoint background-panel component was being kept in full
    because a mere SLIVER of its own area (698 of 8,427px at 384, 8.3%)
    happened to fall inside the keypoints hint -- see
    `MIN_HINT_OVERLAP_FRACTION`'s own docstring. Fixing that drops this
    frame's own 48px count from round 3's 452px to 249px -- BELOW the
    pre-T-0315 351px baseline documented above -- while the surviving
    foreground is now 98.4% a single component (the genuine figure). A lower
    but overwhelmingly character-only count is the correct outcome; this
    test asserts that property directly instead of a pixel floor that a
    retained background blob satisfies just as well as real detail."""
    path = EVIDENCE_T0272_DIR / "attempt_28_secondary_reference_colour_lean.png"
    if not path.exists():
        pytest.skip(f"evidence frame not present in this checkout: {path}")
    img = Image.open(path).convert("RGB")
    points = pose_rig_profile_T0272.profile_keypoints()

    mask = extract_foreground_mask(
        img, CUTOUT_OKLAB_TOLERANCE, points, BACKGROUND_MASK_MARGIN_FRAC
    )
    small = downscale_mask(mask, 48)
    total = int(small.sum())

    assert total >= _MIN_FOREGROUND_PIXELS, (
        f"attempt 28's own frame: 48px foreground is only {total}px, below this project's own "
        f"{_MIN_FOREGROUND_PIXELS}px mechanical-gate floor -- the cutout likely erased the figure"
    )

    labels, count = label_foreground_components(small)
    assert count > 0
    largest = max(int((labels == lbl).sum()) for lbl in range(1, count + 1))
    share = largest / total
    assert share >= _MIN_LARGEST_COMPONENT_SHARE, (
        f"attempt 28's own frame: the largest surviving 48px component is only {share:.1%} of "
        f"total foreground ({largest}/{total}px), below the {_MIN_LARGEST_COMPONENT_SHARE:.0%} "
        "'character-only' bar -- a retained background blob is inflating the count the same way "
        "rounds 2 and 3's own promotions did"
    )


# ── T-0315 round 3: closing round 2's own reviewer FAIL ─────────────────────
#
# Round 2 chose border representatives by a minimum SEPARATION (>= 2.5x
# tolerance apart). That guarantees the accepted set is spread out; it does
# not guarantee every rejected colour ends up within classification range of
# one of them. On this card's own diagnostic frame, 222 of 511 sampled border
# colours (259 of 1,532 actual border pixels) sat strictly between 1x and
# 2.5x tolerance from every accepted representative -- excluded from
# candidacy by the separation floor, but too far to classify as background
# under any survivor. Those pixels never seeded the flood, so a region of the
# frame's own true background, connected only through them, was retained as
# an erroneous "foreground" component alongside the real character.


def test_representative_border_colors_cover_a_gap_separation_alone_would_miss() -> None:
    """Reproduces round 2's exact failure shape directly on
    `_representative_border_colors`, without needing image I/O: three border
    colours along a line, each step smaller than the OLD 2.5x-tolerance
    separation floor (so colour B would never itself become a representative
    -- A arrives first by frequency and excludes it) but each step also
    LARGER than the classification tolerance (so B is not actually within
    range of A either). Round 2's separation-only rule leaves B uncovered by
    construction; greedy coverage by pixel mass cannot, since it does not
    stop until the coverage target is met."""
    tol = CUTOUT_OKLAB_TOLERANCE
    color_a = np.array([0.5, 0.0, 0.0])
    step = tol * 1.5  # > tol (so not auto-covered by A) but < 2.5x tol (the old separation floor)
    color_b = color_a + np.array([step, 0.0, 0.0])
    color_c = color_b + np.array([step, 0.0, 0.0])
    colors = np.array([color_a, color_b, color_c])
    counts = np.array([100, 50, 10])  # frequency-descending, matching real border sampling

    reps = _representative_border_colors(colors, counts, tol)

    min_dist_to_rep = np.array(
        [min(float(np.linalg.norm(c - r)) for r in reps) for c in colors]
    )
    assert (min_dist_to_rep <= tol).all(), (
        "every sampled border colour must end up within tolerance of some representative -- "
        f"got distances {min_dist_to_rep.tolist()} against tolerance {tol} (representatives: "
        f"{reps.tolist()})"
    )


def test_border_coverage_meets_its_own_target_on_the_real_diagnostic_frame() -> None:
    """The property round 2's reviewer actually asked for -- most of a
    frame's own border pixels classify as background -- reframed as a
    measured majority (`BORDER_COLOR_COVERAGE_TARGET`) rather than literal
    100%: chasing every last, most-blended border sample into coverage was
    measured (see `_representative_border_colors`'s own docstring) to sweep
    genuine figure colour on this exact frame instead. This asserts the
    guarantee actually holds at the PIXEL level (not just the internal
    colour-mass bookkeeping) on the raw, un-quantized, wide-border-spread
    frame this card's own regression targets."""
    path = EVIDENCE_T0272_DIR / "attempt_28_secondary_reference_colour_lean.png"
    if not path.exists():
        pytest.skip(f"evidence frame not present in this checkout: {path}")
    img = Image.open(path).convert("RGB")
    arr = np.array(img)
    h, w = arr.shape[:2]

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = True
    border[h - 1, :] = True
    border[:, 0] = True
    border[:, w - 1] = True
    border_background_fraction = float(background[border].mean())

    assert border_background_fraction >= BORDER_COLOR_COVERAGE_TARGET - 1e-9, (
        f"only {border_background_fraction:.1%} of this frame's own border pixels classified "
        f"as background, below the {BORDER_COLOR_COVERAGE_TARGET:.0%} coverage target -- a "
        "regression of the T-0315 round 2 FAIL this fix exists to close"
    )


def test_no_surviving_raw_component_is_background_coloured() -> None:
    """The property that actually distinguishes T-0315 round 2's FAIL from a
    correct fix: not "more total foreground pixels survived" (a spurious
    background-coloured blob inflates that count exactly as well as genuine
    recovered character detail does -- `test_raw_unquantized_render_does_not_regress_below_pre_fix`
    above cannot tell the two apart), but "every surviving component is
    actually character-coloured." A component retained as foreground only
    because a border-colour coverage gap broke its flood connection back to
    the border (round 2's own bug) would, by construction, have a mean
    colour close to the frame's own dominant border/background colour --
    this checks every surviving raw (pre component-selection) blob above a
    small noise floor sits meaningfully farther from that colour than
    classification tolerance."""
    path = EVIDENCE_T0272_DIR / "attempt_28_secondary_reference_colour_lean.png"
    if not path.exists():
        pytest.skip(f"evidence frame not present in this checkout: {path}")
    img = Image.open(path).convert("RGB")
    arr = np.array(img)
    h, w = arr.shape[:2]
    oklab = _oklab_grid(arr)

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = True
    border[h - 1, :] = True
    border[:, 0] = True
    border[:, w - 1] = True
    unique_border_colors, counts = np.unique(oklab[border], axis=0, return_counts=True)
    dominant_background = unique_border_colors[np.argmax(counts)]

    points = pose_rig_profile_T0272.profile_keypoints()
    mask = extract_foreground_mask(
        img, CUTOUT_OKLAB_TOLERANCE, points, BACKGROUND_MASK_MARGIN_FRAC
    )
    labels, count = label_foreground_components(mask)

    min_component_size = 5  # ignore single/few-pixel anti-aliasing noise specks
    min_safe_multiple = 2.0  # a genuinely background-coloured blob sits within ~1x tolerance
    for label in range(1, count + 1):
        component = labels == label
        size = int(component.sum())
        if size < min_component_size:
            continue
        mean_color = oklab[component].mean(axis=0)
        distance = float(np.linalg.norm(mean_color - dominant_background))
        assert distance > min_safe_multiple * CUTOUT_OKLAB_TOLERANCE, (
            f"component {label} ({size}px): mean colour is only {distance:.4f} from this "
            f"frame's own dominant border colour ({min_safe_multiple}x tolerance = "
            f"{min_safe_multiple * CUTOUT_OKLAB_TOLERANCE:.4f}) -- likely a background-coloured "
            "blob retained as foreground by a border-colour coverage gap (T-0315 round 2's own "
            "FAIL), not genuine character content"
        )
