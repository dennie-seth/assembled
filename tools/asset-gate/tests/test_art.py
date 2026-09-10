import numpy as np
import pytest

from asset_gate.art import (
    check_atlas_determinism,
    check_background_growth,
    check_cell_fit,
    check_frame_consistency,
    check_identity_stability,
    check_indexed_preservation,
    check_orphan_pixels,
    check_pose_fidelity,
    check_tile_seamlessness,
    check_transition_adjacency,
    count_pixel_deltas,
    render_rig_silhouette,
    slice_sheet_frames,
)
from conftest import TEST_PALETTE_HEX, make_indexed_image


def test_tile_seamlessness_passes_for_seamless_tile(seamless_tile):
    result = check_tile_seamlessness(seamless_tile)
    assert result.passed


def test_tile_seamlessness_fails_for_broken_tile(unseamless_tile):
    result = check_tile_seamlessness(unseamless_tile)
    assert not result.passed
    assert result.details["col_mismatch"] == 1


def test_transition_adjacency_passes_when_shared_edge_matches():
    a = make_indexed_image(np.array([[1, 2], [1, 2]], dtype=np.uint8), TEST_PALETTE_HEX)
    b = make_indexed_image(np.array([[2, 3], [2, 3]], dtype=np.uint8), TEST_PALETTE_HEX)
    result = check_transition_adjacency(a, b, edge="horizontal")
    assert result.passed


def test_transition_adjacency_fails_when_shared_edge_mismatches():
    a = make_indexed_image(np.array([[1, 2], [1, 2]], dtype=np.uint8), TEST_PALETTE_HEX)
    b = make_indexed_image(np.array([[3, 3], [3, 3]], dtype=np.uint8), TEST_PALETTE_HEX)
    result = check_transition_adjacency(a, b, edge="horizontal")
    assert not result.passed
    assert result.details["mismatch"] == 2


def test_transition_adjacency_vertical_edge():
    a = make_indexed_image(np.array([[1, 1], [2, 2]], dtype=np.uint8), TEST_PALETTE_HEX)
    b = make_indexed_image(np.array([[2, 2], [3, 3]], dtype=np.uint8), TEST_PALETTE_HEX)
    result = check_transition_adjacency(a, b, edge="vertical")
    assert result.passed


def test_cell_fit_passes_when_content_stays_inside_cell():
    # 2x2 grid of 4x4 cells; put foreground only in the center 2x2 of each cell.
    arr = np.zeros((8, 8), dtype=np.uint8)
    for row in range(2):
        for col in range(2):
            y0, x0 = row * 4, col * 4
            arr[y0 + 1 : y0 + 3, x0 + 1 : x0 + 3] = 1
    sheet = make_indexed_image(arr, TEST_PALETTE_HEX)
    results = check_cell_fit(sheet, cell_width=4, cell_height=4, cols=2, rows=2)
    assert all(r.passed for r in results)


def test_cell_fit_fails_when_content_bleeds_into_neighbour():
    arr = np.zeros((8, 8), dtype=np.uint8)
    # top-left cell (0,0): put foreground on its right edge (col 3) -> bleeds toward (0,1)
    arr[0:4, 3] = 1
    sheet = make_indexed_image(arr, TEST_PALETTE_HEX)
    results = check_cell_fit(sheet, cell_width=4, cell_height=4, cols=2, rows=2)
    failing = [r for r in results if not r.passed]
    assert len(failing) == 1
    assert failing[0].details["cell"] == (0, 0)
    assert "right" in failing[0].details["violations"]


def test_orphan_pixels_flags_isolated_blob_below_threshold():
    arr = np.zeros((10, 10), dtype=np.uint8)
    arr[2:6, 2:6] = 1  # a real 4x4 blob, size 16
    arr[8, 8] = 1  # isolated single pixel
    image = make_indexed_image(arr, TEST_PALETTE_HEX)
    result = check_orphan_pixels(image, background_index=0, size_threshold=2)
    assert not result.passed
    assert len(result.details["orphans"]) == 1


