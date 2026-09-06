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

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from char_gen.cutout import (
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_OKLAB_TOLERANCE,
    border_flood_background_mask,
    extract_foreground_mask,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_ENTITY_DIR = REPO_ROOT / "assets" / "final" / "entity"

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


def test_background_only_gradient_is_still_all_background() -> None:
    """Edge case: a background that is not uniform (a smooth vignette/
    gradient) must still be classified as background in full -- sampling
    from every border pixel (not just one seed colour) means the gradient's
    whole value range is already present in the sample set, since the
    gradient reaches its extremes at the frame's own edges."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    # a radial vignette: bright centre fading to a darker edge, entirely
    # within a single smooth gradient -- no separate figure at all
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    value = np.clip(60 - dist * 0.6, 4, 60).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    img = Image.fromarray(arr, mode="RGB")

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    assert background.all(), "a frame that is entirely one smooth gradient has no figure at all"


def test_gradient_background_does_not_hide_a_real_figure() -> None:
    """Companion to the gradient test above: a figure whose colour is far
    from every sampled border colour must still be recovered even when the
    background itself is a gradient, not a flat fill."""
    size = 64
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
    value = np.clip(60 - dist * 0.6, 4, 60).astype(np.uint8)
    arr = np.stack([value, value, value], axis=-1)
    figure_rect = (24, 24, 40, 40)
    arr[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = (0, 200, 90)
    img = Image.fromarray(arr, mode="RGB")

    background = border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    foreground = ~background
    expected = np.zeros((size, size), dtype=bool)
    expected[figure_rect[1] : figure_rect[3], figure_rect[0] : figure_rect[2]] = True
    assert np.array_equal(foreground, expected)


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
