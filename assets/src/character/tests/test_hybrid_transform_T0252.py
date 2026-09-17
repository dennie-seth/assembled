"""Hybrid idle sheet transform (T-0252, HANDOFF §24-e) -- pure algorithm tests.

Round 2 of the T-0227 character-pipeline bake-off (docs/decision-log.md
DL-21): the hypothesis under test is "SDXL for the look, Arm C's
deterministic script for the motion" -- exactly one SDXL-generated idle
frame, every other frame derived from it by translating its own head/arm/leg
pixel bands per `char_gen.synth_entities._player_pose_offsets` (T-0230,
unchanged, not forked). These tests exercise the transform in isolation
against an in-process synthetic stand-in "source frame" -- no ComfyUI/GPU/
network dependency, per this package's fixture convention (python.md:
"Fixtures are generated in-process ... never commit binary test fixtures").

RED state: char_gen.synth_entities has no transform_player_frame_from_source
/ generate_player_idle_sheet_hybrid_T0252 / HYBRID_*_BAND constants yet ->
import fails, every test ERRORs.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")
asset_gate_determinism = pytest.importorskip("asset_gate.determinism")

from char_gen.synth_entities import (  # noqa: E402
    CELL_SIZE,
    HYBRID_HEAD_BAND,
    HYBRID_LEFT_ARM_BAND,
    HYBRID_LEFT_LEG_BAND,
    HYBRID_RIGHT_ARM_BAND,
    HYBRID_RIGHT_LEG_BAND,
    _load_palette,
    generate_player_idle_sheet_hybrid_T0252,
    transform_player_frame_from_source,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

BG_IDX = 0
HEAD_IDX = 10
BODY_IDX = 6
LEG_IDX = 4

ALL_HYBRID_BANDS = [
    HYBRID_HEAD_BAND,
    HYBRID_LEFT_ARM_BAND,
    HYBRID_RIGHT_ARM_BAND,
    HYBRID_LEFT_LEG_BAND,
    HYBRID_RIGHT_LEG_BAND,
]


def _synthetic_source_frame() -> np.ndarray:
    """A standalone stand-in for a real SDXL-generated, palette-quantized
    48x48 source frame. Deliberately not Arm C's own `_draw_player_arm_c`
    (kept independent of Arm C's private internals) but placed inside this
    module's own hybrid bands so the transform has real content to move."""
    arr = np.full((CELL_SIZE, CELL_SIZE), BG_IDX, dtype=np.uint8)
    arr[18:31, 14:34] = BODY_IDX  # torso -- fixed, must never be touched
    hr0, hr1, hc0, hc1 = HYBRID_HEAD_BAND
    arr[hr0:hr1, hc0:hc1] = HEAD_IDX
    lar0, lar1, lac0, lac1 = HYBRID_LEFT_ARM_BAND
    arr[lar0:lar1, lac0:lac1] = BODY_IDX
    rar0, rar1, rac0, rac1 = HYBRID_RIGHT_ARM_BAND
    arr[rar0:rar1, rac0:rac1] = BODY_IDX
    llr0, llr1, llc0, llc1 = HYBRID_LEFT_LEG_BAND
    arr[llr0:llr1, llc0:llc1] = LEG_IDX
    rlr0, rlr1, rlc0, rlc1 = HYBRID_RIGHT_LEG_BAND
    arr[rlr0:rlr1, rlc0:rlc1] = LEG_IDX
    return arr


@pytest.fixture(scope="module")
def source_frame_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    palette_rgb = _load_palette(PALETTE_PATH)
    arr = _synthetic_source_frame()
    img = Image.fromarray(arr, mode="P")
    flat = [0] * (256 * 3)
    for i, (r, g, b) in enumerate(palette_rgb):
        flat[3 * i : 3 * i + 3] = [r, g, b]
    img.putpalette(flat)
    out = tmp_path_factory.mktemp("hybrid_T0252") / "source_frame.png"
    img.save(out)
    return out


def test_frame_zero_is_untouched_source_pixels(source_frame_path: Path, tmp_path: Path) -> None:
    """Every _PLAYER_POSE_PATTERNS entry starts at offset 0 -- frame (0,0) of
    the assembled sheet must be the source frame's own pixels, byte-for-byte,
    proving "exactly one frame is generated, every other frame is derived"
    literally includes frame 0 itself, not just frames 1-8."""
    palette_rgb = _load_palette(PALETTE_PATH)
    out = tmp_path / "sheet.png"
    generate_player_idle_sheet_hybrid_T0252(31416, source_frame_path, palette_rgb, out)
    sheet = Image.open(out)
    frame_0 = np.array(sheet.crop((0, 0, CELL_SIZE, CELL_SIZE)))
    source = np.array(Image.open(source_frame_path))
    assert np.array_equal(frame_0, source)


def test_deterministic_double_render(source_frame_path: Path, tmp_path: Path) -> None:
    """Acceptance: the recipe is reproducible -- the same seed against the
    same source frame produces a byte-identical sheet."""
    palette_rgb = _load_palette(PALETTE_PATH)
    counter = {"n": 0}

    def _produce() -> bytes:
        out = tmp_path / f"render_{counter['n']}.png"
        counter["n"] += 1
        generate_player_idle_sheet_hybrid_T0252(31416, source_frame_path, palette_rgb, out)
        return out.read_bytes()

    result = asset_gate_determinism.check_reproducible(
        "player_idle_hybrid_determinism", _produce, runs=2
    )
    assert result.passed, result.reason


def test_output_is_indexed_144x144(source_frame_path: Path, tmp_path: Path) -> None:
    palette_rgb = _load_palette(PALETTE_PATH)
    out = tmp_path / "sheet.png"
    generate_player_idle_sheet_hybrid_T0252(31416, source_frame_path, palette_rgb, out)
    sheet = Image.open(out)
    assert sheet.mode == "P", f"expected indexed mode 'P', got {sheet.mode!r}"
    assert sheet.size == (144, 144)


def test_rejects_wrong_size_source_frame(tmp_path: Path) -> None:
    palette_rgb = _load_palette(PALETTE_PATH)
    bad = Image.new("P", (32, 32))
    bad_path = tmp_path / "bad.png"
    bad.save(bad_path)
    with pytest.raises(ValueError):
        generate_player_idle_sheet_hybrid_T0252(
            31416, bad_path, palette_rgb, tmp_path / "out.png"
        )


def test_rejects_non_indexed_source_frame(tmp_path: Path) -> None:
    palette_rgb = _load_palette(PALETTE_PATH)
    bad = Image.new("RGB", (CELL_SIZE, CELL_SIZE))
    bad_path = tmp_path / "bad_rgb.png"
    bad.save(bad_path)
    with pytest.raises(ValueError):
        generate_player_idle_sheet_hybrid_T0252(
            31416, bad_path, palette_rgb, tmp_path / "out.png"
        )


def test_transform_only_moves_declared_bands(source_frame_path: Path) -> None:
    """The transform must not touch any pixel outside the declared head/arm/
    leg bands (padded by the max 1px offset any pattern can select) -- torso
    and background stay byte-identical to the source, the same "everything
    except the offset part is fixed" guarantee Arm C's own hardcoded drawing
    gives by construction (module docstring)."""
    source = np.array(Image.open(source_frame_path))
    out = transform_player_frame_from_source(source, head_off=1, arm_off=1, leg_off=1)

    outside_mask = np.ones_like(source, dtype=bool)
    for r0, r1, c0, c1 in ALL_HYBRID_BANDS:
        outside_mask[max(r0 - 1, 0) : r1 + 1, max(c0 - 1, 0) : c1 + 1] = False
    assert np.array_equal(source[outside_mask], out[outside_mask])


@pytest.mark.parametrize(
    "head_off,arm_off,leg_off", [(0, 0, 0), (1, 1, 1), (-1, -1, -1), (1, -1, 0)]
)
def test_transform_stays_within_frame_consistency_cap(
    source_frame_path: Path, head_off: int, arm_off: int, leg_off: int
) -> None:
    """Sanity check of the transform logic itself (independent of whatever a
    real SDXL source frame will measure) -- every offset combination the
    seeded patterns can select must keep the single-step silhouette delta
    well inside DL-21's 0.30 cap, the same by-construction safety property
    Arm C's own patterns guarantee."""
    source = np.array(Image.open(source_frame_path))
    out = transform_player_frame_from_source(source, head_off, arm_off, leg_off)
    assert out.shape == source.shape

    src_img = Image.fromarray(source, mode="P")
    src_img.putpalette(Image.open(source_frame_path).getpalette())
    out_img = Image.fromarray(out, mode="P")
    out_img.putpalette(src_img.getpalette())

    result = asset_gate_art.check_frame_consistency(
        src_img, out_img, background_index=BG_IDX, max_delta_ratio=0.30
    )
    assert result.passed, result.reason