def test_orphan_pixels_passes_when_no_small_blobs():
    arr = np.zeros((10, 10), dtype=np.uint8)
    arr[2:6, 2:6] = 1
    image = make_indexed_image(arr, TEST_PALETTE_HEX)
    result = check_orphan_pixels(image, background_index=0, size_threshold=2)
    assert result.passed


def test_frame_consistency_passes_within_bound():
    a = np.zeros((10, 10), dtype=np.uint8)
    a[2:8, 2:8] = 1
    b = a.copy()
    b[2, 2] = 0  # one pixel drift
    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)
    result = check_frame_consistency(frame_a, frame_b, background_index=0, max_delta_ratio=0.1)
    assert result.passed


def test_frame_consistency_fails_beyond_bound():
    a = np.zeros((10, 10), dtype=np.uint8)
    a[2:8, 2:8] = 1
    b = np.zeros((10, 10), dtype=np.uint8)  # silhouette gone entirely -> identity drift
    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)
    result = check_frame_consistency(frame_a, frame_b, background_index=0, max_delta_ratio=0.1)
    assert not result.passed


def test_background_growth_passes_when_stable():
    """T-0250 HANDOFF §24-c human review: non-background pixel count
    fluctuating frame to frame (pose-driven, no trend) must pass -- this is
    the T-0249 baseline shape (421-566px, ratio 566/421 ~= 1.34)."""
    counts = [10, 11, 9, 10, 13, 9, 10, 11, 9]
    frames = [
        make_indexed_image(np.array([[1] * c + [0] * (20 - c)], dtype=np.uint8), TEST_PALETTE_HEX)
        for c in counts
    ]
    result = check_background_growth(frames, background_index=0, max_growth_ratio=1.35)
    assert result.passed


def test_background_growth_fails_when_accumulating():
    """The failure this check exists to catch: each frame's non-background
    pixel count grows past frame 0's by more than max_growth_ratio -- img2img
    chaining feeding a frame's own noise into the next frame's init image
    (T-0250 promoted attempt 6: 1024px -> 1472px, ratio ~1.44), invisible to
    check_frame_consistency (which measures inter-frame delta, not absolute
    growth against a fixed baseline)."""
    counts = [10, 10, 12, 13, 14, 15, 16, 17, 18]  # baseline 10, ends at 1.8x
    frames = [
        make_indexed_image(np.array([[1] * c + [0] * (20 - c)], dtype=np.uint8), TEST_PALETTE_HEX)
        for c in counts
    ]
    result = check_background_growth(frames, background_index=0, max_growth_ratio=1.35)
    assert not result.passed
    assert result.details["baseline"] == 10


def test_atlas_determinism_passes_for_deterministic_packer():
    from PIL import Image

    imgs = [
        make_indexed_image(np.full((2, 2), i, dtype=np.uint8), TEST_PALETTE_HEX) for i in (1, 2)
    ]

    def pack(images):
        widths = [im.width for im in images]
        out = Image.new("P", (sum(widths), 2))
        out.putpalette(images[0].getpalette())
        x = 0
        for im in images:
            out.paste(im, (x, 0))
            x += im.width
        return out

    result = check_atlas_determinism(pack, imgs)
    assert result.passed


def test_atlas_determinism_fails_for_nondeterministic_packer():
    from PIL import Image

    imgs = [make_indexed_image(np.full((2, 2), 1, dtype=np.uint8), TEST_PALETTE_HEX)]

    _call_count = [0]

    def pack(images):
        # Non-deterministic: increments a counter each call so the pixel value
        # is guaranteed to differ between runs (avoids the 25% collision rate
        # that `random.randint(...) % 4` produces, making the test flaky).
        _call_count[0] += 1
        out = Image.new("P", (2, 2))
        out.putpalette(images[0].getpalette())
        out.info["nonce"] = _call_count[0]
        return out

    def produce_bytes():
        import io

        img = pack(imgs)
        buf = io.BytesIO()
        # PNG doesn't serialize `info`, so inject the nonce into a pixel to
        # make the non-determinism actually show up in the bytes.
        img.putpixel((0, 0), img.info["nonce"] % 4)
        img.save(buf, format="PNG")
        return buf.getvalue()

    from asset_gate.determinism import check_reproducible

    result = check_reproducible("atlas_determinism", produce_bytes)
    assert not result.passed


