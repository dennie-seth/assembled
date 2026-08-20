"""T-0201 — Signal Tower prop pack artifact gate.

Validates that the Signal Tower prop pack sprites exist in
`assets/final/props/signal_tower/` and meet the T-0201 acceptance criteria:

  - Cover props included: relay_cabinet, crate_stack, low_duct
  - Hiding-spot props included: locker, server_rack
  - Cover vs hiding-spot props visually distinguishable at 16px
    (mean luminance of cover opaque pixels > hiding-spot opaque pixels)

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

PNG inspection uses stdlib (struct, zlib) only — no Pillow/numpy dependency.
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"

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


# ── PNG parsing helpers (stdlib only) ─────────────────────────────────────────

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
    """Decompress RGBA PNG and return list of (R,G,B) for all opaque pixels (A>0).

    Assumes colour_type=6 (RGBA, 8-bit), filter type 0 (None) on every
    scanline — both guaranteed by the synth generator used here.
    """
    meta = _parse_ihdr(data)
    assert meta["colour_type"] == 6, "Expected RGBA (colour_type=6)"
    w, h = meta["width"], meta["height"]

    # Collect all IDAT chunks
    idat = bytearray()
    pos = 8
    while pos + 12 <= len(data):
        chunk_len = struct.unpack(">I", data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]
        if chunk_type == b"IDAT":
            idat.extend(data[pos + 8:pos + 8 + chunk_len])
        elif chunk_type == b"IEND":
            break
        pos += 12 + chunk_len

    raw = zlib.decompress(bytes(idat))
    stride = w * 4  # RGBA: 4 bytes per pixel

    opaque = []
    for y in range(h):
        # +1 for filter byte (always 0 for our synth PNG)
        row_start = y * (stride + 1) + 1
        for x in range(w):
            i = row_start + x * 4
            r, g, b, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
            if a > 0:
                opaque.append((r, g, b))
    return opaque


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
    """T-0201 acceptance: cover props must be visually lighter than hiding-spot props.

    Computes BT.601 mean luminance of opaque pixels for each class.
    Cover props are mid-value concrete grey (ramp10, ~luma 97) while hiding-spot
    props are dark-bodied (ramp04 outer shell, ramp00 interior, ~luma <50).
    At 16px game scale this luminance gap is the primary visual discriminant.
    """
    cover_lumas = [
        _mean_luma(_extract_opaque_pixels(prop_bytes[n])) for n in COVER_PROPS
    ]
    hide_lumas = [
        _mean_luma(_extract_opaque_pixels(prop_bytes[n])) for n in HIDE_PROPS
    ]
    cover_mean = sum(cover_lumas) / len(cover_lumas)
    hide_mean = sum(hide_lumas) / len(hide_lumas)

    assert cover_mean > hide_mean, (
        f"Cover props mean luminance ({cover_mean:.1f}) must exceed "
        f"hiding-spot props mean luminance ({hide_mean:.1f}). "
        "Cover props should be mid-value (ramp10), hiding props should be dark (ramp04/ramp00). "
        "This is the primary visual distinguisher at 16px game scale."
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
