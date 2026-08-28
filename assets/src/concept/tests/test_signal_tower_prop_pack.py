"""T-0201 — Signal Tower prop pack artifact gate.

Validates that the Signal Tower prop pack sprites exist in
`assets/final/props/signal_tower/` and meet the T-0201 acceptance criteria:

  - Cover props included: relay_cabinet, crate_stack, low_duct
  - Hiding-spot props included: locker, server_rack
  - Cover vs hiding-spot props visually distinguishable at 16px
    (BT.601 luminance of cover opaque pixels > hiding-spot opaque pixels,
    both per-class-mean and per-prop strict ordering)

All sprites are RGBA (colour_type=6) to represent the BiRefNet cutout output
— background pixels are transparent (alpha=0), prop pixels are fully opaque.

Prop sprite sizes (game px = 1 game unit = 1 sprite px):
  - relay_cabinet_v1.png  — 36×20  (cover, wide squat relay junction cabinet)
  - crate_stack_v1.png    — 24×28  (cover, two-crate stack)
  - low_duct_v1.png       — 48×12  (cover, horizontal HVAC duct segment)
  - locker_v1.png         — 14×42  (hiding spot, tall narrow standing locker)
  - server_rack_v1.png    — 20×46  (hiding spot, enclosed server rack cabinet)

Design references:
  - docs/design/11-moment-to-moment.md §2 (cover vs hiding-spot semantics)
  - docs/design/13-asset-pipeline.md §6 (pipeline, sprite format)

PNG inspection uses Pillow (already in the concept package's `dev` extra) for
correct decoding of all PNG filter types (0–4). The earlier stdlib-only decoder
assumed filter type 0 on every scanline, which silently mis-decoded the
mixed-filter output of the real cutout pipeline (T-0223 root cause).

T-0233 (HANDOFF §23-j) certifies this same 5-prop pack as the full pack for
all seven Signal Tower rooms (docs/design/14-vertical-slice.md §10 -- only
Power Substation, Equipment Floor, Ground Relay, and Antenna Shaft need
cover/hiding dressing; Records Room, Storage Cache, and Broadcast Deck need
none) and adds:

  - P-7 compliance: `concept_hash`/`concept_source` resolving to the
    approved `signal_tower_props_concept_sheet_v1.png` (T-0211) on every
    prop's provenance sidecar.
  - A committed recipe (`assets/src/props/signal_tower_prop_recipes.py`,
    P-3) checked for consistency against the committed provenance -- closes
    the "generated via an uncommitted one-off script" gap T-0221/T-0223
    left open.
  - The T-0215 rendered-visibility gate (`asset_gate.visibility`) run
    against every prop, not just the alpha-coverage/dimension checks above.
  - An explicit per-pair (not just per-class-min/max) 16px luma-gap check,
    so no individual prop can hide inside a passing aggregate.

See `assets/src/concept/SIGNAL_TOWER_PROP_PACK_FULL_T0233.md` for the full
room-coverage mapping and measured-value writeup.
"""

from __future__ import annotations

import io
import itertools
import json
import struct
from pathlib import Path

from PIL import Image
import pytest

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"

asset_gate_visibility = pytest.importorskip("asset_gate.visibility")
prop_recipes = pytest.importorskip("signal_tower_prop_recipes")

COVER_PROPS = [
    "relay_cabinet_v1.png",
    "crate_stack_v1.png",
    "low_duct_v1.png",
]
HIDE_PROPS = [
    "locker_v1.png",
    "server_rack_v1.png",
]
ALL_PROPS = COVER_PROPS + HIDE_PROPS

_PNG_SIG = b"\x89PNG\r\n\x1a\n"

PROP_DIMS = {
    "relay_cabinet_v1.png": (36, 20),
    "crate_stack_v1.png": (24, 28),
    "low_duct_v1.png": (48, 12),
    "locker_v1.png": (14, 42),
    "server_rack_v1.png": (20, 46),
}

# Minimum BT.601 luminance gap (at 16px game scale) between the lightest
# hiding prop and the darkest cover prop.  Derived from
# docs/design/13-asset-pipeline.md §3.5/§6.9: cover targets mid-value
# (ramp10, BT.601 ≈ 97); hiding targets dark (ramp04, BT.601 ≈ 58),
# giving a natural ~39-luma gap on the home palette.  A floor of 15 allows
# for SDXL value variance while keeping the distinction player-readable at
# 16px game scale.
_MIN_COVER_HIDE_GAP = 15.0


