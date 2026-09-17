"""Standalone runner: generate entities concept sheet PNG + provenance (stdlib only).

T-0210 — Concept art: three entities (Watcher / Sound / Still Air).

Produces a 1024×1024 full-colour (RGB) PNG at:
  assets/src/concept/entities_concept_sheet_v1.png

with a sidecar at:
  assets/src/concept/entities_concept_sheet_v1.provenance.json

This is the same programmatic fallback used for T-0209 (player concept sheet):
ComfyUI is not reachable from WSL (Windows Firewall). The image carries the
silhouette, pose direction, and palette family needed to seed T-0200-iter-2
via IP-Adapter/img2img conditioning (T-0106 path). Replace with an
SDXL-generated sheet once WSL->ComfyUI access is resolved (recipe:
entities_concept_sheet_v1.recipe.json).

Design per `docs/design/13-asset-pipeline.md` §6.9 concept-sheet requirements:
- Flat side-on elevation, no perspective/vanishing point
- Reference-layout panels (not a composed scene)
- Hard value separation: darks dark, lights light

Entity silhouettes match synth_entities.py (T-0200) cell geometry:
- Watcher: wide compact orb (rows 14:34, cols 10:38 in 48×48 cell)
- Sound: wide flat wave-band (rows 18:30, cols 8:40 in 48×48 cell)
- Still Air: tall narrow column (rows 8:40, cols 20:28 in 48×48 cell)

Three states shown per entity (cols: Watcher | Sound | Still Air):
  Row 0 — IDLE: entity at neutral centred position
  Row 1 — MOVE: entity at max horizontal drift offset
  Row 2 — TRAPPED: entity at neutral with containment cage overlay

Layout: 2×2 large panels (PW=PH=492px):
  Panel (0,0) — IDLE: all 3 entities side-by-side, scale ×4
  Panel (0,1) — MOVE: all 3 entities drifted, scale ×4
  Panel (1,0) — TRAPPED: all 3 entities with cage, scale ×4
  Panel (1,1) — SCALE REF: all 3 entities at ×2, palette swatches

Mirrors logic in tests/conftest.py exactly.
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
OUT_PNG = CONCEPT_DIR / "entities_concept_sheet_v1.png"
OUT_PROV = CONCEPT_DIR / "entities_concept_sheet_v1.provenance.json"

# ── Home palette (assets/final/palette/home_palette.json) ────────────────────
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

CANVAS   = PAL["ramp00"]  # near-black outer background
BG       = PAL["ramp01"]  # panel fill — deep shadow
BORDER   = PAL["ramp04"]  # panel / cage border
LABEL_C  = PAL["ramp13"]  # label text colour

# Entity body colours (home palette family — concept sheet is full-colour)
#   Watcher: surveillance orb — concrete mid + darker lens
WATCHER_BODY  = PAL["ramp06"]  # concrete mid
WATCHER_LENS  = PAL["ramp04"]  # darker accent (lens/sensor)
#   Sound: wave-band — institutional green + lighter crest
SOUND_BODY    = PAL["ramp07"]  # institutional green mid
SOUND_CREST   = PAL["ramp11"]  # institutional green light (crest accent)
#   Still Air: atmospheric column — concrete with lighter cap
STILLAIR_BODY = PAL["ramp08"]  # concrete mid-light
STILLAIR_CAP  = PAL["ramp14"]  # near-white shadow (cap glow)

CAGE_BAR      = PAL["ramp12"]  # light grey — trap/lock cage bars

W, H = 1024, 1024


# ── Pixel helpers ─────────────────────────────────────────────────────────────

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
    x0, x1 = max(0, min(x0, W - 1)), max(0, min(x1, W - 1))
    y0, y1 = max(0, min(y0, H - 1)), max(0, min(y1, H - 1))
    r, g, b = rgb
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            i = (y * W + x) * 3
            px[i], px[i + 1], px[i + 2] = r, g, b


def _draw_border(px: bytearray, x0: int, y0: int, x1: int, y1: int,
                 rgb: tuple, thick: int = 2) -> None:
    for t in range(thick):
        for x in range(x0 + t, x1 - t + 1):
            _set(px, x, y0 + t, rgb)
            _set(px, x, y1 - t, rgb)
        for y in range(y0 + t, y1 - t + 1):
            _set(px, x0 + t, y, rgb)
            _set(px, x1 - t, y, rgb)


# ── Entity drawing (all relative to cell centre cx, cy at scale s) ────────────
#
# Silhouette geometry from synth_entities.py (T-0200):
#   Cell: 48×48. Centre at (24, 24) in cell-local coords.
#   Body rect given as [r0:r1, c0:c1] in cell-local coords.
#   Relative to centre: row_rel = row - 24, col_rel = col - 24.
#
#   Watcher body [14:34, 10:38]: rows_rel [-10, +10], cols_rel [-14, +14]
#   Watcher lens [28:34, 16:32]: rows_rel [+4, +10],  cols_rel [-8, +8]
#
#   Sound body  [18:30, 8:40]:   rows_rel [-6, +6],   cols_rel [-16, +16]
#   Sound crest [18:22, 14:34]:  rows_rel [-6, -2],   cols_rel [-10, +10]
#
#   Still Air body [8:40, 20:28]: rows_rel [-16, +16], cols_rel [-4, +4]
#   Still Air cap  [8:12, 22:26]: rows_rel [-16, -12], cols_rel [-2, +2]

def _watcher(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Wide compact surveillance orb."""
    ox = h_off
    _fill_rect(px, cx - 14*s + ox, cy - 10*s, cx + 14*s + ox, cy + 10*s, WATCHER_BODY)
    _fill_rect(px, cx - 8*s + ox,  cy + 4*s,  cx + 8*s + ox,  cy + 10*s, WATCHER_LENS)