def test_indexed_preservation_passes_for_matching_indexed_image(test_palette):
    image = make_indexed_image(np.zeros((2, 2), dtype=np.uint8), TEST_PALETTE_HEX)
    result = check_indexed_preservation(image, test_palette)
    assert result.passed


def test_indexed_preservation_fails_when_converted_to_rgb(test_palette):
    image = make_indexed_image(np.zeros((2, 2), dtype=np.uint8), TEST_PALETTE_HEX)
    rgb_image = image.convert("RGB")
    result = check_indexed_preservation(rgb_image, test_palette)
    assert not result.passed
    assert result.details["mode"] == "RGB"


def test_indexed_preservation_fails_when_palette_drifted(test_palette):
    drifted = dict(TEST_PALETTE_HEX)
    drifted[1] = "#abcdef"
    image = make_indexed_image(np.zeros((2, 2), dtype=np.uint8), drifted)
    result = check_indexed_preservation(image, test_palette)
    assert not result.passed
    assert 1 in result.details["mismatched"]


# ---- render_rig_silhouette / check_pose_fidelity / check_identity_stability (T-0340) ----
#
# Replaces whole-silhouette XOR/union (check_frame_consistency) for the
# locomotion/transition/loop motion classes -- see asset_gate.character's
# T-0340 module note for the full rationale. Two independent measures:
# pose fidelity (does the render match what the rig actually commanded for
# THIS frame, not how much the previous frame differed) and identity
# stability (does the torso's own colour stay put frame to frame,
# independent of how far the limbs swing).


def test_render_rig_silhouette_covers_limb_and_leaves_far_corners_clear():
    silhouette = render_rig_silhouette(size=20, limbs=[((2, 10), (17, 10))], radius=2)
    assert silhouette.shape == (20, 20)
    assert silhouette.dtype == np.bool_
    assert silhouette[10, 10]  # midpoint of the limb
    assert not silhouette[0, 0]  # far corner, well clear of the capsule
    assert not silhouette[19, 19]


def test_pose_fidelity_passes_when_render_matches_the_commanded_pose():
    silhouette = render_rig_silhouette(size=20, limbs=[((2, 10), (17, 10))], radius=3)
    frame = make_indexed_image(silhouette.astype(np.uint8), TEST_PALETTE_HEX)
    result = check_pose_fidelity(frame, silhouette, background_index=0, min_iou=0.7)
    assert result.passed
    assert result.details["iou"] == 1.0


def test_pose_fidelity_fails_when_render_barely_shows_the_commanded_motion():
    """The pathology DL-26's calibration trail already measured (T-0259
    attempt 4, `_T0259_ATTEMPT_4_IDLE_LIKE` in test_character_gate.py):
    the rig commands a real stride but the render barely moves at all.
    check_frame_consistency cannot see this (there's nothing to compare it
    to except the previous frame's own equally-timid render); comparing
    against the rig's own predicted silhouette can."""
    predicted = render_rig_silhouette(size=20, limbs=[((2, 10), (17, 10))], radius=3)
    barely_moved = np.zeros_like(predicted)
    barely_moved[1:4, 1:4] = True  # a tiny stub nowhere near the commanded limb
    frame = make_indexed_image(barely_moved.astype(np.uint8), TEST_PALETTE_HEX)
    result = check_pose_fidelity(frame, predicted, background_index=0, min_iou=0.7)
    assert not result.passed
    assert result.details["iou"] < 0.7


