"""Player side-profile base-pose keyframe -- T-0339 descent-only gate.

`docs/design/13-asset-pipeline.md` §3.5 pins the cell spec (48x48, locked
16-slot home palette, dithering off, per-pixel cutout) every keyframe in this
pipeline shares. T-0272's own 84-attempt dual-IPAdapter + ControlNet stack
never produced a promotable frame at this exact path -- see
`ARM_PROFILE_ATTEMPT_LOG_T0272.md`'s full history. **T-0339 supersedes that
route entirely**: the committed, already-provenanced 1024px side-profile
reference from T-0317 (`player_profile_costume_reference_T0317.png`, a plain
txt2img + style-LoRA sample with no ControlNet and no IP-Adapter) is
descended directly to 48x48 through the existing `char_gen` cutout, with no
new diffusion sampling at all.

**Read before editing this file.** This gate no longer describes or requires
the §24-e stack (style LoRA + identity LoRA + IP-Adapter + ControlNet + a
second pose LoRA) -- `test_no_diffusion_stack_fields_present` guards against
a future edit accidentally reintroducing one of those fields, which would
mean the forbidden route (the card's own "Do not" list: "Do not route this
through the dual-IPAdapter + ControlNet stack") was retried. This is also
still a STATIC POSE, not an animation: no frame-delta cap, no loop seam, no
Arm-C comparison -- `test_no_animation_gate_fields_present` is unchanged from
the superseded version of this file.

RED state:  assets/final/character/player_profile_keyframe_hybrid_T0272.png
            absent -> SHEET_PATH fixture raises AssertionError, all tests ERROR.
GREEN state: keyframe present, mode 'P' with a transparent background index,
             48x48; passes palette-membership, index-semantics, background
             cutout, and provenance resolves an explicit chain back to the
             committed T-0317 reference (path + hash + seed + recipe), with a
             non-null model_hash and a bare, resolvable generator path (P-7).

Install:
    pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

asset_gate_art = pytest.importorskip("asset_gate.art")
asset_gate_palette = pytest.importorskip("asset_gate.palette")

from char_gen.cutout import label_foreground_components  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
KEYFRAME_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.png"
PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_profile_keyframe_hybrid_T0272.provenance.json"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

SOURCE_REFERENCE_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_costume_reference_T0317.png"
)
SOURCE_REFERENCE_PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_costume_reference_T0317.provenance.json"
)

CELL_SIZE = 48
BACKGROUND_INDEX = 0

# Same floor every other §24-e-family keyframe in this pipeline uses.
MIN_BACKGROUND_FRACTION = 0.65
MIN_FOREGROUND_PIXELS = 50

# Generous upper bound on disconnected foreground components -- catches
# residual background clutter without assuming an exact single-blob figure
# (see char_gen/cutout.py's own MIN_HINT_OVERLAP_FRACTION docstring for why
# a real figure can legitimately split into a few parts).
MAX_FOREGROUND_COMPONENTS = 6

# Reviewer FAIL on this card's first GREEN (2026-09-09): fitting the source
# figure by height alone let a needle-thin 3px-wide body pass, because
# height > width is satisfied by a 1px-wide sliver just as much as by a
# legible figure. Measured directly against the already-promoted anchor
# this pipeline's own front-facing keyframe uses
# (`player_idle_sheet_hybrid_T0252.png`: every cell's foreground bbox is
# 14-16px wide at 44px tall) -- a side profile is legitimately narrower than
# a front-facing pose (no shoulder width to show), so the floor sits below
# that band, not inside it, but must still clear it by a wide enough margin
# that a degenerate 3px column cannot pass by accident.
MIN_FOREGROUND_WIDTH_PX = 10

# Animation-only fields that must NEVER appear on a static keyframe's
# provenance -- unchanged from the superseded §24-e version of this gate.
FORBIDDEN_ANIMATION_FIELDS = (
    "frame_delta_range",
    "frame_deltas",
    "beats_030_cap",
    "beats_arm_c_benchmark",
    "arm_c_benchmark",
    "loop",
)

# T-0272's own dual-IPAdapter + ControlNet stack, explicitly forbidden for
# this card ("Do not route this through the dual-IPAdapter + ControlNet
# stack -- that stack is exactly what failed 84 times"). A provenance sidecar
# carrying any of these means the forbidden route was retried instead of the
# plain descent this card exists to do.
FORBIDDEN_DIFFUSION_STACK_FIELDS = (
    "style_lora_hash",
    "identity_lora_hash",
    "identity_lora_name",
    "ip_adapter",
    "controlnet",
    "pose_lora_name",
    "pose_lora_hash",
    "pose_lora_weight",
    "pose_lora_trigger_token",
)


@pytest.fixture(scope="module")
def keyframe() -> Image.Image:
    assert KEYFRAME_PATH.exists(), (
        f"profile keyframe not found: {KEYFRAME_PATH}\n"
        "Run gen_profile_keyframe_descent_T0339.py to descend the committed "
        "T-0317 reference -- no ComfyUI call required."
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
# Provenance: descent-only chain, no new diffusion sampling
# ---------------------------------------------------------------------------


def test_keyframe_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash must be non-null, even though this card performs no
    new inference -- it names the model that produced the sample being
    descended (T-0317's), per the card's own acceptance criterion."""
    assert provenance.get("model_hash"), "model_hash missing or null (P-7)"


