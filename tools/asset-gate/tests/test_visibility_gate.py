"""Rendered-visibility validation gate tests.

PR #231 (T-0215) shipped 5 prop PNGs with alpha=0 on every pixel -- they
rendered as blank/transparent everywhere (GitHub, browser, Godot) even
though the RGB data underneath was real SDXL art. The existing asset-gate
CI only checked `model_hash` provenance, never whether an image actually
renders as visible content, so it passed the PR.

`check_rendered_visibility` closes that gap: it rejects any image that is
fully transparent (alpha=0 on every pixel) or effectively blank/uniform
(too few distinct visible colors -- a solid fill, a single-color canvas).
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from asset_gate.visibility import check_rendered_visibility, sweep_rendered_visibility


def _rgba_image(rgb_pattern: np.ndarray, alpha: int | np.ndarray) -> Image.Image:
    h, w = rgb_pattern.shape[:2]
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[:, :, :3] = rgb_pattern
    arr[:, :, 3] = alpha
    return Image.fromarray(arr, mode="RGBA")


def _multicolor_rgb(h: int = 8, w: int = 8) -> np.ndarray:
    """A small checkerboard-ish pattern with several distinct colors."""
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    colors = [(200, 60, 30), (40, 40, 40), (180, 180, 180), (10, 90, 140)]
    for y in range(h):
        for x in range(w):
            rgb[y, x] = colors[(x + y) % len(colors)]
    return rgb


# ---- check_rendered_visibility -------------------------------------------


def test_fails_when_alpha_is_zero_on_every_pixel():
    image = _rgba_image(_multicolor_rgb(), alpha=0)
    result = check_rendered_visibility(image)
    assert not result.passed
    assert "transparent" in result.reason.lower()


def test_passes_for_real_multicolor_opaque_image():
    image = _rgba_image(_multicolor_rgb(), alpha=255)
    result = check_rendered_visibility(image)
    assert result.passed


def test_fails_for_all_white_uniform_image():
    rgb = np.full((8, 8, 3), 255, dtype=np.uint8)
    image = _rgba_image(rgb, alpha=255)
    result = check_rendered_visibility(image)
    assert not result.passed
    assert "blank" in result.reason.lower() or "uniform" in result.reason.lower()


def test_fails_for_single_solid_color_opaque_image():
    rgb = np.full((8, 8, 3), (40, 90, 140), dtype=np.uint8)
    image = _rgba_image(rgb, alpha=255)
    result = check_rendered_visibility(image)
    assert not result.passed


def test_fails_for_two_color_image_below_default_threshold():
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    rgb[:, 4:] = (255, 255, 255)
    image = _rgba_image(rgb, alpha=255)
    result = check_rendered_visibility(image)
    assert not result.passed


def test_passes_when_min_visible_colors_threshold_is_lowered():
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    rgb[:, 4:] = (255, 255, 255)
    image = _rgba_image(rgb, alpha=255)
    result = check_rendered_visibility(image, min_visible_colors=2)
    assert result.passed


def test_only_counts_colors_among_opaque_pixels():
    """A fully-transparent background shouldn't count toward color diversity --
    a real sprite is judged on its opaque foreground pixels only."""
    rgb = _multicolor_rgb()
    alpha = np.zeros((8, 8), dtype=np.uint8)
    alpha[2:6, 2:6] = 255  # small opaque foreground patch, rest transparent
    image = _rgba_image(rgb, alpha=alpha)
    result = check_rendered_visibility(image)
    # foreground patch still has several distinct colors -> should pass
    assert result.passed


def test_rgb_mode_image_without_alpha_channel_is_treated_as_fully_opaque():
    rgb = _multicolor_rgb()
    image = Image.fromarray(rgb, mode="RGB")
    result = check_rendered_visibility(image)
    assert result.passed


def test_result_check_name_is_rendered_visibility():
    image = _rgba_image(_multicolor_rgb(), alpha=255)
    result = check_rendered_visibility(image)
    assert result.check == "rendered_visibility"


# ---- sweep_rendered_visibility ---------------------------------------------


def test_sweep_passes_for_real_opaque_images(tmp_path):
    _rgba_image(_multicolor_rgb(), alpha=255).save(tmp_path / "a.png")
    (tmp_path / "nested").mkdir(exist_ok=True)
    _rgba_image(_multicolor_rgb(), alpha=255).save(tmp_path / "nested" / "b.png")

    results = sweep_rendered_visibility(tmp_path)

    assert len(results) == 2
    assert all(r.passed for r in results)


def test_sweep_fails_for_a_transparent_png(tmp_path):
    _rgba_image(_multicolor_rgb(), alpha=255).save(tmp_path / "good.png")
    _rgba_image(_multicolor_rgb(), alpha=0).save(tmp_path / "bad.png")

    results = sweep_rendered_visibility(tmp_path)

    assert len(results) == 2
    failing = [r for r in results if not r.passed]
    assert len(failing) == 1
    assert "bad.png" in failing[0].reason


def test_sweep_ignores_non_png_files(tmp_path):
    (tmp_path / "notes.txt").write_text("hello")
    _rgba_image(_multicolor_rgb(), alpha=255).save(tmp_path / "a.png")

    results = sweep_rendered_visibility(tmp_path)

    assert len(results) == 1


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_rendered_visibility(tmp_path) == []


# ---- Real-world calibration: the sweep must not false-positive on committed art ----


def test_sweep_of_assets_final_finds_no_false_positives():
    """The threshold must be sensible enough that every currently-committed
    final PNG in this checkout passes -- proves the gate doesn't reject real
    art (guards against a too-strict `min_visible_colors`)."""
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[3]
    assets_final = repo_root / "assets" / "final"
    if not assets_final.exists():
        pytest.skip("assets/final not present in this checkout")

    results = sweep_rendered_visibility(assets_final)
    failures = [r for r in results if not r.passed]
    assert not failures, "\n".join(f"{r.details.get('path', '?')}: {r.reason}" for r in failures)


# ---- The verdict must not depend on how the background is encoded (P-6) ----


def test_transparent_background_counts_as_one_visible_state():
    """A two-tone figure on a transparent background is a sprite, not a blank."""
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    rgb[2:6, 2:4] = (60, 60, 60)
    rgb[2:6, 4:6] = (180, 180, 180)
    alpha = np.zeros((8, 8), dtype=np.uint8)
    alpha[2:6, 2:6] = 255
    result = check_rendered_visibility(_rgba_image(rgb, alpha=alpha))
    assert result.passed
    assert result.details["visible_states"] == 3
    assert result.details["unique_visible_colors"] == 2


def test_verdict_is_unchanged_by_a_transparency_re_save():
    """Same indices, opaque background vs tRNS background -- same verdict.

    This is exactly what the P-6 re-save did to nine committed entity sheets:
    the background stopped counting as a colour, and a gate that measured only
    opaque colours flipped them to FAIL without a pixel changing.
    """
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)
    rgb[:, :] = (18, 17, 14)
    rgb[2:6, 2:4] = (60, 60, 60)
    rgb[2:6, 4:6] = (180, 180, 180)

    opaque_alpha = np.full((8, 8), 255, dtype=np.uint8)
    cut_alpha = np.zeros((8, 8), dtype=np.uint8)
    cut_alpha[2:6, 2:6] = 255

    before = check_rendered_visibility(_rgba_image(rgb, alpha=opaque_alpha))
    after = check_rendered_visibility(_rgba_image(rgb, alpha=cut_alpha))
    assert before.passed == after.passed is True


def test_a_single_colour_on_transparency_is_still_blank():
    """Crediting transparency with one state must not let a solid blob through."""
    rgb = np.full((8, 8, 3), (40, 90, 140), dtype=np.uint8)
    alpha = np.zeros((8, 8), dtype=np.uint8)
    alpha[2:6, 2:6] = 255
    result = check_rendered_visibility(_rgba_image(rgb, alpha=alpha))
    assert not result.passed
    assert result.details["visible_states"] == 2