def test_pose_fidelity_reason_reports_the_measured_iou():
    predicted = render_rig_silhouette(size=10, limbs=[((1, 5), (8, 5))], radius=1)
    frame = make_indexed_image(predicted.astype(np.uint8), TEST_PALETTE_HEX)
    result = check_pose_fidelity(frame, predicted, background_index=0, min_iou=0.7)
    assert "1.0000" in result.reason


def test_pose_fidelity_invariant_to_the_rigs_own_pose_change_between_frames():
    """The property that actually justifies replacing check_frame_consistency
    for locomotion (T-0340): two rig-predicted poses that differ hugely from
    each other -- perfect pose, zero drift -- fail check_frame_consistency's
    whole-silhouette delta almost by construction, even though nothing is
    wrong (docs/decision-log.md's capsule measurement: 0.23-0.49 of the old
    0.50 cap consumed by legitimate motion alone). check_pose_fidelity
    compares each frame to ITS OWN commanded pose, so it is indifferent to
    how far the pose itself swings between frames."""
    limb_a = render_rig_silhouette(size=30, limbs=[((5, 15), (14, 15))], radius=3)
    limb_b = render_rig_silhouette(size=30, limbs=[((16, 15), (25, 15))], radius=3)

    old_gate = check_frame_consistency(
        make_indexed_image(limb_a.astype(np.uint8), TEST_PALETTE_HEX),
        make_indexed_image(limb_b.astype(np.uint8), TEST_PALETTE_HEX),
        background_index=0,
        max_delta_ratio=0.50,
    )
    assert not old_gate.passed  # the exact pathology: perfect pose, zero drift, still fails

    frame_a = make_indexed_image(limb_a.astype(np.uint8), TEST_PALETTE_HEX)
    frame_b = make_indexed_image(limb_b.astype(np.uint8), TEST_PALETTE_HEX)
    fidelity_a = check_pose_fidelity(frame_a, limb_a, background_index=0, min_iou=0.7)
    fidelity_b = check_pose_fidelity(frame_b, limb_b, background_index=0, min_iou=0.7)
    assert fidelity_a.passed
    assert fidelity_b.passed


def test_identity_stability_passes_when_torso_colour_is_stable():
    a = np.zeros((20, 20), dtype=np.uint8)
    a[8:12, 8:12] = 1
    b = a.copy()
    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)
    result = check_identity_stability(
        frame_a, frame_b, background_index=0, region=(8, 8, 12, 12), max_histogram_distance=0.15
    )
    assert result.passed
    assert result.details["distance"] == 0.0


def test_identity_stability_fails_when_torso_colour_drifts():
    a = np.zeros((20, 20), dtype=np.uint8)
    a[8:12, 8:12] = 1
    b = a.copy()
    b[8:10, 8:12] = 0  # half the torso box fades to background between frames
    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)
    result = check_identity_stability(
        frame_a, frame_b, background_index=0, region=(8, 8, 12, 12), max_histogram_distance=0.15
    )
    assert not result.passed
    assert result.details["distance"] > 0.15


def test_identity_stability_catches_drift_that_frame_consistency_missed():
    """T-0340's whole reason for existing: the review corroborated that
    session 13's sequential-chained walk candidate scored a deceptively low
    whole-silhouette delta ratio and passed the old gate outright, because
    colour drift was shrinking the silhouette rather than a real gait
    moving it. Reproduced here at small scale (the real attempt is a
    gitignored `assets/out/` generation artifact, not present in this
    checkout): an 8px torso fade is under 3% of a 280px whole-frame
    silhouette -- comfortably inside even the old MOTION_FRAME_DELTA_CAP --
    but it is exactly the failure this gate exists to catch."""
    a = np.zeros((20, 20), dtype=np.uint8)
    a[0:14, 0:20] = 1  # 280px silhouette -- most of the frame, as if striding
    b = a.copy()
    b[8:10, 8:12] = 0  # 8px of the torso box fades to background

    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)

    old_gate = check_frame_consistency(frame_a, frame_b, background_index=0, max_delta_ratio=0.50)
    assert old_gate.passed  # the exact deceptive pass this card retires the metric over

    new_gate = check_identity_stability(
        frame_a, frame_b, background_index=0, region=(8, 8, 12, 12), max_histogram_distance=0.15
    )
    assert not new_gate.passed


