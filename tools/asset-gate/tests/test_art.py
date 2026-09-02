import numpy as np

from asset_gate.art import (
    check_atlas_determinism,
    check_background_growth,
    check_cell_fit,
    check_frame_consistency,
    check_indexed_preservation,
    check_orphan_pixels,
    check_tile_seamlessness,
    check_transition_adjacency,
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