# ── PNG parsing helpers ────────────────────────────────────────────────────────

def _parse_ihdr(data: bytes) -> dict:
    """Parse PNG signature + IHDR. Returns width, height, bit_depth, colour_type."""
    assert data[:8] == _PNG_SIG, "Not a valid PNG (bad signature)"
    chunk_len = struct.unpack(">I", data[8:12])[0]
    chunk_type = data[12:16]
    assert chunk_type == b"IHDR", f"First chunk is {chunk_type!r}, expected IHDR"
    assert chunk_len == 13, f"IHDR length {chunk_len}, expected 13"
    ihdr = data[16:29]
    width, height = struct.unpack(">II", ihdr[0:8])
    return {
        "width": width,
        "height": height,
        "bit_depth": ihdr[8],
        "colour_type": ihdr[9],
    }


def _extract_opaque_pixels(data: bytes) -> list[tuple[int, int, int]]:
    """Decode RGBA PNG and return list of (R,G,B) for all opaque pixels (A>0).

    Uses Pillow for correct decoding across all PNG filter types (0–4).
    Real cutout-pipeline output uses mixed filter types (1/2/4 per scanline);
    the former stdlib decoder assumed filter type 0 everywhere, producing
    garbage luminance measurements on those files (T-0223 root cause fix).
    """
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    return [(r, g, b) for r, g, b, a in img.getdata() if a > 0]


def _downscale_to_game_16px(data: bytes) -> list[tuple[int, int, int]]:
    """Downscale sprite to 16px on its longest side and return opaque pixels.

    Game-scale rule: longest side → 16px, other side proportionally (round).
    Examples for the five props:
      low_duct_v1.png   48×12  → 16×4   (longest = 48)
      relay_cabinet     36×20  → 16×7   (longest = 36, round(20·16/36)=9 → 9)
      crate_stack       24×28  → 14×16  (longest = 28)
      locker            14×42  → 5×16   (longest = 42)
      server_rack       20×46  → 7×16   (longest = 46)

    Lanczos resampling.  Alpha-weighted: only pixels with a > 0 contribute.
    These sprites are 100% opaque so the filter is effectively a no-op, but
    it guards against soft-edge regressions introduced by re-tuning.
    """
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    w, h = img.size
    max_dim = max(w, h)
    new_w = max(1, round(w * 16 / max_dim))
    new_h = max(1, round(h * 16 / max_dim))
    img_small = img.resize((new_w, new_h), Image.LANCZOS)
    return [(r, g, b) for r, g, b, a in img_small.getdata() if a > 0]


def _mean_luma(pixels: list[tuple[int, int, int]]) -> float:
    """BT.601 luminance average over a list of (R,G,B) pixels."""
    if not pixels:
        return 0.0
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels) / len(pixels)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def prop_bytes(ensure_signal_tower_prop_pack) -> dict[str, bytes]:  # noqa: ARG001
    """Return raw bytes for each prop PNG, keyed by filename."""
    return {name: (PROPS_DIR / name).read_bytes() for name in ALL_PROPS}


# ── Existence gate ─────────────────────────────────────────────────────────────

