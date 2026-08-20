"""Synthetic player character concept sheet generator for T-0209.

Produces a 1024×1024 full-colour (RGB) PNG concept sheet committed to
`assets/src/concept/player_character_concept_sheet_v1.png`.

This is the same programmatic fallback used for T-0198/T-0199 sprite sheets:
ComfyUI is not reachable from WSL (Windows Firewall; see
assets/src/character/MANUAL_GENERATION.md). The image carries the silhouette,
pose direction, and palette family needed to seed T-0198-iter-2 via
IP-Adapter/img2img conditioning (T-0106 path). Replace with an SDXL-generated
sheet once WSL→ComfyUI access is resolved (recipe:
player_character_concept_sheet_v1.recipe.json).

Design per `docs/design/13-asset-pipeline.md` §6.9 concept-sheet requirements:
- Flat side-on elevation, no perspective/vanishing point
- Reference-layout panels (not a composed scene)
- Hard value separation: darks dark, lights light
- Detail density targets the tile, not the canvas
- Figure height 40px native (×8 gen scale = 320px in the generation)

Output:
  assets/src/concept/player_character_concept_sheet_v1.png   (1024×1024 RGB)
  assets/src/concept/player_character_concept_sheet_v1.provenance.json

Usage:
  python3 assets/src/concept/synth_player_concept.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
except ImportError as e:
    print(f"ERROR: {e}. Install: pip install pillow numpy", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_PNG = REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
OUT_PROVENANCE = OUT_PNG.with_suffix("").with_suffix(".provenance.json")
OUT_RECIPE = OUT_PNG.with_suffix("").with_suffix(".recipe.json")

# Home palette colours (from home_palette.json) used as full RGB for the concept art.
# Concept sheets are full-colour — palette is a reference, not an indexed constraint.
PALETTE = {
    "ramp-00": (0x12, 0x11, 0x0e),   # darkest near-black — BG
    "ramp-01": (0x1a, 0x19, 0x16),   # deep shadow
    "ramp-02": (0x0b, 0x2d, 0x18),   # institutional green shadow
    "ramp-03": (0x12, 0x3c, 0x23),   # institutional green dark
    "ramp-04": (0x3d, 0x3b, 0x31),   # concrete dark
    "ramp-05": (0x22, 0x4d, 0x32),   # institutional green mid-dark
    "ramp-06": (0x49, 0x49, 0x3b),   # concrete mid
    "ramp-07": (0x4c, 0x55, 0x3a),   # institutional green mid
    "ramp-08": (0x58, 0x55, 0x4c),   # concrete mid-light
    "ramp-09": (0x5a, 0x60, 0x42),   # institutional green mid-light
    "ramp-10": (0x64, 0x62, 0x58),   # concrete light
    "ramp-11": (0x61, 0x67, 0x47),   # institutional green light
    "ramp-12": (0x71, 0x6f, 0x66),   # concrete pale
    "ramp-13": (0x7e, 0x7c, 0x74),   # concrete lightest
    "ramp-14": (0x8f, 0x8b, 0x86),   # near-white shadow
    "ramp-15": (0xa8, 0xa4, 0xa0),   # lightest
}

# ── Colour assignments for character concept art ──────────────────────────────
BG       = PALETTE["ramp-01"]  # panel background — deep shadow
PANEL_BG = PALETTE["ramp-00"]  # canvas background — near-black
BORDER   = PALETTE["ramp-04"]  # panel border line — concrete dark

SHADOW   = PALETTE["ramp-02"]  # figure cast shadow
BODY_DRK = PALETTE["ramp-05"]  # coat/clothing shadow
BODY_MID = PALETTE["ramp-07"]  # coat/clothing mid-tone (dominant — institutional green)
BODY_HI  = PALETTE["ramp-09"]  # coat/clothing highlight
HEAD_DRK = PALETTE["ramp-08"]  # head/skin shadow
HEAD_MID = PALETTE["ramp-10"]  # head/skin mid
HEAD_HI  = PALETTE["ramp-12"]  # head/skin highlight
LABEL    = PALETTE["ramp-13"]  # label text

# ── Sheet layout ──────────────────────────────────────────────────────────────
W, H     = 1024, 1024
MARGIN   = 16   # outer margin
GUTTER   = 8    # gap between panels
COLS, ROWS = 2, 2
PANEL_W  = (W - 2 * MARGIN - (COLS - 1) * GUTTER) // COLS   # 496px
PANEL_H  = (H - 2 * MARGIN - (ROWS - 1) * GUTTER) // ROWS  # 496px

# Figure is drawn at 8× the 40px native height → 320px tall, in a 48×8=384px cell
SCALE    = 8
CELL     = 48 * SCALE   # 384px — the native 48×48 cell scaled up
FIG_H    = 40 * SCALE   # 320px — the 40px figure scaled up


def _colour(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    return rgb


def _flat_rect(draw: ImageDraw.Draw, x0: int, y0: int, x1: int, y1: int,
               fill: tuple[int, int, int]) -> None:
    draw.rectangle([x0, y0, x1, y1], fill=fill)


def _panel_frame(draw: ImageDraw.Draw, px: int, py: int, pw: int, ph: int) -> None:
    """Fill panel background and draw a thin border."""
    _flat_rect(draw, px, py, px + pw - 1, py + ph - 1, BG)
    draw.rectangle([px, py, px + pw - 1, py + ph - 1], outline=BORDER, width=2)


def _draw_label(draw: ImageDraw.Draw, text: str, cx: int, y: int) -> None:
    """Draw a small text label centred at cx, top at y."""
    try:
        font = ImageFont.load_default(size=14)
    except TypeError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw // 2, y), text, fill=LABEL, font=font)


# ── Figure drawing helpers ────────────────────────────────────────────────────

def _draw_idle(draw: ImageDraw.Draw, cx: int, cy: int, scale: int = SCALE) -> None:
    """Flat side-on standing figure (idle / front-facing reference).

    Proportions derived from 13-asset-pipeline.md §3.5:
      40px tall, 48×48 cell. Parts:
        Head   8px × 12px  → ×scale
        Neck   4px × 6px
        Torso  16px × 18px
        Arms   10px × 4px each side
        Legs   14px × 5px each
    """
    s = scale
    # Shadow on ground
    _flat_rect(draw, cx - 9 * s, cy + 19 * s, cx + 9 * s, cy + 20 * s, SHADOW)

    # Legs
    _flat_rect(draw, cx - 8 * s, cy + 5 * s, cx - 3 * s, cy + 19 * s, BODY_DRK)
    _flat_rect(draw, cx + 3 * s, cy + 5 * s, cx + 8 * s, cy + 19 * s, BODY_DRK)
    # Leg highlight (front face)
    _flat_rect(draw, cx - 7 * s, cy + 5 * s, cx - 4 * s, cy + 18 * s, BODY_MID)
    _flat_rect(draw, cx + 4 * s, cy + 5 * s, cx + 7 * s, cy + 18 * s, BODY_MID)

    # Torso
    _flat_rect(draw, cx - 9 * s, cy - 8 * s, cx + 9 * s, cy + 6 * s, BODY_DRK)
    _flat_rect(draw, cx - 8 * s, cy - 7 * s, cx + 8 * s, cy + 5 * s, BODY_MID)
    # Torso highlight stripe
    _flat_rect(draw, cx - 6 * s, cy - 7 * s, cx - 3 * s, cy + 4 * s, BODY_HI)

    # Arms
    _flat_rect(draw, cx - 13 * s, cy - 8 * s, cx - 9 * s, cy + 3 * s, BODY_DRK)
    _flat_rect(draw, cx + 9 * s, cx + 9 * s, cx + 13 * s, cy + 3 * s, BODY_DRK)
    _flat_rect(draw, cx + 9 * s, cy - 8 * s, cx + 13 * s, cy + 3 * s, BODY_DRK)

    # Neck
    _flat_rect(draw, cx - 3 * s, cy - 12 * s, cx + 3 * s, cy - 8 * s, HEAD_DRK)

    # Head
    _flat_rect(draw, cx - 6 * s, cy - 20 * s, cx + 6 * s, cy - 12 * s, HEAD_DRK)
    _flat_rect(draw, cx - 5 * s, cy - 19 * s, cx + 5 * s, cy - 13 * s, HEAD_MID)
    # Face highlight
    _flat_rect(draw, cx - 4 * s, cy - 19 * s, cx - 1 * s, cy - 14 * s, HEAD_HI)


def _draw_walk(draw: ImageDraw.Draw, cx: int, cy: int, scale: int = SCALE) -> None:
    """Side-on mid-stride walk pose: left leg forward, right leg back, arm swing."""
    s = scale
    # Shadow
    _flat_rect(draw, cx - 10 * s, cy + 19 * s, cx + 10 * s, cy + 20 * s, SHADOW)

    # Rear leg (right, pulled back)
    _flat_rect(draw, cx + 1 * s, cy + 5 * s, cx + 6 * s, cy + 18 * s, BODY_DRK)
    _flat_rect(draw, cx + 2 * s, cy + 5 * s, cx + 5 * s, cy + 17 * s, BODY_MID)

    # Torso (same)
    _flat_rect(draw, cx - 9 * s, cy - 8 * s, cx + 9 * s, cy + 6 * s, BODY_DRK)
    _flat_rect(draw, cx - 8 * s, cy - 7 * s, cx + 8 * s, cy + 5 * s, BODY_MID)
    _flat_rect(draw, cx - 6 * s, cy - 7 * s, cx - 3 * s, cy + 4 * s, BODY_HI)

    # Front leg (left, stepping forward)
    _flat_rect(draw, cx - 8 * s, cy + 4 * s, cx - 3 * s, cy + 19 * s, BODY_DRK)
    _flat_rect(draw, cx - 7 * s, cy + 4 * s, cx - 4 * s, cy + 18 * s, BODY_MID)

    # Arms — opposite swing to legs
    _flat_rect(draw, cx - 14 * s, cy - 5 * s, cx - 9 * s, cy + 5 * s, BODY_DRK)   # rear arm swings forward
    _flat_rect(draw, cx + 9 * s, cy - 8 * s, cx + 14 * s, cy + 1 * s, BODY_DRK)   # front arm swings back

    # Neck + head
    _flat_rect(draw, cx - 3 * s, cy - 12 * s, cx + 3 * s, cy - 8 * s, HEAD_DRK)
    _flat_rect(draw, cx - 6 * s, cy - 20 * s, cx + 6 * s, cy - 12 * s, HEAD_DRK)
    _flat_rect(draw, cx - 5 * s, cy - 19 * s, cx + 5 * s, cy - 13 * s, HEAD_MID)
    _flat_rect(draw, cx - 4 * s, cy - 19 * s, cx - 1 * s, cy - 14 * s, HEAD_HI)


def _draw_crouch(draw: ImageDraw.Draw, cx: int, cy: int, scale: int = SCALE) -> None:
    """Crouched/hiding pose: torso lowered, knees bent, head tucked."""
    s = scale
    # Shadow
    _flat_rect(draw, cx - 12 * s, cy + 9 * s, cx + 12 * s, cy + 10 * s, SHADOW)

    # Bent legs (wide stance, lower torso)
    _flat_rect(draw, cx - 12 * s, cy - 2 * s, cx - 5 * s, cy + 9 * s, BODY_DRK)
    _flat_rect(draw, cx + 5 * s, cy - 2 * s, cx + 12 * s, cy + 9 * s, BODY_DRK)
    _flat_rect(draw, cx - 11 * s, cy - 1 * s, cx - 6 * s, cy + 8 * s, BODY_MID)
    _flat_rect(draw, cx + 6 * s, cy - 1 * s, cx + 11 * s, cy + 8 * s, BODY_MID)

    # Torso (compressed, lower)
    _flat_rect(draw, cx - 10 * s, cy - 10 * s, cx + 10 * s, cy + 0 * s, BODY_DRK)
    _flat_rect(draw, cx - 9 * s, cy - 9 * s, cx + 9 * s, cy - 1 * s, BODY_MID)
    _flat_rect(draw, cx - 7 * s, cy - 9 * s, cx - 4 * s, cy - 2 * s, BODY_HI)

    # Arms (folded low, wide)
    _flat_rect(draw, cx - 14 * s, cy - 8 * s, cx - 10 * s, cy + 0 * s, BODY_DRK)
    _flat_rect(draw, cx + 10 * s, cy - 8 * s, cx + 14 * s, cy + 0 * s, BODY_DRK)

    # Head (tucked lower)
    _flat_rect(draw, cx - 3 * s, cy - 14 * s, cx + 3 * s, cy - 10 * s, HEAD_DRK)
    _flat_rect(draw, cx - 6 * s, cy - 22 * s, cx + 6 * s, cy - 14 * s, HEAD_DRK)
    _flat_rect(draw, cx - 5 * s, cy - 21 * s, cx + 5 * s, cy - 15 * s, HEAD_MID)
    _flat_rect(draw, cx - 4 * s, cy - 21 * s, cx - 1 * s, cy - 16 * s, HEAD_HI)


def _draw_scale_reference(draw: ImageDraw.Draw, px: int, py: int,
                           pw: int, ph: int) -> None:
    """Scale reference panel: native 48×48 cell at ×8, showing figure proportion.

    Draws:
    - A labelled 48×8px cell grid (3 cells wide, 3 tall)
    - The 40px figure centred in one cell at native scale (×1), zoomed to ×8
    - Palette family swatches at bottom
    """
    cx = px + pw // 2
    # Centre the demo cell
    cell_px = 48  # native cell, displayed at 1:1 scale for the reference section
    cell_display = cell_px * 4  # display at ×4 so it's readable without being huge (192px)

    # Draw the cell grid (3×3) at ×4 scale
    grid_left = cx - (3 * cell_display) // 2
    grid_top  = py + 40
    for row in range(3):
        for col in range(3):
            gx = grid_left + col * cell_display
            gy = grid_top + row * cell_display
            _flat_rect(draw, gx, gy, gx + cell_display - 1, gy + cell_display - 1, BG)
            draw.rectangle([gx, gy, gx + cell_display - 1, gy + cell_display - 1],
                           outline=BORDER, width=1)

    # Draw a small ×4-scaled idle figure in cell (0,0) — the reference pose
    s4 = 4
    fig_cx = grid_left + cell_display // 2
    fig_cy = grid_top + cell_display // 2 + 6 * s4  # offset so feet near bottom
    _draw_idle(draw, fig_cx, fig_cy, scale=s4)

    _draw_label(draw, "3×3 grid · 48×48 cell · 40px figure (×4)", cx, grid_top + 3 * cell_display + 8)

    # Palette swatches (home palette family)
    swatch_y = grid_top + 3 * cell_display + 36
    swatch_w, swatch_h = 40, 28
    swatch_gap = 6
    swatch_total = len(PALETTE) * (swatch_w + swatch_gap) - swatch_gap
    swatch_x = px + (pw - swatch_total) // 2
    for i, (name, rgb) in enumerate(PALETTE.items()):
        sx = swatch_x + i * (swatch_w + swatch_gap)
        _flat_rect(draw, sx, swatch_y, sx + swatch_w - 1, swatch_y + swatch_h - 1, rgb)
    _draw_label(draw, "home palette (reference)", cx, swatch_y + swatch_h + 6)


def generate(out_path: Path = OUT_PNG) -> Path:
    """Build the 1024×1024 full-colour concept sheet and write provenance sidecar."""
    canvas = Image.new("RGB", (W, H), PANEL_BG)
    draw = ImageDraw.Draw(canvas)

    # Panel coordinates (row, col) -> (px, py)
    def panel_origin(row: int, col: int) -> tuple[int, int]:
        px = MARGIN + col * (PANEL_W + GUTTER)
        py = MARGIN + row * (PANEL_H + GUTTER)
        return px, py

    # ── Panel 0,0 — Idle (standing, front-facing side-on) ────────────────────
    px, py = panel_origin(0, 0)
    _panel_frame(draw, px, py, PANEL_W, PANEL_H)
    _draw_label(draw, "IDLE — side-on elevation", px + PANEL_W // 2, py + 8)
    cx0 = px + PANEL_W // 2
    cy0 = py + PANEL_H // 2 + FIG_H // 6
    _draw_idle(draw, cx0, cy0)

    # ── Panel 0,1 — Walk mid-stride ───────────────────────────────────────────
    px, py = panel_origin(0, 1)
    _panel_frame(draw, px, py, PANEL_W, PANEL_H)
    _draw_label(draw, "WALK — mid-stride", px + PANEL_W // 2, py + 8)
    cx1 = px + PANEL_W // 2
    cy1 = py + PANEL_H // 2 + FIG_H // 6
    _draw_walk(draw, cx1, cy1)

    # ── Panel 1,0 — Crouch-hide ───────────────────────────────────────────────
    px, py = panel_origin(1, 0)
    _panel_frame(draw, px, py, PANEL_W, PANEL_H)
    _draw_label(draw, "CROUCH-HIDE", px + PANEL_W // 2, py + 8)
    cx2 = px + PANEL_W // 2
    cy2 = py + PANEL_H // 2 + FIG_H // 8
    _draw_crouch(draw, cx2, cy2)

    # ── Panel 1,1 — Scale reference ───────────────────────────────────────────
    px, py = panel_origin(1, 1)
    _panel_frame(draw, px, py, PANEL_W, PANEL_H)
    _draw_label(draw, "SCALE REF + PALETTE FAMILY", px + PANEL_W // 2, py + 8)
    _draw_scale_reference(draw, px, py, PANEL_W, PANEL_H)

    # Save the image
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG")

    # Compute concept_hash and write provenance
    img_bytes = out_path.read_bytes()
    concept_hash = hashlib.sha256(img_bytes).hexdigest()

    provenance = {
        "model": "synth — programmatic PIL generation (T-0209 fallback; SDXL blocked by WSL→Windows Firewall)",
        "model_license": "N/A — no AI model used; PIL/numpy only",
        "model_hash": None,
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

    prov_path = out_path.with_suffix("").with_suffix(".provenance.json")
    prov_path.write_text(json.dumps(provenance, indent=2))
    print(f"wrote {out_path}")
    print(f"wrote {prov_path}")
    print(f"concept_hash: {concept_hash}")
    return out_path


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Generate synthetic player concept sheet (T-0209)")
    parser.add_argument("--out", type=Path, default=OUT_PNG)
    args = parser.parse_args()
    generate(args.out)
