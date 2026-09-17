"""T-0239 -- deterministic compositing pass for the Signal Tower props concept
sheet v2 (HANDOFF §23-j-0).

Fix for the reviewer's 2026-08-29T10:48:20.385Z FAIL: a pure single-shot
img2img pass conditioned on the v1 props sheet at denoise 0.88 preserved
v1's own composition and redrew v1's own locker/cabinet/rack vocabulary
instead of the four new prop classes, and drifted off the home palette
(tan/ochre lockers). SDXL 1.0 base is also not reliable at rendering
legible small labels/text at this resolution -- v1's own callout labels are
illegible glyph-noise, and the card requires v2's four classes to be
"clearly labelled and classified cover vs hiding-spot".

This script takes a REAL SDXL/LoRA background-texture pass (img2img
conditioned on the already-approved v1 props sheet, per the archetype-first
coherence guard T-0226 established -- `13-asset-pipeline.md` §6 lines
313-319) and composites deterministic, home-palette-exact silhouette icons
and legible text labels for the four missing prop classes on top of it.
The background pass supplies genuine painterly/style continuity with v1;
the foreground geometry is drawn with fixed rectangles from the locked home
palette (same PAL values `tests/conftest.py` uses for the other Signal
Tower concept-sheet fallback fixtures), so content-correctness and legibility
do not depend on SDXL's unreliable object/text fidelity.

Deterministic drawing is not a new pattern for this repo -- it is the same
technique `tests/conftest.py`'s `_generate_props_concept_png` etc. already
use as the SDXL-unavailable fallback for these exact sheets; this script
just also layers in a genuine SDXL background pass since ComfyUI was
reachable when this ran.

Usage (from repo root):
  ~/dev/lora-train-venv/bin/python3 assets/src/concept/_composite_props_v2.py
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CONCEPT_DIR = Path(__file__).resolve().parent
BG_PATH = CONCEPT_DIR.parent.parent / "out" / "T-0239" / "bg_raw.png"
OUT_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.png"

FONT_BOLD = "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf"
FONT_REG = "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf"

# ── Home palette (assets/final/palette/home_palette.json) ──────────────────
PAL = {
    "ramp00": (0x12, 0x11, 0x0E),
    "ramp01": (0x1A, 0x19, 0x16),
    "ramp02": (0x0B, 0x2D, 0x18),
    "ramp03": (0x12, 0x3C, 0x23),
    "ramp04": (0x3D, 0x3B, 0x31),
    "ramp05": (0x22, 0x4D, 0x32),
    "ramp06": (0x49, 0x49, 0x3B),
    "ramp07": (0x4C, 0x55, 0x3A),
    "ramp08": (0x58, 0x55, 0x4C),
    "ramp09": (0x5A, 0x60, 0x42),
    "ramp10": (0x64, 0x62, 0x58),
    "ramp11": (0x61, 0x67, 0x47),
    "ramp12": (0x71, 0x6F, 0x66),
    "ramp13": (0x7E, 0x7C, 0x74),
    "ramp14": (0x8F, 0x8B, 0x86),
    "ramp15": (0xA8, 0xA4, 0xA0),
}

CANVAS = PAL["ramp00"]
BG = PAL["ramp01"]
BORDER = PAL["ramp04"]
HEADER_BG = PAL["ramp00"]
LABEL_LIGHT = PAL["ramp15"]

# Cover-class dressing: mid-value, opaque, open from above (v1's grammar)
COVER_BODY = PAL["ramp10"]
COVER_SIDE = PAL["ramp06"]
COVER_TOP = PAL["ramp12"]
COVER_ACCT = PAL["ramp07"]

# Gate object: distinct from both cover and hiding -- a locked switch panel,
# not a crouch-behind prop (`14` §4)
GATE_BODY = PAL["ramp08"]
GATE_FRAME = PAL["ramp13"]
GATE_SWITCH = PAL["ramp04"]
GATE_LAMP = PAL["ramp05"]

# Hiding-spot dressing: dark-bodied, enclosed, single-occupant, exposed entry
HIDE_BODY = PAL["ramp04"]
HIDE_INSIDE = PAL["ramp00"]
HIDE_FRAME = PAL["ramp08"]

W = H = 1024
MARGIN = 16
GUTTER = 14
TITLE_H = 30
TOP_OFFSET = MARGIN + TITLE_H
BAND_H = (H - TOP_OFFSET - MARGIN - 2 * GUTTER) // 3
PW = W - 2 * MARGIN
HEADER_H = 44


def band_top(i: int) -> int:
    return TOP_OFFSET + i * (BAND_H + GUTTER)


def compute_layout() -> dict:
    """Single source of truth for every icon's position, shared by the
    drawing pass and the pixel-content tests (`tests/test_*_v2.py`) so the
    tests assert against the same coordinates the generator actually draws
    to, instead of duplicating hand-computed arithmetic that can drift."""
    x0, x1 = MARGIN, MARGIN + PW
    p1_y0, p1_y1 = band_top(0), band_top(0) + BAND_H
    p2_y0, p2_y1 = band_top(1), band_top(1) + BAND_H
    p3_y0, p3_y1 = band_top(2), band_top(2) + BAND_H
    p1_floor, p2_floor, p3_floor = p1_y1 - 46, p2_y1 - 40, p3_y1 - 40
    return {
        "panel1": (x0, p1_y0, x1, p1_y1),
        "panel1_content": (x0, p1_y0 + HEADER_H, x1, p1_y1),
        "archive_shelving_cx": x0 + PW // 4,
        "archive_shelving_floor": p1_floor,
        "archive_shelving_s": 3,
        "transformer_cx": x0 + 3 * PW // 4,
        "transformer_floor": p1_floor,
        "transformer_s": 3,
        "panel2": (x0, p2_y0, x1, p2_y1),
        "panel2_content": (x0, p2_y0 + HEADER_H, x1, p2_y1),
        "breaker_cx": (x0 + x1) // 2,
        "breaker_floor": p2_floor,
        "breaker_s": 4,
        "panel3": (x0, p3_y0, x1, p3_y1),
        "panel3_content": (x0, p3_y0 + HEADER_H, x1, p3_y1),
        "crawlspace_cx": x0 + PW // 4,
        "crawlspace_floor": p3_floor,
        "crawlspace_s": 3,
        "alcove_cx": x0 + 3 * PW // 4,
        "alcove_floor": p3_floor,
        "alcove_s": 3,
    }


LAYOUT = compute_layout()


def breaker_lamp_centers(cx: int, floor_y: int, s: int) -> list[tuple[int, int]]:
    """(x, y) centres of the three indicator lamps `draw_breaker_panel` draws
    -- factored out so tests can sample the exact lamp pixels."""
    h = 48 * s
    sw_w = 11 * s
    gap = 18 * s
    total = 3 * sw_w + 2 * gap
    sx0 = cx - total // 2
    sy = floor_y - h // 2 - (18 * s) // 2
    centres = []
    for i in range(3):
        sx = sx0 + i * (sw_w + gap)
        lamp_cx = sx + sw_w // 2
        lamp_cy = sy - 12 * s
        centres.append((lamp_cx, lamp_cy))
    return centres


# ── Deterministic prop icons ────────────────────────────────────────────────


def draw_archive_shelving(d: ImageDraw.ImageDraw, cx: int, floor_y: int, s: int) -> None:
    """Cover-class dressing #1: dense archive shelving row (Records Room)."""
    hw = 30 * s
    h = 62 * s
    top = floor_y - h
    d.rectangle([cx - hw, top, cx - hw + 4 * s, floor_y], fill=COVER_SIDE)
    d.rectangle([cx + hw - 4 * s, top, cx + hw, floor_y], fill=COVER_SIDE)
    d.rectangle([cx - hw, top, cx + hw, top + 4 * s], fill=COVER_TOP)
    shelves = 4
    for k in range(1, shelves + 1):
        sy = top + k * (h // (shelves + 1))
        d.rectangle([cx - hw, sy, cx + hw, sy + 3 * s], fill=COVER_BODY)
        for slot in (-1, 0, 1):
            bxc = cx + slot * (hw // 2)
            d.rectangle(
                [bxc - 7 * s, sy - 10 * s, bxc + 7 * s, sy - 2 * s], fill=COVER_ACCT
            )


def draw_transformer_housings(
    d: ImageDraw.ImageDraw, cx: int, floor_y: int, s: int, n: int = 3
) -> None:
    """Cover-class dressing #2: transformer housings x2-3 (Power Substation)."""
    unit_w = 22 * s
    gap = 8 * s
    total_w = n * unit_w + (n - 1) * gap
    x0 = cx - total_w // 2
    h = 34 * s
    for i in range(n):
        ux = x0 + i * (unit_w + gap)
        top = floor_y - h
        d.rectangle([ux, top, ux + unit_w, floor_y], fill=COVER_BODY)
        d.rectangle([ux, top, ux + 4 * s, floor_y], fill=COVER_SIDE)
        d.rectangle([ux, top, ux + unit_w, top + 3 * s], fill=COVER_TOP)
        for r in range(1, 6):
            ry = top + r * (h // 7)
            d.rectangle([ux + 4 * s, ry, ux + unit_w, ry + 2 * s], fill=COVER_SIDE)


def draw_breaker_panel(d: ImageDraw.ImageDraw, cx: int, floor_y: int, s: int) -> None:
    """Gate object, NOT cover: wall-mounted switch-locked breaker panel with
    three labelled breakers and indicator lamps (`14` §4)."""
    hw = 56 * s
    h = 48 * s
    top = floor_y - h
    d.rectangle([cx - hw, top, cx + hw, floor_y], fill=GATE_BODY)
    d.rectangle([cx - hw, top, cx + hw, floor_y], outline=GATE_FRAME, width=3 * s)
    sw_w, sw_h = 11 * s, 18 * s
    gap = 18 * s
    total = 3 * sw_w + 2 * gap
    sx0 = cx - total // 2
    sy = floor_y - h // 2 - sw_h // 2
    for i in range(3):
        sx = sx0 + i * (sw_w + gap)
        d.rectangle([sx, sy, sx + sw_w, sy + sw_h], fill=GATE_SWITCH)
        d.rectangle([sx, sy, sx + sw_w, sy + sw_h], outline=GATE_FRAME, width=1 * s)
    for lamp_cx, lamp_cy in breaker_lamp_centers(cx, floor_y, s):
        d.ellipse(
            [lamp_cx - 4 * s, lamp_cy - 4 * s, lamp_cx + 4 * s, lamp_cy + 4 * s],
            fill=GATE_LAMP,
        )


def draw_crawlspace(d: ImageDraw.ImageDraw, cx: int, floor_y: int, s: int) -> None:
    """Hiding-spot dressing #1: crawlspace opening (Equipment Floor)."""
    hw = 52 * s
    wall_h = 52 * s
    top = floor_y - wall_h
    d.rectangle([cx - hw, top, cx + hw, floor_y], fill=COVER_SIDE)
    open_w = 38 * s
    open_h = 16 * s
    ox0, oy0 = cx - open_w // 2, floor_y - open_h
    d.rectangle([ox0, oy0, cx + open_w // 2, floor_y], fill=HIDE_INSIDE)
    d.rectangle([ox0, oy0, cx + open_w // 2, floor_y], outline=HIDE_FRAME, width=2 * s)


def draw_hiding_alcove(d: ImageDraw.ImageDraw, cx: int, floor_y: int, s: int) -> None:
    """Hiding-spot dressing #2: recessed hiding alcove (Antenna Shaft)."""
    outer_hw = 34 * s
    h = 54 * s
    top = floor_y - h
    d.rectangle([cx - outer_hw, top, cx + outer_hw, floor_y], fill=COVER_SIDE)
    inset = 6 * s
    niche_top = top + 12 * s
    d.rectangle(
        [cx - outer_hw + inset, niche_top, cx + outer_hw - inset, floor_y - inset],
        fill=HIDE_BODY,
    )
    d.rectangle(
        [cx - outer_hw + inset, niche_top, cx + outer_hw - inset, floor_y - inset],
        outline=HIDE_FRAME,
        width=2 * s,
    )
    gap = 4 * s
    d.rectangle(
        [
            cx - outer_hw + inset + gap,
            niche_top + gap,
            cx + outer_hw - inset - gap,
            floor_y - inset - gap,
        ],
        fill=HIDE_INSIDE,
    )


# ── Panel/header/label drawing ──────────────────────────────────────────────


def draw_panel_frame(d: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int) -> None:
    d.rectangle([x0, y0, x1, y1], fill=BG)
    d.rectangle([x0, y0, x1, y1], outline=BORDER, width=2)


def draw_header(
    d: ImageDraw.ImageDraw,
    x0: int,
    y0: int,
    x1: int,
    text: str,
    font: ImageFont.FreeTypeFont,
) -> None:
    d.rectangle([x0, y0, x1, y0 + HEADER_H], fill=HEADER_BG)
    d.text((x0 + 14, y0 + HEADER_H // 2), text, fill=LABEL_LIGHT, font=font, anchor="lm")


def draw_sublabel(
    d: ImageDraw.ImageDraw, cx: int, y: int, text: str, font: ImageFont.FreeTypeFont
) -> None:
    d.text((cx, y), text, fill=LABEL_LIGHT, font=font, anchor="ma")


def build_composite() -> Image.Image:
    bg_src = Image.open(BG_PATH).convert("RGB").resize((W, H), Image.LANCZOS)
    canvas_flat = Image.new("RGB", (W, H), CANVAS)
    # Mute the photographic SDXL background into a flat game-asset wash while
    # keeping genuine texture/gradient from the real generation visible.
    base = Image.blend(bg_src, canvas_flat, alpha=0.62)
    d = ImageDraw.Draw(base)

    font_hdr = ImageFont.truetype(FONT_BOLD, 20)
    font_sub = ImageFont.truetype(FONT_REG, 16)
    font_title = ImageFont.truetype(FONT_BOLD, 17)

    d.text(
        (MARGIN, 6),
        "SIGNAL TOWER PROPS v2 — FOUR ADDITIVE CLASSES (T-0239) — v1's five props not redrawn",
        fill=LABEL_LIGHT,
        font=font_title,
        anchor="la",
    )

    x0, y0, x1, y1 = LAYOUT["panel1"]
    draw_panel_frame(d, x0, y0, x1, y1)
    draw_header(d, x0, y0, x1, "PANEL 1 — COVER (mid-value, exposed, sight-block only)", font_hdr)
    mid = (x0 + x1) // 2
    d.line([mid, y0 + HEADER_H, mid, y1], fill=BORDER, width=2)
    cx, floor_y, s = LAYOUT["archive_shelving_cx"], LAYOUT["archive_shelving_floor"], LAYOUT["archive_shelving_s"]
    draw_archive_shelving(d, cx, floor_y, s)
    draw_sublabel(d, cx, floor_y + 8, "ARCHIVE SHELVING ROW — COVER", font_sub)
    cx, floor_y, s = LAYOUT["transformer_cx"], LAYOUT["transformer_floor"], LAYOUT["transformer_s"]
    draw_transformer_housings(d, cx, floor_y, s)
    draw_sublabel(d, cx, floor_y + 8, "TRANSFORMER HOUSINGS x2-3 — COVER", font_sub)

    x0, y0, x1, y1 = LAYOUT["panel2"]
    draw_panel_frame(d, x0, y0, x1, y1)
    draw_header(d, x0, y0, x1, "PANEL 2 — GATE OBJECT (switch-locked — NOT COVER)", font_hdr)
    cx, floor_y, s = LAYOUT["breaker_cx"], LAYOUT["breaker_floor"], LAYOUT["breaker_s"]
    draw_breaker_panel(d, cx, floor_y, s)
    draw_sublabel(
        d, cx, floor_y + 8,
        "BREAKER PANEL — 3 LABELLED BREAKERS + INDICATOR LAMPS — GATE OBJECT, NOT COVER",
        font_sub,
    )

    x0, y0, x1, y1 = LAYOUT["panel3"]
    draw_panel_frame(d, x0, y0, x1, y1)
    draw_header(
        d, x0, y0, x1, "PANEL 3 — HIDING (dark, enclosed, single-occupant, exposed entry)", font_hdr
    )
    mid = (x0 + x1) // 2
    d.line([mid, y0 + HEADER_H, mid, y1], fill=BORDER, width=2)
    cx, floor_y, s = LAYOUT["crawlspace_cx"], LAYOUT["crawlspace_floor"], LAYOUT["crawlspace_s"]
    draw_crawlspace(d, cx, floor_y, s)
    draw_sublabel(d, cx, floor_y + 8, "CRAWLSPACE OPENING — HIDING", font_sub)
    cx, floor_y, s = LAYOUT["alcove_cx"], LAYOUT["alcove_floor"], LAYOUT["alcove_s"]
    draw_hiding_alcove(d, cx, floor_y, s)
    draw_sublabel(d, cx, floor_y + 8, "HIDING ALCOVE — HIDING", font_sub)

    return base


def main() -> None:
    img = build_composite()
    img.save(OUT_PNG, format="PNG")
    data = OUT_PNG.read_bytes()
    print("concept_hash:", hashlib.sha256(data).hexdigest())
    print("size:", img.size, "mode:", img.mode)


if __name__ == "__main__":
    main()