def test_generator_field_is_bare_repo_path(provenance: dict) -> None:
    """P-7 (T-0219/T-0222): generator must be a bare resolvable repo-relative
    path, no free-text annotation suffix."""
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator {generator!r} does not resolve to a committed file"


def test_route_is_descent_not_generation(provenance: dict) -> None:
    """Acceptance: 'This is a descent of a diffusion sample, which DL-30
    permits explicitly' -- checkable in provenance, not merely asserted."""
    assert provenance.get("route") == "descended"


def test_gpu_call_requirement_is_recorded(provenance: dict) -> None:
    """Acceptance: 'The summary states plainly whether any GPU call was
    needed' -- recorded as a checkable boolean, not left to prose alone."""
    assert isinstance(provenance.get("gpu_call_required"), bool)


def test_no_diffusion_stack_fields_present(provenance: dict) -> None:
    """This is a plain descent of an already-committed sample -- see module
    docstring. A style/identity/pose LoRA, IP-Adapter, or ControlNet field
    would mean the card's own forbidden route (the dual-IPAdapter +
    ControlNet stack that failed 84 times) was retried instead."""
    present = [f for f in FORBIDDEN_DIFFUSION_STACK_FIELDS if f in provenance]
    assert not present, f"descent-only provenance must not carry diffusion-stack field(s) {present}"


def test_no_animation_gate_fields_present(provenance: dict) -> None:
    """This is a STATIC POSE, not an animation -- see module docstring. A
    frame-delta cap, loop seam, or Arm-C comparison would be a misapplied
    gate: there is no second frame to compare this keyframe against."""
    present = [f for f in FORBIDDEN_ANIMATION_FIELDS if f in provenance]
    assert not present, f"static keyframe provenance must not carry animation field(s) {present}"


def test_concept_hash_resolves_to_the_committed_T0317_reference(provenance: dict) -> None:
    """Acceptance: 'resolving concept_hash' -- must match the CURRENT bytes
    of the committed T-0317 reference, re-hashed here rather than trusted
    from a stale constant."""
    assert SOURCE_REFERENCE_PATH.is_file(), f"T-0317 reference missing: {SOURCE_REFERENCE_PATH}"
    actual_hash = hashlib.sha256(SOURCE_REFERENCE_PATH.read_bytes()).hexdigest()
    assert provenance.get("concept_hash") == actual_hash


def test_source_reference_chain_recorded(provenance: dict) -> None:
    """Acceptance: 'an explicit chain back to player_profile_costume_
    reference_T0317.png and its seed/recipe'."""
    source = provenance.get("source_reference")
    assert source, "source_reference missing"
    assert source.get("path") == str(SOURCE_REFERENCE_PATH.relative_to(REPO_ROOT))
    assert source.get("card") == "T-0317"
    actual_hash = hashlib.sha256(SOURCE_REFERENCE_PATH.read_bytes()).hexdigest()
    assert source.get("sha256") == actual_hash
    assert source.get("seed") is not None, "source_reference.seed missing"
    assert source.get("method"), "source_reference.method (the original recipe) missing"


