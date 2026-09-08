"""RED: `border_flood_background_mask`'s outline/border colour-collision
defect (T-0259 sessions 6-8), and why the fix is an explicit opt-in.

Distinct from T-0315's own fix (`test_cutout_absolute_background_distance_
T0315.py`): T-0315 replaced hop-to-hop tolerance chaining with absolute
Oklab distance to a set of sampled border representatives, closing a leak
where a long chain of small colour steps could walk arbitrarily far from
the true background. That fix is correct and unaffected here -- this module
covers a different failure the absolute-distance classifier does not, by
itself, protect against: a raw generated frame's own outline strokes or
highlight linework can sit *genuinely* within `CUTOUT_OKLAB_TOLERANCE` of a
sampled border colour (both near-black, or both near-white, by real colour
coincidence, not a chained artifact) -- and because that linework forms a
single connected network running through the whole silhouette, ONE contact
point between the network and the border-connected background is enough for
`border_flood_background_mask`'s BFS to sweep the network's full length,
even though the network is a hairline conduit and the true background
region it borders is not. Measured directly against T-0259's own cached
diagnostic frames (`ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md`, 2026-09-08
session 6): frame 0 of `attempt_7` retained only 19.3% foreground against a
complete, fully-rendered figure.

Fix: morphological OPENING (erode, then dilate, by the same small amount) on
the qualifying set before the border-seeded flood, gated behind a new
`sever_thin_conduits` parameter that defaults OFF. Geodesic reconstruction
(dilating the eroded marker back into the *original*, un-eroded mask) was
tried first and rejected: it simply re-floods straight back through the same
thin bridge, leaving the background fraction on this card's own diagnostic
frames unchanged to three decimal places across erosion depths 1-6 --
opening (dilating only the *eroded* result) is the operation that actually
severs a bridge rather than restoring it.

Why OFF by default, not a blanket fix: measured directly against
`player_idle_sheet_hybrid_T0252.png`'s own cell (0,0) -- an already-cutout,
already-quantized 48px cell, not a raw generated frame -- turning severance
on UNCONDITIONALLY grew that cell's foreground from 474px to 576px. That
cell has no hairline colour-collision conduit left to sever; what actually
happened is a genuine background enclave (a gap between a limb and the
torso) got absorbed into foreground, because at 48px-cell scale a real
enclave and a defect conduit are both only 1-3 raw pixels wide -- the same
absolute erosion depth that only ever touches a defect on a ~384px raw
frame cannot tell them apart at this scale. Making severance an explicit
opt-in (default `False`, preserving every existing caller's exact behaviour)
avoids conflating the two: only `gen_hybrid_walk_T0259`'s own raw-frame
cutout call opts in.
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
    cutout_foreground_mask,
    extract_foreground_mask,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
IDLE_ANCHOR_PATH = (
    REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_hybrid_T0252.png"
)

SIZE = 64
BG = (10, 10, 10)
# Within CUTOUT_OKLAB_TOLERANCE of BG by real colour coincidence -- a coat
# seam / outline stroke, not a chained hop.
SEAM = (15, 15, 12)
FIGURE = (0, 180, 90)  # far from BG/SEAM in Oklab


def _figure_with_colour_colliding_seam() -> tuple[Image.Image, int]:
    """A solid figure block, not touching the frame border, split down the
    middle by a 1px vertical seam whose colour collides with the frame's
    own border tolerance class. Returns (image, true_figure_area_incl_seam).
    """
    x0, y0, x1, y1 = 8, 8, 56, 56
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = BG
    arr[y0:y1, x0:x1] = FIGURE
    seam_x = (x0 + x1) // 2
    arr[y0:y1, seam_x : seam_x + 1] = SEAM
    return Image.fromarray(arr, mode="RGB"), (x1 - x0) * (y1 - y0)


def test_default_behaviour_still_loses_the_seam_to_background() -> None:
    """Documents the opt-in: with `sever_thin_conduits` at its default
    (`False`), the pre-existing behaviour every other caller relies on is
    completely unchanged -- the seam (and only the seam) is still swept."""
    img, true_area = _figure_with_colour_colliding_seam()
    mask = ~border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE)
    assert int(mask.sum()) == true_area - (56 - 8), (
        "default behaviour must be byte-for-byte unchanged: the seam's own column "
        "(48px) is swept, nothing more and nothing less"
    )


def test_thin_colour_colliding_seam_does_not_fragment_the_figure_when_severed() -> None:
    """The core fix, opted into: a seam only 1px wide, whose colour happens
    to collide with the border/background tolerance class, must not sweep
    any of the figure's own interior away once `sever_thin_conduits=True`.
    Before the fix, this frame lost exactly the seam's own area from both
    sides; after, the seam itself is recovered too, since it can no longer
    serve as a border-to-interior conduit at all."""
    img, true_area = _figure_with_colour_colliding_seam()
    mask = ~border_flood_background_mask(img, CUTOUT_OKLAB_TOLERANCE, sever_thin_conduits=True)
    assert int(mask.sum()) == true_area, (
        f"expected the full figure ({true_area}px, seam included) to survive as foreground "
        f"once the seam can no longer bridge to the border; got {int(mask.sum())}px -- a "
        "colour-colliding outline/seam is sweeping real figure content"
    )


def test_thin_seam_does_not_split_the_figure_into_separate_components_when_severed() -> None:
    """Even where `extract_foreground_mask`'s hint-overlap fallback would
    eventually recover a stray small island, the figure must not be reported
    as more than one component in the first place -- a seam collision must
    not fragment a single contiguous figure at all, with severance opted in."""
    img, _ = _figure_with_colour_colliding_seam()
    hint = {0: (0.0, 0.0), 1: (1.0, 1.0)}
    mask = extract_foreground_mask(
        img, CUTOUT_OKLAB_TOLERANCE, hint, BACKGROUND_MASK_MARGIN_FRAC, sever_thin_conduits=True
    )
    # A single contiguous figure region: every foreground row between y=8..55
    # must be one unbroken run (no seam-shaped gap down the middle).
    for y in range(8, 56):
        row = mask[y, 8:56]
        (indices,) = np.nonzero(row)
        assert indices.size > 0
        assert indices.max() - indices.min() + 1 == indices.size, (
            f"row {y}: figure foreground is not contiguous -- the seam split it into "
            "disconnected pieces"
        )


def test_wide_background_intrusion_still_classified_as_background_when_severed() -> None:
    """Guard against over-correction: a genuinely wide (20px-deep) true
    background region reaching in from one edge -- nothing like a hairline
    conduit -- must remain overwhelmingly classified as background with
    severance opted in. Morphological opening trims a little at the
    boundary (a known, accepted cost of severing thin bridges) but must not
    flip a wide region to foreground."""
    img, _ = _figure_with_colour_colliding_seam()
    arr = np.array(img)
    arr[0:20, :] = BG
    wide_bg_img = Image.fromarray(arr, mode="RGB")
    mask = ~border_flood_background_mask(
        wide_bg_img, CUTOUT_OKLAB_TOLERANCE, sever_thin_conduits=True
    )
    # None of the wide intrusion strip itself should read as foreground.
    assert int(mask[0:18, :].sum()) == 0, (
        "a wide true-background intrusion must not be reclassified as foreground by the "
        "thin-conduit fix"
    )


def _wide_background_room_behind_a_narrow_neck() -> tuple[Image.Image, tuple[int, int, int, int]]:
    """A real background room -- a wide 20x20 block, not touching the frame
    border at all -- reachable from the border ONLY through a 1px-wide
    corridor (the same absolute width as a colour-collision outline
    conduit). A separate, unrelated figure block sits elsewhere, touching
    neither the corridor nor the room, so it can never influence either
    region's classification. Returns (image, (y0, y1, x0, x1) of the room).
    """
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = (150, 60, 200)  # an inert filler colour, far from BG and FIGURE
    arr[0, :] = BG
    arr[SIZE - 1, :] = BG
    arr[:, 0] = BG
    arr[:, SIZE - 1] = BG
    # 1px-wide corridor from the top border down to the room.
    arr[1:20, 30] = BG
    # The room itself: a genuinely wide 20x20 block, not touching any edge.
    room = (20, 40, 20, 40)  # y0, y1, x0, x1
    arr[room[0] : room[1], room[2] : room[3]] = BG
    # An unrelated figure, nowhere near the corridor or the room.
    arr[45:60, 45:60] = FIGURE
    return Image.fromarray(arr, mode="RGB"), room


def test_wide_room_behind_a_narrow_neck_stays_background_when_severed() -> None:
    """The over-severance defect this session fixes (T-0259 session 9,
    found by the reviewer measuring `attempt_5/frame_4_main_384.png`'s own
    cell (1,0): a 39,327px wide background panel, spanning nearly the full
    frame and surviving 5 erosion iterations, was wrongly flipped to
    foreground once its only connecting neck -- exactly as thin as a real
    colour-collision conduit -- was opened away). Opening correctly severs a
    genuine hairline conduit (see the seam tests above), but severing must
    not also disconnect a real, wide background region from the border seed
    merely because its OWN path back to the border happens to be narrow too.
    A component that survives the opening AND was already reachable from
    the border via the *original*, un-opened qualifying set must be
    re-admitted to background, not left orphaned as a false foreground
    island."""
    img, (y0, y1, x0, x1) = _wide_background_room_behind_a_narrow_neck()
    foreground = ~border_flood_background_mask(
        img, CUTOUT_OKLAB_TOLERANCE, sever_thin_conduits=True
    )
    room_foreground = int(foreground[y0:y1, x0:x1].sum())
    assert room_foreground == 0, (
        f"the wide room behind the narrow neck must stay classified as background once "
        f"the neck is severed, not become {room_foreground}px of false foreground -- "
        "severing a thin conduit must not also orphan a real, wide background region"
    )
    # The corridor's own severed conduit pixels are still correctly excluded
    # from background (unchanged from the seam tests): only the room itself
    # is re-admitted, not blanket-restored connectivity through the neck.
    figure_foreground = int(foreground[45:60, 45:60].sum())
    assert figure_foreground == 15 * 15, "the unrelated figure block must be untouched"


def test_legacy_alias_defaults_to_unsevered_and_accepts_the_new_keyword() -> None:
    """`cutout_foreground_mask` (the name every real generator calls) must
    keep its existing 4-positional-argument call sites working unchanged,
    while still accepting the new keyword for the one caller that opts in."""
    img, true_area = _figure_with_colour_colliding_seam()
    hint = {0: (0.0, 0.0), 1: (1.0, 1.0)}
    default_mask = cutout_foreground_mask(img, hint, CUTOUT_OKLAB_TOLERANCE, 0.0)
    severed_mask = cutout_foreground_mask(
        img, hint, CUTOUT_OKLAB_TOLERANCE, 0.0, sever_thin_conduits=True
    )
    assert int(default_mask.sum()) < int(severed_mask.sum()) == true_area


def test_promoted_idle_sheet_cells_are_unaffected_by_the_new_parameter() -> None:
    """Regression anchor: the already-promoted T-0252 front sheet's own
    generator never opts in, so its cells must keep recovering exactly what
    `test_cutout_T0272.test_promoted_front_sheet_cells_survive_the_new_
    selection_whole` already proves -- the new parameter must not change a
    single pixel for a caller that never asked for it."""
    if not IDLE_ANCHOR_PATH.exists():
        pytest.skip(f"regression anchor not present in this checkout: {IDLE_ANCHOR_PATH}")
    sheet = Image.open(IDLE_ANCHOR_PATH).convert("RGB")
    cell = 48
    arr = np.array(sheet)
    rows, cols = sheet.height // cell, sheet.width // cell
    whole_cell_hint = {0: (0.0, 0.0), 1: (1.0, 1.0)}
    checked_cells = 0
    for r in range(rows):
        for c in range(cols):
            sub = arr[r * cell : (r + 1) * cell, c * cell : (c + 1) * cell]
            cell_img = Image.fromarray(sub, mode="RGB")
            raw_foreground = ~border_flood_background_mask(cell_img, CUTOUT_OKLAB_TOLERANCE)
            mask = extract_foreground_mask(
                cell_img, CUTOUT_OKLAB_TOLERANCE, whole_cell_hint, BACKGROUND_MASK_MARGIN_FRAC
            )
            assert int(mask.sum()) == int(raw_foreground.sum()), (
                f"cell ({r},{c}): a whole-cell hint must still recover every foreground "
                "component in full -- unchanged from test_cutout_T0272's own anchor"
            )
            checked_cells += 1
    assert checked_cells == 9, (
        f"expected the known 3x3 T-0252 sheet layout, found {checked_cells} cells"
    )
