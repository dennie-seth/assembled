#!/usr/bin/env python3
"""Profile-pose LoRA dataset preparation — T-0274.

Turns [T-0273](T-0273)'s six committed, direction-approved profile
reference photographs/illustrations (assets/src/concept/player_profile_reference_*.jpg,
varying aspect ratio) into the square training set
assets/src/character/identity_refs_profile_v1/ + its curation manifest.

Unlike T-0248's identity-view curation (IP-Adapter *generated* candidates,
some kept, some dropped for defects), all six of T-0273's kept images are
used as-is -- T-0273 already did the keep/reject curation (it fetched 7,
kept 6); this script's only job is the square-letterbox preprocessing
sd-scripts' non-bucketed dataset path requires (see
char_gen.prepare_profile_refs.letterbox_to_square) and caption assignment.

These images are anonymous pose/form reference, not a costume match (T-0209
remains the identity authority for costume) -- so captions describe pose and
source rendering only, under a dedicated trigger token distinct from
player_identity_v2's `sbrutalistplayer`, meant to be stacked with it at
generation time.

Usage (from the repo root):
    python3 assets/src/character/prepare_profile_refs_T0274.py

Writes:
    assets/src/character/identity_refs_profile_v1/ref_NNN.png   (6 files)
    assets/src/character/identity_refs_profile_v1/ref_NNN.txt   (6 caption files)
    assets/src/character/identity_curation_manifest_profile_T0274.json
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image

from char_gen.prepare_profile_refs import letterbox_to_square

REPO_ROOT = Path(__file__).resolve().parents[3]
CONCEPT_DIR = REPO_ROOT / "assets" / "src" / "concept"
REFS_DIR = Path(__file__).resolve().parent / "identity_refs_profile_v1"
MANIFEST_PATH = Path(__file__).resolve().parent / "identity_curation_manifest_profile_T0274.json"

TRIGGER_TOKEN = "sbrutalistprofilepose"

# T-0273's six kept source files (player_profile_reference_SUMMARY.md), each
# tagged with what is actually depicted -- a photographic multi-frame gait
# study or a flat silhouette illustration, and the specific pose variant --
# so the caption matches the image, not an aspirational description.
SOURCES: list[dict] = [
    {
        "filename": "player_profile_reference_0817eaf501.jpg",
        "rendering": "black and white photographic reference, multi-frame gait study",
        "detail": "old man walking",
    },
    {
        "filename": "player_profile_reference_b13423a1f5.jpg",
        "rendering": "black and white photographic reference, multi-frame gait study",
        "detail": "man walking, different subject and build",
    },
    {
        "filename": "player_profile_reference_4ef2fcbe5b.jpg",
        "rendering": "black and white photographic reference, multi-frame gait study",
        "detail": "man walking with a cane",
    },
    {
        "filename": "player_profile_reference_3b9ee3bc20.jpg",
        "rendering": "flat black silhouette illustration",
        "detail": "man walking, mid-stride",
    },
    {
        "filename": "player_profile_reference_09511dbc54.jpg",
        "rendering": "flat black silhouette illustration",
        "detail": "man walking, distinct leg phase",
    },
    {
        "filename": "player_profile_reference_8b5318f88e.jpg",
        "rendering": "flat black silhouette illustration",
        "detail": "man walking, distinct leg phase",
    },
]

CAPTION_TEMPLATE = "{trigger}, side view, walking pose, {rendering}, {detail}"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def curate() -> dict:
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    refs: list[dict] = []
    for i, source in enumerate(SOURCES, start=1):
        src_path = CONCEPT_DIR / source["filename"]
        ref_id = f"ref_{i:03d}"
        caption = CAPTION_TEMPLATE.format(
            trigger=TRIGGER_TOKEN, rendering=source["rendering"], detail=source["detail"]
        )

        with Image.open(src_path) as img:
            squared = letterbox_to_square(img)
        squared.save(REFS_DIR / f"{ref_id}.png")
        (REFS_DIR / f"{ref_id}.txt").write_text(caption)

        refs.append(
            {
                "id": ref_id,
                "source_file": f"assets/src/concept/{source['filename']}",
                "source_sha256": sha256_of(src_path),
                "caption": caption,
            }
        )

    manifest = {
        "curation_version": "1.0",
        "card": "T-0274",
        "source_card": "T-0273",
        "source_summary": "assets/src/concept/player_profile_reference_SUMMARY.md",
        "trigger_token": TRIGGER_TOKEN,
        "generator": "assets/src/character/prepare_profile_refs_T0274.py",
        "selection_rationale": (
            "T-0273 already curated (fetched 7, kept 6) -- this card's only job is "
            "square-letterbox preprocessing (char_gen.prepare_profile_refs.letterbox_to_square) "
            "for sd-scripts' non-bucketed dataset path, and caption assignment. No further "
            "images dropped; all six kept T-0273 sources are used. These are anonymous "
            "pose/form reference, not a costume match -- T-0209 remains the identity "
            "authority for costume; this trigger token is distinct from "
            "player_identity_v2's sbrutalistplayer and is meant to be stacked with it at "
            "generation time."
        ),
        "refs": refs,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    manifest = curate()
    print(json.dumps({"kept": len(manifest["refs"])}, indent=2))


if __name__ == "__main__":
    main()
