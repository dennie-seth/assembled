"""Standalone runner: generate player concept sheet PNG + provenance (stdlib only).

Used to produce the committed artifact when pytest cannot run (no venv yet).
Mirrors the logic in tests/conftest.py exactly.
"""
from __future__ import annotations

import binascii
import hashlib
import json
import struct
import zlib
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[3]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
OUT_PNG = CONCEPT_DIR / "player_character_concept_sheet_v1.png"
OUT_PROV = CONCEPT_DIR / "player_character_concept_sheet_v1.provenance.json"

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

BG = PAL["ramp01"]
CANVAS = PAL["ramp00"]
BORDER = PAL["ramp04"]
SHADOW = PAL["ramp02"]
BODY_DRK = PAL["ramp05"]
BODY_MID = PAL["ramp07"]
BODY_HI = PAL["ramp09"]
HEAD_DRK = PAL["ramp08"]
HEAD_MID = PAL["ramp10"]
HEAD_HI = PAL["ramp12"]

W, H = 1024, 1024


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


def _idle(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    _fill_rect(px, cx - 9 * s, cy + 19 * s, cx + 9 * s, cy + 20 * s, SHADOW)
    _fill_rect(px, cx - 8 * s, cy + 5 * s, cx - 3 * s, cy + 19 * s, BODY_DRK)
    _fill_rect(px, cx + 3 * s, cy + 5 * s, cx + 8 * s, cy + 19 * s, BODY_DRK)
    _fill_rect(px, cx - 7 * s, cy + 6 * s, cx - 4 * s, cy + 18 * s, BODY_MID)
    _fill_rect(px, cx + 4 * s, cy + 6 * s, cx + 7 * s, cy + 18 * s, BODY_MID)
    _fill_rect(px, cx - 9 * s, cy - 8 * s, cx + 9 * s, cy + 5 * s, BODY_DRK)
    _fill_rect(px, cx - 8 * s, cy - 7 * s, cx + 8 * s, cy + 4 * s, BODY_MID)
    _fill_rect(px, cx - 6 * s, cy - 7 * s, cx - 3 * s, cy + 3 * s, BODY_HI)
    _fill_rect(px, cx - 13 * s, cy - 8 * s, cx - 9 * s, cy + 3 * s, BODY_DRK)
    _fill_rect(px, cx + 9 * s, cy - 8 * s, cx + 13 * s, cy + 3 * s, BODY_DRK)
    _fill_rect(px, cx - 3 * s, cy - 12 * s, cx + 3 * s, cy - 8 * s, HEAD_DRK)
    _fill_rect(px, cx - 6 * s, cy - 20 * s, cx + 6 * s, cy - 12 * s, HEAD_DRK)
    _fill_rect(px, cx - 5 * s, cy - 19 * s, cx + 5 * s, cy - 13 * s, HEAD_MID)
    _fill_rect(px, cx - 4 * s, cy - 19 * s, cx - 1 * s, cy - 14 * s, HEAD_HI)


def _walk(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    _fill_rect(px, cx - 10 * s, cy + 19 * s, cx + 10 * s, cy + 20 * s, SHADOW)
    _fill_rect(px, cx + 1 * s, cy + 4 * s, cx + 6 * s, cy + 19 * s, BODY_DRK)
    _fill_rect(px, cx + 2 * s, cy + 5 * s, cx + 5 * s, cy + 18 * s, BODY_MID)
    _fill_rect(px, cx - 9 * s, cy - 8 * s, cx + 9 * s, cy + 5 * s, BODY_DRK)
    _fill_rect(px, cx - 8 * s, cy - 7 * s, cx + 8 * s, cy + 4 * s, BODY_MID)
    _fill_rect(px, cx - 6 * s, cy - 7 * s, cx - 3 * s, cy + 3 * s, BODY_HI)
    _fill_rect(px, cx - 8 * s, cy + 4 * s, cx - 3 * s, cy + 19 * s, BODY_DRK)
    _fill_rect(px, cx - 7 * s, cy + 5 * s, cx - 4 * s, cy + 18 * s, BODY_MID)
    _fill_rect(px, cx - 14 * s, cy - 5 * s, cx - 9 * s, cy + 5 * s, BODY_DRK)
    _fill_rect(px, cx + 9 * s, cy - 8 * s, cx + 14 * s, cy + 1 * s, BODY_DRK)
    _fill_rect(px, cx - 3 * s, cy - 12 * s, cx + 3 * s, cy - 8 * s, HEAD_DRK)
    _fill_rect(px, cx - 6 * s, cy - 20 * s, cx + 6 * s, cy - 12 * s, HEAD_DRK)
    _fill_rect(px, cx - 5 * s, cy - 19 * s, cx + 5 * s, cy - 13 * s, HEAD_MID)
    _fill_rect(px, cx - 4 * s, cy - 19 * s, cx - 1 * s, cy - 14 * s, HEAD_HI)


def _crouch(px: bytearray, cx: int, cy: int, s: int = 8) -> None:
    _fill_rect(px, cx - 12 * s, cy + 9 * s, cx + 12 * s, cy + 10 * s, SHADOW)
    _fill_rect(px, cx - 12 * s, cy - 2 * s, cx - 5 * s, cy + 9 * s, BODY_DRK)
    _fill_rect(px, cx + 5 * s, cy - 2 * s, cx + 12 * s, cy + 9 * s, BODY_DRK)
    _fill_rect(px, cx - 11 * s, cy - 1 * s, cx - 6 * s, cy + 8 * s, BODY_MID)
    _fill_rect(px, cx + 6 * s, cy - 1 * s, cx + 11 * s, cy + 8 * s, BODY_MID)
    _fill_rect(px, cx - 10 * s, cy - 10 * s, cx + 10 * s, cy, BODY_DRK)
    _fill_rect(px, cx - 9 * s, cy - 9 * s, cx + 9 * s, cy - 1 * s, BODY_MID)
    _fill_rect(px, cx - 7 * s, cy - 9 * s, cx - 4 * s, cy - 2 * s, BODY_HI)
    _fill_rect(px, cx - 14 * s, cy - 8 * s, cx - 10 * s, cy, BODY_DRK)
    _fill_rect(px, cx + 10 * s, cy - 8 * s, cx + 14 * s, cy, BODY_DRK)
    _fill_rect(px, cx - 3 * s, cy - 14 * s, cx + 3 * s, cy - 10 * s, HEAD_DRK)
    _fill_rect(px, cx - 6 * s, cy - 22 * s, cx + 6 * s, cy - 14 * s, HEAD_DRK)
    _fill_rect(px, cx - 5 * s, cy - 21 * s, cx + 5 * s, cy - 15 * s, HEAD_MID)
    _fill_rect(px, cx - 4 * s, cy - 21 * s, cx - 1 * s, cy - 16 * s, HEAD_HI)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def _encode_png(pixels: bytearray, w: int, h: int) -> bytes:
    ihdr_data = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(pixels[y * w * 3:(y + 1) * w * 3])
    compressed = zlib.compress(bytes(raw), level=6)
    sig = b"\x89PNG\r\n\x1a\n"
    return (sig
            + _png_chunk(b"IHDR", ihdr_data)
            + _png_chunk(b"IDAT", compressed)
            + _png_chunk(b"IEND", b""))


MARGIN, GUTTER = 16, 8
PW = (W - 2 * MARGIN - GUTTER) // 2
PH = (H - 2 * MARGIN - GUTTER) // 2


def generate() -> None:
    pxbuf = _make_canvas(W, H, CANVAS)

    def panel(row: int, col: int) -> tuple[int, int]:
        return (MARGIN + col * (PW + GUTTER), MARGIN + row * (PH + GUTTER))

    for r in range(2):
        for c in range(2):
            x0, y0 = panel(r, c)
            _fill_rect(pxbuf, x0, y0, x0 + PW - 1, y0 + PH - 1, BG)
            _draw_border(pxbuf, x0, y0, x0 + PW - 1, y0 + PH - 1, BORDER, 2)

    x0, y0 = panel(0, 0)
    _idle(pxbuf, x0 + PW // 2, y0 + PH // 2 + 40, s=8)

    x0, y0 = panel(0, 1)
    _walk(pxbuf, x0 + PW // 2, y0 + PH // 2 + 40, s=8)

    x0, y0 = panel(1, 0)
    _crouch(pxbuf, x0 + PW // 2, y0 + PH // 2 + 20, s=8)

    x0, y0 = panel(1, 1)
    S4, CELL = 4, 48 * 4
    grid_l, grid_t = x0 + (PW - 3 * CELL) // 2, y0 + 30
    for r in range(3):
        for c in range(3):
            gx, gy = grid_l + c * CELL, grid_t + r * CELL
            _fill_rect(pxbuf, gx, gy, gx + CELL - 1, gy + CELL - 1, BG)
            _draw_border(pxbuf, gx, gy, gx + CELL - 1, gy + CELL - 1, BORDER, 1)
    _idle(pxbuf, grid_l + CELL // 2, grid_t + CELL // 2 + 6 * S4, s=S4)

    slots = list(PAL.values())
    sw_w, sw_h, sw_gap = 32, 24, 4
    sw_total = len(slots) * (sw_w + sw_gap) - sw_gap
    sw_x = x0 + (PW - sw_total) // 2
    sw_y = grid_t + 3 * CELL + 26
    for rgb in slots:
        _fill_rect(pxbuf, sw_x, sw_y, sw_x + sw_w - 1, sw_y + sw_h - 1, rgb)
        sw_x += sw_w + sw_gap

    png_bytes = _encode_png(pxbuf, W, H)
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    OUT_PNG.write_bytes(png_bytes)
    concept_hash = hashlib.sha256(png_bytes).hexdigest()

    prov = {
        "model": (
            "synth -- programmatic stdlib-only generation (T-0209 fallback; "
            "SDXL blocked by WSL->Windows Firewall)"
        ),
        "model_license": "N/A -- no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": None,
        "prompt": (
            "flat side-on character concept sheet, 4 reference panels: idle standing, "
            "walk mid-stride, crouch-hide, scale reference + palette family. "
            "Player figure: 40px tall in 48x48 cell, institutional green clothing, "
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
            "Synthetic reference -- replace with SDXL generation via "
            "player_character_concept_sheet_v1.recipe.json once WSL->ComfyUI is accessible. "
            "Same swap path as T-0198/T-0199 sprite sheets."
        ),
    }
    OUT_PROV.write_text(json.dumps(prov, indent=2))
    print(f"wrote {OUT_PNG} ({OUT_PNG.stat().st_size} bytes)")
    print(f"wrote {OUT_PROV}")
    print(f"concept_hash: {concept_hash}")


if __name__ == "__main__":
    generate()