def test_cover_props_exist(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """T-0201 acceptance: cover props (relay cabinet, crate stack, low duct) must exist."""
    for name in COVER_PROPS:
        assert (PROPS_DIR / name).exists(), (
            f"Missing cover prop sprite: {PROPS_DIR / name}"
        )


def test_hiding_props_exist(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """T-0201 acceptance: hiding-spot props (locker, server rack) must exist."""
    for name in HIDE_PROPS:
        assert (PROPS_DIR / name).exists(), (
            f"Missing hiding-spot prop sprite: {PROPS_DIR / name}"
        )


# ── Format gate ───────────────────────────────────────────────────────────────

def test_all_props_are_rgba(prop_bytes):
    """BiRefNet cutout output must be RGBA (colour_type=6) with transparent background."""
    for name, data in prop_bytes.items():
        meta = _parse_ihdr(data)
        assert meta["colour_type"] == 6, (
            f"{name}: expected colour_type 6 (RGBA), got {meta['colour_type']}. "
            "Prop sprites must be RGBA (BiRefNet cutout with transparent background)."
        )
        assert meta["bit_depth"] == 8, (
            f"{name}: expected 8-bit depth, got {meta['bit_depth']}."
        )


def test_all_props_have_correct_dimensions(prop_bytes):
    """Each prop must match its specified game-pixel dimensions."""
    for name, data in prop_bytes.items():
        expected_w, expected_h = PROP_DIMS[name]
        meta = _parse_ihdr(data)
        assert meta["width"] == expected_w, (
            f"{name}: expected width {expected_w}, got {meta['width']}."
        )
        assert meta["height"] == expected_h, (
            f"{name}: expected height {expected_h}, got {meta['height']}."
        )


def test_all_props_have_opaque_pixels(prop_bytes):
    """Every prop sprite must contain at least one opaque (non-transparent) pixel."""
    for name, data in prop_bytes.items():
        pixels = _extract_opaque_pixels(data)
        assert pixels, (
            f"{name}: no opaque pixels found — sprite appears fully transparent."
        )


def test_opaque_pixel_decode_full_coverage(prop_bytes):
    """Regression (T-0223): fully-opaque sprites must decode to exactly width × height pixels.

    Guards against the T-0201 stdlib decoder bug: PNG filter types 1/2/4
    (used by real cutout-pipeline output) caused mis-decode, reporting only
    4–80 opaque pixels in sprites that are 100% opaque
    (e.g. relay_cabinet_v1.png = 720 px all at alpha=255, but the old reader
    saw 5).  With Pillow, a fully-opaque sprite must always yield W × H pixels.
    """
    for name, data in prop_bytes.items():
        meta = _parse_ihdr(data)
        expected_count = meta["width"] * meta["height"]
        pixels = _extract_opaque_pixels(data)
        assert len(pixels) == expected_count, (
            f"{name}: expected {expected_count} opaque pixels "
            f"({meta['width']}×{meta['height']}), got {len(pixels)}. "
            "All cutout-pipeline sprite pixels must be fully opaque (alpha=255). "
            "If count is far below expected, the decoder has a filter-type bug. "
            "If count is below expected due to soft edges, re-tune the generation "
            "to ensure solid_mask_value=1.0 propagates correctly."
        )


# ── Provenance gate ───────────────────────────────────────────────────────────

def test_all_provenance_sidecars_exist(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Each prop sprite must have a .provenance.json sidecar."""
    for name in ALL_PROPS:
        prov_path = PROPS_DIR / name.replace(".png", ".provenance.json")
        assert prov_path.exists(), f"Missing provenance sidecar: {prov_path}"


def test_provenance_required_fields(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Each provenance sidecar must carry model, model_license, prompt, seed."""
    required = {"model", "model_license", "prompt", "seed"}
    for name in ALL_PROPS:
        prov_path = PROPS_DIR / name.replace(".png", ".provenance.json")
        prov = json.loads(prov_path.read_text())
        missing = required - prov.keys()
        assert not missing, (
            f"{name}.provenance.json missing required fields: {missing}"
        )


def test_provenance_prop_class_field(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Each provenance sidecar must declare prop_class (cover or hide)."""
    for name in ALL_PROPS:
        prov_path = PROPS_DIR / name.replace(".png", ".provenance.json")
        prov = json.loads(prov_path.read_text())
        assert "prop_class" in prov, (
            f"{name}.provenance.json missing 'prop_class' field."
        )
        assert prov["prop_class"] in ("cover", "hide"), (
            f"{name}: prop_class must be 'cover' or 'hide', got {prov['prop_class']!r}."
        )


# ── Visual distinguishability gate ────────────────────────────────────────────

def test_cover_vs_hiding_distinguishable_at_16px(prop_bytes):
    """T-0201/T-0223: cover props must read lighter than hiding props at 16px game scale.

    Checks both class-mean AND per-prop strict ordering: every cover prop must
    have higher BT.601 luminance than every hiding prop, with a minimum gap of
    _MIN_COVER_HIDE_GAP luma units between the lightest cover and the darkest
    hiding prop.  Measurements taken after downscaling each sprite to 16px on
    its longest side (game-scale rule; see _downscale_to_game_16px docstring).

    Design rationale (docs/design/13-asset-pipeline.md §3.5 / §6.9):
      - Cover props: exposed, mid-value concrete grey — player crouches behind
        for sight-cone cover only; sound sensors still fire.  Target: ramp10
        dominant (BT.601 ≈ 97).
      - Hiding props: enclosed, dark-bodied — player fully sealed from all
        sensors.  Target: ramp04/ramp00 dominant (BT.601 ≈ 17–58).
    At 16px game scale the luminance gap is the primary visual discriminant.

    xfail marker removed by T-0223: the bug was the mis-decoding stdlib reader,
    not the art.  Per-prop strict ordering is now enforced; re-tuning the locker
    (the only prop whose true luma violated per-prop ordering) ships with this card.
    """
    cover_lumas = {
        n: _mean_luma(_downscale_to_game_16px(prop_bytes[n])) for n in COVER_PROPS
    }
    hide_lumas = {
        n: _mean_luma(_downscale_to_game_16px(prop_bytes[n])) for n in HIDE_PROPS
    }

    cover_mean = sum(cover_lumas.values()) / len(cover_lumas)
    hide_mean = sum(hide_lumas.values()) / len(hide_lumas)

    # Class-mean ordering
    assert cover_mean > hide_mean, (
        f"Cover class mean luma ({cover_mean:.1f}) must exceed hiding class mean "
        f"luma ({hide_mean:.1f}) at 16px game scale.\n"
        f"  Cover: { {n: f'{v:.1f}' for n, v in cover_lumas.items()} }\n"
        f"  Hide:  { {n: f'{v:.1f}' for n, v in hide_lumas.items()} }"
    )

    # Per-prop strict ordering: every cover prop lighter than every hiding prop.
    # Find the pair with the smallest gap (lightest cover vs darkest hide).
    min_cover_name = min(cover_lumas, key=cover_lumas.__getitem__)
    max_hide_name = max(hide_lumas, key=hide_lumas.__getitem__)
    min_cover = cover_lumas[min_cover_name]
    max_hide = hide_lumas[max_hide_name]
    gap = min_cover - max_hide

    assert gap >= _MIN_COVER_HIDE_GAP, (
        f"Per-prop separation at 16px insufficient: "
        f"lightest cover prop '{min_cover_name}' ({min_cover:.1f} luma) must be "
        f"≥ {_MIN_COVER_HIDE_GAP} luma above darkest hiding prop "
        f"'{max_hide_name}' ({max_hide:.1f} luma); actual gap = {gap:.1f}.\n"
        "Every cover prop must read visually lighter than every hiding prop "
        "at game scale — re-tune props so the bands do not overlap.\n"
        f"  Cover lumas: { {n: f'{v:.1f}' for n, v in cover_lumas.items()} }\n"
        f"  Hide lumas:  { {n: f'{v:.1f}' for n, v in hide_lumas.items()} }"
    )


def test_cover_classes_in_provenance_match_expected(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Provenance prop_class labels must match their gameplay role."""
    for name in COVER_PROPS:
        prov = json.loads((PROPS_DIR / name.replace(".png", ".provenance.json")).read_text())
        assert prov["prop_class"] == "cover", (
            f"{name} should have prop_class='cover', got {prov['prop_class']!r}."
        )
    for name in HIDE_PROPS:
        prov = json.loads((PROPS_DIR / name.replace(".png", ".provenance.json")).read_text())
        assert prov["prop_class"] == "hide", (
            f"{name} should have prop_class='hide', got {prov['prop_class']!r}."
        )


# ── T-0233: P-7 compliance (concept_hash) ─────────────────────────────────────
#
# P-7-compliant provenance requires generator resolvable + model_hash
# non-null + concept_hash resolves to the approved concept sheet
# (docs/decision-log.md). The generator/model_hash halves were already true
# for every prop; concept_hash was never wired through (tools/comfy-client's
# generate_cutout had no such parameter until T-0233).


def test_concept_hash_matches_approved_sheet(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Every prop's concept_hash must equal the approved props sheet's own hash."""
    sheet_prov = json.loads(
        (CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.provenance.json").read_text()
    )
    expected = sheet_prov["concept_hash"]
    assert expected == prop_recipes.CONCEPT_HASH, (
        "signal_tower_props_concept_sheet_v1.provenance.json's concept_hash "
        f"({expected}) no longer matches the recipe module's CONCEPT_HASH "
        f"({prop_recipes.CONCEPT_HASH}) -- update "
        "assets/src/props/signal_tower_prop_recipes.py if the sheet was "
        "regenerated."
    )
    for name in ALL_PROPS:
        prov_path = PROPS_DIR / name.replace(".png", ".provenance.json")
        prov = json.loads(prov_path.read_text())
        assert prov.get("concept_hash") == expected, (
            f"{name}.provenance.json concept_hash is {prov.get('concept_hash')!r}, "
            f"expected {expected!r} (the approved signal_tower_props_concept_sheet_v1 "
            "hash) -- this prop is not P-7-compliant."
        )


def test_provenance_concept_source_resolves(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """Every prop's concept_source must resolve to a real, committed file."""
    for name in ALL_PROPS:
        prov_path = PROPS_DIR / name.replace(".png", ".provenance.json")
        prov = json.loads(prov_path.read_text())
        source = prov.get("concept_source")
        assert source, f"{name}.provenance.json is missing concept_source."
        resolved = WORKTREE / source
        assert resolved.is_file(), (
            f"{name}: concept_source {source!r} does not resolve to a file under "
            f"{WORKTREE}"
        )


# ── T-0233: P-3 compliance (committed recipe) ─────────────────────────────────


def test_recipe_covers_every_committed_prop():
    """assets/src/props/signal_tower_prop_recipes.py must define every prop
    currently committed under assets/final/props/signal_tower/ -- a prop
    with no committed recipe is exactly the P-3 gap this card closes."""
    recipe_names = {entry["name"] for entry in prop_recipes.PROP_RECIPES}
    expected_names = {name.replace(".png", "") for name in ALL_PROPS}
    assert recipe_names == expected_names, (
        f"recipe module defines {recipe_names}, expected {expected_names}"
    )


def test_recipe_data_matches_committed_provenance(ensure_signal_tower_prop_pack):  # noqa: ARG001
    """The committed recipe's prompt/seed/dimensions/class must match what
    actually produced each committed PNG -- otherwise the recipe documents
    a *different* asset than the one in the repo, which is worse than no
    recipe at all."""
    for entry in prop_recipes.PROP_RECIPES:
        name = f"{entry['name']}.png"
        prov = json.loads((PROPS_DIR / name.replace(".png", ".provenance.json")).read_text())
        assert prov["prompt"] == entry["prompt"], f"{name}: prompt mismatch"
        assert prov["negative_prompt"] == entry["negative_prompt"], (
            f"{name}: negative_prompt mismatch"
        )
        assert prov["seed"] == entry["seed"], f"{name}: seed mismatch"
        assert prov["prop_class"] == entry["prop_class"], f"{name}: prop_class mismatch"
        expected_w, expected_h = PROP_DIMS[name]
        assert (entry["width"], entry["height"]) == (expected_w, expected_h), (
            f"{name}: recipe game-px dims {(entry['width'], entry['height'])} != "
            f"expected {(expected_w, expected_h)}"
        )


# ── T-0233: full asset-gate visibility check (T-0215 failure mode) ───────────


def test_all_props_pass_rendered_visibility_gate(prop_bytes):
    """Every prop must pass the real T-0215 visibility gate
    (asset_gate.visibility.check_rendered_visibility): not fully transparent,
    and not blank/uniform among its opaque pixels. This is the actual gate
    function CI runs elsewhere in the pipeline (assets/src/tiles), not a
    reimplementation of its logic."""
    for name, data in prop_bytes.items():
        image = Image.open(io.BytesIO(data))
        result = asset_gate_visibility.check_rendered_visibility(image)
        assert result.passed, f"{name} failed asset_gate visibility check: {result.reason}"


# ── T-0233: per-pair value separation (no prop hides inside a class mean) ────


def test_each_cover_hide_pair_meets_min_gap(prop_bytes):
    """Every individual (cover, hide) pair must independently satisfy the
    16px luma gap -- not just the lightest-cover-vs-darkest-hide pair the
    aggregate test above checks. Reports every pair's actual gap so a
    regression names the specific prop, not just a class mean."""
    lumas = {
        n: _mean_luma(_downscale_to_game_16px(prop_bytes[n])) for n in ALL_PROPS
    }
    failures = []
    gaps = {}
    for cover_name, hide_name in itertools.product(COVER_PROPS, HIDE_PROPS):
        gap = lumas[cover_name] - lumas[hide_name]
        gaps[(cover_name, hide_name)] = gap
        if gap < _MIN_COVER_HIDE_GAP:
            failures.append(
                f"{cover_name} ({lumas[cover_name]:.1f}) vs {hide_name} "
                f"({lumas[hide_name]:.1f}): gap {gap:.1f} < {_MIN_COVER_HIDE_GAP}"
            )
    assert not failures, (
        "Per-pair 16px luma separation failed for:\n  " + "\n  ".join(failures) +
        f"\nAll measured pairs: { {f'{c}/{h}': f'{g:.1f}' for (c, h), g in gaps.items()} }"
    )
