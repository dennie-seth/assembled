"""Concept-test fixtures for T-0209.

The session-scoped `ensure_concept_sheet` fixture (autouse=True) generates
`assets/src/concept/player_character_concept_sheet_v1.png` and its
`.provenance.json` sidecar before any test runs, using only Python stdlib
(struct, zlib, hashlib, binascii — no Pillow, no numpy).

This is the same conftest-generation pattern used in T-0198/T-0199 for
character sprite sheets: the artifact is produced as a test-session side
effect so the verify step (which runs pytest) both creates and validates the
artifact in a single pass. After verification, the PNG is committed.

PNG encoding details:
  - 1024×1024 RGB truecolour (colour type 2, bit depth 8)
  - Filter method 0 (None) on every scanline
  - zlib.compress() deflate, level 6
  - CRC32 via binascii.crc32
"""

from __future__ import annotations

import binascii
import hashlib
import json
import struct
import zlib
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
OUT_PNG = CONCEPT_DIR / "player_character_concept_sheet_v1.png"
OUT_PROV = CONCEPT_DIR / "player_character_concept_sheet_v1.provenance.json"

# ── Home palette (assets/final/palette/home_palette.json) ─────────────────
PAL = {
    "ramp00": (0x12, 0x11, 0x0e),
    "ramp01": (0x1a, 0x19, 0x16),
    "ramp02": (0x0b, 0x2d, 0x18),
    "ramp03": (0x12, 0x3c, 0x23),
    "ramp04": (0x3d, 0x3b, 0x31),
    "ramp05": (0x22, 0x4d, 0x32),
    "ramp06": (0x49, 0x49, 0x3b),
    "ramp07": (0x4c, 0x55, 0x3a),
    "ramp08": (0x58, 0x55, 0x4c),
    "ramp09": (0x5a, 0x60, 0x42),
    "ramp10": (0x64, 0x62, 0x58),
    "ramp11": (0x61, 0x67, 0x47),
    "ramp12": (0x71, 0x6f, 0x66),
    "ramp13": (0x7e, 0x7c, 0x74),
    "ramp14": (0x8f, 0x8b, 0x86),
    "ramp15": (0xa8, 0xa4, 0xa0),
}

BG       = PAL["ramp01"]   # panel background
CANVAS   = PAL["ramp00"]   # canvas outer
BORDER   = PAL["ramp04"]   # panel border
SHADOW   = PAL["ramp02"]   # figure shadow
BODY_DRK = PAL["ramp05"]   # clothing shadow
BODY_MID = PAL["ramp07"]   # clothing mid (institutional green)
BODY_HI  = PAL["ramp09"]   # clothing highlight
HEAD_DRK = PAL["ramp08"]   # head shadow
HEAD_MID = PAL["ramp10"]   # head mid
HEAD_HI  = PAL["ramp12"]   # head highlight
LABEL_C  = PAL["ramp13"]   # label colour

W, H = 1024, 1024


# ── Pixel canvas ──────────────────────────────────────────────────────────
# bytearray of W×H×3 bytes, row-major, RGB
def _make_canvas(w: int, h: int, fill: tuple) -> bytearray:
    ba = bytearray(w * h * 3)
    r, g, b = fill
    for i in range(w * h):
        ba[3 * i] = r
        ba[3 * i + 1] = g
        ba[3 * i + 2] = b
    return ba


def _set(px: bytearray, x: int, y: int, rgb: tuple) -> None:
    if 0 <= x < W and 0 <= y < H:
        i = (y * W + x) * 3
        px[i], px[i + 1], px[i + 2] = rgb


def _fill_rect(px: bytearray, x0: int, y0: int, x1: int, y1: int, rgb: tuple) -> None:
    x0, x1 = max(0, x0), min(W - 1, x1)
    y0, y1 = max(0, y0), min(H - 1, y1)
    r, g, b = rgb
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            i = (y * W + x) * 3
            px[i], px[i + 1], px[i + 2] = r, g, b


def _draw_border(px: bytearray, x0: int, y0: int, x1: int, y1: int, rgb: tuple, thick: int = 2) -> None:
    for t in range(thick):
        for x in range(x0 + t, x1 - t + 1):
            _set(px, x, y0 + t, rgb)
            _set(px, x, y1 - t, rgb)
        for y in range(y0 + t, y1 - t + 1):
            _set(px, x0 + t, y, rgb)
            _set(px, x1 - t, y, rgb)