def _sound(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Wide flat wave-band entity."""
    ox = h_off
    _fill_rect(px, cx - 16*s + ox, cy - 6*s, cx + 16*s + ox, cy + 6*s, SOUND_BODY)
    _fill_rect(px, cx - 10*s + ox, cy - 6*s, cx + 10*s + ox, cy - 2*s, SOUND_CREST)


def _still_air(px: bytearray, cx: int, cy: int, s: int, h_off: int = 0) -> None:
    """Tall narrow atmospheric column entity."""
    ox = h_off
    _fill_rect(px, cx - 4*s + ox, cy - 16*s, cx + 4*s + ox, cy + 16*s, STILLAIR_BODY)
    _fill_rect(px, cx - 2*s + ox, cy - 16*s, cx + 2*s + ox, cy - 12*s, STILLAIR_CAP)


def _cage(px: bytearray, cx: int, cy: int, half_w: int, half_h: int, s: int) -> None:
    """Trap/lock cage overlay: outer border + two vertical bars.

    half_w, half_h in pixels (already at display scale).
    """
    pad = 2 * s
    x0 = cx - half_w - pad
    x1 = cx + half_w + pad
    y0 = cy - half_h - pad
    y1 = cy + half_h + pad
    _draw_border(px, x0, y0, x1, y1, CAGE_BAR, 1)
    # Two vertical bars through the entity (every third of cage width)
    third = (x1 - x0) // 3
    for bx in [x0 + third, x0 + 2 * third]:
        _fill_rect(px, bx, y0, bx + 1, y1, CAGE_BAR)


# ── Panel layout ──────────────────────────────────────────────────────────────

MARGIN = 16
GUTTER = 8
PW = (W - 2 * MARGIN - GUTTER) // 2   # 492
PH = (H - 2 * MARGIN - GUTTER) // 2   # 492

# Scale for entity panels (×4): entities are legible, sections don't overflow.
SCALE = 4

# Section layout within a panel (3 equal horizontal sections for 3 entities)
SEC_W = PW // 3   # 164px


def _panel_origin(row: int, col: int) -> tuple[int, int]:
    return (MARGIN + col * (PW + GUTTER), MARGIN + row * (PH + GUTTER))


def _entity_centres(panel_x0: int, panel_y0: int) -> list[tuple[int, int]]:
    """(cx, cy) for Watcher, Sound, Still Air within a panel."""
    cy = panel_y0 + PH // 2
    centres = []
    for i in range(3):
        cx = panel_x0 + SEC_W * i + SEC_W // 2
        centres.append((cx, cy))
    return centres


def _draw_panel_frame(px: bytearray, x0: int, y0: int) -> None:
    _fill_rect(px, x0, y0, x0 + PW - 1, y0 + PH - 1, BG)
    _draw_border(px, x0, y0, x0 + PW - 1, y0 + PH - 1, BORDER, 2)


def _draw_section_dividers(px: bytearray, x0: int, y0: int) -> None:
    """Thin vertical lines separating the three entity sections."""
    for i in (1, 2):
        sx = x0 + SEC_W * i
        _fill_rect(px, sx, y0 + 2, sx, y0 + PH - 3, BORDER)


# ── Sheet generation ──────────────────────────────────────────────────────────

def _generate_entities_concept_png(out_path: Path) -> str:
    """Build 1024×1024 RGB entities concept sheet; return its sha256 hex digest."""
    px = _make_canvas(W, H, CANVAS)

    # Draw all four panel frames
    for r in range(2):
        for c in range(2):
            x0, y0 = _panel_origin(r, c)
            _draw_panel_frame(px, x0, y0)

    # ── Panel (0,0) — IDLE: all entities at neutral centred position ──────────
    x0, y0 = _panel_origin(0, 0)
    _draw_section_dividers(px, x0, y0)
    centres = _entity_centres(x0, y0)
    _watcher(px, *centres[0], SCALE)
    _sound(px, *centres[1], SCALE)
    _still_air(px, *centres[2], SCALE)

    # ── Panel (0,1) — MOVE: entities at max horizontal drift offset ───────────
    # Max native offsets from synth_entities.py: Watcher ±6px, Sound ±6px, Still Air ±3px
    x0, y0 = _panel_origin(0, 1)
    _draw_section_dividers(px, x0, y0)
    centres = _entity_centres(x0, y0)
    _watcher(px, *centres[0], SCALE, h_off=6 * SCALE)      # max rightward drift
    _sound(px, *centres[1], SCALE, h_off=6 * SCALE)        # max rightward drift
    _still_air(px, *centres[2], SCALE, h_off=3 * SCALE)    # max rightward drift (smaller sway)

    # ── Panel (1,0) — TRAPPED: entities at neutral with cage overlay ──────────
    x0, y0 = _panel_origin(1, 0)
    _draw_section_dividers(px, x0, y0)
    centres = _entity_centres(x0, y0)
    # Draw entities first, then overlay cages
    _watcher(px, *centres[0], SCALE)
    _sound(px, *centres[1], SCALE)
    _still_air(px, *centres[2], SCALE)
    _cage(px, *centres[0], 14 * SCALE, 10 * SCALE, SCALE)
    _cage(px, *centres[1], 16 * SCALE, 6 * SCALE, SCALE)
    _cage(px, *centres[2], 4 * SCALE, 16 * SCALE, SCALE)

    # ── Panel (1,1) — SCALE REFERENCE: ×2 roster comparison + palette ─────────
    x0, y0 = _panel_origin(1, 1)
    s2 = 2   # scale ×2 for the reference panel
    _draw_section_dividers(px, x0, y0)
    ref_centres = _entity_centres(x0, y0)
    # Shift up a bit to leave room for palette swatches below
    ref_cy_offset = -30
    _watcher(px, ref_centres[0][0], ref_centres[0][1] + ref_cy_offset, s2)
    _sound(px, ref_centres[1][0], ref_centres[1][1] + ref_cy_offset, s2)
    _still_air(px, ref_centres[2][0], ref_centres[2][1] + ref_cy_offset, s2)

    # Palette swatches below the reference entities
    slots = list(PAL.values())
    sw_w, sw_h, sw_gap = 32, 24, 4
    sw_total = len(slots) * (sw_w + sw_gap) - sw_gap
    sw_x = x0 + (PW - sw_total) // 2
    sw_y = y0 + PH - sw_h - 20
    for rgb in slots:
        _fill_rect(px, sw_x, sw_y, sw_x + sw_w - 1, sw_y + sw_h - 1, rgb)
        sw_x += sw_w + sw_gap

    # Encode and write
    png_bytes = _encode_png(px, W, H)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes)
    return hashlib.sha256(png_bytes).hexdigest()


# ── PNG encoding (stdlib only) ────────────────────────────────────────────────

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


# ── Provenance ────────────────────────────────────────────────────────────────

def _generate_provenance(concept_hash: str, out_path: Path) -> None:
    prov = {
        "model": (
            "synth -- programmatic stdlib-only generation (T-0210 fallback; "
            "SDXL blocked by WSL->Windows Firewall)"
        ),
        "model_license": "N/A -- no AI model used; Python stdlib only (struct, zlib, binascii)",
        "model_hash": None,
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
            "Panel 1 (MOVE): all three entities at maximum horizontal drift (Watcher/Sound 6px, Still Air 3px native). "
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


# ── Entrypoint ────────────────────────────────────────────────────────────────

def generate() -> None:
    concept_hash = _generate_entities_concept_png(OUT_PNG)
    _generate_provenance(concept_hash, OUT_PROV)
    print(f"wrote {OUT_PNG} ({OUT_PNG.stat().st_size} bytes)")
    print(f"wrote {OUT_PROV}")
    print(f"concept_hash: {concept_hash}")


if __name__ == "__main__":
    generate()
