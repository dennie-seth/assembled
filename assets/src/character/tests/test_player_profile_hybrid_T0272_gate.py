"""Player side-profile base-pose keyframe -- T-0272 gate validation.

`docs/design/13-asset-pipeline.md` §3.5 pins the cell spec (48x48, native
generation at x8 -> 384x384, indexed to the locked 16-slot home palette,
dithering off) that every §24-e hybrid asset in this pipeline shares. This
card generates exactly ONE static side-profile keyframe through the full
§24-e stack (style LoRA + identity LoRA + IP-Adapter + OpenPose ControlNet on
`pose_rig_profile_T0272.py`'s profile-topology skeleton) -- there is no sheet,
no second frame, no animation.

**Read before editing this file.** This is a STATIC POSE, not an animation:
no frame-delta/0.30 cap, no loop seam, no GIF, no Arm-C comparison -- CHR-1's
multi-frame fields do not apply to a single keyframe. `test_no_animation_gate_fields_present`
guards against a future edit accidentally reintroducing one of those checks
against this asset.

RED state:  assets/final/character/player_profile_keyframe_hybrid_T0272.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: keyframe present, mode 'P' with a transparent background index,
             48x48; passes palette-membership, index-semantics, background
             cutout, and provenance resolves the full stack with a non-null
             model_hash and a concept_hash matching T-0209's approved sheet.

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import pose_rig_profile_T0272  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
KEYFRAME_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.png"
PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.provenance.json"
IDLE_ANCHOR_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_hybrid_T0252.png"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the shared reference DL-21 pins for every §24-e generation in this pipeline.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CELL_SIZE = 48
BACKGROUND_INDEX = 0

# Same floor T-0252's own source-frame half uses (test_player_idle_hybrid_T0252_gate.py) --
# a real per-pixel cutout leaves the great majority of the cell as background_index.
MIN_BACKGROUND_FRACTION = 0.65
MIN_FOREGROUND_PIXELS = 50
BBOX_TEST_PIXEL_BUFFER = 3

# Animation-only fields that must NEVER appear on a static keyframe's
# provenance -- see this module's own docstring ("read before editing").
FORBIDDEN_ANIMATION_FIELDS = (
    "frame_delta_range",
    "frame_deltas",
    "beats_030_cap",
    "beats_arm_c_benchmark",
    "arm_c_benchmark",
    "loop",
)


@pytest.fixture(scope="module")
def keyframe() -> Image.Image:
    assert KEYFRAME_PATH.exists(), (
        f"profile keyframe not found: {KEYFRAME_PATH}\n"
        "Run gen_hybrid_profile_T0272.py against the ComfyUI host, then --promote-attempt "
        "to promote a passing attempt."
    )
    img = Image.open(KEYFRAME_PATH)
    assert img.mode == "P", f"expected indexed mode 'P', got {img.mode!r}"
    assert img.size == (CELL_SIZE, CELL_SIZE)
    return img


@pytest.fixture(scope="module")
def provenance() -> dict:
    assert PROVENANCE_PATH.exists(), f"provenance sidecar not found: {PROVENANCE_PATH}"
    return json.loads(PROVENANCE_PATH.read_text())


@pytest.fixture(scope="module")
def palette() -> asset_gate_palette.Palette:
    assert PALETTE_PATH.exists(), f"home palette not found: {PALETTE_PATH}"
    return asset_gate_palette.load_palette(PALETTE_PATH)


# ---------------------------------------------------------------------------
# Full-stack / P-7 provenance
# ---------------------------------------------------------------------------


def test_keyframe_concept_hash_resolves(provenance: dict) -> None:
    assert provenance.get("concept_hash") == EXPECTED_CONCEPT_HASH


def test_keyframe_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash must be non-null."""
    assert provenance.get("model_hash"), "model_hash missing or null (P-7)"


def test_keyframe_full_stack_recorded(provenance: dict) -> None:
    """Acceptance: the §24-e stack, all four conditioning mechanisms present --
    style LoRA + identity LoRA + IP-Adapter + ControlNet."""
    assert provenance.get("style_lora_hash"), "style_lora_hash missing"
    assert provenance.get("identity_lora_hash"), "identity_lora_hash missing"
    assert provenance.get("identity_lora_name") == "player_identity_v2.safetensors"
    assert provenance.get("ip_adapter"), "ip_adapter missing -- full stack must include IP-Adapter"
    assert provenance.get("controlnet"), "controlnet missing"


def test_generator_field_is_bare_repo_path(provenance: dict) -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative
    path, no free-text annotation suffix."""
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator {generator!r} does not resolve to a committed file"


def test_pose_source_is_the_profile_rig_not_the_front_rig(provenance: dict) -> None:
    """Acceptance: 'a profile-topology OpenPose skeleton is authored ... not
    a reframed or mirrored front rig'. Checkable via provenance, not merely
    asserted in prose."""
    pose_source = provenance.get("pose_source", "")
    assert "pose_rig_profile_T0272" in pose_source, (
        f"pose_source must name the profile rig module, got {pose_source!r}"
    )


def test_facing_direction_recorded(provenance: dict) -> None:
    """Acceptance: 'record it in the sidecar, so downstream animation mirrors
    deliberately rather than guessing'."""
    assert provenance.get("facing") == pose_rig_profile_T0272.FACING