# ── Figure drawing ───────────────────────────────────────────────────────
def _idle(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    """Flat side-on idle pose. Figure spans cy-20s..cy+20s."""
    _fill_rect(px, cx - 9*s, cy + 19*s, cx + 9*s, cy + 20*s, SHADOW)
    _fill_rect(px, cx - 8*s, cy + 5*s, cx - 3*s, cy + 19*s, BODY_DRK)
    _fill_rect(px, cx + 3*s, cy + 5*s, cx + 8*s, cy + 19*s, BODY_DRK)
    _fill_rect(px, cx - 7*s, cy + 6*s, cx - 4*s, cy + 18*s, BODY_MID)
    _fill_rect(px, cx + 4*s, cy + 6*s, cx + 7*s, cy + 18*s, BODY_MID)
    _fill_rect(px, cx - 9*s, cy - 8*s, cx + 9*s, cy + 5*s, BODY_DRK)
    _fill_rect(px, cx - 8*s, cy - 7*s, cx + 8*s, cy + 4*s, BODY_MID)
    _fill_rect(px, cx - 6*s, cy - 7*s, cx - 3*s, cy + 3*s, BODY_HI)
    _fill_rect(px, cx - 13*s, cy - 8*s, cx - 9*s, cy + 3*s, BODY_DRK)
    _fill_rect(px, cx + 9*s, cy - 8*s, cx + 13*s, cy + 3*s, BODY_DRK)
    _fill_rect(px, cx - 3*s, cy - 12*s, cx + 3*s, cy - 8*s, HEAD_DRK)
    _fill_rect(px, cx - 6*s, cy - 20*s, cx + 6*s, cy - 12*s, HEAD_DRK)
    _fill_rect(px, cx - 5*s, cy - 19*s, cx + 5*s, cy - 13*s, HEAD_MID)
    _fill_rect(px, cx - 4*s, cy - 19*s, cx - 1*s, cy - 14*s, HEAD_HI)


def _walk(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    """Flat side-on mid-stride walk pose."""
    _fill_rect(px, cx - 10*s, cy + 19*s, cx + 10*s, cy + 20*s, SHADOW)
    _fill_rect(px, cx + 1*s, cy + 4*s, cx + 6*s, cy + 19*s, BODY_DRK)
    _fill_rect(px, cx + 2*s, cy + 5*s, cx + 5*s, cy + 18*s, BODY_MID)
    _fill_rect(px, cx - 9*s, cy - 8*s, cx + 9*s, cy + 5*s, BODY_DRK)
    _fill_rect(px, cx - 8*s, cy - 7*s, cx + 8*s, cy + 4*s, BODY_MID)
    _fill_rect(px, cx - 6*s, cy - 7*s, cx - 3*s, cy + 3*s, BODY_HI)
    _fill_rect(px, cx - 8*s, cy + 4*s, cx - 3*s, cy + 19*s, BODY_DRK)
    _fill_rect(px, cx - 7*s, cy + 5*s, cx - 4*s, cy + 18*s, BODY_MID)
    _fill_rect(px, cx - 14*s, cy - 5*s, cx - 9*s, cy + 5*s, BODY_DRK)
    _fill_rect(px, cx + 9*s, cy - 8*s, cx + 14*s, cy + 1*s, BODY_DRK)
    _fill_rect(px, cx - 3*s, cy - 12*s, cx + 3*s, cy - 8*s, HEAD_DRK)
    _fill_rect(px, cx - 6*s, cy - 20*s, cx + 6*s, cy - 12*s, HEAD_DRK)
    _fill_rect(px, cx - 5*s, cy - 19*s, cx + 5*s, cy - 13*s, HEAD_MID)
    _fill_rect(px, cx - 4*s, cy - 19*s, cx - 1*s, cy - 14*s, HEAD_HI)


def _crouch(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    """Flat side-on crouch-hide pose."""
    _fill_rect(px, cx - 12*s, cy + 9*s, cx + 12*s, cy + 10*s, SHADOW)
    _fill_rect(px, cx - 12*s, cy - 2*s, cx - 5*s, cy + 9*s, BODY_DRK)
    _fill_rect(px, cx + 5*s, cy - 2*s, cx + 12*s, cy + 9*s, BODY_DRK)
    _fill_rect(px, cx - 11*s, cy - 1*s, cx - 6*s, cy + 8*s, BODY_MID)
    _fill_rect(px, cx + 6*s, cy - 1*s, cx + 11*s, cy + 8*s, BODY_MID)
    _fill_rect(px, cx - 10*s, cy - 10*s, cx + 10*s, cy, BODY_DRK)
    _fill_rect(px, cx - 9*s, cy - 9*s, cx + 9*s, cy - 1*s, BODY_MID)
    _fill_rect(px, cx - 7*s, cy - 9*s, cx - 4*s, cy - 2*s, BODY_HI)
    _fill_rect(px, cx - 14*s, cy - 8*s, cx - 10*s, cy, BODY_DRK)
    _fill_rect(px, cx + 10*s, cy - 8*s, cx + 14*s, cy, BODY_DRK)
    _fill_rect(px, cx - 3*s, cy - 14*s, cx + 3*s, cy - 10*s, HEAD_DRK)
    _fill_rect(px, cx - 6*s, cy - 22*s, cx + 6*s, cy - 14*s, HEAD_DRK)
    _fill_rect(px, cx - 5*s, cy - 21*s, cx + 5*s, cy - 15*s, HEAD_MID)
    _fill_rect(px, cx - 4*s, cy - 21*s, cx - 1*s, cy - 16*s, HEAD_HI)


# ── PNG encoding (stdlib only) ─────────────────────────────────────────────
def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def _encode_png(pixels: bytearray, w: int, h: int) -> bytes:
    # IHDR
    ihdr_data = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    # Scanlines with filter byte 0 (None)
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type None
        raw.extend(pixels[y * w * 3:(y + 1) * w * 3])
    compressed = zlib.compress(bytes(raw), level=6)
    sig = b"\x89PNG\r\n\x1a\n"
    return (sig
            + _png_chunk(b"IHDR", ihdr_data)
            + _png_chunk(b"IDAT", compressed)
            + _png_chunk(b"IEND", b""))


# ── Sheet layout ──────────────────────────────────────────────────────────
MARGIN, GUTTER = 16, 8
PW = (W - 2 * MARGIN - GUTTER) // 2   # 496
PH = (H - 2 * MARGIN - GUTTER) // 2  # 496


def _generate_concept_png(out_path: Path) -> str:
    """Build the 1024×1024 concept sheet and return its sha256 hex digest."""
    px = _make_canvas(W, H, CANVAS)

    def panel(row: int, col: int) -> tuple[int, int]:
        return (MARGIN + col * (PW + GUTTER), MARGIN + row * (PH + GUTTER))

    # Panel frames
    for r in range(2):
        for c in range(2):
            x0, y0 = panel(r, c)
            _fill_rect(px, x0, y0, x0 + PW - 1, y0 + PH - 1, BG)
            _draw_border(px, x0, y0, x0 + PW - 1, y0 + PH - 1, BORDER, 2)

    # Panel 0,0 — Idle
    x0, y0 = panel(0, 0)
    _idle(px, x0 + PW // 2, y0 + PH // 2 + 40, s=8)

    # Panel 0,1 — Walk
    x0, y0 = panel(0, 1)
    _walk(px, x0 + PW // 2, y0 + PH // 2 + 40, s=8)

    # Panel 1,0 — Crouch-hide
    x0, y0 = panel(1, 0)
    _crouch(px, x0 + PW // 2, y0 + PH // 2 + 20, s=8)

    # Panel 1,1 — Scale reference (3×3 grid + idle at ×4 + palette swatches)
    x0, y0 = panel(1, 1)
    S4, CELL = 4, 48 * 4
    grid_l, grid_t = x0 + (PW - 3 * CELL) // 2, y0 + 30
    for r in range(3):
        for c in range(3):
            gx, gy = grid_l + c * CELL, grid_t + r * CELL
            _fill_rect(px, gx, gy, gx + CELL - 1, gy + CELL - 1, BG)
            _draw_border(px, gx, gy, gx + CELL - 1, gy + CELL - 1, BORDER, 1)
    _idle(px, grid_l + CELL // 2, grid_t + CELL // 2 + 6 * S4, s=S4)

    # Palette swatches
    slots = list(PAL.values())
    sw_w, sw_h, sw_gap = 32, 24, 4
    sw_total = len(slots) * (sw_w + sw_gap) - sw_gap
    sw_x = x0 + (PW - sw_total) // 2
    sw_y = grid_t + 3 * CELL + 26
    for rgb in slots:
        _fill_rect(px, sw_x, sw_y, sw_x + sw_w - 1, sw_y + sw_h - 1, rgb)
        sw_x += sw_w + sw_gap

    png_bytes = _encode_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes)
    return hashlib.sha256(png_bytes).hexdigest()


def _generate_provenance(concept_hash: str, out_path: Path) -> None:
    prov = {
        "model": (
            "synth — programmatic stdlib-only generation (T-0209 fallback; "
            "SDXL blocked by WSL→Windows Firewall)"
        ),
        "model_license": "N/A — no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": "N/A — stdlib-only synthetic placeholder; no AI model used (T-0209 fallback)",
        "prompt": (
            "flat side-on character concept sheet, 4 reference panels: idle standing, "
            "walk mid-stride, crouch-hide, scale reference + palette family. "
            "Player figure: 40px tall in 48×48 cell, institutional green clothing, "
            "concrete-grey head/skin, deep shadow values. "
            "Soviet brutalist interior aesthetic. Hard value separation, flat lighting. "
            "No perspective, no vanishing point, no scene composition."
        ),
        "negative_prompt": (
            "perspective, vanishing point, atmospheric haze, depth of field, "
            "bright saturated colors, photorealistic, 3d render, scene composition"
        ),
        "seed": 0,
        "steps": None,
        "cfg": None,
        "width": W,
        "height": H,
        "workflow_hash": None,
        "prompt_id": "synth-T-0209",
        "concept_hash": concept_hash,
        "_note": (
            "Synthetic reference — replace with SDXL generation via "
            "player_character_concept_sheet_v1.recipe.json once WSL→ComfyUI is accessible. "
            "Same swap path as T-0198/T-0199 sprite sheets."
        ),
    }
    out_path.write_text(json.dumps(prov, indent=2))


@pytest.fixture(scope="session", autouse=True)
def ensure_concept_sheet():
    """Generate the concept sheet PNG + provenance if they don't exist yet.

    Autouse so the artifact is always present before any test in this
    session inspects it — same pattern as the character synth fixtures in
    assets/src/character/tests/conftest.py.
    """
    if not OUT_PNG.exists() or not OUT_PROV.exists():
        concept_hash = _generate_concept_png(OUT_PNG)
        _generate_provenance(concept_hash, OUT_PROV)


# ── T-0210 — Entities concept sheet (Watcher / Sound / Still Air) ─────────────

OUT_ENTITIES_PNG = CONCEPT_DIR / "entities_concept_sheet_v1.png"
OUT_ENTITIES_PROV = CONCEPT_DIR / "entities_concept_sheet_v1.provenance.json"

# Entity body colours (home palette, full-colour concept art)
WATCHER_BODY  = PAL["ramp06"]
WATCHER_LENS  = PAL["ramp04"]
SOUND_BODY    = PAL["ramp07"]
SOUND_CREST   = PAL["ramp11"]
STILLAIR_BODY = PAL["ramp08"]
STILLAIR_CAP  = PAL["ramp14"]
CAGE_BAR      = PAL["ramp12"]


def _watcher(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Wide compact surveillance orb (rows_rel [-10,+10], cols_rel [-14,+14])."""
    ox = h_off
    _fill_rect(px, cx - 14*s + ox, cy - 10*s, cx + 14*s + ox, cy + 10*s, WATCHER_BODY)
    _fill_rect(px, cx - 8*s + ox,  cy + 4*s,  cx + 8*s + ox,  cy + 10*s, WATCHER_LENS)


def _sound(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Wide flat wave-band entity (rows_rel [-6,+6], cols_rel [-16,+16])."""
    ox = h_off
    _fill_rect(px, cx - 16*s + ox, cy - 6*s, cx + 16*s + ox, cy + 6*s, SOUND_BODY)
    _fill_rect(px, cx - 10*s + ox, cy - 6*s, cx + 10*s + ox, cy - 2*s, SOUND_CREST)


def _still_air(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Tall narrow atmospheric column (rows_rel [-16,+16], cols_rel [-4,+4])."""
    ox = h_off
    _fill_rect(px, cx - 4*s + ox, cy - 16*s, cx + 4*s + ox, cy + 16*s, STILLAIR_BODY)
    _fill_rect(px, cx - 2*s + ox, cy - 16*s, cx + 2*s + ox, cy - 12*s, STILLAIR_CAP)


def _entity_cage(px: bytearray, cx: int, cy: int,
                 half_w: int, half_h: int, s: int) -> None:
    """Trap/lock cage overlay: outer 1px border + two interior vertical bars."""
    pad = 2 * s
    x0 = cx - half_w - pad
    x1 = cx + half_w + pad
    y0 = cy - half_h - pad
    y1 = cy + half_h + pad
    _draw_border(px, x0, y0, x1, y1, CAGE_BAR, 1)
    third = (x1 - x0) // 3
    for bx in [x0 + third, x0 + 2 * third]:
        _fill_rect(px, bx, y0, bx + 1, y1, CAGE_BAR)


_E_MARGIN = 16
_E_GUTTER = 8
_E_PW = (W - 2 * _E_MARGIN - _E_GUTTER) // 2   # 492
_E_PH = (H - 2 * _E_MARGIN - _E_GUTTER) // 2   # 492
_E_SEC_W = _E_PW // 3                             # 164  (entity section width)
_E_SCALE = 4


def _e_panel_origin(row: int, col: int) -> tuple[int, int]:
    return (_E_MARGIN + col * (_E_PW + _E_GUTTER),
            _E_MARGIN + row * (_E_PH + _E_GUTTER))


def _e_entity_centres(px0: int, py0: int) -> list[tuple[int, int]]:
    """(cx, cy) for Watcher, Sound, Still Air within a 492×492 panel."""
    cy = py0 + _E_PH // 2
    return [(px0 + _E_SEC_W * i + _E_SEC_W // 2, cy) for i in range(3)]


def _e_panel_frame(px: bytearray, x0: int, y0: int) -> None:
    _fill_rect(px, x0, y0, x0 + _E_PW - 1, y0 + _E_PH - 1, BG)
    _draw_border(px, x0, y0, x0 + _E_PW - 1, y0 + _E_PH - 1, BORDER, 2)


def _e_section_dividers(px: bytearray, x0: int, y0: int) -> None:
    for i in (1, 2):
        sx = x0 + _E_SEC_W * i
        _fill_rect(px, sx, y0 + 2, sx, y0 + _E_PH - 3, BORDER)


def _generate_entities_concept_png(out_path: Path) -> str:
    """Build 1024×1024 RGB entities concept sheet; return sha256 hex digest."""
    px = _make_canvas(W, H, CANVAS)

    for r in range(2):
        for c in range(2):
            x0, y0 = _e_panel_origin(r, c)
            _e_panel_frame(px, x0, y0)

    # Panel (0,0) — IDLE: all three entities at neutral centred position
    x0, y0 = _e_panel_origin(0, 0)
    _e_section_dividers(px, x0, y0)
    cs = _e_entity_centres(x0, y0)
    _watcher(px, *cs[0], _E_SCALE)
    _sound(px, *cs[1], _E_SCALE)
    _still_air(px, *cs[2], _E_SCALE)

    # Panel (0,1) — MOVE: entities at max horizontal drift offset
    x0, y0 = _e_panel_origin(0, 1)
    _e_section_dividers(px, x0, y0)
    cs = _e_entity_centres(x0, y0)
    _watcher(px, *cs[0], _E_SCALE, h_off=6 * _E_SCALE)
    _sound(px, *cs[1], _E_SCALE, h_off=6 * _E_SCALE)
    _still_air(px, *cs[2], _E_SCALE, h_off=3 * _E_SCALE)

    # Panel (1,0) — TRAPPED: entities at neutral with cage overlay
    x0, y0 = _e_panel_origin(1, 0)
    _e_section_dividers(px, x0, y0)
    cs = _e_entity_centres(x0, y0)
    _watcher(px, *cs[0], _E_SCALE)
    _sound(px, *cs[1], _E_SCALE)
    _still_air(px, *cs[2], _E_SCALE)
    _entity_cage(px, *cs[0], 14 * _E_SCALE, 10 * _E_SCALE, _E_SCALE)
    _entity_cage(px, *cs[1], 16 * _E_SCALE,  6 * _E_SCALE, _E_SCALE)
    _entity_cage(px, *cs[2],  4 * _E_SCALE, 16 * _E_SCALE, _E_SCALE)

    # Panel (1,1) — SCALE REF: ×2 roster + palette swatches
    x0, y0 = _e_panel_origin(1, 1)
    _e_section_dividers(px, x0, y0)
    cs2 = _e_entity_centres(x0, y0)
    cy_offset = -30
    _watcher(px, cs2[0][0], cs2[0][1] + cy_offset, 2)
    _sound(px, cs2[1][0], cs2[1][1] + cy_offset, 2)
    _still_air(px, cs2[2][0], cs2[2][1] + cy_offset, 2)
    slots = list(PAL.values())
    sw_w, sw_h, sw_gap = 32, 24, 4
    sw_total = len(slots) * (sw_w + sw_gap) - sw_gap
    sw_x = x0 + (_E_PW - sw_total) // 2
    sw_y = y0 + _E_PH - sw_h - 20
    for rgb in slots:
        _fill_rect(px, sw_x, sw_y, sw_x + sw_w - 1, sw_y + sw_h - 1, rgb)
        sw_x += sw_w + sw_gap

    png_bytes = _encode_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes)
    return hashlib.sha256(png_bytes).hexdigest()


def _generate_entities_provenance(concept_hash: str, out_path: Path) -> None:
    prov = {
        "model": (
            "synth -- programmatic stdlib-only generation (T-0210 fallback; "
            "SDXL blocked by WSL->Windows Firewall)"
        ),
        "model_license": "N/A -- no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": "N/A — stdlib-only synthetic placeholder; no AI model used (T-0210 fallback)",
        "prompt": (
            "flat side-on entity concept reference sheet, three entities: Watcher, Sound, Still Air. "
            "2x2 panel layout (four 492x492px panels). "
            "Watcher: wide compact surveillance orb silhouette (20px tall, 28px wide in 48x48 cell), "
            "concrete-grey body, darker lens/sensor accent on lower body. "
            "Sound: wide flat wave-band silhouette (12px tall, 32px wide in 48x48 cell), "
            "institutional green body, lighter crest accent on upper body. "
            "Still Air: tall narrow atmospheric column silhouette (32px tall, 8px wide in 48x48 cell), "
            "concrete-grey body, near-white cap accent at top. "
            "Panel 0 (IDLE): all three entities at neutral centred position. "
            "Panel 1 (MOVE): all three entities at maximum horizontal drift "
            "(Watcher/Sound 6px, Still Air 3px native). "
            "Panel 2 (TRAPPED): all three entities at neutral with cage/containment overlay bars. "
            "Panel 3 (SCALE REF): all three entities at 2x scale with home palette swatches. "
            "Soviet brutalist interior aesthetic. Hard value separation, flat even lighting. "
            "No perspective, no vanishing point, no scene composition."
        ),
        "negative_prompt": (
            "perspective, vanishing point, atmospheric haze, depth of field, "
            "bright saturated colors, photorealistic, 3d render, scene composition"
        ),
        "seed": 0,
        "steps": None,
        "cfg": None,
        "width": W,
        "height": H,
        "workflow_hash": None,
        "prompt_id": "synth-T-0210",
        "concept_hash": concept_hash,
        "_note": (
            "Synthetic reference -- replace with SDXL generation via "
            "entities_concept_sheet_v1.recipe.json once WSL->ComfyUI is accessible. "
            "Same swap path as T-0209 player concept sheet. "
            "Entity silhouettes match synth_entities.py (T-0200) cell geometry exactly."
        ),
    }
    out_path.write_text(json.dumps(prov, indent=2))


@pytest.fixture(scope="session", autouse=True)
def ensure_entities_concept_sheet():
    """Generate the entities concept sheet PNG + provenance if not yet present.

    Covers Watcher, Sound, Still Air (T-0210). Autouse so the artifact is
    always present before any test in this session inspects it.
    """
    if not OUT_ENTITIES_PNG.exists() or not OUT_ENTITIES_PROV.exists():
        concept_hash = _generate_entities_concept_png(OUT_ENTITIES_PNG)
        _generate_entities_provenance(concept_hash, OUT_ENTITIES_PROV)


# ── T-0211 — Signal Tower props concept sheet (cover + hiding-spot) ────────────

OUT_PROPS_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.png"
OUT_PROPS_PROV = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.provenance.json"

# Prop colours (home palette, full-colour concept art)
# Cover props: mid-to-light value — opaque, open, exposed from above
COVER_BODY  = PAL["ramp10"]  # concrete light  — main face
COVER_SIDE  = PAL["ramp06"]  # concrete mid    — shadow side
COVER_TOP   = PAL["ramp12"]  # concrete pale   — top lit face
COVER_ACCT  = PAL["ramp07"]  # inst. green mid — accent stripe

# Hiding-spot props: dark-bodied enclosed containers, exposed entry only
HIDE_BODY   = PAL["ramp04"]  # concrete dark      — outer shell
HIDE_INSIDE = PAL["ramp00"]  # near-black         — interior void
HIDE_FRAME  = PAL["ramp08"]  # concrete mid-light — door/entry frame
HIDE_HANDLE = PAL["ramp13"]  # concrete lightest  — door handle accent

_P_PW = (W - 2 * _E_MARGIN - _E_GUTTER) // 2   # 492 — same as entity panels
_P_PH = (H - 2 * _E_MARGIN - _E_GUTTER) // 2   # 492


def _p_panel_origin(row: int, col: int) -> tuple[int, int]:
    return (_E_MARGIN + col * (_P_PW + _E_GUTTER),
            _E_MARGIN + row * (_P_PH + _E_GUTTER))


def _p_panel_frame(px: bytearray, x0: int, y0: int) -> None:
    _fill_rect(px, x0, y0, x0 + _P_PW - 1, y0 + _P_PH - 1, BG)
    _draw_border(px, x0, y0, x0 + _P_PW - 1, y0 + _P_PH - 1, BORDER, 2)


def _draw_relay_cabinet(px: bytearray, cx: int, floor_y: int, s: int) -> None:
    """Wide squat relay junction cabinet (cover prop). Game: 36w x 20h."""
    hw = 18 * s
    h  = 20 * s
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y, COVER_BODY)
    _fill_rect(px, cx - hw, floor_y - h, cx - hw + 4*s, floor_y, COVER_SIDE)
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y - h + 3*s, COVER_TOP)
    _fill_rect(px, cx - hw + 4*s, floor_y - 12*s, cx + hw, floor_y - 10*s, COVER_ACCT)


def _draw_crate_stack(px: bytearray, cx: int, floor_y: int, s: int) -> None:
    """Two-crate stack (cover prop). Game: 24w x 28h."""
    hw = 12 * s
    # Bottom crate
    _fill_rect(px, cx - hw, floor_y - 16*s, cx + hw, floor_y, COVER_BODY)
    _fill_rect(px, cx - hw, floor_y - 16*s, cx - hw + 3*s, floor_y, COVER_SIDE)
    _fill_rect(px, cx - hw, floor_y - 16*s, cx + hw, floor_y - 14*s, COVER_TOP)
    # Seam
    _fill_rect(px, cx - hw, floor_y - 17*s, cx + hw, floor_y - 16*s, COVER_SIDE)
    # Top crate (slightly narrower)
    _fill_rect(px, cx - hw + 2*s, floor_y - 28*s, cx + hw - 2*s, floor_y - 17*s, COVER_BODY)
    _fill_rect(px, cx - hw + 2*s, floor_y - 28*s, cx - hw + 5*s, floor_y - 17*s, COVER_SIDE)
    _fill_rect(px, cx - hw + 2*s, floor_y - 28*s, cx + hw - 2*s, floor_y - 26*s, COVER_TOP)


def _draw_low_duct(px: bytearray, cx: int, floor_y: int, s: int) -> None:
    """Horizontal HVAC duct segment (cover prop). Game: 48w x 12h."""
    hw = 24 * s
    h  = 12 * s
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y, COVER_SIDE)
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y - h + 4*s, COVER_TOP)
    _fill_rect(px, cx - hw, floor_y - h, cx - hw + 3*s, floor_y, COVER_ACCT)
    _fill_rect(px, cx + hw - 3*s, floor_y - h, cx + hw, floor_y, COVER_ACCT)


def _draw_locker(px: bytearray, cx: int, floor_y: int, s: int) -> None:
    """Tall narrow standing locker (hiding-spot prop). Game: 14w x 42h."""
    hw = 7 * s
    h  = 42 * s
    # Outer body
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y, HIDE_BODY)
    # Door frame border
    _draw_border(px, cx - hw, floor_y - h, cx + hw, floor_y, HIDE_FRAME, 2)
    # Interior darkness (enclosed space visible through entry)
    gap = 2 * s
    _fill_rect(px, cx - hw + gap, floor_y - h + gap,
               cx + hw - gap, floor_y - gap, HIDE_INSIDE)
    # Door handle
    hh = floor_y - h // 2
    _fill_rect(px, cx + hw - 3*s, hh - s, cx + hw - s, hh + s, HIDE_HANDLE)


def _draw_server_rack(px: bytearray, cx: int, floor_y: int, s: int) -> None:
    """Enclosed server rack cabinet (hiding-spot prop). Game: 20w x 46h."""
    hw = 10 * s
    h  = 46 * s
    _fill_rect(px, cx - hw, floor_y - h, cx + hw, floor_y, HIDE_BODY)
    _draw_border(px, cx - hw, floor_y - h, cx + hw, floor_y, HIDE_FRAME, 3)
    # Interior void
    gap = 3 * s
    _fill_rect(px, cx - hw + gap, floor_y - h + gap,
               cx + hw - gap, floor_y - gap, HIDE_INSIDE)
    # Horizontal rack bars
    inner_h = h - 2 * gap
    for k in range(1, 4):
        bar_y = floor_y - h + gap + k * inner_h // 4
        t = max(1, s // 2)
        _fill_rect(px, cx - hw + gap, bar_y - t, cx + hw - gap, bar_y + t, HIDE_BODY)


def _generate_props_concept_png(out_path: Path) -> str:
    """Build 1024x1024 RGB signal tower props concept sheet; return sha256 hex digest."""
    px = _make_canvas(W, H, CANVAS)

    for r in range(2):
        for c in range(2):
            x0, y0 = _p_panel_origin(r, c)
            _p_panel_frame(px, x0, y0)

    _SEC  = _P_PW // 3   # 164px per cover-prop section
    _HSEC = _P_PW // 2   # 246px per hiding-spot section

    # Panel (0,0) — COVER PROPS: relay cabinet | crate stack | low duct
    x0, y0 = _p_panel_origin(0, 0)
    for i in (1, 2):
        sx = x0 + _SEC * i
        _fill_rect(px, sx, y0 + 2, sx, y0 + _P_PH - 3, BORDER)
    floor_y = y0 + _P_PH - 40
    S_C = 3
    _draw_relay_cabinet(px, x0 + _SEC // 2,              floor_y, S_C)
    _draw_crate_stack(  px, x0 + _SEC + _SEC // 2,       floor_y, S_C)
    _draw_low_duct(     px, x0 + 2 * _SEC + _SEC // 2,   floor_y, S_C)

    # Panel (0,1) — HIDING SPOTS: locker | server rack
    x0, y0 = _p_panel_origin(0, 1)
    sx = x0 + _HSEC
    _fill_rect(px, sx, y0 + 2, sx, y0 + _P_PH - 3, BORDER)
    floor_y_h = y0 + _P_PH - 40
    S_H = 4
    _draw_locker(      px, x0 + _HSEC // 2,           floor_y_h, S_H)
    _draw_server_rack( px, x0 + _HSEC + _HSEC // 2,   floor_y_h, S_H)

    # Panel (1,0) — SCALE REFERENCE: cover prop | player | hiding spot at x2
    x0, y0 = _p_panel_origin(1, 0)
    for i in (1, 2):
        sx = x0 + _SEC * i
        _fill_rect(px, sx, y0 + 2, sx, y0 + _P_PH - 3, BORDER)
    floor_y_r = y0 + _P_PH - 60
    S_R = 2
    _draw_relay_cabinet(px, x0 + _SEC // 2, floor_y_r, S_R)
    # Player silhouette at x2 (head + torso)
    pcx = x0 + _SEC + _SEC // 2
    _fill_rect(px, pcx - 7*S_R, floor_y_r - 14*S_R, pcx + 7*S_R, floor_y_r, BODY_DRK)
    _fill_rect(px, pcx - 6*S_R, floor_y_r - 20*S_R, pcx + 6*S_R, floor_y_r - 14*S_R, HEAD_DRK)
    _draw_locker(px, x0 + 2 * _SEC + _SEC // 2, floor_y_r, S_R)

    # Panel (1,1) — PALETTE SWATCHES
    x0, y0 = _p_panel_origin(1, 1)
    slots = list(PAL.values())
    sw_w, sw_h, sw_gap = 32, 24, 4
    sw_total = len(slots) * (sw_w + sw_gap) - sw_gap
    sw_x = x0 + (_P_PW - sw_total) // 2
    sw_y = y0 + _P_PH - sw_h - 20
    for rgb in slots:
        _fill_rect(px, sw_x, sw_y, sw_x + sw_w - 1, sw_y + sw_h - 1, rgb)
        sw_x += sw_w + sw_gap

    png_bytes = _encode_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes)
    return hashlib.sha256(png_bytes).hexdigest()


def _generate_props_provenance(concept_hash: str, out_path: Path) -> None:
    prov = {
        "model": (
            "synth -- programmatic stdlib-only generation (T-0211 fallback; "
            "SDXL blocked by WSL->Windows Firewall)"
        ),
        "model_license": "N/A -- no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": "N/A — stdlib-only synthetic placeholder; no AI model used (T-0211 fallback)",
        "prompt": (
            "flat side-on prop concept reference sheet, Signal Tower interior props. "
            "Panel 0 (COVER PROPS - sight-cone block only): relay junction cabinet "
            "(wide squat, 36w x 20h game px), crate stack (24w x 28h), "
            "low HVAC duct (48w x 12h). "
            "Cover props are mid-to-light value, open top, exposed -- "
            "block sight-cone but not sound/proximity sensors. "
            "Panel 1 (HIDING SPOT PROPS - all-sensor block, single-occupant, exposed entry only): "
            "standing locker (14w x 42h, dark body, door frame, handle detail), "
            "server rack cabinet (20w x 46h, dark body, interior horizontal bars). "
            "Hiding spot props are dark-bodied enclosed containers -- "
            "interior near-black, entry frame lighter, single-occupant. "
            "Panel 2 (SCALE REFERENCE): relay cabinet + player silhouette + locker at x2 scale. "
            "Panel 3 (PALETTE): home palette swatches. "
            "Soviet brutalist Signal Tower interior. Hard value separation. "
            "No perspective, no vanishing point, no scene composition."
        ),
        "negative_prompt": (
            "perspective, vanishing point, atmospheric haze, depth of field, "
            "bright saturated colors, photorealistic, 3d render, scene composition"
        ),
        "seed": 0,
        "steps": None,
        "cfg": None,
        "width": W,
        "height": H,
        "workflow_hash": None,
        "prompt_id": "synth-T-0211",
        "concept_hash": concept_hash,
        "_note": (
            "Synthetic reference -- replace with SDXL generation via "
            "signal_tower_props_concept_sheet_v1.recipe.json once WSL->ComfyUI is accessible. "
            "Cover props: mid-value, exposed, sight-block only (ss11 s2). "
            "Hiding-spot props: dark-bodied, enclosed, all-sensor block (ss11 s2)."
        ),
    }
    out_path.write_text(json.dumps(prov, indent=2))


@pytest.fixture(scope="session", autouse=True)
def ensure_signal_tower_props_concept_sheet():
    """Generate the signal tower props concept sheet PNG + provenance if not yet present.

    Covers cover props and hiding-spot props (T-0211). Autouse so the
    artifact is always present before any test in this session inspects it.

    If the SDXL-generated PNG already exists (fetched from ComfyUI), this
    fixture is a no-op -- it never overwrites an already-present file.
    """
    if not OUT_PROPS_PNG.exists() or not OUT_PROPS_PROV.exists():
        concept_hash = _generate_props_concept_png(OUT_PROPS_PNG)
        _generate_props_provenance(concept_hash, OUT_PROPS_PROV)


# ── T-0201 — Signal Tower prop pack (cover + hiding-spot final sprites) ────────
#
# Generates 5 RGBA PNG prop sprites at game-pixel resolution into
# assets/final/props/signal_tower/. These represent the BiRefNet cutout output
# (transparent background, opaque prop pixels). Synthetic placeholders until the
# SDXL img2img → BiRefNet pipeline (T-0106) is accessible from WSL.
#
# Sprite sizes (1 game px = 1 sprite px, s=1 in concept drawing convention):
#   relay_cabinet_v1.png  36×20  cover prop — wide squat relay junction cabinet
#   crate_stack_v1.png    24×28  cover prop — two-crate equipment stack
#   low_duct_v1.png       48×12  cover prop — horizontal HVAC duct segment
#   locker_v1.png         14×42  hiding spot — tall narrow standing locker
#   server_rack_v1.png    20×46  hiding spot — enclosed server rack cabinet
#
# Cover props: mid-value palette (ramp10 body, ramp06 shadow, ramp12 top).
# Hiding props: dark palette (ramp04 shell, ramp00 interior, ramp08 frame).
# This luminance separation is the primary visual discriminant at 16px game scale.
#
# Palette entries reuse PAL dict defined at top of this conftest.
# ──────────────────────────────────────────────────────────────────────────────

_PACK_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"

# Cover prop colours (same as concept conftest section above)
_CVER_BODY  = PAL["ramp10"]   # (0x64, 0x62, 0x58) mid concrete grey
_CVER_SIDE  = PAL["ramp06"]   # (0x49, 0x49, 0x3b) shadow side
_CVER_TOP   = PAL["ramp12"]   # (0x71, 0x6f, 0x66) lit top face
_CVER_ACCT  = PAL["ramp07"]   # (0x4c, 0x55, 0x3a) institutional-green accent

# Hiding-spot prop colours (same as concept conftest section above)
_HIDE_BODY   = PAL["ramp04"]  # (0x3d, 0x3b, 0x31) dark concrete shell
_HIDE_INSIDE = PAL["ramp00"]  # (0x12, 0x11, 0x0e) near-black interior void
_HIDE_FRAME  = PAL["ramp08"]  # (0x58, 0x55, 0x4c) entry door / frame
_HIDE_HANDLE = PAL["ramp13"]  # (0x7e, 0x7c, 0x74) door-handle accent


# ── RGBA canvas helpers ────────────────────────────────────────────────────────

def _rgba_canvas(w: int, h: int) -> bytearray:
    """Fully-transparent (alpha=0) RGBA canvas, row-major, 4 bytes per pixel."""
    return bytearray(w * h * 4)


def _set_px(px: bytearray, x: int, y: int, rgb: tuple, w: int, h: int) -> None:
    if 0 <= x < w and 0 <= y < h:
        i = (y * w + x) * 4
        px[i], px[i + 1], px[i + 2], px[i + 3] = rgb[0], rgb[1], rgb[2], 255


def _frect(px: bytearray, x0: int, y0: int, x1: int, y1: int,
           rgb: tuple, w: int, h: int) -> None:
    """Fill an axis-aligned rectangle with a fully-opaque colour."""
    x0, x1 = max(0, x0), min(w - 1, x1)
    y0, y1 = max(0, y0), min(h - 1, y1)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            i = (y * w + x) * 4
            px[i], px[i + 1], px[i + 2], px[i + 3] = rgb[0], rgb[1], rgb[2], 255


def _border_rgba(px: bytearray, x0: int, y0: int, x1: int, y1: int,
                 rgb: tuple, thick: int, w: int, h: int) -> None:
    """Draw a rectangular border (inside the given bounds)."""
    for t in range(thick):
        for x in range(x0 + t, x1 - t + 1):
            _set_px(px, x, y0 + t, rgb, w, h)
            _set_px(px, x, y1 - t, rgb, w, h)
        for y in range(y0 + t, y1 - t + 1):
            _set_px(px, x0 + t, y, rgb, w, h)
            _set_px(px, x1 - t, y, rgb, w, h)


def _encode_rgba_png(pixels: bytearray, w: int, h: int) -> bytes:
    """Encode RGBA pixel buffer (4 bytes/px, row-major) as PNG colour_type=6."""
    ihdr_data = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None) on every scanline
        raw.extend(pixels[y * w * 4:(y + 1) * w * 4])
    compressed = zlib.compress(bytes(raw), level=6)
    sig = b"\x89PNG\r\n\x1a\n"
    return (sig
            + _png_chunk(b"IHDR", ihdr_data)
            + _png_chunk(b"IDAT", compressed)
            + _png_chunk(b"IEND", b""))


# ── Individual prop generators ─────────────────────────────────────────────────

def _gen_relay_cabinet(out_path: Path) -> str:
    """36×20 RGBA — wide squat relay junction cabinet (cover prop).

    Body: COVER_BODY (ramp10).  Left 4px: COVER_SIDE (ramp06).
    Top 3px: COVER_TOP (ramp12).  Mid accent stripe rows 7-9: COVER_ACCT (ramp07).
    """
    W, H, s = 36, 20, 1
    px = _rgba_canvas(W, H)
    cx, floor_y = W // 2, H - 1
    hw = 18 * s
    h  = 20 * s
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y, _CVER_BODY, W, H)
    _frect(px, cx - hw, floor_y - h, cx - hw + 4 * s, floor_y, _CVER_SIDE, W, H)
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y - h + 3 * s, _CVER_TOP, W, H)
    _frect(px, cx - hw + 4 * s, floor_y - 12 * s, cx + hw, floor_y - 10 * s, _CVER_ACCT, W, H)
    png = _encode_rgba_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    return hashlib.sha256(png).hexdigest()


def _gen_crate_stack(out_path: Path) -> str:
    """24×28 RGBA — two-crate equipment stack (cover prop).

    Bottom crate: rows 11-27.  Top crate (2px narrower each side): rows 0-10.
    Seam line at row 10. COVER_BODY / COVER_SIDE / COVER_TOP palette.
    """
    W, H, s = 24, 28, 1
    px = _rgba_canvas(W, H)
    cx, floor_y = W // 2, H - 1
    hw = 12 * s
    # Bottom crate
    _frect(px, cx - hw, floor_y - 16 * s, cx + hw, floor_y, _CVER_BODY, W, H)
    _frect(px, cx - hw, floor_y - 16 * s, cx - hw + 3 * s, floor_y, _CVER_SIDE, W, H)
    _frect(px, cx - hw, floor_y - 16 * s, cx + hw, floor_y - 16 * s + 2 * s, _CVER_TOP, W, H)
    # Seam
    _frect(px, cx - hw, floor_y - 17 * s, cx + hw, floor_y - 16 * s, _CVER_SIDE, W, H)
    # Top crate (2px narrower each side)
    _frect(px, cx - hw + 2 * s, floor_y - 28 * s, cx + hw - 2 * s, floor_y - 17 * s, _CVER_BODY, W, H)
    _frect(px, cx - hw + 2 * s, floor_y - 28 * s, cx - hw + 5 * s, floor_y - 17 * s, _CVER_SIDE, W, H)
    _frect(px, cx - hw + 2 * s, floor_y - 28 * s, cx + hw - 2 * s, floor_y - 28 * s + 2 * s, _CVER_TOP, W, H)
    png = _encode_rgba_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    return hashlib.sha256(png).hexdigest()


def _gen_low_duct(out_path: Path) -> str:
    """48×12 RGBA — horizontal HVAC duct segment (cover prop).

    Body: COVER_SIDE (ramp06).  Top 4px: COVER_TOP (ramp12).
    Left/right 3px caps: COVER_ACCT (ramp07) — end-cap flanges.
    """
    W, H, s = 48, 12, 1
    px = _rgba_canvas(W, H)
    cx, floor_y = W // 2, H - 1
    hw = 24 * s
    h  = 12 * s
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y, _CVER_SIDE, W, H)
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y - h + 4 * s, _CVER_TOP, W, H)
    _frect(px, cx - hw, floor_y - h, cx - hw + 3 * s, floor_y, _CVER_ACCT, W, H)
    _frect(px, cx + hw - 3 * s, floor_y - h, cx + hw, floor_y, _CVER_ACCT, W, H)
    png = _encode_rgba_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    return hashlib.sha256(png).hexdigest()


def _gen_locker(out_path: Path) -> str:
    """14×42 RGBA — tall narrow standing locker (hiding-spot prop).

    Outer shell: HIDE_BODY (ramp04).  Door-frame border 2px: HIDE_FRAME (ramp08).
    Interior void: HIDE_INSIDE (ramp00).  Handle accent 3×3 px: HIDE_HANDLE (ramp13).
    """
    W, H, s = 14, 42, 1
    px = _rgba_canvas(W, H)
    cx, floor_y = W // 2, H - 1
    hw = 7 * s
    h  = 42 * s
    gap = 2 * s
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y, _HIDE_BODY, W, H)
    _border_rgba(px, cx - hw, floor_y - h, cx + hw, floor_y, _HIDE_FRAME, 2, W, H)
    _frect(px, cx - hw + gap, floor_y - h + gap,
           cx + hw - gap, floor_y - gap, _HIDE_INSIDE, W, H)
    # Door handle: right-side centre
    hh = floor_y - h // 2
    _frect(px, cx + hw - 3 * s, hh - s, cx + hw - s, hh + s, _HIDE_HANDLE, W, H)
    png = _encode_rgba_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    return hashlib.sha256(png).hexdigest()


def _gen_server_rack(out_path: Path) -> str:
    """20×46 RGBA — enclosed server rack cabinet (hiding-spot prop).

    Outer shell: HIDE_BODY (ramp04).  Frame border 3px: HIDE_FRAME (ramp08).
    Interior void: HIDE_INSIDE (ramp00).  3 horizontal rack bars at 1/4 intervals.
    """
    W, H, s = 20, 46, 1
    px = _rgba_canvas(W, H)
    cx, floor_y = W // 2, H - 1
    hw = 10 * s
    h  = 46 * s
    gap = 3 * s
    _frect(px, cx - hw, floor_y - h, cx + hw, floor_y, _HIDE_BODY, W, H)
    _border_rgba(px, cx - hw, floor_y - h, cx + hw, floor_y, _HIDE_FRAME, 3, W, H)
    _frect(px, cx - hw + gap, floor_y - h + gap,
           cx + hw - gap, floor_y - gap, _HIDE_INSIDE, W, H)
    # Horizontal rack bars (dividers inside the interior void)
    inner_h = h - 2 * gap
    t = max(1, s // 2)
    for k in range(1, 4):
        bar_y = floor_y - h + gap + k * inner_h // 4
        _frect(px, cx - hw + gap, bar_y - t,
               cx + hw - gap, bar_y + t, _HIDE_BODY, W, H)
    png = _encode_rgba_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    return hashlib.sha256(png).hexdigest()


# ── Provenance sidecar ─────────────────────────────────────────────────────────

_PROP_PROMPTS = {
    "relay_cabinet": (
        "flat side-on relay junction cabinet sprite, cover prop (sight-cone block only), "
        "Signal Tower interior. 36x20 game px RGBA cutout. Wide squat form: "
        "mid-value concrete grey body (ramp10), darker left shadow side (ramp06), "
        "lit top face (ramp12), institutional-green accent stripe at mid-height (ramp07). "
        "Exposed top and sides — player crouches behind for sight-cone cover only, "
        "sound sensors still detect. Soviet brutalist, hard value separation."
    ),
    "crate_stack": (
        "flat side-on two-crate equipment stack sprite, cover prop (sight-cone block only), "
        "Signal Tower interior. 24x28 game px RGBA cutout. Bottom crate rows 11-27, "
        "top crate slightly narrower rows 0-10. Visible seam line. "
        "Mid-value concrete grey (ramp10 body, ramp06 side, ramp12 top). "
        "Fully exposed from above — cover only, not a hiding spot."
    ),
    "low_duct": (
        "flat side-on horizontal HVAC duct segment sprite, cover prop (sight-cone block only), "
        "Signal Tower interior. 48x12 game px RGBA cutout. Wide flat horizontal form. "
        "Duct body: darker concrete grey side (ramp06). Top lit face (ramp12). "
        "Institutional-green end-cap flanges left and right (ramp07). "
        "Low clearance, player slides behind for partial cover."
    ),
    "locker": (
        "flat side-on standing locker sprite, hiding-spot prop (all-sensor block, single-occupant), "
        "Signal Tower interior. 14x42 game px RGBA cutout. Tall narrow form. "
        "Dark concrete outer shell (ramp04), door-frame border lighter (ramp08), "
        "near-black interior visible through entry gap (ramp00), "
        "door-handle accent right side centre (ramp13). "
        "Single-occupant, fully seals all sensors once player enters. Exposed entry only."
    ),
    "server_rack": (
        "flat side-on server rack cabinet sprite, hiding-spot prop (all-sensor block, single-occupant), "
        "Signal Tower interior. 20x46 game px RGBA cutout. Tall enclosed cabinet form. "
        "Dark concrete outer shell (ramp04), heavier frame border (ramp08), "
        "near-black interior with 3 horizontal rack divider bars (ramp04 over ramp00). "
        "Single-occupant, fully seals all sensors. Exposed entry only."
    ),
}

_PROP_CLASSES = {
    "relay_cabinet": "cover",
    "crate_stack": "cover",
    "low_duct": "cover",
    "locker": "hide",
    "server_rack": "hide",
}


def _gen_prop_prov(sprite_hash: str, name: str, out_path: Path) -> None:
    """Write provenance sidecar for a T-0201 prop sprite."""
    prov = {
        "model": (
            "synth -- programmatic stdlib-only generation (T-0201 fallback; "
            "SDXL img2img + BiRefNet pipeline blocked by WSL->Windows Firewall)"
        ),
        "model_license": "N/A -- no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": "N/A — stdlib-only synthetic placeholder; no AI model used (T-0201 fallback)",
        "prompt": _PROP_PROMPTS[name],
        "negative_prompt": (
            "perspective, vanishing point, isometric, background, scene, "
            "depth of field, ambient occlusion, photorealistic, 3d render, "
            "multiple props, composed illustration, text, watermark"
        ),
        "seed": 0,
        "steps": None,
        "cfg": None,
        "width": None,
        "height": None,
        "workflow_hash": None,
        "prompt_id": f"synth-T-0201-{name}",
        "prop_class": _PROP_CLASSES[name],
        "sprite_hash": sprite_hash,
        "_note": (
            "Synthetic placeholder — replace with SDXL img2img (conditioned on "
            "signal_tower_props_concept_sheet_v1.png via IP-Adapter) + BiRefNet "
            "background removal once WSL->ComfyUI is accessible (T-0106 pipeline). "
            "Concept hash source: signal_tower_props_concept_sheet_v1.provenance.json."
        ),
    }
    out_path.write_text(json.dumps(prov, indent=2))


# ── T-0201 fixture ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def ensure_signal_tower_prop_pack():
    """Generate Signal Tower prop pack RGBA sprites if not yet present.

    Produces five RGBA PNG cutout sprites in assets/final/props/signal_tower/:
      relay_cabinet_v1.png  (36×20, cover prop)
      crate_stack_v1.png    (24×28, cover prop)
      low_duct_v1.png       (48×12, cover prop)
      locker_v1.png         (14×42, hiding-spot prop)
      server_rack_v1.png    (20×46, hiding-spot prop)

    Each sprite has a .provenance.json sidecar with prop_class label.
    Autouse ensures the artifacts exist before any test in this session runs.
    If files already exist (e.g. from a real BiRefNet pipeline run), this
    fixture is a no-op — it never overwrites an already-present file.
    """
    _PACK_DIR.mkdir(parents=True, exist_ok=True)
    _generators = [
        ("relay_cabinet_v1.png", _gen_relay_cabinet, "relay_cabinet"),
        ("crate_stack_v1.png",   _gen_crate_stack,   "crate_stack"),
        ("low_duct_v1.png",      _gen_low_duct,      "low_duct"),
        ("locker_v1.png",        _gen_locker,        "locker"),
        ("server_rack_v1.png",   _gen_server_rack,   "server_rack"),
    ]
    for fname, gen_fn, name in _generators:
        png_path  = _PACK_DIR / fname
        prov_path = _PACK_DIR / fname.replace(".png", ".provenance.json")
        if not png_path.exists() or not prov_path.exists():
            sprite_hash = gen_fn(png_path)
            _gen_prop_prov(sprite_hash, name, prov_path)