# ---------------------------------------------------------------------------
# slice_sheet_frames / count_pixel_deltas (T-0349) -- the grid-slicing and
# raw per-pixel delta primitives the machine-readable gate report is built
# from. `count_pixel_deltas` is deliberately a different metric than
# `check_frame_consistency`'s silhouette (fg/bg *state*) delta: it counts
# ANY palette-index change, including a foreground pixel changing to a
# *different* foreground index -- the number a reviewer eyeballing the raw
# sheet by hand actually sees, per T-0349's motivating T-0259 review
# disagreement.
# ---------------------------------------------------------------------------


def test_slice_sheet_frames_row_major_order():
    arr = np.array(
        [
            [0, 0, 1, 1],
            [0, 0, 1, 1],
            [2, 2, 3, 3],
            [2, 2, 3, 3],
        ],
        dtype=np.uint8,
    )
    sheet = make_indexed_image(arr, TEST_PALETTE_HEX)
    frames = slice_sheet_frames(sheet, cell_width=2, cell_height=2, cols=2, rows=2)
    assert len(frames) == 4
    assert np.array(frames[0]).tolist() == [[0, 0], [0, 0]]
    assert np.array(frames[1]).tolist() == [[1, 1], [1, 1]]
    assert np.array(frames[2]).tolist() == [[2, 2], [2, 2]]
    assert np.array(frames[3]).tolist() == [[3, 3], [3, 3]]


def test_slice_sheet_frames_rejects_size_mismatch():
    sheet = make_indexed_image(np.zeros((4, 4), dtype=np.uint8), TEST_PALETTE_HEX)
    with pytest.raises(ValueError):
        slice_sheet_frames(sheet, cell_width=3, cell_height=3, cols=2, rows=2)


def test_count_pixel_deltas_counts_any_index_change_not_just_silhouette_state():
    a = np.array([[1, 1], [0, 0]], dtype=np.uint8)
    b = np.array([[2, 1], [0, 3]], dtype=np.uint8)
    frame_a = make_indexed_image(a, TEST_PALETTE_HEX)
    frame_b = make_indexed_image(b, TEST_PALETTE_HEX)

    # (0,0): 1 -> 2, still foreground but a DIFFERENT index -- must count.
    # (1,1): 0 -> 3, a real silhouette flip -- must also count.
    assert count_pixel_deltas(frame_a, frame_b) == 2

    # check_frame_consistency's silhouette-only metric only sees the (1,1)
    # fg/bg flip -- confirms this is genuinely a different measurement.
    silhouette = check_frame_consistency(
        frame_a, frame_b, background_index=0, max_delta_ratio=1.0
    )
    assert silhouette.details["delta_pixels"] == 1


def test_count_pixel_deltas_zero_for_identical_frames():
    a = make_indexed_image(np.array([[1, 2], [3, 0]], dtype=np.uint8), TEST_PALETTE_HEX)
    b = make_indexed_image(np.array([[1, 2], [3, 0]], dtype=np.uint8), TEST_PALETTE_HEX)
    assert count_pixel_deltas(a, b) == 0


def test_count_pixel_deltas_rejects_shape_mismatch():
    a = make_indexed_image(np.zeros((2, 2), dtype=np.uint8), TEST_PALETTE_HEX)
    b = make_indexed_image(np.zeros((3, 3), dtype=np.uint8), TEST_PALETTE_HEX)
    with pytest.raises(ValueError):
        count_pixel_deltas(a, b)