def test_identity_anchor_references_the_committed_front_keyframe(provenance: dict) -> None:
    """Acceptance: identity must be 'consistent with the T-0252 front anchor
    at 40px'. Same identity_anchor shape gen_hybrid_walk_T0259.py records
    against the same file."""
    anchor = provenance.get("identity_anchor")
    assert anchor, "identity_anchor missing"
    assert anchor.get("path") == str(IDLE_ANCHOR_PATH.relative_to(REPO_ROOT))
    assert anchor.get("hash"), "identity_anchor.hash missing"


def test_no_animation_gate_fields_present(provenance: dict) -> None:
    """This is a STATIC POSE, not an animation -- see module docstring. A
    frame-delta cap, loop seam, or Arm-C comparison would be a misapplied
    gate: there is no second frame to compare this keyframe against."""
    present = [f for f in FORBIDDEN_ANIMATION_FIELDS if f in provenance]
    assert not present, f"static keyframe provenance must not carry animation field(s) {present}"


# ---------------------------------------------------------------------------
# Pixel-level checks
# ---------------------------------------------------------------------------


def test_palette_membership(keyframe: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """All used pixel colours must be exact members of the home palette (P-4)."""
    result = asset_gate_palette.check_palette_membership(keyframe, palette)
    assert result.passed, result.reason


def test_index_semantics(keyframe: Image.Image, palette: asset_gate_palette.Palette) -> None:
    """P-4: index N must resolve to the same RGB as home_palette slot N."""
    result = asset_gate_palette.check_index_semantics(keyframe, palette)
    assert result.passed, result.reason


def test_orphan_pixels(keyframe: Image.Image) -> None:
    result = asset_gate_art.check_orphan_pixels(
        keyframe, background_index=BACKGROUND_INDEX, size_threshold=4
    )
    assert result.passed, result.reason


def test_background_cutout_applied(provenance: dict) -> None:
    """Acceptance: 'cutout applied; true RGBA transparent background,
    character only -- no floor or prop geometry'."""
    assert provenance.get("background_cutout_applied") is True
    method = provenance.get("cutout_method")
    assert method and len(method) > 40, "cutout_method missing or too short"
    assert isinstance(provenance.get("cutout_oklab_tolerance"), int | float)
    assert isinstance(provenance.get("cutout_bbox_margin_frac"), int | float)
    assert 0.0 < provenance["cutout_bbox_margin_frac"] < 1.0


def test_keyframe_has_a_true_transparency_index(keyframe: Image.Image) -> None:
    """P-6: a committed sprite must declare a tRNS transparency index, not
    ship as an opaque indexed PNG (the defect char_gen.sprite_io.save_sprite_sheet
    exists to prevent -- see its own module docstring)."""
    raw = keyframe.info.get("transparency")
    assert raw is not None, "keyframe declares no tRNS transparency at all"


def test_background_is_mostly_clean() -> None:
    img = Image.open(KEYFRAME_PATH)
    arr = np.array(img)
    bg_fraction = float((arr == BACKGROUND_INDEX).mean())
    assert bg_fraction >= MIN_BACKGROUND_FRACTION, (
        f"keyframe: only {bg_fraction:.2%} background -- expected >= "
        f"{MIN_BACKGROUND_FRACTION:.0%}, residual background clutter likely survived cutout"
    )


def test_silhouette_not_erased() -> None:
    img = Image.open(KEYFRAME_PATH)
    arr = np.array(img)
    fg_count = int((arr != BACKGROUND_INDEX).sum())
    assert fg_count >= MIN_FOREGROUND_PIXELS, (
        f"keyframe: only {fg_count}px of character survived cutout "
        f"(floor {MIN_FOREGROUND_PIXELS}px)"
    )


def test_no_foreground_outside_the_profile_rigs_keypoint_bbox(provenance: dict) -> None:
    """No residual background clutter may survive far from the character:
    every non-background pixel must fall within the PROFILE rig's own
    keypoint bounding box (not the front rig's), expanded by the same margin
    the cutout itself used."""
    margin = provenance["cutout_bbox_margin_frac"]
    points = pose_rig_profile_T0272.profile_keypoints()
    xs = [x for x, _ in points.values()]
    ys = [y for _, y in points.values()]
    x0n, x1n = min(xs), max(xs)
    y0n, y1n = min(ys), max(ys)
    wn, hn = x1n - x0n, y1n - y0n
    x0n = max(0.0, x0n - wn * margin)
    x1n = min(1.0, x1n + wn * margin)
    y0n = max(0.0, y0n - hn * margin)
    y1n = min(1.0, y1n + hn * margin)

    arr = np.array(Image.open(KEYFRAME_PATH))
    size = arr.shape[0]
    px0 = max(0, int(x0n * size) - BBOX_TEST_PIXEL_BUFFER)
    px1 = min(size, int(x1n * size) + BBOX_TEST_PIXEL_BUFFER)
    py0 = max(0, int(y0n * size) - BBOX_TEST_PIXEL_BUFFER)
    py1 = min(size, int(y1n * size) + BBOX_TEST_PIXEL_BUFFER)

    fg = arr != BACKGROUND_INDEX
    outside = fg.copy()
    outside[py0:py1, px0:px1] = False
    stray = int(outside.sum())
    assert stray == 0, (
        f"keyframe: {stray} foreground px outside the profile rig's keypoint bbox+margin "
        f"({px0},{py0})-({px1},{py1}) -- residual background clutter survived cutout"
    )
