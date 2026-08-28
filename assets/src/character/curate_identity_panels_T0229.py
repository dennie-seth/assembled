#!/usr/bin/env python3
"""Curate player-identity figure panels from T-0209's approved concept sheet
(T-0229, HANDOFF §23-e, Arm B of the T-0227 bake-off, DL-21).

`docs/design/13-asset-pipeline.md` §6.14 stage 2 trains identity into
weights rather than conditioning a general model per generation. The first
step is curating training images for that LoRA. T-0209's concept sheet
diverged from its own prompt ("four reference panels") into a dense,
irregular grid of ~20 costume/figure studies -- not every panel is usable:
rows below the jacket close-ups and colour-swatch strip (y<245) show at
least three visually distinct designs (an institutional green coat, a tan/
khaki satchel-and-wrap costume, and a grey/tan heavy-armour variant in the
bottom row), and only the green-coat panels are consistent with the sheet's
own prompt and with the established player silhouette. Curation here means
selecting only the on-model green-coat panels -- training an identity LoRA
on a sheet's incidental drift would teach the model the wrong identity.

Six on-model panels were selected by visual inspection of the sheet (see
_PANELS below for exact crop boxes and the view each shows): three front
views and three back/three-quarter views, giving the trained LoRA angle
diversity without introducing a second costume. Each is also curated as its
own horizontal mirror (a same-content augmentation, not new identity
content) to bring the training set to 12 images -- still a small set by
LoRA standards, deliberately: curation and training time count against this
arm's cost row (see ARM_B_BAKEOFF_REPORT_T0229.md), so the curated set and
the training_config's epoch count are both sized to the smallest set that
still gives the LoRA real angle coverage, not the largest available.

Every panel is padded to a square canvas (its own corner colour as fill)
before being written: sd-scripts' dataset path (no `enable_bucket` in
build_dataset_toml, `lora_train.train`) resizes/centre-crops to a square, so
a non-square curated image would lose real figure content to that crop
before training ever sees it. Padding here, once, deterministically, keeps
the full panel intact through that step.

Usage (from the repo root):
    python3 assets/src/character/curate_identity_panels_T0229.py

Writes:
    assets/src/character/identity_refs/ref_NNN.png   (12 files, square-padded)
    assets/src/character/identity_refs/ref_NNN.txt   (12 caption files)
    assets/src/character/identity_curation_manifest_T0229.json
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parents[3]

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

REFS_DIR = Path(__file__).resolve().parent / "identity_refs"
MANIFEST_PATH = Path(__file__).resolve().parent / "identity_curation_manifest_T0229.json"

TRIGGER_TOKEN = "sbrutalistplayer"

CAPTION_TEMPLATE = (
    "{trigger} character, Soviet brutalist institutional green coat, "
    "pale hooded head, white gloves, {view}, flat colour concept illustration, "
    "grey background"
)

# On-model (green-coat) panels selected by visual inspection of the 1024x1024
# sheet -- see module docstring for why the tan/khaki and grey-armour panels
# elsewhere on the same sheet are excluded. Boxes are (x0, y0, x1, y1).
_PANELS: list[dict] = [
    {
        "id": "ref_001",
        "crop_box": (0, 245, 205, 500),
        "view": "front view, hood down, arms at sides",
    },
    {
        "id": "ref_002",
        "crop_box": (205, 245, 410, 500),
        "view": "front view, arms at sides",
    },
    {
        "id": "ref_003",
        "crop_box": (410, 245, 614, 500),
        "view": "front view, hooded, right arm raised",
    },
    {
        "id": "ref_004",
        "crop_box": (0, 500, 205, 755),
        "view": "three-quarter back view, pack visible",
    },
    {
        "id": "ref_005",
        "crop_box": (410, 500, 614, 755),
        "view": "three-quarter back view, pack visible",
    },
    {
        "id": "ref_006",
        "crop_box": (614, 500, 819, 755),
        "view": "straight back view",
    },
]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _pad_to_square(img: Image.Image) -> Image.Image:
    """Pad `img` to a square canvas, filled with its own top-left corner
    colour (the panel's flat background), content centred."""
    w, h = img.size
    side = max(w, h)
    fill = img.convert("RGB").getpixel((0, 0))
    canvas = Image.new("RGB", (side, side), fill)
    canvas.paste(img.convert("RGB"), ((side - w) // 2, (side - h) // 2))
    return canvas


def curate() -> dict:
    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH} "
            "-- refusing to curate training images from a sheet that is not T-0209's approved sheet"
        )

    sheet = Image.open(CONCEPT_SHEET_PATH)
    REFS_DIR.mkdir(parents=True, exist_ok=True)

    refs: list[dict] = []
    for panel in _PANELS:
        crop = sheet.crop(panel["crop_box"])
        caption = CAPTION_TEMPLATE.format(trigger=TRIGGER_TOKEN, view=panel["view"])

        squared = _pad_to_square(crop)
        (REFS_DIR / f"{panel['id']}.png").parent.mkdir(parents=True, exist_ok=True)
        squared.save(REFS_DIR / f"{panel['id']}.png")
        (REFS_DIR / f"{panel['id']}.txt").write_text(caption)
        refs.append(
            {
                "id": panel["id"],
                "crop_box": list(panel["crop_box"]),
                "view": panel["view"],
                "augmentation": "none",
                "source_panel": None,
                "caption": caption,
            }
        )

        mirrored_id = f"ref_{int(panel['id'].split('_')[1]) + len(_PANELS):03d}"
        mirrored = ImageOps.mirror(squared)
        mirrored.save(REFS_DIR / f"{mirrored_id}.png")
        (REFS_DIR / f"{mirrored_id}.txt").write_text(caption)
        refs.append(
            {
                "id": mirrored_id,
                "crop_box": list(panel["crop_box"]),
                "view": panel["view"],
                "augmentation": "horizontal_flip",
                "source_panel": panel["id"],
                "caption": caption,
            }
        )

    manifest = {
        "curation_version": "1.0",
        "card": "T-0229",
        "bake_off_arm": "B (§23-e)",
        "source_sheet": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_hash": concept_hash,
        "concept_card": "T-0209",
        "trigger_token": TRIGGER_TOKEN,
        "selection_rationale": (
            "T-0209's sheet diverged from its own 'four reference panels' prompt into "
            "~20 costume/figure studies spanning at least three visually distinct designs. "
            "Only the institutional-green-coat panels (consistent with the sheet's own "
            "prompt and the established player silhouette) were curated; tan/khaki and "
            "grey-armour panels elsewhere on the same sheet are a different design and "
            "were excluded, not merely deduplicated."
        ),
        "generator": "assets/src/character/curate_identity_panels_T0229.py",
        "refs": refs,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    manifest = curate()
    summary = {"ref_count": len(manifest["refs"]), "manifest": str(MANIFEST_PATH)}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
