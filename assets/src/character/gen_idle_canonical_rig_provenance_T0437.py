#!/usr/bin/env python3
"""T-0437 fix round 2: write the missing provenance sidecar for the ALREADY-COMMITTED
`docs/assets/evidence/T-0437/idle_canonical_rig.png`.

This does NOT regenerate the sheet. Codex's final review explicitly verified the arm-breath
fix and the two submitted PNGs by their exact SHA-256 -- re-rendering would change the blob
Codex reviewed and void that verification. This script only OPENS the committed file
read-only, measures it, and writes the sidecar the character gate's `--provenance` flag
requires (`asset_gate.cli character-gate-report`, `required=True`).

Measurement method
-------------------
The sheet is RGBA (`char_gen.rig_compositor.save_sheet` composites frames with
`Image.alpha_composite`, never palette-quantizes), not the indexed "P" mode
`asset_gate.art.check_frame_consistency` requires -- this evidence sheet was never run
through palette quantization, unlike a curated `assets/final/` asset. Re-implementing the
SAME silhouette-delta definition (`asset_gate.art.check_frame_consistency`'s own:
delta = count(silhouette_a != silhouette_b), union = count(silhouette_a | silhouette_b),
ratio = delta / union) against the alpha channel (alpha != 0 is foreground, exactly RGBA's
own analogue of a P-mode "background_index=0") is the faithful equivalent on this sheet's
actual mode, not an invented metric.

Writes:
    docs/assets/evidence/T-0437/idle_canonical_rig.provenance.json
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _CHARACTER_DIR.parents[2]
for _extra in (
    _REPO_ROOT / "tools" / "asset-gate" / "src",
    _REPO_ROOT / "tools" / "comfy-client" / "src",
):
    if str(_extra) not in sys.path:
        sys.path.insert(0, str(_extra))

from comfy_client.provenance_sidecar import apply_arm_c_benchmark_fields  # noqa: E402

SHEET_PATH = _REPO_ROOT / "docs" / "assets" / "evidence" / "T-0437" / "idle_canonical_rig.png"
SIDECAR_PATH = SHEET_PATH.with_suffix(".provenance.json")
GENERATOR_REL_PATH = "assets/src/character/gen_idle_canonical_rig_evidence_T0437.py"
COLS, ROWS, CELL_PX = 12, 1, 48


def _silhouette_delta_ratio(frame_a: Image.Image, frame_b: Image.Image) -> float:
    a = np.asarray(frame_a)[:, :, 3] != 0
    b = np.asarray(frame_b)[:, :, 3] != 0
    delta = np.count_nonzero(a != b)
    union = np.count_nonzero(a | b)
    return float(delta / union) if union else 0.0


def _slice_frames(sheet: Image.Image) -> list[Image.Image]:
    expected = (CELL_PX * COLS, CELL_PX * ROWS)
    if sheet.size != expected:
        raise ValueError(f"sheet is {sheet.size}, expected {expected} for a {COLS}x{ROWS} grid")
    return [sheet.crop((i * CELL_PX, 0, (i + 1) * CELL_PX, CELL_PX)) for i in range(COLS)]


def main() -> None:
    sheet = Image.open(SHEET_PATH)
    print("sheet mode:", sheet.mode, "size:", sheet.size)
    frames = _slice_frames(sheet)

    pairs = [(i, i + 1) for i in range(len(frames) - 1)] + [(len(frames) - 1, 0)]
    ratios = [_silhouette_delta_ratio(frames[a], frames[b]) for a, b in pairs]
    print("per-pair silhouette delta ratios:", [round(r, 6) for r in ratios])

    generator_path = _REPO_ROOT / GENERATOR_REL_PATH
    generator_hash = hashlib.sha256(generator_path.read_bytes()).hexdigest()
    sheet_sha256 = hashlib.sha256(SHEET_PATH.read_bytes()).hexdigest()
    print("generator_hash:", generator_hash)
    print("sheet sha256:", sheet_sha256)

    provenance: dict = {
        "model": "none -- deterministic composite, zero GPU/network calls",
        "model_hash": None,
        "method": (
            "char_gen.idle_cycle.render_frames (the canonical-rig standing idle) over the "
            "ten committed assets/src/character/parts/side_view/*.png parts, descended to "
            "the shared 48px cell via char_gen.character_scale.CHARACTER_SCALE. Measured "
            "here, after the fact, directly from the already-committed sheet -- this "
            "script performs no rendering of its own."
        ),
        "generator": GENERATOR_REL_PATH,
        "generator_hash": generator_hash,
        "card": "T-0437",
        "sheet_sha256": sheet_sha256,
        "layout": {"cols": COLS, "rows": ROWS, "cell_px": CELL_PX},
    }
    provenance = apply_arm_c_benchmark_fields(provenance, ratios, motion_class="idle")

    SIDECAR_PATH.write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
    print("wrote", SIDECAR_PATH)
    print(json.dumps(provenance, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