def test_source_reference_seed_matches_the_committed_T0317_provenance(provenance: dict) -> None:
    """The seed/recipe recorded here must actually be T-0317's own, not a
    re-typed guess -- cross-checked directly against that card's own
    committed sidecar."""
    assert SOURCE_REFERENCE_PROVENANCE_PATH.is_file()
    t0317 = json.loads(SOURCE_REFERENCE_PROVENANCE_PATH.read_text())
    source = provenance["source_reference"]
    assert source["seed"] == t0317["seed"]
    assert source["method"] == t0317["method"]


def test_dithering_disabled(provenance: dict) -> None:
    """Acceptance: 'dithering off'."""
    assert provenance.get("dithering") is False


def test_cell_size_is_48(provenance: dict) -> None:
    assert provenance.get("cell_size") == CELL_SIZE


def test_background_cutout_applied(provenance: dict) -> None:
    """Acceptance: 'true-RGBA cutout, character only'."""
    assert provenance.get("background_cutout_applied") is True
    method = provenance.get("cutout_method")
    assert method and len(method) > 40, "cutout_method missing or too short"
    assert isinstance(provenance.get("cutout_oklab_tolerance"), int | float)


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
    """Acceptance: 'clears the 50px foreground floor that the old 384px
    attempts kept failing'."""
    img = Image.open(KEYFRAME_PATH)
    arr = np.array(img)
    fg_count = int((arr != BACKGROUND_INDEX).sum())
    assert fg_count >= MIN_FOREGROUND_PIXELS, (
        f"keyframe: only {fg_count}px of character survived cutout "
        f"(floor {MIN_FOREGROUND_PIXELS}px)"
    )


def test_foreground_component_count_is_bounded() -> None:
    """No disconnected background clutter may survive alongside the
    character."""
    arr = np.array(Image.open(KEYFRAME_PATH))
    fg = arr != BACKGROUND_INDEX
    _, count = label_foreground_components(fg)
    assert count <= MAX_FOREGROUND_COMPONENTS, (
        f"keyframe: foreground splits into {count} disconnected components (ceiling "
        f"{MAX_FOREGROUND_COMPONENTS}) -- residual background clutter likely survived cutout"
    )


def test_figure_is_not_squashed_into_a_wide_aspect() -> None:
    """Acceptance: 'not mirrored, sheared or squashed'. A genuine side-on
    standing figure descended without distortion is taller than it is wide;
    a squash/shear that flattened it toward the cell's own square aspect
    would be the specific defect this checks for, cheaply, without a human
    in the loop for every future regeneration."""
    arr = np.array(Image.open(KEYFRAME_PATH))
    fg = arr != BACKGROUND_INDEX
    ys, xs = np.where(fg)
    height = int(ys.max() - ys.min() + 1)
    width = int(xs.max() - xs.min() + 1)
    assert height > width, (
        f"keyframe foreground bbox is {width}x{height} -- expected a standing side-profile "
        "figure to be taller than it is wide"
    )


def test_figure_clears_the_minimum_legible_width_floor() -> None:
    """Two-sided companion to `test_figure_is_not_squashed_into_a_wide_aspect`:
    height > width alone passes a 1px-wide sliver just as readily as a
    legible figure. See MIN_FOREGROUND_WIDTH_PX's own comment -- this is the
    mechanical gate for the exact defect the reviewer measured on this
    card's first GREEN (a 3px-wide olive column with no recoverable facing
    information at all)."""
    arr = np.array(Image.open(KEYFRAME_PATH))
    fg = arr != BACKGROUND_INDEX
    ys, xs = np.where(fg)
    width = int(xs.max() - xs.min() + 1)
    assert width >= MIN_FOREGROUND_WIDTH_PX, (
        f"keyframe foreground bbox is {width}px wide -- expected at least "
        f"{MIN_FOREGROUND_WIDTH_PX}px, below which a side profile reads as a "
        "featureless needle regardless of its height"
    )
