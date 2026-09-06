#!/usr/bin/env python3
"""Derive a same-render-style side-profile reference panel from the
committed T-0209 concept sheet (T-0272 round 4, defect 2).

The round-4 card's cheapest costume-bearing-reference option was "crop/derive
a profile-ish view from the existing concept sheet or from T-0252's promoted
idle sheet, so it at least carries the palette." Direct visual inspection of
`player_character_concept_sheet_v1.png` (cropped and read with the Read tool,
recorded in `ARM_PROFILE_ATTEMPT_LOG_T0272.md`) found that option is not
literally achievable from either named source: every one of T-0209's
green-coat panels (the jacket close-ups and all three full-body panels) is a
pure front view, and T-0252's own idle sheet is the front-facing animation
this card exists to supplement -- neither contains any profile or even
three-quarter angle of the green costume to crop.

What the concept sheet *does* contain, at panel (row 3, column 5, pixel box
(819, 256, 1024, 512) of the 1024x1024 sheet), is a genuine, unambiguous
side-profile figure -- rendered in the sheet's grey/tan tactical-variant
costume tier rather than the green cloth-coat tier, but in the exact same
render style as every other panel (same linework, same studio background),
and already facing right, matching `pose_rig_profile_T0272.FACING`. That
makes it a same-style pose/framing reference -- still not a costume match,
exactly like T-0273's anonymous photographic references, but drawn by the
same process that produced the identity-bearing concept sheet itself, which
T-0273's real photographs are not.

`extract_panel_reference` is the reusable pure-function half of this
derivation: border-flood the panel's own background (identical detector to
`char_gen.cutout`, at the pipeline's shared default tolerance), keep only the
largest connected foreground component (the figure -- discarding the panel's
own small text-label artifact, which is a separate component), force every
other pixel to solid black (this card's own "solid flat black background"
generation target), and crop tightly to that component's bbox plus a small
margin, clamped to the source panel's own extent.

Usage (from the repo root):
    python3 assets/src/character/derive_profile_style_reference_T0272.py

Writes:
    assets/src/concept/player_profile_style_reference_T0272.png
    assets/src/concept/player_profile_style_reference_T0272.provenance.json
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

from char_gen.cutout import (
    CUTOUT_OKLAB_TOLERANCE,
    border_flood_background_mask,
    label_foreground_components,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

# Row 3 (0-indexed row 2), column 5 of the sheet's 5-column x N-row grid
# (1024x1024, cells ~204.8px wide) -- the one genuine side-profile panel on
# the whole sheet, identified by direct visual inspection.
PANEL_BOX = (819, 256, 1024, 512)
PANEL_MARGIN = 6

OUTPUT_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_profile_style_reference_T0272.png"
)
PROVENANCE_PATH = (
    REPO_ROOT
    / "assets"
    / "src"
    / "concept"
    / "player_profile_style_reference_T0272.provenance.json"
)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_panel_reference(
    img: Image.Image,
    tolerance: float = CUTOUT_OKLAB_TOLERANCE,
    margin: int = PANEL_MARGIN,
) -> Image.Image:
    """Crop `img` tightly to its own largest foreground component (the
    figure), forcing every other pixel -- background and any smaller
    disconnected artifact, such as a text label -- to solid black."""
    rgb = img.convert("RGB")
    arr = np.array(rgb)
    h, w = arr.shape[:2]

    background = border_flood_background_mask(rgb, tolerance)
    foreground = ~background
    labels, count = label_foreground_components(foreground)
    if count == 0:
        raise ValueError("no foreground component found -- panel appears to be entirely background")
    areas = {lbl: int((labels == lbl).sum()) for lbl in range(1, count + 1)}
    largest_label = max(areas, key=areas.get)
    keep = labels == largest_label

    out = arr.copy()
    out[~keep] = (0, 0, 0)

    ys, xs = np.where(keep)
    y0 = max(0, int(ys.min()) - margin)
    y1 = min(h, int(ys.max()) + 1 + margin)
    x0 = max(0, int(xs.min()) - margin)
    x1 = min(w, int(xs.max()) + 1 + margin)

    return Image.fromarray(out[y0:y1, x0:x1])


def derive() -> dict:
    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH}"
        )

    sheet = Image.open(CONCEPT_SHEET_PATH).convert("RGB")
    panel = sheet.crop(PANEL_BOX)
    reference = extract_panel_reference(
        panel, tolerance=CUTOUT_OKLAB_TOLERANCE, margin=PANEL_MARGIN
    )
    reference.save(OUTPUT_PATH)

    provenance = {
        "card": "T-0272",
        "round": 4,
        "generator": "assets/src/character/derive_profile_style_reference_T0272.py",
        "source_file": str(CONCEPT_SHEET_PATH.relative_to(REPO_ROOT)),
        "source_card": "T-0209",
        "source_sha256": concept_hash,
        "source_panel_box": list(PANEL_BOX),
        "extraction_method": (
            "border-connected tolerant Oklab flood (char_gen.cutout.border_flood_background_mask, "
            f"tolerance={CUTOUT_OKLAB_TOLERANCE}) to detect the panel's own background, largest-"
            "connected-component selection to isolate the figure from the panel's own text-label "
            "artifact, every non-figure pixel forced to solid black, cropped to the figure's own "
            f"bbox + {PANEL_MARGIN}px margin (clamped to the source panel's extent)."
        ),
        "model_hash": "N/A -- deterministic crop/cleanup of an already-generated, already-"
        "provenanced source (see player_character_concept_sheet_v1.provenance.json for the "
        "original generation's model_hash); no new model inference performed by this script",
        "license": "inherits the source concept sheet's own licence -- no new generation",
        "note": (
            "NOT a costume match: this panel is the sheet's grey/tan tactical-variant costume "
            "tier, not the green cloth-coat tier -- direct visual inspection of the full sheet "
            "(see ARM_PROFILE_ATTEMPT_LOG_T0272.md) found every green-coat panel on it is a pure "
            "front view, so no profile-angle green reference exists anywhere on this sheet to "
            "crop. What this panel does carry is a genuine, unambiguous side profile in the same "
            "render style as the rest of the sheet (unlike T-0273's anonymous real-photograph "
            "references), already facing right to match pose_rig_profile_T0272.FACING -- a "
            "same-style pose/framing reference, tested as an alternative secondary IP-Adapter "
            "input to T-0273's photographic set."
        ),
    }
    PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    provenance = derive()
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
